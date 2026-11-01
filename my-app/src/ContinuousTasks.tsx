import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import ContinuousTaskCard, { type ContinuousTaskCardView } from './ContinuousTaskCard'
import './continuous-task.css'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'
import { createContinuousRequestGate } from './continuous-request.mjs'

export type ContinuousProjection = {
  rootTaskId: number; version: number; goalRevision: number; state: string; goal: string
  completionCriteria: string[]; constraints: string[]; waitingReason?: string | null
  currentStepId?: string | null; steps?: { stepId: string; title: string; status: string; deliverable?: string; summary?: string; goalRevision?: number }[]
  availableActions: string[]; limits: { modelCalls: number; toolCalls: number; totalTokens: number; durationMs: number }
  deadlineAt?: string | null; usage?: { modelCalls?: number; toolCalls?: number; totalTokens?: number; unknownTokenCalls?: number }
  pendingGoalRevision?: { goalPatch?: { goal?: string; completionCriteria?: string[]; constraints?: string[] } } | null
}
type Origin = { kind: 'main' | 'group'; taskId: number }
type TaskState = { goal: string; completionCriteria: string[]; constraints: string[] }
const labels: Record<string, string> = { running: '进行中', pausing: '正在暂停', paused: '已暂停', waiting: '等待中', limited: '已到上限', blocked: '遇到阻碍', failed: '执行失败', cancelled: '已停止', completed: '已完成', revising: '正在调整目标', retrying: '暂时遇到问题，等待重试' }
const reasons: Record<string, string> = { 'child-results': '正在等待协作结果。', 'user-approval': '等待你的确认。', 'user-blocker': '等待你的回答。', 'action-outcome-unknown': '操作结果待核对。', 'unknown-tokens': '部分用量未知，需要核对。', 'in-flight': '正在等待已发出的操作返回。', stalled: '暂时没有可确认的新进展。', 'user-cancelled': '你已停止这个目标。', 'manual-pause': '你已暂停这个目标。', 'user-paused': '你已暂停这个目标。', 'global-paused': '自动执行已全局暂停。', 'feature-disabled': '持续执行功能已关闭。', 'goal-revision-pending': '目标调整等待安全应用。', modelCalls: '已到模型调用上限。', toolCalls: '已到工具调用上限。', totalTokens: '已到 Token 上限。', 'token-bound-unavailable': '无法确定下一次调用的用量上限。', 'token-bound-exceeded': '调用用量超出预留，需要核对。', 'deadline-unavailable': '截止时间不可用，请核对目标设置。', 'deadline': '已到截止时间。', 'deadline-reached': '已到截止时间。' }
const actionLabels: Record<string, string> = { pause: '暂停', resume: '继续', cancel: '停止', 'revise-goal': '调整目标', 'raise-limits': '提高上限' }
const lines = (value: FormDataEntryValue | null) => String(value ?? '').split('\n').map(line => line.trim()).filter(Boolean)
const stateFrom = (data: FormData): TaskState => ({ goal: String(data.get('goal') ?? '').trim(), completionCriteria: lines(data.get('completionCriteria')), constraints: lines(data.get('constraints')) })

function useRequest(token: string, scope: string, onChanged: () => void) {
  const abort = useRef<AbortController | null>(null)
  const makeGate = useCallback(() => { let storage: Storage | undefined; try { storage = window.sessionStorage } catch { /* memory fallback */ } return createContinuousRequestGate({ storage, key: `pidot.continuous-request:${scope}`, makeId: () => crypto.randomUUID() }) }, [scope])
  const gate = useRef(makeGate())
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { gate.current = makeGate(); return () => { gate.current.dispose(); abort.current?.abort() } }, [makeGate])
  async function send(path: string, method: string, payload: object, idempotent = true) {
    const request = gate.current.begin(path, method, payload, idempotent)
    if (!request) return null
    setBusy(true); setError('')
    const controller = new AbortController(); abort.current = controller
    let succeeded = false
    try {
      const response = await fetch(path, { method, signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(idempotent ? { ...payload, requestId: request.requestId } : payload) })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 409) onChanged()
        throw new Error(body?.error?.message ?? '操作未完成，请刷新后核对。')
      }
      if (controller.signal.aborted) return null
      succeeded = true; onChanged()
      return body
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof TypeError ? '结果尚未确认，可保持内容不变后重试，或刷新查看。' : caught instanceof Error ? caught.message : '结果尚未确认，请刷新查看。')
      return null
    } finally { gate.current.finish(succeeded); if (!controller.signal.aborted && gate.current.current()) setBusy(false) }
  }
  return { send, busy, error }
}

