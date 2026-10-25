import WorkspaceIdentity from './WorkspaceIdentity'
import { createWorkspaceRequestGuard } from './workspace-request-guard.mjs'
import ExternalSync from './ExternalSync'
import { useCallback, useEffect, useRef, useState } from 'react'

type Source = { id: string; calendarId: string; epoch: number; authorized: boolean; readScope: string }
type Event = { id: string; remoteId: string; title: string; start: string | object; end: string | object; timezone: string; version: number; remoteVersion: string; readOnly: boolean; description?: string }
type Operation = { requestId: string; payloadHash: string; state: string; normalizedArgs: object; external: { before: object | null; expiresAt: string; notice: string }; receipt?: object; error?: { message: string } }
const initial = { title: '', description: '', start: '', end: '', timezone: 'Asia/Shanghai', freeBusy: 'busy' }
export default function ExternalWorkspace({ token }: { token: string }) {
  const [source, setSource] = useState<Source | null>(null), [events, setEvents] = useState<Event[]>([]), [op, setOp] = useState<Operation | null>(null)
  const [form, setForm] = useState(initial), [target, setTarget] = useState<Event | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [requestId, setRequestId] = useState(''), [message, setMessage] = useState('')
  const [window, setWindow] = useState(() => ({ start: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), end: new Date(Date.now() + 7 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z') }))
  const sourceIdentity = useRef(''), refreshSequence = useRef(0), queries = useRef(createWorkspaceRequestGuard())
  const api = useCallback(async (path: string, body: object = {}) => {
    const identity = queries.current.capture()
    const r = await fetch(`/api/workspace/external-${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    const j = await r.json(); if (path !== 'sources' && !queries.current.sameIdentity(identity)) throw Error('请求期间来源或权限已变化，已隐藏迟到结果；请按原请求标识查询持久回执，不重发。'); if (!r.ok) throw Error(`${j.error?.code ?? r.status}: ${j.error?.message ?? '请求失败'}`); return j.data
  }, [token])
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    const s = (await api('sources')).sources[0] ?? null, identity = `${s?.id}:${s?.epoch}:${s?.authorized}:${s?.readScope}`
    if (sequence !== refreshSequence.current) return null
    queries.current.identity(identity)
    if (sourceIdentity.current !== identity) { setEvents([]); setOp(null); setTarget(null); setForm(initial); setMessage(''); sourceIdentity.current = identity }
    setSource(s)
    if (!s?.authorized || s.readScope !== 'full') { setEvents([]); setOp(null); setTarget(null); setForm(initial); setMessage('') }
    return s as Source | null
  }, [api])
  useEffect(() => {
    let active = true
    const queryGuard = queries.current, sequence = refreshSequence
    const check = async () => { try { if (active) await refresh() } catch { if (active) { queries.current.invalidate(); setSource(null); setEvents([]); setOp(null); setTarget(null); setForm(initial); setMessage('') } } }
    void check(); const timer = setInterval(check, 3000); return () => { active = false; sequence.current++; queryGuard.invalidate(); clearInterval(timer) }
  }, [refresh])
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn() } catch (e) { setError(String(e)); setEvents([]); setTarget(null) } finally { setBusy(false) } }
  async function query() {
    const s = await refresh(); if (!s?.authorized) return
    const ticket = queries.current.begin()
    const r = await api('query', { sourceId: s.id, ...window, timezone: form.timezone }); if (!queries.current.current(ticket)) return; setEvents(r.items)
    setMessage(`来源feishu · 完整性${r.complete ? '完整' : '不完整'} · ${r.stale ? 'stale（离线只读/未完整刷新）' : 'fresh'} · 缓存时间${r.observedAt} · ${r.notice}`)
  }
  async function prepare(action: string) {
    if (!source) return
    const id = crypto.randomUUID(); setRequestId(id)
    const args = action === 'delete' ? {} : form
    const result = await api('prepare', { sourceId: source.id, requestId: id, action, arguments: { ...args, ...(target ? { eventId: target.remoteId, beforeHash: target.remoteVersion } : {}) }, ...(target ? { expectedVersion: target.version } : {}) })
    setOp(result)
  }
  return <section className="panel" aria-label="飞书统一工作区" style={{ gridColumn: '1 / -1', minWidth: 0, overflowWrap: 'anywhere', padding: 12 }}>
    <h2>飞书统一工作区（无模型）</h2>
    <p>这里管理用户的飞书来源许可与手动操作；Bot 按当前工具、资源和规则执行。手动改动先预览再批准；结果未知时先查询原请求。</p>
    {busy && <p role="status">正在处理来源请求；写入是否成功以持久回执为准。</p>}{error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void run(async () => { await refresh() })}>刷新飞书来源</button>
    {source ? <><WorkspaceIdentity sourceId={source.id} authority="external" scope={source.authorized ? source.readScope : 'none'} epoch={source.epoch} /><p>飞书应用日历账号/容器：{source.calendarId}（服务端绑定；不展示凭证）</p>
      <button disabled={busy} onClick={() => void run(async () => { if (!globalThis.confirm('确认授予当前用户此来源正文和普通CRUD权限？不会授予Bot权限。')) return; await api('grant', { sourceId: source.id, expectedEpoch: source.epoch, enabled: true, readScope: 'full', confirmed: true }); await refresh() })}>明确授权飞书来源</button>
      <button disabled={busy || !source.authorized} onClick={() => void run(async () => { if (!globalThis.confirm('撤销当前用户此飞书来源权限？历史审计保留。')) return; await api('grant', { sourceId: source.id, expectedEpoch: source.epoch, enabled: false, readScope: 'full', confirmed: true }); setEvents([]); setOp(null); setTarget(null); setForm(initial); setMessage(''); await refresh() })}>撤销飞书来源</button>
      {source.authorized && <>
        <ExternalSync token={token} sourceId={source.id} epoch={source.epoch} readScope={source.readScope} />
        <div>{(['start', 'end'] as const).map(k => <label key={k}>查询{k}<input value={window[k]} onChange={e => setWindow({ ...window, [k]: e.target.value })} style={{ maxWidth: '100%' }} /></label>)}<button disabled={busy} onClick={() => void run(query)}>查询飞书日程</button></div>
        <p role="status">{message}</p>{message && events.length === 0 && <p className="workspace-empty">当前查询窗口没有可见日程；不代表其他窗口或未授权来源为空。</p>}
        <ul>{events.map((e, i) => <li key={e.id ?? i}>{e.title ?? '忙碌'} · {typeof e.start === 'string' ? e.start : JSON.stringify(e.start)} {source.readScope === 'full' && <button disabled={busy} onClick={() => void run(async () => { const ticket = queries.current.begin(); const d = (await api('get', { sourceId: source.id, eventId: e.remoteId })).items[0]; if (!queries.current.current(ticket)) return; setTarget(d); setForm({ ...initial, title: d.title, description: d.description ?? '' }); setOp(null); setMessage('已读取精确ID与版本。编辑时请明确输入带偏移起止；不支持全天/重复/邀请/会议室。') })}>读取精确事件 {e.remoteId}</button>}</li>)}</ul>
        {source.readScope === 'full' && <><p>当前目标：{target ? `${target.remoteId} · v${target.version}${target.readOnly ? ' · 只读类型' : ''}` : '新建日程'}</p>
          <button disabled={busy} onClick={() => { setTarget(null); setForm(initial); setOp(null) }}>选择新建日程</button>
          {(['title', 'description', 'start', 'end', 'timezone', 'freeBusy'] as const).map(k => <label key={k} style={{ display: 'block' }}>{k}<input aria-label={`飞书${k}`} value={form[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} style={{ maxWidth: '100%' }} /></label>)}
          <button disabled={busy || !!target?.readOnly} onClick={() => void run(() => prepare(target ? 'update' : 'create'))}>准备飞书{target ? '更新' : '创建'}预览</button>
          <button disabled={busy || !target || target.readOnly} onClick={() => void run(() => prepare('delete'))}>准备飞书删除预览</button>
          {op && <div><h3>精确确认 · {op.state}</h3><p className="workspace-risk">{op.state === 'succeeded' ? '已取得持久操作回执；以回执内容与精确回读为准。' : ['unknown', 'outcome-unknown', 'dispatching'].includes(op.state) ? '结果未知或派发中：禁止重新发送。只查询原请求，不将缓存当写入成功。' : op.state === 'awaiting_confirmation' ? '候选预览，尚未发送外部写入。批准仅对当前精确参数生效。' : '冲突或失败请先查询原回执、核对版本；不要自动覆盖或盲重试。'}</p><p>请求 {op.requestId} · 有效至 {op.external.expiresAt}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ before: op.external.before, after: op.normalizedArgs, receipt: op.receipt, error: op.error }, null, 2)}</pre><p>{op.external.notice}</p>
            <button disabled={busy || op.state !== 'awaiting_confirmation'} onClick={() => void run(async () => { if (!globalThis.confirm('批准此精确来源、目标与参数并发送外部写入？')) return; setOp(await api('confirm', { requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true })); setOp(await api('execute', { requestId: op.requestId })) })}>批准精确预览并执行</button>
            <button disabled={busy || !['awaiting_confirmation', 'ready'].includes(op.state)} onClick={() => void run(async () => setOp(await api('cancel', { requestId: op.requestId })))}>取消未派发操作</button>
            {op.state === 'ready' && <button disabled={busy} onClick={() => void run(async () => setOp(await api('execute', { requestId: op.requestId })))}>执行已批准原请求</button>}
          </div>}
          <label>原请求标识<input value={requestId} onChange={e => setRequestId(e.target.value)} style={{ maxWidth: '100%' }} /></label><button disabled={busy || !requestId} onClick={() => void run(async () => setOp(await api('operation', { requestId })))}>查询原操作回执（不重发）</button>
        </>}
      </>}
    </> : <p>当前无绑定来源；不会自动连接、授权或创建容器。</p>}
  </section>
}
