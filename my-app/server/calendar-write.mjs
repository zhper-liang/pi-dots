import { createHash } from 'node:crypto'
import { calendarQueryCapability, calendarIdempotencyCapability, supportsCalendarRecovery, validCalendarWriteArgs } from './approvals.mjs'
const copy = (x) => JSON.parse(JSON.stringify(x))
const fail = (code) => ({ result: { ok: false, error: { code, message: '模拟工具拒绝无保障执行；原操作结果不能据此推断。' } } })
export function calendarRequestHash(op) {
  return createHash('sha256').update(JSON.stringify([op.id, op.taskId, op.approvalId, op.inReplyTo, op.binding, op.toolName,
    op.arguments, op.before, op.decision, op.createdAt, op.capabilities, ...(op.source ? [op.source, op.botId, op.parametersHash, op.idempotencyKey] : [])])).digest('hex')
}
export function idempotencyWindow(op, now = Date.now()) {
  const start = Date.parse(op.createdAt), end = start + calendarIdempotencyCapability.idempotency.windowMs
  return Number.isFinite(start) && now >= start && now < end ? { validFrom: op.createdAt, expiresAt: new Date(end).toISOString() } : null
}
export function originalCalendarResult(op) {
  return { ok: true, data: { simulated: true, source: 'pidot.mock-calendar.v1', resource: 'mock:personal', timezone: 'Asia/Shanghai',
    operationId: op.id, approvalId: op.approvalId, before: copy(op.before), event: { ...copy(op.before), start: op.arguments.start, end: op.arguments.end } } }
}
// Tool-owned deduplication. Its caller must commit this state and the effect
// atomically. No Task receipt, current meeting time, or Harness replay proves it.
export function executeMockCalendarOperation(state, op, now = Date.now()) {
  if (!validCalendarWriteArgs(op.arguments)) return fail('INVALID_TOOL_ARGUMENTS')
  const stable = op.capabilities?.stableIdempotency === true, hash = calendarRequestHash(op), saved = state.idempotency?.[op.id]
  if (saved && saved.requestHash !== hash) return fail('IDEMPOTENCY_KEY_CONFLICT')
  if (stable && !supportsCalendarRecovery(op.capabilities, 'idempotency')) return fail('IDEMPOTENCY_CONTRACT_UNSUPPORTED')
  const window = stable && idempotencyWindow(op, now)
  if (stable && !window) return fail('IDEMPOTENCY_WINDOW_EXPIRED')
  if (stable && saved) return { result: copy(saved.result), evidence: copy(saved), replayed: true }
  const current = state.events[op.arguments.eventId] ?? op.before
  if (JSON.stringify(current) !== JSON.stringify(op.before)) return fail('CALENDAR_CONFLICT')
  const result = originalCalendarResult(op), committedAt = new Date(now).toISOString()
  state.events[result.data.event.id] = copy(result.data.event); state.revision = (state.revision ?? 0) + 1
  if (op.capabilities.reliableQuery) {
    state.operations ??= {}
    state.operations[op.id] = { source: calendarQueryCapability.query.source, operationId: op.id, taskId: op.taskId,
      approvalId: op.approvalId, binding: op.binding, arguments: copy(op.arguments), before: copy(op.before),
      event: copy(result.data.event), revision: state.revision, committedAt }
  }
  if (stable) {
    state.idempotency ??= {}
    state.idempotency[op.id] = { source: calendarIdempotencyCapability.idempotency.source, operationId: op.id, requestHash: hash,
      ...window, result: copy(result), revision: state.revision, committedAt }
    return { result, evidence: copy(state.idempotency[op.id]), replayed: false }
  }
  return { result }
}
export function validIdempotentResult(response, op) {
  const e = response?.evidence, window = idempotencyWindow(op, Date.parse(e?.committedAt))
  return response && typeof response.replayed === 'boolean' && e && Object.keys(e).length === 8 && window &&
    e.source === calendarIdempotencyCapability.idempotency.source && e.operationId === op.id && e.requestHash === calendarRequestHash(op) &&
    e.validFrom === window.validFrom && e.expiresAt === window.expiresAt && Number.isSafeInteger(e.revision) && e.revision > 0 &&
    JSON.stringify(response.result) === JSON.stringify(originalCalendarResult(op)) && JSON.stringify(e.result) === JSON.stringify(response.result)
}
