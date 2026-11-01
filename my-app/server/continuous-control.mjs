import { createHash } from 'node:crypto'
import { TaskProgress, ContinuousBudget, isContinuousTask } from './continuous-task.mjs'
import { TaskCancellation } from './cancellation.mjs'
import { AutomationPause, automationPaused } from './policy.mjs'
import { TaskInputError, parseTaskState } from './task-config.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const signature = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
const stamp = now => new Date(now).toISOString()

export function recordContinuousControlChange(progress, action, now, requestId = null) {
  progress.controlVersion++
  progress.controlChanges ??= []
  progress.controlChanges.push({ version: progress.controlVersion, action, requestId, changedAt: stamp(now) })
}

export function continuousBudgetBlockReason(budget, blocked) {
  if (!blocked) return null
  const attempts = Object.values(budget.attempts)
  const reason = blocked.reason
  if (reason === 'modelCalls' && attempts.filter(item => item.kind === 'model').length >= budget.limits.modelCalls) return reason
  if (reason === 'toolCalls' && attempts.filter(item => item.kind === 'tool').length >= budget.limits.toolCalls) return reason
  if (reason === 'unknown-tokens' && attempts.some(item => item.kind === 'model' && item.state === 'unknown')) return reason
  if (reason === 'token-bound-exceeded' && attempts.some(item => item.boundExceeded)) return reason
  if (reason === 'totalTokens') {
    const tokens = attempts.filter(item => item.kind === 'model').reduce((sum, item) => sum + (item.state === 'settled' ? item.usage.totalTokens : item.tokenReservation), 0)
    if (tokens >= budget.limits.totalTokens || tokens + blocked.tokenReservation > budget.limits.totalTokens) return reason
  }
  if (['token-bound-unavailable', 'attempt-outcome-unknown', 'task-modelCalls', 'task-toolCalls', 'task-totalTokens'].includes(reason)) return reason
  return null
}

/** Capture in the same commit that parks the Harness; watches can then detect earlier wakeups. */
export function continuousControlWatchKey(progress, budget, automation, cancellation) {
  return signature({ version: progress.controlVersion, goalRevision: progress.goalRevision, intent: progress.controlIntent,
    pending: progress.pendingGoalRevision, final: progress.finalOutcome, budgetBlocked: progress.budgetBlocked ?? null, automationEpoch: automation.epoch,
    limits: budget.limits, deadlineAt: budget.deadlineAt, cancellation: cancellation.request,
    attempts: Object.entries(budget.attempts).map(([id, attempt]) => [id, attempt.state, attempt.usage?.totalTokens ?? null]) })
}

export async function readContinuousControlWatchKey(tx, rootTaskId) {
  return continuousControlWatchKey(await tx.doc(TaskProgress, rootTaskId), await tx.doc(ContinuousBudget, rootTaskId), await tx.doc(AutomationPause), await tx.doc(TaskCancellation, rootTaskId))
}

/** A Harness phase wait, not another dispatcher. It never sleeps inside a transaction. */
export async function waitContinuousControlChange(runtime, ctx, { rootTaskId = runtime.taskId, observed, now = Date.now } = {}) {
  if (typeof observed !== 'string') throw new TypeError('A persisted continuous control watch key is required')
  const watches = []
  let timer, abort
  try {
    watches.push(await runtime.watchDoc(TaskProgress, rootTaskId, ctx))
    watches.push(await runtime.watchDoc(ContinuousBudget, rootTaskId, ctx))
    watches.push(await runtime.watchDoc(AutomationPause, ctx))
    watches.push(await runtime.watchDoc(TaskCancellation, rootTaskId, ctx))
    await new Promise((resolve, reject) => {
      const check = () => {
        const [progress, budget, automation, cancellation] = watches.map(watch => watch.value)
        if (continuousControlWatchKey(progress, budget, automation, cancellation) !== observed) return resolve('changed')
      }
      abort = () => reject(runtime.signal.reason ?? new Error('Invocation stopped'))
      runtime.signal.addEventListener('abort', abort, { once: true })
      if (runtime.signal.aborted) return abort()
      for (const watch of watches) {
        watch.start(check)
        void watch.closed.then(() => reject(new Error('Continuous control watch closed')))
      }
      check()
      const remaining = Date.parse(watches[1].value.deadlineAt) - now()
      // Once already limited by time, wait for an explicit extension instead of spinning.
      if (remaining > 0) timer = setTimeout(() => resolve('deadline'), Math.min(remaining, 2147483647))
    })
  } finally {
    clearTimeout(timer)
    if (abort) runtime.signal.removeEventListener('abort', abort)
    await Promise.all(watches.map(watch => watch.stop()))
  }
}