function GoalFields({ initial }: { initial?: TaskState }) {
  return <>
    <label>目标<textarea name="goal" required maxLength={4000} rows={2} defaultValue={initial?.goal ?? ''} /></label>
    <label>完成标准（每行一项）<textarea name="completionCriteria" required rows={3} defaultValue={initial?.completionCriteria.join('\n') ?? ''} /></label>
    <label>限制（每行一项，可不填）<textarea name="constraints" rows={2} defaultValue={initial?.constraints.join('\n') ?? ''} /></label>
  </>
}


type ListedTask = { taskId: number; title: string; bot: { id: string; name: string }; continuous?: ContinuousProjection | null }
export function ContinuousList({ origin, token, refreshKey, onOpen }: { origin: Origin; token: string; refreshKey: number; onOpen: (id: number, botId: string) => void }) {
  const [items, setItems] = useState<ListedTask[] | null>(null), [error, setError] = useState('')
  const reader = useWorkspaceRefresh({
    scopeKey: JSON.stringify([token, origin.kind, origin.taskId]), active: true, refreshKey,
    load: async ({ signal, isCurrent }) => {
      const response = await fetch(`/api/tasks?continuousOriginTaskId=${origin.taskId}`, { signal, headers: { Authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? '无法读取目标。')
      if (isCurrent()) { setItems(body.tasks); setError('') }
    },
    onInvalidate: () => setItems(null),
    onError: caught => { setItems(null); setError(caught instanceof Error ? caught.message : '无法读取目标。') }
  })
  return <section className="continuous-list" aria-label="持续目标"><h3>持续目标</h3>
    {error ? <p role="alert">{error} <button type="button" onClick={() => void reader.refresh(true)}>重新读取</button></p> : items === null ? <p role="status">正在读取目标…</p> : items.length === 0 ? <p className="shell-muted small">还没有持续目标。</p> : <ul>{items.map(item => item.continuous && <li key={item.taskId}><ContinuousTaskCard task={{ rootTaskId: item.taskId, title: item.title, goal: item.continuous.goal, status: labels[item.continuous.state] ?? '状态待确认', currentStep: item.continuous.steps?.find(step => step.stepId === item.continuous?.currentStepId)?.title, actions: [{ id: 'open', label: '打开目标' }] }} onAction={() => onOpen(item.taskId, item.bot.id)} /></li>)}</ul>}
  </section>
}

export function ContinuousStart({ origin, token, onChanged, onOpen }: { origin: Origin; token: string; onChanged: () => void; onOpen: (taskId: number) => void }) {
  const { send, busy, error } = useRequest(token, `start:${origin.kind}:${origin.taskId}`, onChanged)
  const [open, setOpen] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget), state = stateFrom(data)
    if (!state.completionCriteria.length) return
    const result = await send('/api/tasks/continuous', 'POST', { origin, ...state, limits: { modelCalls: Number(data.get('modelCalls')), toolCalls: Number(data.get('toolCalls')), totalTokens: Number(data.get('totalTokens')), durationMs: Number(data.get('hours')) * 3600000 } })
    if (result?.data?.rootTaskId) onOpen(result.data.rootTaskId)
  }
  return <section className="continuous-start"><button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起新目标' : '启动持续目标'}</button>
    {open && <form className="continuous-form" onSubmit={event => void submit(event)}><GoalFields />
      <p>工作会持续推进，直到完成、需要你处理或达到上限。上限是初始设置，不代表费用或完成保证。</p>
      <div className="continuous-form-grid">
        <label>模型调用上限<input name="modelCalls" type="number" min="1" step="1" required defaultValue="200" /></label>
        <label>工具调用上限<input name="toolCalls" type="number" min="1" step="1" required defaultValue="1000" /></label>
        <label>Token 上限<input name="totalTokens" type="number" min="1" step="1" required defaultValue="2000000" /></label>
        <label>最长时间（小时）<input name="hours" type="number" min="1" max="8" step="1" required defaultValue="8" /></label>
      </div>{error && <p role="alert">{error}</p>}<button type="submit" className="primary" disabled={busy}>{busy ? '正在启动…' : '启动目标'}</button>
    </form>}
  </section>
}

