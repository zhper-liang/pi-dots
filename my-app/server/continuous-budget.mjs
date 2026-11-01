import { ContinuousBudget, TaskProgress, isContinuousTask } from './continuous-task.mjs'
import { Collaboration } from './collaboration.mjs'
import { TaskInputError } from './task-config.mjs'
import { CallLimitError } from './tools.mjs'
import { continuousDispatchState, recordContinuousControlChange } from './continuous-control.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const integer = value => Number.isSafeInteger(value) && value >= 0
const identity = value => Number.isSafeInteger(value) && value > 0
const fail = (code, message) => { throw new TaskInputError(409, code, message) }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const timestamp = value => new Date(value).toISOString()

export class ContinuousBudgetError extends CallLimitError {
  constructor(kind) {
    super(kind)
    this.message = `持续目标的 ${kind} 额度不足或无法核实；已保存进度，停止新增调用。`
    this.continuous = true
  }
}

/** Counts derive from the durable ledger, including interrupted and unsuccessful attempts. */
export function continuousBudgetUsage(budget) {
  const usage = { modelCalls: 0, toolCalls: 0, totalTokens: 0, reservedTokens: 0, unknownTokenCalls: 0, inFlight: 0 }
  for (const attempt of Object.values(budget.attempts ?? {})) {
    usage[attempt.kind === 'model' ? 'modelCalls' : 'toolCalls']++
    if (attempt.state === 'reserved') usage.inFlight++
    if (attempt.kind !== 'model') continue
    if (attempt.state === 'settled') {
      usage.totalTokens += attempt.usage.totalTokens
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) if (integer(attempt.usage[key])) usage[key] = (usage[key] ?? 0) + attempt.usage[key]
    } else {
      usage.reservedTokens += attempt.tokenReservation
      if (attempt.state === 'unknown') usage.unknownTokenCalls++
    }
  }
  return usage
}

/** A conservative configured bound, not a provider guarantee. An observed breach stops dispatch. */
export function continuousModelTokenReservation(parameters) {
  const input = parameters?.contextWindows?.[parameters?.model?.id]
  const output = parameters?.maxOutputTokens ?? 4096
  if (!identity(input) || !identity(output) || !Number.isSafeInteger(input + output)) throw new ContinuousBudgetError('token-bound-unavailable')
  return input + output
}

async function rootDocuments(tx, rootTaskId, TaskCard) {
  if (!identity(rootTaskId) || !TaskCard) fail('CONTINUOUS_BUDGET_BINDING', '根目标身份无效。')
  const root = await tx.doc(TaskCard, rootTaskId)
  const budget = await tx.doc(ContinuousBudget, rootTaskId)
  if (!isContinuousTask(root) || root.taskId !== rootTaskId || root.executionPolicy.rootTaskId !== rootTaskId || budget.rootTaskId !== rootTaskId || !budget.limits) fail('CONTINUOUS_BUDGET_BINDING', '根目标预算绑定无效。')
  return { root, budget }
}

/** Only a real, already-authorized one-level Collaboration can join a root budget. */
export async function registerContinuousChild(tx, input, { TaskCard } = {}) {
  const { root, budget } = await rootDocuments(tx, input.rootTaskId, TaskCard)
  const relation = (await tx.doc(Collaboration)).items.find(row => row.parentTaskId === root.taskId && row.parentInputId === root.executionPolicy.rootInputId && row.childTaskId === input.taskId && row.childInputId === input.inputId)
  if (!relation || input.goalRevision !== root.taskState.goalRevision || input.rootInputId !== root.executionPolicy.rootInputId || !identity(input.inputId)) fail('CONTINUOUS_BUDGET_BINDING', '执行者不属于当前根目标或目标修订。')
  const member = { taskId: input.taskId, inputId: input.inputId, rootInputId: input.rootInputId, goalRevision: input.goalRevision, stepId: input.stepId ?? null, relationId: relation.id }
  budget.members ??= {}
  const prior = budget.members[input.taskId]
  if (prior && !same(copy(prior), member)) fail('CONTINUOUS_BUDGET_BINDING', '执行者已有不可改写的根目标预算归属。')
  budget.members[input.taskId] = member
  return { ...member, replayed: Boolean(prior) }
}