/** Call at every admission boundary, including child and approved-operation dispatches. */
export async function continuousDispatchState(tx, card, entryId, { now = Date.now(), enabled = true } = {}) {
  if (!isContinuousTask(card)) return { allowed: true }
  const progress = await tx.doc(TaskProgress, card.taskId)
  const budget = await tx.doc(ContinuousBudget, card.taskId)
  const stop = (state, reason) => ({ allowed: false, state, reason, rootTaskId: card.taskId })
  if ((await tx.doc(TaskCancellation, card.taskId)).request || progress.controlIntent?.action === 'cancel') return stop('cancelled', 'user-cancelled')
  if (progress.finalOutcome) return stop(progress.finalOutcome.status, 'goal-closed')
  if (card.executionPolicy.rootInputId !== entryId) return stop('blocked', 'input-binding')
  if (!Number.isFinite(Date.parse(budget.deadlineAt))) return stop('limited', 'deadline-unavailable')
  if (now >= Date.parse(budget.deadlineAt)) return stop('limited', 'deadline')
  if (progress.controlIntent?.action === 'pause') return stop('paused', 'user-paused')
  const budgetReason = continuousBudgetBlockReason(budget, progress.budgetBlocked)
  if (budgetReason) return stop('limited', budgetReason)
  if (progress.budgetBlocked) delete progress.budgetBlocked
  if (progress.pendingGoalRevision) return stop('revising', 'goal-revision-pending')
  if (progress.stall?.lastAction === 'blocked') return stop('blocked', 'stalled')
  if (!enabled) return stop('paused', 'feature-disabled')
  if (await automationPaused(tx)) return stop('paused', 'global-paused')
  return { allowed: true, rootTaskId: card.taskId }
}

/** The caller owns cancellation propagation and the sole Harness checkpoint transition. */
export async function applyContinuousControl(tx, card, input, { now = Date.now(), cancel } = {}) {
  if (!isContinuousTask(card) || card.executionPolicy.rootTaskId !== card.taskId) fail(404, 'CONTINUOUS_NOT_FOUND', '持续根目标不存在。')
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['requestId', 'expectedVersion', 'action', 'goalPatch'].includes(key)) ||
    typeof input.requestId !== 'string' || !/^[\w.:-]{1,120}$/.test(input.requestId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
    !['pause', 'resume', 'cancel', 'revise-goal'].includes(input.action) || (input.action === 'revise-goal') !== Object.hasOwn(input, 'goalPatch')) fail(400, 'INVALID_CONTINUOUS_CONTROL', '控制请求须包含 requestId、expectedVersion 和有效 action。')
  const progress = await tx.doc(TaskProgress, card.taskId)
  progress.controlRequests ??= {}
  const hash = signature(input), prior = progress.controlRequests[input.requestId]
  if (prior) {
    if (prior.signature !== hash) fail(409, 'CONTINUOUS_REQUEST_CONFLICT', '同一 requestId 不能更换控制内容。')
    return { ...copy(prior.result), replayed: true }
  }
  if ((await tx.doc(TaskCancellation, card.taskId)).request || progress.controlIntent?.action === 'cancel') fail(409, 'TASK_CANCELLED', '此目标已取消，不能恢复或修改。')
  if (progress.finalOutcome) fail(409, 'CONTINUOUS_INPUT_CLOSED', '此目标已结束，不能恢复或修改。')
  const intervening = (progress.controlChanges ?? []).filter(row => row.version > input.expectedVersion)
  const monotonicCancel = input.action === 'cancel' && input.expectedVersion < progress.controlVersion && intervening.length === progress.controlVersion - input.expectedVersion && intervening.every(row => ['pause', 'resume'].includes(row.action))
  if (input.expectedVersion !== progress.controlVersion && !monotonicCancel) fail(409, 'CONTINUOUS_VERSION_CONFLICT', '目标控制版本已变化，请读取当前状态。')
  if (input.action === 'pause') progress.controlIntent = { action: 'pause', requestId: input.requestId, requestedAt: stamp(now) }
  if (input.action === 'resume' && progress.controlIntent?.action === 'pause') progress.controlIntent = null
  if (input.action === 'resume' && progress.stall?.lastAction === 'blocked') {
    progress.stall.evaluated = 0
    progress.stall.replans = 0
    progress.stall.lastAction = 'continue'
  }
  if (input.action === 'cancel') {
    if (typeof cancel !== 'function') throw new Error('Continuous cancellation requires the existing cancellation host hook')
    // Persist the intent in the same commit as the existing cancellation marker.
    await cancel(tx, card.taskId)
    progress.controlIntent = { action: 'cancel', requestId: input.requestId, requestedAt: stamp(now) }
  }
  if (input.action === 'revise-goal') {
    if (progress.pendingGoalRevision) fail(409, 'CONTINUOUS_REVISION_PENDING', '已有目标修订等待安全边界。')
    const patch = parseTaskState(input.goalPatch)
    const state = { ...copy(card.taskState), ...patch }
    if (!state.completionCriteria.length) fail(400, 'CONTINUOUS_CRITERIA_REQUIRED', '持续目标至少需要一项完成标准。')
    progress.pendingGoalRevision = { goalRevision: card.taskState.goalRevision + 1, goalPatch: patch, requestId: input.requestId, requestedAt: stamp(now) }
  }
  recordContinuousControlChange(progress, input.action, now, input.requestId)
  const result = { rootTaskId: card.taskId, version: progress.controlVersion, action: input.action, replayed: false }
  progress.controlRequests[input.requestId] = { signature: hash, result: copy(result) }
  return result
}

