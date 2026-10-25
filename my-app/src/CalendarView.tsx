import { useEffect, useRef, useState } from 'react'
type Moment = { timestamp?: string; date?: string; timezone: string }
type CalendarEvent = { instanceId: string; eventId: string; title: string; description: string; start: Moment; end: Moment; allDay: boolean; recurrence: string | null; recurringEventId?: string | null; isException?: boolean; organizerCalendarId?: string; status: string; isFree: boolean; vchatType?: string }
type View = { viewId: string; expiresAt: string; source: { calendarId: string }; events: CalendarEvent[]; complete: boolean; eventHashes: Record<string, string> }
type Task = { taskId: number; bot: { id: string; name: string }; kind?: string; calendarAccess: boolean; botLifecycle: string; toolSets: { authorized: string[]; resources: string[] }; approvals: { items: { id: number; status: string; toolName?: string; receipt?: { result?: { error?: { code: string } } } }[] } }
type Form = { operation: 'create' | 'update' | 'delete'; eventId?: string; title: string; description: string; start: string; end: string; freeBusy: string; requestId: string }
const zone = 'Asia/Shanghai'
const local = (seconds: string) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Number(seconds) * 1000)).map(p => [p.type, p.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` }
const day = (s: string, n: number) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''; const d = new Date(`${s}T00:00:00+08:00`); d.setUTCDate(d.getUTCDate() + n); return local(String(d.getTime() / 1000)).slice(0, 10) }
const timed = (v: string) => `${v}:00+08:00`
export default function CalendarView({ token, taskId, resource, calendarId, authorizationVersion }: { token: string; taskId: number | null; resource: string; calendarId: string; authorizationVersion: number }) {
  const [date, setDate] = useState(() => local(String(Date.now() / 1000)).slice(0, 10)), [mode, setMode] = useState<'day' | 'week'>('day'), [view, setView] = useState<View | null>(null), [task, setTask] = useState<Task | null>(null), [form, setForm] = useState<Form | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [detail, setDetail] = useState<CalendarEvent | null>(null)
  const epoch = useRef(0), submitting = useRef(false), drag = useRef<string | null>(null), approvalSignature = useRef<string | null>(null), refreshNeeded = useRef(false)
  async function api(path: string, body?: object) {
    const generation = epoch.current
    const response = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const json = await response.json()
    if (generation !== epoch.current) throw new Error('窗口已切换，迟到响应已丢弃')
    if (!response.ok) throw new Error(json.error?.message ?? '日历连接失败')
    return json.data ?? json.task
  }
  async function load() {
    const generation = ++epoch.current; setBusy(true); setView(null); setForm(null); setDetail(null); setError('')
    try { const next = await api('feishu/view', { taskId, arguments: { resource, start: timed(`${date}T00:00`), end: timed(`${day(date, mode === 'week' ? 7 : 1)}T00:00`), timezone: zone } }); if (generation === epoch.current) { setView(next); refreshNeeded.current = false } }
    catch (e) { if (generation === epoch.current) setError((e as Error).message) }
    finally { if (generation === epoch.current) setBusy(false) }
  }
  useEffect(() => {
    let active = true, pending = false; epoch.current++; approvalSignature.current = null
    queueMicrotask(() => { if (active) { setView(null); setForm(null); setDetail(null); setTask(null); setBusy(false); setError(''); setNotice('') } })
    const check = async () => {
      if (pending) return; pending = true; const generation = epoch.current
      try {
        const next: Task = await api(`tasks/${taskId}`), status = await api('feishu/status')
        if (!active || generation !== epoch.current) return
        if (!next.calendarAccess || !next.toolSets.authorized.includes('calendar_feishu_read_schedule') || !next.toolSets.resources.includes(resource) || next.botLifecycle === 'inactive' || status.binding?.resource !== resource || status.authorizationVersion !== authorizationVersion) throw new Error('权限或连接已变化，已隐藏旧窗口')
        const signature = JSON.stringify(next.approvals.items.map(a => [a.id, a.status]))
        if (approvalSignature.current && signature !== approvalSignature.current) refreshNeeded.current = true
        approvalSignature.current = signature; setTask(next)
      } catch (e) { if (active && generation === epoch.current) { epoch.current++; setView(null); setForm(null); setDetail(null); setTask(null); setBusy(false); setError((e as Error).message) } }
      finally { pending = false }
    }
    if (taskId) void check(); const timer = window.setInterval(() => { if (taskId) void check() }, 3000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { active = false; epoch.current++; clearInterval(timer) }
  }, [token, taskId, resource, authorizationVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setInterval(() => { if (refreshNeeded.current && !submitting.current && !busy && !form) void load() }, 1000); return () => clearInterval(timer) }, [busy, form, date, mode, taskId, resource]) // eslint-disable-line react-hooks/exhaustive-deps
  function changeWindow(nextDate: string, nextMode = mode) { epoch.current++; setDate(nextDate); setMode(nextMode); setView(null); setDetail(null); setForm(null); setBusy(false); setNotice(''); setError('') }
  const writable = (e: CalendarEvent) => !e.allDay && !e.recurrence && !e.recurringEventId && !e.isException && e.status === 'confirmed' && e.organizerCalendarId === calendarId && !!e.start.timestamp && !!e.end.timestamp && (!e.vchatType || e.vchatType === 'no_meeting')
  const can = (op: string) => !!task?.toolSets.authorized.includes(`calendar_feishu_${op}_event`) && task?.kind !== 'group'
  function edit(e?: CalendarEvent, operation: Form['operation'] = 'create', targetDay?: string) {
    if (!view || e && !writable(e)) return
    const start = e?.start.timestamp ? local(e.start.timestamp) : `${targetDay ?? date}T09:00`, end = e?.end.timestamp ? local(e.end.timestamp) : `${targetDay ?? date}T09:30`
    setForm({ operation, eventId: e?.eventId, title: e?.title ?? '', description: e?.description ?? '', start, end, freeBusy: e?.isFree ? 'free' : 'busy', requestId: crypto.randomUUID() }); setNotice('仅为候选，尚未写入飞书')
  }
  async function submit() {
    if (!form || !view || submitting.current) return
    if (form.operation === 'delete' && !window.confirm(`确认提议删除“${form.title}”？仍须原Task网页精确审批。`)) return
    const generation = epoch.current; submitting.current = true; setBusy(true); setError('')
    const args = form.operation === 'delete' ? { resource, eventId: form.eventId, beforeHash: view.eventHashes[form.eventId!] } : { resource, title: form.title.trim(), description: form.description, start: timed(form.start), end: timed(form.end), timezone: zone, freeBusy: form.freeBusy, ...(form.eventId ? { eventId: form.eventId, beforeHash: view.eventHashes[form.eventId] } : {}) }
    try { const r = await api('feishu/command', { taskId, viewId: view.viewId, requestId: form.requestId, operation: form.operation, arguments: args, ...(form.operation === 'delete' ? { confirmDelete: true } : {}) }); if (generation === epoch.current) { setForm(null); setNotice(`提案已持久化至 Task ${r.taskId} / 输入 ${r.messageId}（${r.status}），由模型生成精确审批；此处不表示写入成功。请在原Task审批区处理。`) } }
    catch (e) { if (generation === epoch.current) setError(`${(e as Error).message}；发送结果不明时先查原Task，不自动重发。`) }
    finally { submitting.current = false; if (generation === epoch.current) setBusy(false) }
  }
  const days = Array.from({ length: date ? mode === 'week' ? 7 : 1 : 0 }, (_, i) => day(date, i))
  return <section className="calendar-view" aria-label="Pidot图形日历"><h3>Pidot 日 / 周日历</h3><p>飞书应用日历 · {zone} · Task {taskId ?? '未选择'} · 执行Bot：{task?.bot.name ?? '权限核验中'}</p><p className="muted small">仅此绑定日历；非个人全部日历。全天、重复、例外只读；无邀请/会议室/通知。拖动仅生成候选，不乐观移动。快照非预订锁。</p>
    <div className="feishu-actions"><label>图形日期<input aria-label="图形日历日期" type="date" value={date} onChange={e => changeWindow(e.target.value)} /></label><button onClick={() => changeWindow(day(date, mode === 'week' ? -7 : -1))}>上一窗口</button><button onClick={() => changeWindow(day(date, mode === 'week' ? 7 : 1))}>下一窗口</button><button aria-pressed={mode === 'day'} onClick={() => changeWindow(date, 'day')}>日视图</button><button aria-pressed={mode === 'week'} onClick={() => changeWindow(date, 'week')}>周视图</button><button disabled={!task || busy || !date} onClick={() => void load()}>{busy ? '加载窗口…' : '读取 / 刷新图形日历'}</button><button disabled={!view || busy || !can('create')} onClick={() => edit()}>新增日程候选</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{!view && !busy && <p>请选择窗口并读取；无数据不代表空日历。</p>}
    {view && <><p>{view.complete ? '实例覆盖完整' : '结果不完整，不可推断空闲'} · 窗口结束不含 · 预览有效至 {new Date(view.expiresAt).toLocaleTimeString('zh-CN', { timeZone: zone })}</p><div className={`calendar-days calendar-${mode}`}>{days.map(d => <section className="calendar-day" key={d} aria-label={`${d}日程`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const event = view.events.find(v => v.instanceId === drag.current); drag.current = null; if (!event || !can('update')) return; edit(event, 'update'); setForm(f => f ? { ...f, start: d + f.start.slice(10), end: day(d, Math.round((Date.parse(f.end.slice(0,10)) - Date.parse(f.start.slice(0,10))) / 86400000)) + f.end.slice(10) } : null) }}><h4>{d}</h4>{view.events.filter(e => { const start = e.start.date ? Date.parse(`${e.start.date}T00:00:00+08:00`) : Number(e.start.timestamp) * 1000, end = e.end.date ? Date.parse(`${e.end.date}T00:00:00+08:00`) : Number(e.end.timestamp) * 1000; return start < Date.parse(`${day(d, 1)}T00:00:00+08:00`) && end > Date.parse(`${d}T00:00:00+08:00`) }).map(e => <button className="calendar-event" key={e.instanceId} draggable={writable(e) && can('update') && !busy} onDragStart={() => { drag.current = e.instanceId }} onDragEnd={() => { drag.current = null }} onClick={() => setDetail(e)}><strong>{e.title || '无标题'}</strong><span>{e.allDay ? '全天 · 结束日期不含' : `${local(e.start.timestamp!).slice(11)}—${local(e.end.timestamp!).slice(11)}`}</span><span>{e.status === 'cancelled' ? '已取消' : e.isFree ? '空闲' : '忙碌'}{!writable(e) ? ' · 只读（全天/重复/例外/非支持目标）' : ''}</span></button>)}{view.events.length === 0 && <p>{view.complete ? '此窗口无日程' : '未取得完整日程'}</p>}</section>)}</div></>}
    {detail && view && <article aria-label="图形日程详情"><h4>{detail.title}</h4><p>{detail.start.date ?? local(detail.start.timestamp!)} — {detail.end.date ?? local(detail.end.timestamp!)} · {zone}</p><p className="feishu-description">{detail.description}</p><p>飞书 · {detail.eventId}{!writable(detail) && ' · 只读，不能写全天/重复/例外或非支持目标'}</p><button disabled={!writable(detail) || !can('update') || busy} onClick={() => edit(detail, 'update')}>编辑日程候选</button><button disabled={!writable(detail) || !can('delete') || busy} onClick={() => edit(detail, 'delete')}>删除日程候选</button></article>}
    {form && view && <form aria-label="日历候选表单" onSubmit={e => { e.preventDefault(); void submit() }}><h4>{form.operation === 'create' ? '新增' : form.operation === 'update' ? '编辑' : '删除'}候选 · 尚未批准</h4><fieldset disabled={busy || form.operation === 'delete'}><label>日程标题<input required maxLength={300} aria-label="候选标题" value={form.title} onChange={e => setForm({ ...form, title: e.target.value, requestId: crypto.randomUUID() })} /></label><label>说明<textarea maxLength={2000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value, requestId: crypto.randomUUID() })} /></label><label>开始<input required aria-label="候选开始" type="datetime-local" value={form.start} onChange={e => setForm({ ...form, start: e.target.value, requestId: crypto.randomUUID() })} /></label><label>结束<input required aria-label="候选结束" type="datetime-local" value={form.end} onChange={e => setForm({ ...form, end: e.target.value, requestId: crypto.randomUUID() })} /></label><label>忙闲<select value={form.freeBusy} onChange={e => setForm({ ...form, freeBusy: e.target.value, requestId: crypto.randomUUID() })}><option value="busy">忙碌</option><option value="free">空闲</option></select></label></fieldset><p>{zone} · {form.operation === 'delete' ? `明确删除目标 ${form.eventId}` : `${form.title} · ${form.start} — ${form.end}`}；提交只进入当前Task，不批准或写入。</p><button type="submit" disabled={busy || !can(form.operation)}>提交提案到原Task</button><button type="button" disabled={busy} onClick={() => { setForm(null); setNotice('候选已取消，原日程位置不变') }}>取消候选</button></form>}
    {!!task?.approvals.items.length && <aside aria-label="日历审批状态"><h4>原Task审批 / 恢复状态</h4>{task.approvals.items.map(a => <p key={a.id}>审批 {a.id} · {a.status}{a.receipt?.result?.error?.code && ` · ${a.receipt.result.error.code}（未确认成功，请查原Task）`}{a.status === 'outcome-unknown' && ' · 结果未知，禁止盲重发'}{a.status === 'executed' && ' · 以原Task回执为准，冲突不表示写成功'}</p>)}<a href={`#bot=${task.bot.id}&task=${taskId}`}>回到执行Task与精确审批</a></aside>}
  </section>
}