/** Must run in the same serialized Harness commit as the existing per-task reservation. */
export async function reserveContinuousAttempt(tx, input, { TaskCard, now = Date.now(), enabled = true } = {}) {
  const { root, budget } = await rootDocuments(tx, input.rootTaskId, TaskCard)
  if (!identity(input.taskId) || !identity(input.inputId) || !identity(input.goalRevision) ||
    typeof input.attemptId !== 'string' || !/^[\w.:-]{1,240}$/.test(input.attemptId) || !['model', 'tool'].includes(input.kind) ||
    typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.length > 100) fail('CONTINUOUS_ATTEMPT_INVALID', '调用预留须包含完整、稳定的尝试身份。')
  const tokenReservation = input.kind === 'model' ? input.tokenReservation : 0
  if (input.kind === 'model' && !identity(tokenReservation)) throw new ContinuousBudgetError('token-bound-unavailable')
  const binding = { attemptId: input.attemptId, taskId: input.taskId, inputId: input.inputId, goalRevision: input.goalRevision, kind: input.kind, purpose: input.purpose, tokenReservation }
  const prior = budget.attempts[input.attemptId]
  if (prior) {
    if (!Object.entries(binding).every(([key, value]) => prior[key] === value)) fail('CONTINUOUS_ATTEMPT_CONFLICT', '同一 attemptId 不能对应另一调用。')
    return { attempt: copy(prior), replayed: true, dispatch: false }
  }
  const member = input.taskId === root.taskId ? { inputId: root.executionPolicy.rootInputId, goalRevision: root.taskState.goalRevision } : budget.members?.[input.taskId]
  if (!member || member.inputId !== input.inputId || member.goalRevision !== input.goalRevision || root.taskState.goalRevision !== input.goalRevision) fail('CONTINUOUS_BUDGET_BINDING', '调用不属于当前根目标的已登记执行者和修订。')
  const control = await continuousDispatchState(tx, root, root.executionPolicy.rootInputId, { now, enabled })
  if (!control.allowed) {
    if (control.state === 'limited') throw new ContinuousBudgetError(control.reason)
    const error = new TaskInputError(409, 'CONTINUOUS_DISPATCH_STOPPED', '持续目标已停止派发；原回执仍可保存。')
    error.control = control
    throw error
  }
  const usage = continuousBudgetUsage(budget)
  if (usage.unknownTokenCalls) throw new ContinuousBudgetError('unknown-tokens')
  if (Object.values(budget.attempts).some(attempt => attempt.boundExceeded)) throw new ContinuousBudgetError('token-bound-exceeded')
  const count = input.kind === 'model' ? 'modelCalls' : 'toolCalls'
  if (usage[count] >= budget.limits[count]) throw new ContinuousBudgetError(count)
  if (usage.totalTokens + usage.reservedTokens + tokenReservation > budget.limits.totalTokens || usage.totalTokens >= budget.limits.totalTokens) throw new ContinuousBudgetError('totalTokens')
  const attempt = { ...binding, state: 'reserved', reservedAt: timestamp(now) }
  budget.attempts[input.attemptId] = attempt
  return { attempt: copy(attempt), replayed: false, dispatch: true }
}