/** In-flight receipts retain their original revision; only an empty safe boundary may revise. */
export async function applyPendingContinuousGoal(tx, card, { now = Date.now(), hasInFlight = false } = {}) {
  const progress = await tx.doc(TaskProgress, card.taskId)
  if (!progress.pendingGoalRevision) return { applied: false }
  if ((await tx.doc(TaskCancellation, card.taskId)).request || progress.controlIntent?.action === 'cancel' || progress.finalOutcome) return { applied: false, reason: 'goal-closed' }
  const budget = await tx.doc(ContinuousBudget, card.taskId)
  if (hasInFlight || Object.values(budget.attempts).some(attempt => attempt.state === 'reserved')) return { applied: false, reason: 'in-flight' }
  const pending = copy(progress.pendingGoalRevision)
  if (pending.goalRevision !== card.taskState.goalRevision + 1) fail(409, 'CONTINUOUS_VERSION_CONFLICT', '待应用修订与当前目标不一致。')
  const { TaskApprovals } = await import('./approvals.mjs')
  const approvals = await tx.doc(TaskApprovals, card.taskId), superseded = []
  for (const item of approvals.items) {
    if (item.operation || item.receipt || item.status !== 'pending') continue
    const turn = await tx.entry(item.turnId)
    if (turn?.data.continuousBinding?.goalRevision !== card.taskState.goalRevision) continue
    item.status = 'superseded'
    item.supersededByGoalRevision = pending.goalRevision
    if (approvals.activeId === item.id) approvals.activeId = null
    superseded.push(item.id)
  }
  for (const step of progress.steps) if (step.goalRevision === card.taskState.goalRevision) step.status = 'superseded'
  card.taskState = { ...copy(card.taskState), ...pending.goalPatch, goalRevision: pending.goalRevision }
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.task-state', data: {
    changes: pending.goalPatch, goalRevision: pending.goalRevision, source: 'authenticated-user-continuous-revision',
    requestId: pending.requestId, createdAt: stamp(now) } })
  card.taskStateSources = { ...copy(card.taskStateSources ?? {}), ...Object.fromEntries(Object.keys(pending.goalPatch).map(key => [key, {
    type: 'authenticated-user-continuous-revision', entryId: audit.id, goalRevision: pending.goalRevision,
    ...(card.configRef ? { configRef: copy(card.configRef) } : {}) }])) }
  for (const approvalId of superseded) await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-superseded', data: {
    taskId: card.taskId, approvalId, goalRevision: pending.goalRevision, requestId: pending.requestId,
    source: 'authenticated-user-continuous-revision', createdAt: stamp(now) } })
  progress.goalRevision = pending.goalRevision
  progress.planRevision++
  progress.currentStepId = null
  progress.pendingGoalRevision = null
  progress.retry = null
  progress.stall = { ...copy(progress.stall), evaluated: 0, replans: 0,
    known: { evidence: copy(progress.stall?.known?.evidence ?? []), criteria: [], resolved: [] } }
  progress.goalRevisions ??= []
  progress.goalRevisions.push({ ...pending, appliedAt: stamp(now) })
  return { applied: true, goalRevision: pending.goalRevision }
}
