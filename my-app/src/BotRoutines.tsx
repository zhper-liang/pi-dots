import { useEffect, useRef, useState, useId, type FormEvent } from 'react'
import { ROUTINE_WHEN, ROUTINE_WEEKDAYS, ROUTINE_EVENTS, routineInput, routineRule, routineBotSelection, routineBotChoices, type RoutineBotChoice, type RoutineBotSelection, ruleLabel, runLabel, statusLabel, type RoutineRule } from './routines.mjs'
import ModelPicker, { type ModelPickerTask } from './ModelPicker'
import EditorDialog from './EditorDialog'
import LocalTimePicker from './LocalTimePicker'
import { getLocalTimezone, localDateTime } from './local-time.mjs'
import './routines.css'

// PLAN §8.5: the Bot page's 例行任务 section (the 自动化 page stays as the overview). Uses the
// existing schedule endpoints; a request whose outcome is unknown is retried with the same requestId.
type Routine = { id: string; title: string; status: string; enabled: boolean; revision: number; timezone: string; rule: RoutineRule; nextDueAt: string | null; redacted?: boolean; testOccurrenceId?: string | null; actionSpec?: { botId: string; prompt: string; writes?: boolean; notification: string; model?: { id: string } } }
type Run = { id: string; scheduledFor: string; state: string; reason?: string; test?: boolean; taskId?: number }

