import { useEffect, useRef, useState } from 'react'
import { ruleLabel, runLabel } from './routines.mjs'
type Workflow = { kind: string; botId: string; sourceIds: string[]; prompt: string; promptVersion: string; callLimits: { modelCalls: number; toolCalls: number; totalTokens: number }; notification: string; writes?: boolean }
type Schedule = { actionSpec?: Workflow; redacted?: boolean; id: string; title: string; revision: number; enabled: boolean; status: string; nextDueAt: string; timezone: string; rule: { type: string; at?: string; seconds?: number; anchor?: string; time?: string } }
type Occurrence = { id: string; scheduledFor: string; state: string; attempts: number; operationId?: string; taskId?: number; deliveryId?: string; reason?: string; startedAt?: string; finishedAt?: string; error?: { code: string }; result?: { notificationDelivered: boolean; usage?: { modelCalls: number; toolCalls: number; totalTokens: number; unknownTokenCalls: number } } }
type Form = { id?: string; revision?: number; title: string; type: string; value: string; timezone: string }
const initial = (): Form => ({ title: '', type: 'at', value: '', timezone: 'Asia/Shanghai' })
export default function ScheduleWorkspace({ token, view = 'schedules' }: { token: string; view?: 'schedules' | 'runs' }) {
  const [items, setItems] = useState<Schedule[]>([]), [rows, setRows] = useState<Occurrence[]>([]), [selected, setSelected] = useState(''), [cursor, setCursor] = useState<number | undefined>(), [form, setForm] = useState<Form>(initial), [confirmation, setConfirmation] = useState<{ command: string; item: Schedule } | null>(null)
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [receipt, setReceipt] = useState<{ id: string; state: string } | null>(null)
  const [workflow, setWorkflow] = useState(false), [botId, setBotId] = useState('calendar'), [sources, setSources] = useState('local'), [prompt, setPrompt] = useState(''), [promptVersion, setPromptVersion] = useState('v1'), [limits, setLimits] = useState({ modelCalls: 4, toolCalls: 4, totalTokens: 12000 }), [notification, setNotification] = useState('inbox')
  const [hasPending, setHasPending] = useState(false)
  const selectedRef = useRef('')
  const pending = useRef<{ requestId: string; key: string; input: object } | null>(null), running = useRef(false)
  async function api<T>(path: string, input: object): Promise<T> {
    const r = await fetch(`/api/workspace/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).catch(() => { throw Error('连接中断，结果未确认。查询原请求回执，不要另建重复计划。') })
    const body = await r.json(); if (!r.ok) throw Object.assign(Error(`${body.error?.code}: ${body.error?.message}`), { status: r.status }); return body.data
  }
  async function act(fn: () => Promise<void>) {
    if (running.current) return; running.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : '计划操作失败。') } finally { running.current = false; setBusy(false) }
  }
  async function refresh() { setItems([]); setRows([]); setSelected(''); selectedRef.current = ''; const result = await api<{ items: Schedule[]; notice: string }>('schedule-list', {}); setItems(result.items); setNotice(result.notice) }
  async function history(id: string, next?: number) { selectedRef.current = id; setSelected(id); const r = await api<{ items: Occurrence[]; next?: number }>('schedule-list', { scheduleId: id, ...(next !== undefined ? { cursor: next } : {}) }); if (selectedRef.current !== id) return; setRows(old => next === undefined ? r.items : [...old, ...r.items]); setCursor(r.next) }
  async function send(input: object) {
    const key = JSON.stringify(input)
    if (pending.current && pending.current.key !== key) throw Error('存在结果未确认的原请求，请先查询原回执，不能换参数重建。')
    pending.current ??= { key, input, requestId: crypto.randomUUID() }
    setHasPending(true)
    try { setReceipt(await api('schedule-manage', { ...input, requestId: pending.current.requestId })) } catch (e) { if (e instanceof Error && 'status' in e && Number(e.status) < 500) { pending.current = null; setHasPending(false) } throw e } pending.current = null; setHasPending(false); setConfirmed(false); setConfirmation(null); setForm(initial()); await refresh()
  }
  useEffect(() => {
    const c = new AbortController(); let timer: ReturnType<typeof setTimeout>
    async function load() { try { const r = await fetch('/api/workspace/schedule-list', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', signal: c.signal }); const b = await r.json(); if (!c.signal.aborted) { if (!r.ok) { setItems([]); setRows([]); setError(b.error?.message ?? '读取失败') } else { setItems(b.data.items); if (selectedRef.current) { const historyId = selectedRef.current; const hr = await fetch('/api/workspace/schedule-list', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduleId: selectedRef.current }), signal: c.signal }); const hb = await hr.json(); if (!c.signal.aborted && selectedRef.current === historyId) setRows(hr.ok ? hb.data.items : []) } } } } catch { if (!c.signal.aborted) { setItems([]); setRows([]) } } finally { if (!c.signal.aborted) timer = setTimeout(load, 3000) } }
    void load(); return () => { c.abort(); clearTimeout(timer) }
  }, [token])
  const rule = () => form.type === 'daily' ? { type: 'daily', time: form.value } : form.type === 'interval' ? { type: 'interval', seconds: Number(form.value), anchor: new Date(Date.now() + 60000).toISOString() } : { type: 'at', at: form.value }
  return <section className="schedule-workspace"><h2>{view === 'runs' ? '执行记录与原Task' : '持久定时计划与只读Agent简报'}</h2>
    <p className="shell-note">每个 Bot 的例行任务（含事件触发、测试运行、按规则改动）在该 Bot 的资料页「例行任务」区管理；这里是全部计划的总览。</p>
    <p>后端运行时闭页仍执行；停机不执行。内部记录不调用模型；只读Agent简报复用原Task/预算与持久收件箱，不提供写入或委派。外部只读同步在飞书来源面板独立配置。</p>
    <button disabled={busy} onClick={() => void act(refresh)}>加载计划</button>
    <div hidden={view === 'runs'}><label>动作<select aria-label="计划动作" value={workflow ? 'agent' : 'internal'} onChange={e => { setWorkflow(e.target.value === 'agent'); setConfirmed(false) }}><option value="internal">内部确定性验收记录</option><option value="agent">只读Agent简报</option></select></label>
    <form onSubmit={e => { e.preventDefault(); void act(() => send({ command: form.id ? 'update' : 'create', ...(form.id ? { id: form.id, expectedRevision: form.revision } : {}), title: form.title, timezone: form.timezone, rule: rule(), actionSpec: workflow ? { kind: 'agent_readonly_workflow', botId, sourceIds: sources.split(',').map(s => s.trim()), prompt, promptVersion, callLimits: limits, notification } : { kind: 'internal_deterministic_record' }, confirmed })) }}>
      <label>计划名称<input aria-label="计划名称" required value={form.title} onChange={e => { setForm({ ...form, title: e.target.value }); setConfirmed(false) }} /></label>
      <label>频率<select aria-label="频率" value={form.type} onChange={e => { setForm({ ...form, type: e.target.value, value: '' }); setConfirmed(false) }}><option value="at">一次性</option><option value="daily">每日</option><option value="interval">固定间隔（≥60秒）</option></select></label>
      <label>触发值<input required aria-label="触发值" placeholder={form.type === 'daily' ? 'HH:mm' : form.type === 'interval' ? '整数秒，至少60' : '带偏移ISO，如2026-10-20T09:00:00+08:00'} value={form.value} onChange={e => { setForm({ ...form, value: e.target.value }); setConfirmed(false) }} /></label>
      <label>IANA时区<input aria-label="IANA时区" required value={form.timezone} onChange={e => { setForm({ ...form, timezone: e.target.value }); setConfirmed(false) }} /></label>
      {workflow && <fieldset onChange={() => setConfirmed(false)}><legend>固定只读执行范围</legend>
        <label>执行Bot ID<input aria-label="执行Bot ID" required value={botId} onChange={e => setBotId(e.target.value)} /></label>
        <label>来源ID（逗号分隔）<input aria-label="工作流来源" required value={sources} onChange={e => setSources(e.target.value)} /></label>
        <label>提示版本<input aria-label="提示版本" required value={promptVersion} onChange={e => setPromptVersion(e.target.value)} /></label>
        <label>只读简报提示<textarea aria-label="只读简报提示" required maxLength={3000} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
        {(['modelCalls', 'toolCalls', 'totalTokens'] as const).map(key => <label key={key}>{key}上限<input aria-label={key + '上限'} type="number" min="0" required value={limits[key]} onChange={e => setLimits({ ...limits, [key]: Number(e.target.value) })} /></label>)}
        <label>结果通知<select aria-label="结果通知" value={notification} onChange={e => setNotification(e.target.value)}><option value="inbox">持久应用收件箱</option><option value="none">仅执行记录</option></select></label>
        <p>固定Bot {botId}；来源 {sources}；提示 {promptVersion}；额度 {JSON.stringify(limits)}；通知 {notification}。仅MCP list/get，无写入、委派或自批准。失败/未知/额度耗尽只处理原Task，不新建重试。</p>
      </fieldset>}
      <p>频率：{form.type} / {form.value || '待填写'} / {form.timezone}；interval从提交后约60秒开始。一次性宽限15分钟；每日/间隔仅补最近一次；DST缺失跳过、重复第一次；同计划不重叠；内部记录最多3次、30秒/120秒退避；Agent无自动新Task重试，额度以上述固定配置为准。</p>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />明确确认上述频率与运行条件；{workflow ? '固定只读Agent范围/提示/额度/通知；失败不自动新建Task' : '只生成内部验收记录，不是提醒'}</label>
      <button disabled={busy || !confirmed}>{form.id ? '保存计划修改' : workflow ? '创建只读工作流' : '创建内部计划'}</button><button type="button" disabled={busy} onClick={() => { setForm(initial()); setConfirmed(false) }}>取消编辑</button>
    </form></div>
    {notice && <p>{notice}</p>}{error && <p role="alert">{error}</p>}{receipt && <p role="status">持久管理回执：{receipt.id} · {receipt.state}（非通知送达）</p>}
    <button disabled={busy || !hasPending} onClick={() => void act(async () => { const r = await api<{ id: string; state: string }>('operation', { requestId: pending.current!.requestId, sourceId: 'local' }); if (!r) throw Error('原请求尚无持久回执；保留原请求，不自动重派。'); setReceipt(r); pending.current = null; setHasPending(false); await refresh() })}>查询原计划请求回执</button>
    {items.length === 0 && <p className="workspace-empty">暂无计划。尚无记录不代表已执行；加载失败请查看错误提示。</p>}
    <ul>{items.map(s => <li key={s.id}><strong>{s.title}</strong> · {s.status} · revision {s.revision}{s.actionSpec?.kind === 'agent_readonly_workflow' && <p>Bot {s.actionSpec.botId} · 来源 {s.actionSpec.sourceIds.join(', ')} · 提示 {s.actionSpec.promptVersion} · 额度 {JSON.stringify(s.actionSpec.callLimits)} · 通知 {s.actionSpec.notification}</p>}<p>{ruleLabel(s.rule)} · {s.timezone}{s.nextDueAt ? ` · 下次 ${s.nextDueAt}` : ''}{s.actionSpec?.writes ? ' · 可按规则改动' : ''}</p>
      <button disabled={busy || s.redacted} onClick={() => void act(() => history(s.id))}>查看执行记录</button>
      <button disabled={busy || s.redacted || s.status === 'cancelled'} onClick={() => { setWorkflow(s.actionSpec?.kind === 'agent_readonly_workflow'); if (s.actionSpec?.kind === 'agent_readonly_workflow') { setBotId(s.actionSpec.botId); setSources(s.actionSpec.sourceIds.join(',')); setPrompt(s.actionSpec.prompt); setPromptVersion(s.actionSpec.promptVersion); setLimits(s.actionSpec.callLimits); setNotification(s.actionSpec.notification) }; setForm({ id: s.id, revision: s.revision, title: s.title, type: s.rule.type, value: String(s.rule.time ?? s.rule.seconds ?? s.rule.at), timezone: s.timezone }); setConfirmed(false) }}>修改计划</button>
      <button disabled={busy || s.status === 'cancelled' || s.status === 'completed'} onClick={() => { setConfirmation({ command: s.enabled ? 'pause' : 'resume', item: s }); setConfirmed(false) }}>{s.enabled ? '暂停计划' : '恢复计划'}</button>
      <button disabled={busy || s.status === 'cancelled'} onClick={() => { setConfirmation({ command: 'cancel', item: s }); setConfirmed(false) }}>取消计划</button>
    </li>)}</ul>
    {confirmation && <section aria-label="确认计划状态变更"><p>{confirmation.command}：{confirmation.item.title}，{confirmation.item.rule.type}，{confirmation.item.rule.time ?? confirmation.item.rule.seconds ?? confirmation.item.rule.at}，{confirmation.item.timezone}。恢复从下一时点，不补暂停期间；一次性15分钟宽限；每日/间隔仅最近一次，同计划不重叠；{confirmation.item.actionSpec?.kind === 'agent_readonly_workflow' ? `Bot ${confirmation.item.actionSpec.botId}；来源 ${confirmation.item.actionSpec.sourceIds.join(',')}；提示 ${confirmation.item.actionSpec.promptVersion}；额度 ${JSON.stringify(confirmation.item.actionSpec.callLimits)}；通知 ${confirmation.item.actionSpec.notification}；Agent不自动重建重试` : '内部记录最多3次30/120秒退避，模型/工具0'}；取消仅阻止未来触发，不取消原Task或撤回结果；当前执行需进入原Task单独取消。</p><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认计划状态变更与运行条件</label><button disabled={busy || !confirmed} onClick={() => void act(() => send({ command: confirmation.command, id: confirmation.item.id, expectedRevision: confirmation.item.revision, confirmed }))}>确认状态变更</button><button onClick={() => { setConfirmation(null); setConfirmed(false) }}>返回不变更</button></section>}
    {selected && <section aria-label="执行记录"><h4>执行记录（{selected}）</h4>{rows.length === 0 && <p>尚无记录，不代表已执行。</p>}<ul>{rows.map(o => <li key={o.id}>{o.scheduledFor} · {runLabel(o)} · attempts {o.attempts}<p>{o.startedAt} → {o.finishedAt} · {o.reason ?? o.error?.code} · operation {o.operationId ?? '—'} · task {o.taskId ?? '—'} · delivery {o.deliveryId ?? '—'}</p>{o.taskId && <p><a href={`#task=${o.taskId}`}>查看/处理原Task #{o.taskId}</a>（取消当前Task不取消未来计划；取消计划不撤销当前Task）</p>}{o.result?.usage && <p>累计用量 {JSON.stringify(o.result.usage)}</p>}</li>)}</ul>{cursor !== undefined && <button disabled={busy} onClick={() => void act(() => history(selected, cursor))}>更多执行记录</button>}</section>}
  </section>
}