/** Pure ledger form also settles the root's archived document after cancellation. */
export function settleContinuousBudget(budget, input, { now = Date.now() } = {}) {
  if (budget.rootTaskId !== input.rootTaskId) fail('CONTINUOUS_RECEIPT_BINDING', '回执根目标身份无效。')
  const attempt = budget.attempts[input.attemptId]
  if (!attempt || attempt.taskId !== input.taskId) fail('CONTINUOUS_RECEIPT_BINDING', '回执没有对应的原派发预留。')
  const usage = attempt.kind === 'model' && integer(input.usage?.totalTokens)
    ? Object.fromEntries(['totalTokens', 'input', 'output', 'cacheRead', 'cacheWrite'].filter(key => integer(input.usage[key])).map(key => [key, input.usage[key]])) : null
  if (attempt.state === 'settled') {
    if (attempt.kind === 'model' && (!usage || !same(copy(attempt.usage), usage))) fail('CONTINUOUS_RECEIPT_CONFLICT', '同一调用已有不同的真实用量回执。')
    return { attempt: copy(attempt), replayed: true }
  }
  if (attempt.kind === 'model' && !usage) {
    const replayed = attempt.state === 'unknown'
    attempt.state = 'unknown'
    attempt.unknownAt ??= timestamp(now)
    attempt.unknownReason ??= 'receipt-without-usage'
    return { attempt: copy(attempt), replayed }
  }
  attempt.state = 'settled'
  attempt.settledAt = timestamp(now)
  if (usage) {
    attempt.usage = usage
    if (usage.totalTokens > attempt.tokenReservation) attempt.boundExceeded = true
  }
  return { attempt: copy(attempt), replayed: false }
}

export async function settleContinuousAttempt(tx, input, options = {}) {
  return settleContinuousBudget(await tx.doc(ContinuousBudget, input.rootTaskId), input, options)
}

/** Call once during process recovery, before any restored task is resumed. Never refunds. */
export async function recoverContinuousReservations(tx, rootTaskId, { now = Date.now() } = {}) {
  const budget = await tx.doc(ContinuousBudget, rootTaskId)
  let recovered = 0
  for (const attempt of Object.values(budget.attempts)) if (attempt.state === 'reserved') {
    attempt.state = 'unknown'
    attempt.unknownAt = timestamp(now)
    attempt.unknownReason = 'process-interrupted'
    recovered++
  }
  return { recovered, usage: continuousBudgetUsage(budget) }
}

export async function raiseContinuousLimits(tx, rootTaskId, input, { TaskCard, now = Date.now() } = {}) {
  const { root, budget } = await rootDocuments(tx, rootTaskId, TaskCard)
  const progress = await tx.doc(TaskProgress, rootTaskId)
  const control = await continuousDispatchState(tx, root, root.executionPolicy.rootInputId, { now })
  if (['cancelled', 'completed', 'failed'].includes(control.state) || progress.finalOutcome) fail('CONTINUOUS_INPUT_CLOSED', '已终止的目标不能提额恢复。')
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !['modelCalls', 'toolCalls', 'totalTokens', 'deadlineAt'].includes(key))) fail('INVALID_CALL_LIMITS', '只允许提高根调用、Token 上限或延长截止时间。')
  const next = copy(budget.limits)
  let deadlineAt = budget.deadlineAt, changed = false
  for (const [key, value] of Object.entries(input)) {
    if (key === 'deadlineAt') {
      const deadline = typeof value === 'string' ? Date.parse(value) : NaN
      if (!Number.isFinite(deadline) || deadline < Date.parse(deadlineAt)) fail('INVALID_CALL_LIMITS', '截止时间只允许显式延长。')
      if (deadline > Date.parse(deadlineAt)) changed = true
      deadlineAt = timestamp(deadline)
    } else {
      if (!identity(value) || value < next[key]) fail('INVALID_CALL_LIMITS', '根目标额度只能提高为有限正整数；未知用量不能清零。')
      if (value > next[key]) changed = true
      next[key] = value
    }
  }
  if (!changed) fail('INVALID_CALL_LIMITS', '请显式提高至少一项根上限或截止时间。')
  budget.limits = next
  budget.deadlineAt = deadlineAt
  recordContinuousControlChange(progress, 'limits', now)
  return { limits: copy(next), deadlineAt, usage: continuousBudgetUsage(budget) }
}
