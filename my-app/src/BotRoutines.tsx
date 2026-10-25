import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ROUTINE_WHEN, routineInput, ruleLabel, runLabel, statusLabel, type RoutineRule } from './routines.mjs'

// PLAN §8.5: the Bot page's 例行任务 section (the 自动化 page stays as the overview). Uses the
// existing schedule endpoints; a request whose outcome is unknown is retried with the same requestId.
type Routine = { id: string; title: string; status: string; enabled: boolean; revision: number; rule: RoutineRule; nextDueAt: string | null; redacted?: boolean; testOccurrenceId?: string | null; actionSpec?: { botId: string; prompt: string; writes?: boolean; notification: string } }
type Run = { id: string; scheduledFor: string; state: string; reason?: string; test?: boolean; taskId?: number }

async function call<T>(token: string, path: string, input: object): Promise<T> {
  let response: Response
  try { response = await fetch(`/api/workspace/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }
  catch { throw Object.assign(new Error('连接中断，结果未确认。请刷新核对，不要换内容重复提交。'), { unknown: true }) }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? '操作没有成功。'), { unknown: response.status >= 500 || !body })
  return body.data
}
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export default function BotRoutines({ token, botId, readOnly, onOpenTask }: { token: string; botId: string; readOnly: boolean; onOpenTask: (taskId: number) => void }) {
  const [items, setItems] = useState<Routine[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(''), [runs, setRuns] = useState<Run[]>([])
  const [form, setForm] = useState({ title: '', prompt: '', when: 'daily', value: '08:00', notification: 'inbox', writes: true })
  // The confirmation covers exactly what is on screen; any edit asks again.
  const [confirmedFor, setConfirmedFor] = useState(''), formKey = JSON.stringify(form), confirmed = confirmedFor === formKey
  const pending = useRef<{ key: string; requestId: string } | null>(null)
  const load = useCallback(async () => {
    try { const data = await call<{ items: Routine[] }>(token, 'schedule-list', {}); setItems(data.items.filter(s => s.actionSpec?.botId === botId)); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : '读取失败。') }
  }, [token, botId])
  const loadRuns = useCallback(async (id: string) => {
    try { setRuns((await call<{ items: Run[] }>(token, 'schedule-list', { scheduleId: id })).items.slice(-5).reverse()) } catch (e) { setError(e instanceof Error ? e.message : '读取失败。') }
  }, [token])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load(); if (open) void loadRuns(open) }, 8000)
    return () => window.clearInterval(timer)
  }, [load, loadRuns, open])
  // Idempotent: the same input keeps its requestId until the server answers definitively.
  async function send(path: string, input: object) {
    const key = JSON.stringify([path, input])
    if (!pending.current || pending.current.key !== key) pending.current = { key, requestId: crypto.randomUUID() }
    try { const data = await call<{ receipt?: { taskId?: number } }>(token, path, { ...input, requestId: pending.current.requestId }); pending.current = null; return data }
    catch (e) { if (!(e as { unknown?: boolean }).unknown) pending.current = null; throw e }
  }
  async function act(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await fn(); await load() } catch (e) { setError(e instanceof Error ? e.message : '操作没有成功。') } finally { setBusy(false) }
  }
  function create(event: FormEvent) {
    event.preventDefault()
    const built = routineInput({ ...form, botId, requestId: 'pending' })
    if (built.error !== undefined) { setError(built.error); return }
    void act(async () => { await send('schedule-manage', built.input); setForm(f => ({ ...f, title: '', prompt: '' })) })
  }
  const test = (r: Routine) => act(async () => { const data = await send('schedule-test', { id: r.id }); setOpen(r.id); await loadRuns(r.id); if (data.receipt?.taskId) onOpenTask(data.receipt.taskId) })
  const change = (r: Routine, command: 'pause' | 'resume' | 'cancel') => act(async () => { await send('schedule-manage', { command, id: r.id, expectedRevision: r.revision, ...(command === 'resume' ? { confirmed: true } : {}) }) })

  return <section className="today-card bot-routines" aria-labelledby={`bot-routines-${botId}`}>
    <h2 id={`bot-routines-${botId}`}>例行任务</h2>
    <p className="shell-muted small">按时间或在某事发生时自动运行，每次运行是一个任务。按 Bot 当前工具、资源和规则执行；需要询问时跳过该步骤，并在结果中写明需要你来做。全局暂停时都不运行，恢复后不补跑。也可以在对话里让 Bot 提议。</p>
    {error && <p role="alert" className="shell-note">{error}</p>}
    {items === null ? <p className="shell-muted">正在读取…</p> : items.length === 0 ? <p className="shell-muted">还没有例行任务。</p>
      : <ul className="routine-list">{items.map(r => <li key={r.id} className="routine-row">
        <div className="routine-head">
          <strong>{r.redacted ? '权限已失效的例行任务' : r.title}</strong>
          <span className="shell-muted small">{ruleLabel(r.rule)} · {statusLabel(r.status)}{r.actionSpec ? ` · ${r.actionSpec.writes ? '可按规则改动' : '只读'}` : ''}{r.enabled && r.nextDueAt ? ` · 下次 ${when(r.nextDueAt)}` : ''}</span>
        </div>
        {r.actionSpec?.prompt && <p className="routine-prompt">{r.actionSpec.prompt}</p>}
        <div className="action-row">
          <button type="button" disabled={busy || readOnly || r.redacted || r.status === 'cancelled'} title="立即运行一次：只读，结果不投递" onClick={() => void test(r)}>测试运行</button>
          {['active', 'paused'].includes(r.status) && <button type="button" disabled={busy || readOnly || r.redacted} onClick={() => void change(r, r.enabled ? 'pause' : 'resume')}>{r.enabled ? '暂停' : '恢复'}</button>}
          {r.status !== 'cancelled' && <button type="button" disabled={busy || readOnly} onClick={() => { if (window.confirm(`取消例行任务「${r.title}」？之后不再运行，已发生的改动不会撤回。`)) void change(r, 'cancel') }}>取消</button>}
          <button type="button" className="text-button" aria-expanded={open === r.id} onClick={() => { const next = open === r.id ? '' : r.id; setOpen(next); setRuns([]); if (next) void loadRuns(next) }}>运行记录</button>
        </div>
        {open === r.id && (runs.length === 0 ? <p className="shell-muted small">还没有运行过。</p>
          : <ul className="today-list">{runs.map(o => <li key={o.id}><span className="today-time">{when(o.scheduledFor)}</span><span>{runLabel(o)}</span>{o.taskId && <button type="button" className="text-button" onClick={() => onOpenTask(o.taskId!)}>打开</button>}</li>)}</ul>)}
      </li>)}</ul>}
    {!readOnly && <details className="routine-create"><summary>新建例行任务</summary>
      <form className="bot-form" onSubmit={create}>
        <label htmlFor={`routine-title-${botId}`}>名称</label>
        <input id={`routine-title-${botId}`} required maxLength={200} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="例如：每日待办整理" />
        <label htmlFor={`routine-prompt-${botId}`}>每次要做什么</label>
        <textarea id={`routine-prompt-${botId}`} required rows={3} maxLength={3000} value={form.prompt} onChange={e => setForm({ ...form, prompt: e.target.value })} placeholder="例如：看看今天到期的待办，按轻重排一下，冲突的提醒我" />
        <label htmlFor={`routine-when-${botId}`}>什么时候</label>
        <select id={`routine-when-${botId}`} value={form.when} onChange={e => setForm({ ...form, when: e.target.value, value: e.target.value === 'daily' ? '08:00' : e.target.value === 'interval' ? '60' : '' })}>
          {ROUTINE_WHEN.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        {form.when === 'daily' && <input aria-label="每天几点" type="time" required value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} />}
        {form.when === 'interval' && <input aria-label="间隔分钟" type="number" min={1} step={1} required value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} />}
        {form.when === 'at' && <input aria-label="运行时间" type="datetime-local" required value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} />}
        <label htmlFor={`routine-notify-${botId}`}>结果</label>
        <select id={`routine-notify-${botId}`} value={form.notification} onChange={e => setForm({ ...form, notification: e.target.value })}><option value="inbox">放进收件箱</option><option value="none">只留运行记录</option></select>
        <label className="routine-check"><input type="checkbox" checked={form.writes} onChange={e => setForm({ ...form, writes: e.target.checked })} />允许按规则改动本地事项（不勾就只读）</label>
        <label className="routine-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmedFor(e.target.checked ? formKey : '')} />我确认：{ruleLabel(routineInput({ ...form, botId, requestId: 'x' }).input?.rule as RoutineRule)}运行，读本地日程和待办{form.writes ? '，低风险改动直接执行并可撤销' : '，只读'}</label>
        <div className="bot-actions"><button className="primary" disabled={busy || !confirmed}>{busy ? '正在保存…' : '创建例行任务'}</button></div>
      </form>
    </details>}
  </section>
}