async function call<T>(token: string, path: string, input: object): Promise<T> {
  let response: Response
  try { response = await fetch(`/api/workspace/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }
  catch { throw Object.assign(new Error('连接中断，结果未确认。请刷新核对，不要换内容重复提交。'), { unknown: true }) }
  const body = await response.json().catch(() => null)
  if (response.ok && (!body || !Object.hasOwn(body, 'data'))) throw Object.assign(new Error('响应未确认，请用原请求核对结果。'), { unknown: true })
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? '操作没有成功。'), { unknown: response.status >= 500 || !body })
  return body.data
}
const when = (iso: string | null, timezone = 'Asia/Shanghai') => iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export type BotRoutinesProps = {
  token: string; botId: string; botName?: string; readOnly: boolean; onOpenTask: (taskId: number) => void
  bots?: RoutineBotChoice[]; onChanged?: () => void; refreshKey?: string | number
}
type BotConfiguration = { bot: { id: string; status?: string; configRef: { version: string }; defaults: { model?: { id: string } | null } }; models: { id: string }[]; assigned: { tools: string[]; resources: string[] } }
type Selection = { snapshot: RoutineBotSelection; task: ModelPickerTask }
type PendingRequest = { key: string; requestId: string; path: string; input: object }
const initialForm = () => ({ title: '', prompt: '', when: 'daily', value: '08:00', date: '', weekdays: [1], day: '1', event: 'todo_due', timezone: getLocalTimezone(), model: '', notification: 'inbox', writes: true })

// A real outer Bot/token change discards drafts and late responses. refreshKey only refreshes data.
export default function BotRoutines(props: BotRoutinesProps) {
  return <BotRoutinesPanel key={`${props.token}:${props.botId}`} {...props} />
}
function BotRoutinesPanel({ token, botId, botName, readOnly, onOpenTask, bots, onChanged, refreshKey }: BotRoutinesProps) {
  const formId = useId()
  const [items, setItems] = useState<Routine[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(''), [runs, setRuns] = useState<Run[]>([])
  const [form, setForm] = useState(initialForm), [editorTime, setEditorTime] = useState(0)
  const [editor, setEditor] = useState(false), [editing, setEditing] = useState<Routine | null>(null)
  const [targetBotId, setTargetBotId] = useState(botId), [choices, setChoices] = useState<RoutineBotChoice[]>(bots ?? [])
  const [selection, setSelection] = useState<Selection | null>(null), [selectionError, setSelectionError] = useState(''), [selecting, setSelecting] = useState(false)
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [confirmedFor, setConfirmedFor] = useState('')
  const formKey = JSON.stringify([targetBotId, form, selection?.snapshot.fingerprint]), confirmed = confirmedFor === formKey
  const preview = routineRule({ ...form, now: editorTime })
  const selectableBots = routineBotChoices(choices, bots)
  const busyGuard = useRef(false), selectionController = useRef<AbortController | null>(null)
  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { signal, headers: { Authorization: `Bearer ${token}` } })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error?.message ?? '无法读取 Bot 当前配置。')
    return body
  }
  async function readSelection(id: string, signal?: AbortSignal) {
    const [directory, configuration] = await Promise.all([
      get<{ bots: RoutineBotChoice[]; mainSessions: Record<string, number> }>('/api/bots', signal),
      get<BotConfiguration>(`/api/bots/${encodeURIComponent(id)}/configuration`, signal),
    ])
    const taskId = directory.mainSessions[id]
    if (!Number.isSafeInteger(taskId)) throw new Error('目标 Bot 当前主会话不可用。')
    const body = await get<{ task: ModelPickerTask }>(`/api/tasks/${taskId}`, signal)
    const snapshot = routineBotSelection({ botId: id, directory, configuration, task: body.task })
    if ('error' in snapshot && snapshot.error) throw new Error(snapshot.error)
    if (!('fingerprint' in snapshot)) throw new Error('Bot 配置无法验证。')
    return { snapshot, task: body.task, bots: directory.bots }
  }
  async function chooseBot(id: string, preservedModel = '', resetModel = true) {
    selectionController.current?.abort()
    const controller = new AbortController()
    selectionController.current = controller
    setTargetBotId(id); setSelection(null); setSelectionError(''); setSelecting(true); setConfirmedFor('')
    if (resetModel) setForm(current => ({ ...current, model: preservedModel }))
    try {
      const fresh = await readSelection(id, controller.signal)
      if (controller.signal.aborted) return
      setChoices(fresh.bots); setSelection(fresh)
      setForm(current => ({ ...current, model: resetModel ? preservedModel || fresh.snapshot.defaultModel : current.model || fresh.snapshot.defaultModel }))
    } catch (caught) { if (!controller.signal.aborted) setSelectionError(caught instanceof Error ? caught.message : '读取 Bot 失败。') }
    finally { if (!controller.signal.aborted) setSelecting(false) }
  }
  function editRoutine(routine?: Routine) {
    if (busyGuard.current || readOnly || routine?.redacted || pending) return
    const now = Date.now(), timezone = routine?.timezone ?? getLocalTimezone()
    const local = localDateTime(routine?.rule.at ?? now, timezone)
    setEditorTime(now); setError(''); setConfirmedFor(''); setEditing(routine ?? null)
    setForm(routine ? { title: routine.title, prompt: routine.actionSpec?.prompt ?? '', when: routine.rule.type,
      value: routine.rule.type === 'at' ? local ? `${local.date}T${local.time}` : '' : routine.rule.type === 'interval' ? String((routine.rule.seconds ?? 3600) / 60) : routine.rule.time ?? '08:00',
      date: local?.date ?? '', weekdays: routine.rule.weekdays ?? [1], day: String(routine.rule.day ?? 1), event: routine.rule.event ?? 'todo_due',
      timezone, model: routine.actionSpec?.model?.id ?? '', notification: routine.actionSpec?.notification ?? 'inbox', writes: routine.actionSpec?.writes === true }
      : { ...initialForm(), timezone, date: local?.date ?? '' })
    setEditor(true)
    void chooseBot(routine?.actionSpec?.botId ?? botId, routine?.actionSpec?.model?.id ?? '')
  }
  useEffect(() => {
    let live = true, loading = false
    const load = async () => {
      if (loading) return
      loading = true
      try {
        const data = await call<{ items: Routine[] }>(token, 'schedule-list', {})
        if (live) setItems(data.items.filter(item => item.actionSpec?.botId === botId))
        if (open) {
          const history = await call<{ items: Run[] }>(token, 'schedule-list', { scheduleId: open })
          if (live) setRuns(history.items.slice(-5).reverse())
        }
      } catch (caught) { if (live) setError(caught instanceof Error ? caught.message : '读取失败。') }
      finally { loading = false }
    }
    const start = window.setTimeout(() => { void load() }, 0), timer = window.setInterval(() => { void load() }, 8000)
    return () => { live = false; window.clearTimeout(start); window.clearInterval(timer) }
  }, [token, botId, open, refreshKey])
  useEffect(() => {
    if (!editor) return
    const refresh = () => { if (!busyGuard.current && !pending) void chooseBot(targetBotId, '', false) }
    const timer = window.setTimeout(refresh, 0)
    window.addEventListener('pidot:model-settings-updated', refresh)
    return () => { window.clearTimeout(timer); window.removeEventListener('pidot:model-settings-updated', refresh) }
    // chooseBot owns a fresh abort controller; captured draft target is scoped to this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, targetBotId, editor, refreshKey, pending])
  useEffect(() => () => { selectionController.current?.abort() }, [])
  async function load() {
    const data = await call<{ items: Routine[] }>(token, 'schedule-list', {})
    setItems(data.items.filter(item => item.actionSpec?.botId === botId))
  }
  async function loadRuns(id: string) {
    try { setRuns((await call<{ items: Run[] }>(token, 'schedule-list', { scheduleId: id })).items.slice(-5).reverse()) }
    catch (caught) { setError(caught instanceof Error ? caught.message : '读取失败。') }
  }
  async function send(path: string, input: object) {
    const key = JSON.stringify([path, input])
    if (pending && pending.key !== key) throw new Error('上一请求结果未确认，请先核对原请求。')
    const request = pending ?? { key, requestId: crypto.randomUUID(), path, input }
    try {
      const data = await call<{ receipt?: { taskId?: number } }>(token, path, { ...request.input, requestId: request.requestId })
      setPending(null)
      return data
    } catch (caught) { setPending((caught as { unknown?: boolean }).unknown ? request : null); throw caught }
  }
  async function act(fn: () => Promise<void>) {
    if (busyGuard.current || readOnly) return
    busyGuard.current = true; setBusy(true); setError('')
    try { await fn(); await load(); onChanged?.() }
    catch (caught) { setError(caught instanceof Error ? caught.message : '操作没有成功。') }
    finally { busyGuard.current = false; setBusy(false) }
  }
  function create(event: FormEvent) {
    event.preventDefault()
    if (busyGuard.current || readOnly || pending || !confirmed || !selection || selection.snapshot.botId !== targetBotId || selection.snapshot.missing.length) return
    const built = routineInput({ ...form, botId: targetBotId, requestId: 'pending', now: editorTime })
    if (built.error !== undefined) { setError(built.error); return }
    void act(async () => {
      const fresh = await readSelection(targetBotId)
      if (fresh.snapshot.fingerprint !== selection.snapshot.fingerprint || !fresh.snapshot.models.includes(form.model) || fresh.snapshot.missing.length) {
        setChoices(fresh.bots); setSelection(fresh); setConfirmedFor('')
        throw new Error('目标 Bot 版本、模型目录或权限已改变，请核对后重新确认；未保存。')
      }
      const actionSpec = { ...(built.input.actionSpec as Record<string, unknown>), ...(editing?.actionSpec ?? {}), botId: targetBotId,
        prompt: form.prompt.trim(), writes: form.writes, notification: form.notification, model: { id: form.model } }
      const input: Record<string, unknown> = editing ? { ...built.input, command: 'update', id: editing.id, expectedRevision: editing.revision, actionSpec } : { ...built.input, actionSpec }
      if (editing?.rule.type === 'interval' && form.when === 'interval' && editing.rule.seconds === Number(form.value) * 60) input.rule = editing.rule
      await send('schedule-manage', input)
      setEditor(false); setEditing(null); setConfirmedFor('')
    })
  }
  const retryUnknown = () => act(async () => {
    if (!pending) return
    await send(pending.path, pending.input)
    if (pending.path === 'schedule-manage') { setEditor(false); setEditing(null); setConfirmedFor('') }
  })
  const test = (routine: Routine) => act(async () => { const data = await send('schedule-test', { id: routine.id }); setOpen(routine.id); await loadRuns(routine.id); if (data.receipt?.taskId) onOpenTask(data.receipt.taskId) })
  const change = (routine: Routine, command: 'pause' | 'resume' | 'cancel') => act(async () => { await send('schedule-manage', { command, id: routine.id, expectedRevision: routine.revision, ...(command === 'resume' ? { confirmed: true } : {}) }) })

  return <section className="today-card bot-routines" aria-labelledby={`bot-routines-${formId}`}>
    <div className="routine-head"><h2 id={`bot-routines-${formId}`}>例行任务</h2>{!readOnly && <button type="button" disabled={busy || !!pending} onClick={() => editRoutine()}>新建例行任务</button>}</div>
    <p className="shell-muted small">按时间或在某事发生时自动运行，每次运行是一个任务。按 Bot 当前工具、资源和规则执行；需要询问时跳过该步骤，并在结果中写明需要你来做。全局暂停时都不运行，恢复后不补跑。也可以在对话里让 Bot 提议。</p>
    {pending && !editor && <button type="button" disabled={busy || readOnly} onClick={() => { void retryUnknown() }}>重试核对原请求</button>}
    {error && !editor && <p role="alert" className="shell-note">{error}</p>}
    {items === null ? <p className="shell-muted">正在读取…</p> : items.length === 0 ? <p className="shell-muted">还没有例行任务。</p>
      : <ul className="routine-list">{items.map(r => <li key={r.id} className="routine-row">
        <div className="routine-head">
          <strong>{r.redacted ? '权限已失效的例行任务' : r.title}</strong>
          <span className="shell-muted small">{ruleLabel(r.rule, r.timezone)} · {statusLabel(r.status)}{r.actionSpec ? ` · ${r.actionSpec.writes ? '可按规则改动' : '只读'}` : ''}{r.enabled && r.nextDueAt ? ` · 下次 ${when(r.nextDueAt, r.timezone)}` : ''}</span>
        </div>
        {r.actionSpec?.prompt && <p className="routine-prompt">{r.actionSpec.prompt}</p>}
        <div className="action-row">
          <button type="button" disabled={busy || !!pending || readOnly || r.redacted || r.status === 'cancelled'} onClick={() => editRoutine(r)}>编辑</button>
          <button type="button" disabled={busy || !!pending || readOnly || r.redacted || r.status === 'cancelled'} title="立即运行一次：只读，结果不投递" onClick={() => void test(r)}>测试运行</button>
          {['active', 'paused'].includes(r.status) && <button type="button" disabled={busy || !!pending || readOnly || r.redacted} onClick={() => void change(r, r.enabled ? 'pause' : 'resume')}>{r.enabled ? '暂停' : '恢复'}</button>}
          {r.status !== 'cancelled' && <button type="button" disabled={busy || !!pending || readOnly} onClick={() => { if (window.confirm(`取消例行任务「${r.title}」？之后不再运行，已发生的改动不会撤回。`)) void change(r, 'cancel') }}>取消</button>}
          <button type="button" className="text-button" aria-expanded={open === r.id} onClick={() => { const next = open === r.id ? '' : r.id; setOpen(next); setRuns([]); if (next) void loadRuns(next) }}>运行记录</button>
        </div>
        {open === r.id && (runs.length === 0 ? <p className="shell-muted small">还没有运行过。</p>
          : <ul className="today-list">{runs.map(o => <li key={o.id}><span className="today-time">{when(o.scheduledFor, r.timezone)}</span><span>{runLabel(o)}</span>{o.taskId && <button type="button" className="text-button" onClick={() => onOpenTask(o.taskId!)}>打开</button>}</li>)}</ul>)}
      </li>)}</ul>}
    <EditorDialog open={editor} title={editing ? '编辑例行任务' : '新建例行任务'} pending={busy} disabled={readOnly || !!pending} error={error}
      onClose={() => { selectionController.current?.abort(); setEditor(false); setError('') }} initialFocus={`#routine-title-${formId}`}
      description="仅按所选 Bot 已有权限执行，不会自动授予工具或来源；改执行 Bot 仅影响后续触发，旧运行归属保持不变。"
      footer={pending && <button type="button" disabled={busy || readOnly} onClick={() => { void retryUnknown() }}>用原 requestId 核对保存结果</button>}>
      <form className="bot-form routine-form" onSubmit={create}>
        <label htmlFor={`routine-bot-${formId}`}>执行 Bot</label>
        <select id={`routine-bot-${formId}`} value={targetBotId} disabled={busy || !!pending} onChange={event => { void chooseBot(event.target.value) }} aria-describedby={`routine-bot-help-${formId}`}>
          {!selectableBots.some(bot => bot.id === targetBotId) && <option value={targetBotId} disabled>{botName ?? targetBotId}（等待核对）</option>}
          {selectableBots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
        </select>
        <p className="shell-muted small" id={`routine-bot-help-${formId}`}>执行者与接收者为同一个 Bot；切换后重新读取版本、权限和模型目录，不复制旧 Bot 模型。</p>
        <label htmlFor={`routine-title-${formId}`}>名称</label>
        <input id={`routine-title-${formId}`} required maxLength={200} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="例如：每日待办整理" />
        <label htmlFor={`routine-prompt-${formId}`}>每次要做什么</label>
        <textarea id={`routine-prompt-${formId}`} required rows={3} maxLength={3000} value={form.prompt} onChange={e => setForm({ ...form, prompt: e.target.value })} placeholder="例如：看看今天到期的待办，按轻重排一下，冲突的提醒我" />
        <label htmlFor={`routine-when-${formId}`}>什么时候</label>
        <select id={`routine-when-${formId}`} value={form.when} onChange={e => setForm({ ...form, when: e.target.value, value: ['daily', 'weekly', 'monthly'].includes(e.target.value) ? '08:00' : e.target.value === 'interval' ? '60' : e.target.value === 'at' ? `${form.date}T08:00` : '' })}>
          {ROUTINE_WHEN.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        {['daily', 'weekly', 'monthly'].includes(form.when) && <LocalTimePicker mode="time" label="运行时刻" date={form.date} time={form.value} timezone={form.timezone} onChange={value => setForm({ ...form, date: value.date, value: value.time })} />}
        {form.when === 'weekly' && <fieldset className="routine-weekdays"><legend>每周哪些天</legend>{ROUTINE_WEEKDAYS.map(([day, label]) => <label key={day}><input type="checkbox" checked={form.weekdays.includes(day)} onChange={e => setForm({ ...form, weekdays: e.target.checked ? [...form.weekdays, day].sort((a, b) => a - b) : form.weekdays.filter(d => d !== day) })} />{label}</label>)}</fieldset>}
        {form.when === 'monthly' && <label>每月几号<input aria-label="每月日期" type="number" min={1} max={31} step={1} required value={form.day} onChange={e => setForm({ ...form, day: e.target.value })} /><span className="shell-muted small">短月取当月最后一天。</span></label>}
        {form.when === 'event' && <select aria-label="触发事件" value={form.event} onChange={e => setForm({ ...form, event: e.target.value })}>{Object.entries(ROUTINE_EVENTS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>}
        {form.when === 'interval' && <input aria-label="间隔分钟" type="number" min={1} step={1} required value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} />}
        {form.when === 'at' && <LocalTimePicker label="运行日期与时刻" date={form.value.split('T')[0] || form.date} time={form.value.split('T')[1] || '08:00'} timezone={form.timezone} onChange={value => setForm({ ...form, date: value.date, value: `${value.date}T${value.time}` })} />}

        <label className="routine-check"><input type="checkbox" checked={form.notification === 'inbox'} onChange={e => setForm({ ...form, notification: e.target.checked ? 'inbox' : 'none' })} />结果通知到应用收件箱（非系统推送）</label>
        {selecting && <p role="status">正在核对所选 Bot 的配置与模型目录…</p>}
        {selectionError && <p role="alert">{selectionError}<button type="button" onClick={() => { void chooseBot(targetBotId) }}>重新读取</button></p>}
        {selection?.snapshot.botId === targetBotId && <div className="routine-model"><ModelPicker key={`${targetBotId}:${selection.snapshot.fingerprint}`} token={token} task={selection.task}
          value={{ id: form.model }} disabled={busy || !!pending || selecting} onChange={model => { setForm(current => ({ ...current, model: model.id })); setConfirmedFor('') }} /></div>}
        {!!selection?.snapshot.missing.length && <p role="alert">缺少能力：{selection.snapshot.missing.join('、')}。请在 Bot 设置或向配置 Agent 申请；此处不会自动授予。</p>}
        <details className="routine-advanced"><summary>高级选项</summary>
          <label className="routine-check"><input type="checkbox" checked={form.writes} onChange={e => setForm({ ...form, writes: e.target.checked })} />允许按规则改动本地事项（不勾就只读）</label>
        </details>
        <p className="shell-muted small">后端在线才执行；暂停不补跑。夏令时缺失时刻跳过，重复时刻只运行第一次。</p>
        <label className="routine-check"><input type="checkbox" disabled={!!preview.error} checked={confirmed} onChange={e => setConfirmedFor(e.target.checked ? formKey : '')} />我确认：{preview.error ? preview.error : `${ruleLabel(preview.rule, form.timezone)}运行`}，读本地日程和待办{form.writes ? '，按当前权限与规则执行；本地改动留撤销记录' : '，只读'}</label>
        <div className="bot-actions"><button className="primary" disabled={busy || !!pending || selecting || !selection || selection.snapshot.botId !== targetBotId || !!selection.snapshot.missing.length || !selection.snapshot.models.includes(form.model) || !confirmed || !!preview.error}>{busy ? '正在保存…' : editing ? '保存修改' : '创建例行任务'}</button></div>
      </form>
    </EditorDialog>
  </section>
}