export function ContinuousDetail({ task, title, executor, token, onChanged, onTimeline }: { task: ContinuousProjection; title: string; executor: string; token: string; onChanged: () => void; onTimeline: () => void }) {
  const { send, busy, error } = useRequest(token, `root:${task.rootTaskId}`, onChanged)
  const [form, setForm] = useState<'revise-goal' | 'raise-limits' | null>(null), [formError, setFormError] = useState('')
  const current = task.steps?.find(step => step.stepId === task.currentStepId)
  const verified = task.steps?.filter(step => step.status === 'verified').map(step => ({ id: step.stepId, summary: step.summary || step.title }))
  const old = task.steps?.filter(step => step.status === 'superseded' && step.summary).map(step => ({ id: step.stepId, summary: step.summary || step.title }))
  const usage = task.usage
  const view: ContinuousTaskCardView = { rootTaskId: task.rootTaskId, title, goal: task.goal, status: labels[task.state] ?? '状态待确认', statusReason: task.waitingReason ? reasons[task.waitingReason] ?? '请查看执行记录或待处理事项。' : null, currentStep: current?.title, executor, completionCriteria: task.completionCriteria, verifiedResults: verified, pendingReverification: old,
    usage: usage ? [{ label: '模型调用', value: `${usage.modelCalls ?? '未知'} / ${task.limits.modelCalls}` }, { label: '工具调用', value: `${usage.toolCalls ?? '未知'} / ${task.limits.toolCalls}` }, { label: '已知 Token', value: `${usage.totalTokens ?? '未知'} / ${task.limits.totalTokens}` }, ...(usage.unknownTokenCalls ? [{ label: '用量未知', value: `${usage.unknownTokenCalls} 次` }] : [])] : [],
    actions: task.availableActions.filter(action => actionLabels[action]).map(id => ({ id, label: actionLabels[id] })) }
  async function action(id: string) {
    if (id === 'revise-goal' || id === 'raise-limits') { setFormError(''); setForm(id); return }
    if (id === 'cancel' && !window.confirm('停止这个目标？已发出的操作可能仍会返回结果，已有成果会保留。')) return
    await send(`/api/tasks/${task.rootTaskId}/continuous/control`, 'POST', { expectedVersion: task.version, action: id })
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setFormError('')
    if (form === 'revise-goal') {
      const goalPatch = stateFrom(data)
      if (!goalPatch.completionCriteria.length) { setFormError('请填写至少一项完成标准。'); return }
      const result = await send(`/api/tasks/${task.rootTaskId}/continuous/control`, 'POST', { expectedVersion: task.version, action: 'revise-goal', goalPatch })
      if (result) setForm(null)
    } else if (form === 'raise-limits') {
      const changes: Record<string, number | string> = {}
      for (const key of ['modelCalls', 'toolCalls', 'totalTokens'] as const) {
        const value = Number(data.get(key))
        if (value > task.limits[key]) changes[key] = value
      }
      const deadline = String(data.get('deadlineAt') ?? '')
      if (deadline && task.deadlineAt && Date.parse(deadline) <= Date.parse(task.deadlineAt)) { setFormError('新截止时间须晚于当前截止时间。'); return }
      if (deadline) changes.deadlineAt = new Date(deadline).toISOString()
      if (!Object.keys(changes).length) { setFormError('请提高至少一项上限或延长截止时间。'); return }
      const result = await send(`/api/tasks/${task.rootTaskId}/limits`, 'PATCH', changes, false)
      if (result) setForm(null)
    }
  }
  return <><ContinuousTaskCard task={view} busy={busy} onAction={(_, id) => void action(id)} />
    {task.pendingGoalRevision && <div role="status"><p>目标调整等待安全应用；已有成果需要按新标准重新核验。</p>{task.pendingGoalRevision.goalPatch && <><p>新目标：{task.pendingGoalRevision.goalPatch.goal ?? task.goal}</p><p>新完成标准：{(task.pendingGoalRevision.goalPatch.completionCriteria ?? task.completionCriteria).join('；')}</p></>}</div>}
    {task.deadlineAt && <p className="shell-muted small">截止时间：{new Date(task.deadlineAt).toLocaleString('zh-CN')}</p>}
    <button type="button" className="text-button" onClick={onTimeline}>查看执行记录</button>
    {form && <form className="continuous-form" onSubmit={event => void submit(event)}>
      <h4>{form === 'revise-goal' ? '调整目标' : '提高上限'}</h4>
      {form === 'revise-goal' ? <GoalFields initial={task} /> : <><p>已用次数不会清零。</p><div className="continuous-form-grid">
        <label>模型调用上限<input name="modelCalls" type="number" min={task.limits.modelCalls} step="1" required defaultValue={task.limits.modelCalls} /></label>
        <label>工具调用上限<input name="toolCalls" type="number" min={task.limits.toolCalls} step="1" required defaultValue={task.limits.toolCalls} /></label>
        <label>Token 上限<input name="totalTokens" type="number" min={task.limits.totalTokens} step="1" required defaultValue={task.limits.totalTokens} /></label>
        <label>延长截止时间（可不填）<input name="deadlineAt" type="datetime-local" /></label>
      </div></>}
      {formError && <p role="alert">{formError}</p>}
      <div className="continuous-task-actions"><button type="submit" className="primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</button><button type="button" onClick={() => setForm(null)}>返回</button></div>
    </form>}
    {error && <p role="alert">{error}</p>}
  </>
}
