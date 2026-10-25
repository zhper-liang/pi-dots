import WorkspaceIdentity from './WorkspaceIdentity'
import { useEffect, useRef, useState } from 'react'

type Item = { id: string; sourceId: string; title: string; version: number; status?: 'open' | 'completed'; due?: string | null; timezone: string; start?: string; end?: string; description?: string; deletedAt?: string | null }
type Ref = { type: 'Todo' | 'Event'; sourceId: string; id: string }
type Link = { todoRef: Ref; eventRef: Ref; id: string; todoId: string; eventId: string; todoState: string; eventState: string }
type Form = { type: 'Todo' | 'Event'; id?: string; version?: number; title: string; description: string; start: string; end: string; due: string; timezone: string }
type Receipt = { id: string; requestId: string; state: string; receipt: { target?: { id: string; sourceId: string }; version?: number; status?: string } }
const initial = (type: Form['type']): Form => ({ type, title: '', description: '', start: '', end: '', due: '', timezone: 'Asia/Shanghai' })
export default function LocalWorkspace({ token, view = 'todos' }: { token: string; view?: 'todos' | 'calendar' }) {
  const [enabled, setEnabled] = useState(false), [epoch, setEpoch] = useState(0), [loaded, setLoaded] = useState(false)
  const [todos, setTodos] = useState<Item[]>([]), [events, setEvents] = useState<Item[]>([]), [links, setLinks] = useState<Link[]>([])
  const [form, setForm] = useState<Form | null>(null), [deleting, setDeleting] = useState<{ type: Form['type']; item: Item } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState<Receipt | null>(null)
  const [hasPending, setHasPending] = useState(false)
  const [todoId, setTodoId] = useState(''), [eventId, setEventId] = useState('')
  const [externalEvents, setExternalEvents] = useState<Item[]>([])
  const [linkConfirm, setLinkConfirm] = useState<{ todo: Item; event: Item } | null>(null)
  const [linkWindow, setLinkWindow] = useState(() => ({ start: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), end: new Date(Date.now() + 7 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z') }))
  const visibility = useRef(0)
  const running = useRef(false)
  const pending = useRef<{ key: string; requestId: string } | null>(null)
  async function api<T>(path: string, input?: object): Promise<T> {
    const response = await fetch(`/api/workspace/${path}`, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }).catch(() => { throw new Error('连接中断，结果未确认。请查询原请求回执，不要改参数重建请求。') })
    const body = await response.json()
    if (!response.ok) throw new Error(`${body.error?.code ?? response.status}：${body.error?.message ?? '业务操作失败，请重试。'}`)
    return body.data
  }
  async function page<T>(type: string): Promise<T[]> {
    const result: T[] = []; let cursor: number | undefined = 0
    while (cursor !== undefined) { const p: { items: T[]; next?: number } = await api('query', { type, sourceId: 'local', cursor, limit: 100 }); result.push(...p.items); cursor = p.next }
    return result
  }
  async function refresh() {
    // Discard stale authorized projection before every refresh or permission change.
    const generation = ++visibility.current; setExternalEvents([]); setLinkConfirm(null); setTodoId(''); setEventId(''); setReceipt(null); setTodos([]); setEvents([]); setLinks([]); setLoaded(false); setForm(null); setDeleting(null)
    const status = await api<{ sources: { id: string; authorized: boolean; grantEpoch: number }[] }>('status')
    if (generation !== visibility.current) return
    const source = status.sources.find(s => s.id === 'local'); setEnabled(source?.authorized ?? true); setEpoch(source?.grantEpoch ?? 0)
    {
      const [t, e, l] = await Promise.all([page<Item>('Todo'), page<Item>('Event'), page<Link>('ItemLink')])
      if (generation !== visibility.current) return
      setTodos(t); setEvents(e); setLinks(l)
    }
    setLoaded(true)
    return true
  }
  // A stale authorized projection is not retained after source revocation/change.
  useEffect(() => {
    let active = true, checking = false, identity: string | undefined
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const responses = await Promise.all([fetch('/api/workspace/status', { headers }), fetch('/api/workspace/external-sources', { method: 'POST', headers, body: '{}' })])
        if (responses.some(r => !r.ok)) throw Error('来源权限检查失败')
        const bodies = await Promise.all(responses.map(r => r.json()))
        const next = JSON.stringify(bodies.map(b => b.data.sources))
        if (active && identity !== undefined && next !== identity) {
          visibility.current++; setTodos([]); setEvents([]); setLinks([]); setExternalEvents([]); setLinkConfirm(null); setReceipt(null); setLoaded(false); setForm(null); setDeleting(null)
          setError('来源许可已变化，已隐藏旧数据，请刷新后重新确认。')
        }
        identity = next
      } catch {
        if (active) { visibility.current++; setTodos([]); setEvents([]); setLinks([]); setExternalEvents([]); setLinkConfirm(null); setReceipt(null); setForm(null); setDeleting(null); setLoaded(false); setError('无法核验当前来源权限，已隐藏关联数据。') }
      } finally { checking = false }
    }
    void check(); const timer = setInterval(() => void check(), 3000)
    return () => { active = false; clearInterval(timer) }
  }, [token])
  async function loadExternalEvents() {
    const generation = visibility.current
    setExternalEvents([]); setLinkConfirm(null); setEventId('')
    const { sources } = await api<{ sources: { id: string; authorized: boolean; readScope: string }[] }>('external-sources', {})
    const result: Item[] = []
    for (const source of sources.filter(s => s.authorized && s.readScope === 'full')) {
      const page = await api<{ items: Item[]; complete: boolean; stale?: boolean }>('external-query', { sourceId: source.id, ...linkWindow, timezone: 'Asia/Shanghai' })
      if (!page.complete || page.stale) throw Error('外部窗口不完整或缓存过期，请缩小时间范围后重试。')
      result.push(...page.items.filter(item => item.id && item.version && !item.deletedAt).map(item => ({ ...item, sourceId: source.id })))
    }
    if (generation !== visibility.current) throw Error('查询期间来源权限已变化，请刷新。')
    setExternalEvents(result)
    if (!result.length) throw Error('窗口内没有可关联的外部日程，或未授予当前用户完整读取权限。')
  }
  async function act(fn: () => Promise<unknown>) {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : '连接失败，请检查连接；不确定结果请按原请求标识查询，勿重建重复请求。') }
    finally { running.current = false; setBusy(false) }
  }
  async function command(input: object, path = 'command') {
    const key = JSON.stringify({ path, input })
    if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() }
    setHasPending(true)
    const generation = visibility.current
    const result = await api<Receipt>(path, { ...input, requestId: pending.current.requestId })
    if (generation !== visibility.current) throw Error('操作期间权限已变化；请查询原请求回执，不要重建请求。')
    setReceipt(result); pending.current = null; setHasPending(false); setForm(null); setDeleting(null)
    if (await refresh()) setReceipt(result)
  }
  async function edit(type: Form['type'], item: Item) {
    // Detail uses the same service and permission projection as list.
    const detail = await api<{ items: Item[] }>('get', { type, sourceId: item.sourceId, id: item.id })
    const latest = detail.items[0]
    if (!latest || latest.deletedAt) throw new Error('对象已删除，请刷新列表。')
    setForm({ ...initial(type), id: latest.id, version: latest.version, title: latest.title, description: latest.description ?? '', start: latest.start ?? '', end: latest.end ?? '', due: latest.due ?? '', timezone: latest.timezone })
  }
  function renderItems(type: Form['type'], items: Item[]) {
    return <ul>{items.map(item => <li key={item.id} style={{ overflowWrap: 'anywhere' }}><strong>{item.title}</strong><p>source: {item.sourceId} · version: {item.version} · {item.deletedAt ? `已删除 ${item.deletedAt}` : item.status ?? 'active'} · ID: {item.id}</p><p>{type === 'Todo' ? `截止：${item.due ?? '无'} · ${item.timezone}` : `${item.start} — ${item.end} · ${item.timezone}`}</p>{!item.deletedAt && <><button disabled={busy} onClick={() => void act(() => edit(type, item))}>编辑{type === 'Todo' ? '待办' : '日程'}</button>{type === 'Todo' && <button disabled={busy} onClick={() => void act(() => command({ sourceId: 'local', type, action: 'update', id: item.id, expectedVersion: item.version, data: { status: item.status === 'completed' ? 'open' : 'completed' } }))}>{item.status === 'completed' ? '重开待办' : '完成待办'}</button>}<button disabled={busy} onClick={() => { setDeleting({ type, item }); setForm(null) }}>删除{type === 'Todo' ? '待办' : '日程'}</button></>}</li>)}</ul>
  }
  return <section className="feishu-panel"><h2>{view === 'calendar' ? '本地日程' : '本地待办与事项关联'}</h2><p>本地用户操作无需聊天Task，不调用模型。你对本地日程与待办始终拥有完整权限；Bot 权限在 Bot 设置中单独选择。</p><button disabled={busy} onClick={() => void act(refresh)}>{busy ? '正在处理…' : '刷新本地工作区'}</button>
    {busy && <p role="status">正在读取或保存本地事项…</p>}{!loaded && !busy && <p>正在读取本地事项；如未显示请刷新。</p>}{error && <p role="alert">{error}</p>}{receipt && <p role="status" style={{ overflowWrap: 'anywhere' }}>持久回执：{receipt.state} · 请求 {receipt.requestId} · 对象 {receipt.receipt.target?.id ?? '用户来源许可'} · 版本 {receipt.receipt.version ?? '—'}</p>}
    {hasPending && <button disabled={busy} onClick={() => void act(async () => { const op = await api<Receipt | null>('operation', { requestId: pending.current!.requestId, sourceId: 'local' }); if (!op) throw new Error('未查询到回执；保留原请求标识，仅原参数可重试。'); pending.current = null; setHasPending(false); if (await refresh()) setReceipt(op) })}>查询上次请求回执</button>}
    {loaded && <><WorkspaceIdentity sourceId="local" authority="local" scope={enabled ? 'full' : 'none'} epoch={epoch} /></>}
    {loaded && <><button disabled={busy} onClick={() => { setForm(initial('Todo')); setDeleting(null) }}>新建待办</button><button disabled={busy} onClick={() => { setForm(initial('Event')); setDeleting(null) }}>新建日程</button>
      {form && <form aria-label="本地事项表单" onSubmit={e => { e.preventDefault(); void act(() => command({ sourceId: 'local', type: form.type, action: form.id ? 'update' : 'create', ...(form.id ? { id: form.id, expectedVersion: form.version } : {}), data: form.type === 'Todo' ? { title: form.title, due: form.due || null, timezone: form.timezone } : { title: form.title, description: form.description, start: form.start, end: form.end, timezone: form.timezone } })) }}><fieldset disabled={busy}><legend>{form.id ? '编辑' : '创建'}{form.type === 'Todo' ? '待办' : '日程'} · 本地来源{form.version && ` · 版本${form.version}`}</legend><label>标题<input required maxLength={500} aria-label="本地标题" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label><label>IANA时区<input required aria-label="本地时区" value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} /></label>{form.type === 'Todo' ? <label>截止日期（可选；YYYY-MM-DD或带偏移ISO）<input aria-label="待办截止日期" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} /></label> : <><label>描述<textarea aria-label="本地描述" maxLength={4000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label><label>开始（例2026-10-20T09:00:00+08:00）<input required aria-label="本地开始" value={form.start} onChange={e => setForm({ ...form, start: e.target.value })} /></label><label>结束（带偏移ISO）<input required aria-label="本地结束" value={form.end} onChange={e => setForm({ ...form, end: e.target.value })} /></label></>}<p>明确提交保存；不支持重复/全天写入。修改冲突时请刷新并重新编辑，不会自动覆盖。</p><button type="submit">明确提交保存</button><button type="button" onClick={() => setForm(null)}>取消编辑</button></fieldset></form>}
      {deleting && <section aria-label="精确删除确认" style={{ overflowWrap: 'anywhere' }}><p>确认删除 {deleting.item.title} · source local · ID {deleting.item.id} · version {deleting.item.version}？保留删除标记和关联记录，不删除另一事项。</p><button disabled={busy} onClick={() => void act(() => command({ sourceId: 'local', type: deleting.type, action: 'delete', id: deleting.item.id, expectedVersion: deleting.item.version, confirmedDelete: true }))}>确认删除此对象</button><button disabled={busy} onClick={() => setDeleting(null)}>取消删除</button></section>}
      {view === 'todos' ? <><h3>待办清单（含历史删除标记）</h3>{todos.length === 0 && <p className="workspace-empty">暂无待办。新建待办后会获得持久回执；无截止日期不会自动占用日历。</p>}{renderItems('Todo', todos)}</> : <><h3>本地日程（含历史删除标记）</h3>{events.length === 0 && <p className="workspace-empty">暂无本地日程；外部来源独立展示，不自动合并或授权。</p>}{renderItems('Event', events)}</>}
      <section aria-label="外部关联日程查询"><label>关联窗口开始<input aria-label="关联窗口开始" value={linkWindow.start} onChange={e => setLinkWindow({ ...linkWindow, start: e.target.value })} /></label><label>关联窗口结束<input aria-label="关联窗口结束" value={linkWindow.end} onChange={e => setLinkWindow({ ...linkWindow, end: e.target.value })} /></label><button disabled={busy} onClick={() => void act(loadExternalEvents)}>查询可关联外部日程</button></section>
      <form aria-label="显式事项关联" onSubmit={e => { e.preventDefault(); const todo = todos.find(t => t.id === todoId), event = [...events, ...externalEvents].find(v => `${v.sourceId}|${v.id}` === eventId); if (todo && event) setLinkConfirm({ todo, event }) }}><fieldset disabled={busy}><legend>显式关联（本地或已授权外部日程；不级联删除）</legend><label>待办<select required aria-label="关联待办" value={todoId} onChange={e => { setTodoId(e.target.value); setLinkConfirm(null) }}><option value="">请选择待办</option>{todos.filter(i => !i.deletedAt).map(i => <option key={i.id} value={i.id}>{i.title}</option>)}</select></label><label>日程<select required aria-label="关联日程" value={eventId} onChange={e => { setEventId(e.target.value); setLinkConfirm(null) }}><option value="">请选择日程</option>{[...events, ...externalEvents].filter(i => !i.deletedAt).map(i => <option key={`${i.sourceId}|${i.id}`} value={`${i.sourceId}|${i.id}`}>{i.title} · {i.sourceId === 'local' ? '本地' : '外部'} · v{i.version}</option>)}</select></label><button type="submit">核对关联对象</button></fieldset></form>
      {linkConfirm && <section aria-label="精确关联确认" style={{ overflowWrap: 'anywhere' }}><p>待办：{linkConfirm.todo.title} · source {linkConfirm.todo.sourceId} · ID {linkConfirm.todo.id} · v{linkConfirm.todo.version}</p><p>日程：{linkConfirm.event.title} · source {linkConfirm.event.sourceId} · 实例ID {linkConfirm.event.id} · v{linkConfirm.event.version}</p><p>仅保存关系，不修改外部日程；删除待办不会删除日程。权限或版本变化时拒绝保存。</p><button disabled={busy} onClick={() => void act(() => command({ sourceId: 'local', type: 'ItemLink', action: 'create', data: { todoRef: { type: 'Todo', sourceId: linkConfirm.todo.sourceId, id: linkConfirm.todo.id }, eventRef: { type: 'Event', sourceId: linkConfirm.event.sourceId, id: linkConfirm.event.id }, expectedTodoVersion: linkConfirm.todo.version, expectedEventVersion: linkConfirm.event.version, relation: 'related' } }))}>明确提交关联</button><button disabled={busy} onClick={() => setLinkConfirm(null)}>取消关联</button></section>}
      <ul aria-label="持久事项关联">{links.map(link => <li key={link.id} style={{ overflowWrap: 'anywhere' }}>{link.todoRef?.sourceId ?? 'local'} / {link.todoId}（{link.todoState}）↔ {link.eventRef?.sourceId ?? 'local'} / {link.eventId}（{link.eventState}） · related</li>)}</ul></>}
  </section>
}
