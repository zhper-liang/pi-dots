import { normalizeFeishuMutation, feishuMutationHash, feishuBefore, feishuBeforeHash, supportedFeishuTarget } from './feishu-mutation.mjs'
import { FeishuCalendar } from './feishu-calendar.mjs'
import { FEISHU_CREATE_TOOL, feishuCreateHash, normalizeFeishuCreate, feishuCreateCapability } from './feishu-write.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError } from './task-config.mjs'
import { assertNotCancelled } from './cancellation.mjs'
import { ChatSteering } from './steering.mjs'
import { validDate } from './tool-results.mjs'
import { addRule } from './policy.mjs'

export const CALENDAR_WRITE_TOOL = 'calendar_reschedule_event'
export const TaskApprovals = defineDoc({ kind: 'pidot.task-approvals', version: 1, scope: 'task',
  initial: () => ({ activeId: null, items: [] }) })
// Shared simulated resource only. There is no real calendar transport or credential.
export const MockCalendar = defineDoc({ kind: 'pidot.mock-calendar', version: 1, scope: 'session', initial: () => ({ events: {}, revision: 0, operations: {} }) })
export const calendarQueryCapability = Object.freeze({ reliableQuery: true, stableIdempotency: false,
  query: Object.freeze({ name: 'mock_calendar_operation_result', source: 'pidot.mock-calendar.operation-ledger.v1',
    identity: ['operationId', 'taskId', 'approvalId', 'binding', 'resource', 'eventId'], maxAttempts: 3, timeoutMs: 2000 }) })
// The mock tool (not Harness) owns this bounded guarantee. The window starts
// at the durable intent timestamp, earlier than the first possible dispatch.
export const calendarIdempotencyCapability = Object.freeze({ ...calendarQueryCapability, stableIdempotency: true,
  idempotency: Object.freeze({ name: 'mock_calendar_stable_operation', source: 'pidot.mock-calendar.idempotency.v1',
    key: 'operationId', scope: 'mock:personal', parameters: 'exact-intent-and-approved-arguments',
    windowMs: 86400000, windowStart: 'intent.createdAt', maxAttempts: 3, timeoutMs: 2000 }) })
export function calendarRecoveryCapability(query = true, idempotency = true) {
  if (!idempotency) return query ? calendarQueryCapability : { reliableQuery: false, stableIdempotency: false }
  if (query) return calendarIdempotencyCapability
  return { reliableQuery: false, stableIdempotency: true, idempotency: calendarIdempotencyCapability.idempotency }
}
export function supportsCalendarRecovery(capability, mode) {
  return [calendarQueryCapability, calendarRecoveryCapability(true, true), calendarRecoveryCapability(false, true)]
    .some((known) => JSON.stringify(known) === JSON.stringify(capability)) &&
    (mode === 'idempotency' ? capability.stableIdempotency === true : capability.reliableQuery === true)
}
export const calendarWriteTool = Object.freeze({ name: CALENDAR_WRITE_TOOL, effect: 'write', requiresConfirmation: true, recovery: calendarIdempotencyCapability,
  description: '改期个人模拟日历会议（非真实日历），必须先读列表和事件详情，提供原始 expectedStart/expectedEnd 与精确新 start/end（Asia/Shanghai，+08:00）。宿主默认直接执行，规则或全局暂停可要求网页确认；普通消息、模型或Skill不算批准。以最终回执为准，未知结果不可盲目重试。',
  parameters: { type: 'object', additionalProperties: false, required: ['resource', 'eventId', 'expectedStart', 'expectedEnd', 'start', 'end'], properties: {
    resource: { type: 'string', enum: ['mock:personal'] }, eventId: { type: 'string', minLength: 1, maxLength: 100 },
    ...Object.fromEntries(['expectedStart', 'expectedEnd', 'start', 'end'].map((key) => [key, { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\+08:00$' }])),
  } },
})
const validTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00\+08:00$/.test(value) && validDate(value.slice(0, 10))
export function validCalendarWriteArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 6 &&
    args.resource === 'mock:personal' && typeof args.eventId === 'string' && /^mock-\d{8}-[1-3]$/.test(args.eventId) &&
    ['expectedStart', 'expectedEnd', 'start', 'end'].every((key) => validTime(args[key])) &&
    args.expectedStart.slice(0, 10) === args.expectedEnd.slice(0, 10) && args.start.slice(0, 10) === args.end.slice(0, 10) &&
    Date.parse(args.expectedEnd) > Date.parse(args.expectedStart) && Date.parse(args.end) > Date.parse(args.start) &&
    (args.expectedStart !== args.start || args.expectedEnd !== args.end)
}
export async function overlayMockSchedule(tx, data, args) {
  const state = await tx.doc(MockCalendar)
  const matches = (event) => args.month ? event.start.startsWith(`${args.month}-`) : event.start.startsWith(`${args.date}T`)
  const summary = ({ id, title, start, end }) => ({ id, title, start, end })
  return { ...data, events: [...data.events.filter((event) => !state.events[event.id]),
    ...Object.values(state.events).filter(matches).map(summary)].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)) }
}
export async function overlayMockEvent(tx, data, args) {
  const event = (await tx.doc(MockCalendar)).events[args.eventId]
  return event ? { simulated: true, source: 'pidot.mock-calendar.v1', timezone: 'Asia/Shanghai', resource: args.resource, event: JSON.parse(JSON.stringify(event)) } : data
}
const canonicalJson = (x) => Array.isArray(x) ? x.map(canonicalJson) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonicalJson(x[k])])) : x
// Host approvals bind the exact management or routine call.
export const HOST_APPROVAL_TOOLS = ['bot_manage', 'routine_propose']
const binding = (item) => HOST_APPROVAL_TOOLS.includes(item.toolName) ? createHash('sha256').update(JSON.stringify([item.taskId, item.conversationId, item.inReplyTo, item.turnId, item.callId, item.botId, item.toolName, canonicalJson(item.arguments), canonicalJson(item.before), item.operationKey])).digest('hex') : item.simulated === false ? createHash('sha256').update(JSON.stringify([item.taskId, item.conversationId, item.inReplyTo, item.turnId, item.callId, item.botId, item.toolName, item.source, ...(item.toolName === FEISHU_CREATE_TOOL ? [feishuCreateHash(item.arguments)] : [feishuMutationHash(item.toolName, item.arguments), item.before]), item.retryOf ?? null, item.duplicateRisk ?? null])).digest('hex') : createHash('sha256').update(JSON.stringify([item.taskId, item.conversationId, item.inReplyTo, item.turnId, item.callId,
  item.arguments.resource, item.arguments.eventId, item.arguments.expectedStart, item.arguments.expectedEnd, item.arguments.start, item.arguments.end, item.before, ...(item.retryOf ? [item.retryOf, item.duplicateRisk] : [])])).digest('hex')
const fail = (code, message) => ({ ok: false, error: { code, message } })
export async function requestCalendarApproval(tx, card, args, entryId, turnId, callId, readEvent, allowAlways = true) {
  const state = await tx.doc(TaskApprovals, card.taskId)
  if (state.activeId !== null) return fail('TASK_AWAITING_APPROVAL', '请先处理原审批事项。')
  // Same logical input across rework: never repeat an explicitly successful effect.
  // Changed parameters have no matching receipt and require a fresh exact approval.
  const sameArgs=(a,b)=>JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort())
  const prior=card.collaboration?.reviewRequired && state.items.find(i=>i.inReplyTo===entryId && i.receipt?.result?.ok && sameArgs(i.arguments,args))
  if(prior) return {...JSON.parse(JSON.stringify(prior.receipt.result)),replayed:true,approvalId:prior.id,notice:'同一原工作已明确成功的相同动作回执；未重新执行。'}
  const current = await overlayMockEvent(tx, readEvent(args), args)
  if (!current?.event) return fail('TOOL_EVENT_NOT_FOUND', '模拟日历中没有该事件。')
  if (current.event.start !== args.expectedStart || current.event.end !== args.expectedEnd) return fail('CALENDAR_CONFLICT', '原时间已变化；请重新读取后提交新方案审批。')
  const item = { taskId: card.taskId, conversationId: card.conversationId, inReplyTo: entryId, turnId, callId,
    toolName: CALENDAR_WRITE_TOOL, arguments: structuredClone(args), before: structuredClone(current.event), simulated: true, allowAlways,
    status: 'pending', decision: null, receipt: null, createdAt: new Date().toISOString() }
  item.binding = binding(item)
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-requested', data: item })
  state.items.push({ ...item, id: audit.id }); state.activeId = audit.id
  return { ok: true, data: { approvalId: audit.id, taskId: card.taskId, status: 'waiting-for-user-approval', simulated: true,
    notice: '精确意图已登记；宿主按当前规则直接执行或等待确认，以最终执行回执为准。' } }
}
export async function requestFeishuApproval(tx, card, args, entryId, turnId, callId, allowAlways = true) {
  const state = await tx.doc(TaskApprovals, card.taskId), d = await tx.doc(FeishuCalendar)
  if (state.activeId !== null) return fail('TASK_AWAITING_APPROVAL', '请先处理原审批事项。')
  if (!normalizeFeishuCreate(args) || !d.binding || d.binding.resource !== args.resource || d.binding.connectionId !== d.identity) return fail('FEISHU_BINDING_DENIED', '真实创建参数或连接已失效。')
  const item = { taskId: card.taskId, conversationId: card.conversationId, botId: card.bot.id, inReplyTo: entryId, turnId, callId, toolName: FEISHU_CREATE_TOOL, arguments: structuredClone(args), source: JSON.parse(JSON.stringify(d.binding)), simulated: false, before: null, allowAlways, status: 'pending', decision: null, receipt: null, createdAt: new Date().toISOString() }
  item.binding = binding(item)
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-requested', data: item })
  state.items.push({ ...item, id: audit.id }); state.activeId = audit.id
  return { ok: true, data: { approvalId: audit.id, taskId: card.taskId, status: 'waiting-for-user-approval', simulated: false, notice: '精确创建意图已登记；宿主按当前规则直接执行或等待确认，以最终回执为准。' } }
}
export async function requestFeishuMutationApproval(tx, card, name, args, entryId, turnId, callId, detail, allowAlways = true) {
  const state = await tx.doc(TaskApprovals, card.taskId), d = await tx.doc(FeishuCalendar)
  if (state.activeId !== null) return fail('TASK_AWAITING_APPROVAL', '请先处理原审批事项。')
  if (!normalizeFeishuMutation(name, args) || !d.binding || d.binding.resource !== args.resource || d.binding.connectionId !== d.identity) return fail('FEISHU_BINDING_DENIED', '真实操作参数或连接已失效。')
  const input = await tx.entry(entryId)
  if (input?.kind !== 'pidot.user' || typeof input.data?.content !== 'string' || !input.data.content.includes(args.eventId)) return fail('FEISHU_TARGET_SELECTION_REQUIRED', '请用户从详情中选择并明确提供精确eventId，再预览批准；不让模型按同名标题或猜测ID选择目标。')
  if (!detail || detail.source?.resource !== args.resource || detail.event?.eventId !== args.eventId || detail.beforeHash !== args.beforeHash || feishuBeforeHash(detail.event) !== args.beforeHash || !supportedFeishuTarget(detail.event, d.binding.calendarId)) return fail('FEISHU_TARGET_NOT_READ', '请先读取精确事件详情及最新beforeHash；仅组织者日历的普通单次事件可编辑/删除，同名须用户选择。')
  const item = { taskId: card.taskId, conversationId: card.conversationId, botId: card.bot.id, inReplyTo: entryId, turnId, callId, toolName: name, arguments: structuredClone(args), source: JSON.parse(JSON.stringify(d.binding)), simulated: false, before: feishuBefore(detail.event), allowAlways, status: 'pending', decision: null, receipt: null, createdAt: new Date().toISOString() }
  item.binding = binding(item)
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-requested', data: item })
  state.items.push({ ...item, id: audit.id }); state.activeId = audit.id
  return { ok: true, data: { approvalId: audit.id, taskId: card.taskId, status: 'waiting-for-user-approval', simulated: false, notice: '精确修改或删除意图已登记；宿主按当前规则直接执行或等待确认，以最终回执为准。' } }
}
export async function requestManagementApproval(tx, card, call, entryId, turnId, operationKey, target, toolName = 'bot_manage', allowAlways = true) {
  const state = await tx.doc(TaskApprovals, card.taskId)
  if (state.activeId !== null) return fail('TASK_AWAITING_APPROVAL', '请先处理原审批事项。')
  const rejected = state.items.find(i => i.toolName === toolName && i.inReplyTo === entryId && i.operationKey === operationKey && i.receipt && !i.receipt.result.ok)
  if (rejected) return { ...JSON.parse(JSON.stringify(rejected.receipt.result)), replayed: true }
  const item = { taskId: card.taskId, conversationId: card.conversationId, botId: card.bot.id, inReplyTo: entryId, turnId, callId: call.id, toolName, arguments: structuredClone(call.arguments), operationKey,
    before: target ? { botId: target.id, name: target.name, description: target.description, configRef: JSON.parse(JSON.stringify(target.configRef)) } : null, simulated: false, allowAlways, status: 'pending', decision: null, receipt: null, createdAt: new Date().toISOString() }
  item.binding = binding(item)
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-requested', data: item })
  state.items.push({ ...item, id: audit.id }); state.activeId = audit.id
  return { ok: true, data: { approvalId: audit.id, taskId: card.taskId, status: 'waiting-for-user-approval', notice: toolName === 'routine_propose' ? '例行任务意图已登记；宿主按当前规则直接执行或等待确认，以最终回执为准。' : 'Bot管理意图已登记；宿主按当前规则直接执行或等待确认，以最终回执为准。' } }
}
/** D-09: an exact "always allow" rule decides the card itself; dispatch, unknown and read-back are unchanged. */
export async function autoApproveByRule(tx, card, item, rule) {
  const decision = { taskId: card.taskId, approvalId: item.id, inReplyTo: item.inReplyTo, decision: 'approved', reason: '按“总是允许”规则自动通过', binding: item.binding, source: 'policy-rule', rule, createdAt: new Date().toISOString() }
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-decided', data: decision })
  item.decision = { ...decision, id: audit.id }
}
export async function finishManagementApproval(tx, card, item, execute) {
  if (item.receipt) return item.receipt.result
  let result
  if (!validApprovalBinding(card, item)) result = fail('APPROVAL_BINDING_MISMATCH', '决定与原Task/操作/参数不匹配，未执行。')
  else if (item.decision.decision === 'inserted') result = fail('APPROVAL_SUPERSEDED', `用户已选择插入并提交新要求，原${item.toolName === 'routine_propose' ? '例行任务提议' : 'Bot管理变更'}未执行；任何新变更必须重新确认。`)
  else if (item.decision.decision === 'rejected') result = fail('APPROVAL_REJECTED', `用户拒绝本次${item.toolName === 'routine_propose' ? '例行任务提议，没有创建计划' : 'Bot管理变更。没有任何改动'}。原因：${item.decision.reason || '未提供'}。不能绕过确认。`)
  else result = await execute()
  return saveApprovalReceipt(tx, card, item, result)
}
export async function waitForApproval(runtime, id, ctx) {
  const watch = await runtime.watchDoc(TaskApprovals, runtime.taskId, ctx)
  const {watchRootStop}=await import('./collaboration.mjs')
  const rootStop=await watchRootStop(runtime,ctx)
  let abort
  try {
    await Promise.race([rootStop.promise,new Promise((resolve, reject) => {
      abort = () => reject(runtime.signal.reason ?? new Error('Invocation stopped'))
      runtime.signal.addEventListener('abort', abort, { once: true })
      if (runtime.signal.aborted) { abort(); return }
      const check = (state) => { if (state?.items.some((item) => item.id === id && (item.receipt || (item.operation ? ['completed', 'retry'].includes(item.operation.resolution?.outcome) : item.decision && (item.decision.decision !== 'inserted' || item.insertion))))) resolve() }
      check(watch.value); watch.start(async (state) => { check(state) })
      void watch.closed.then(() => reject(new Error('Approval watch closed')))
    })])
  } finally { runtime.signal.removeEventListener('abort', abort); await watch.stop(); await rootStop.stop() }
}
// The intent commits BEFORE dispatch; only an explicit tool guarantee can permit safe recovery.
export function validApprovalBinding(card, item) {
  return item.taskId === card.taskId && item.conversationId === card.conversationId && item.decision?.taskId === card.taskId &&
    item.decision?.approvalId === item.id && item.decision?.inReplyTo === item.inReplyTo &&
    ['approved', 'rejected', 'inserted'].includes(item.decision?.decision) && ['authenticated-user', 'policy-rule'].includes(item.decision?.source) &&
    item.decision?.binding === item.binding && binding(item) === item.binding &&
    (!item.retryOf || item.decision.decision !== 'approved' || item.decision.acknowledgeDuplicateRisk === true)
}
export async function saveApprovalReceipt(tx, card, item, result, source = 'tool') {
  if (item.receipt) return item.receipt.result
  const createdAt = new Date().toISOString()
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-executed', data: {
    taskId: card.taskId, approvalId: item.id, inReplyTo: item.inReplyTo, binding: item.binding,
    operationId: item.operation?.id ?? null, result, source, createdAt } })
  item.receipt = { id: audit.id, result, source, createdAt }
  item.status = result.ok ? 'executed' : item.decision?.decision === 'rejected' ? 'rejected' : 'not-executed'
  const state = await tx.doc(TaskApprovals, card.taskId)
  if (state.activeId === item.id) state.activeId = null
  return result
}
export async function markOutcomeUnknown(tx, card, item) {
  if (item.receipt || !item.operation) return
  item.status = 'outcome-unknown'
  if (item.operation.unknownAt) return
  item.operation.unknownAt = new Date().toISOString()
  await tx.appendEntry(card.conversationId, { kind: 'pidot.action-outcome-unknown', data: {
    taskId: card.taskId, approvalId: item.id, operationId: item.operation.id, inReplyTo: item.inReplyTo,
    reason: 'action-outcome-unknown', missing: 'execution-receipt', createdAt: item.operation.unknownAt } })
}
export async function finishCalendarApproval(tx, card, item, check, capabilities = { reliableQuery: false, stableIdempotency: false }) {
  if (item.receipt) return item.receipt.result
  if (item.operation) return { unknown: true } // Never redispatch an existing intent.
  let result
  if (!validApprovalBinding(card, item)) result = fail('APPROVAL_BINDING_MISMATCH', '决定与原Task/操作/参数不匹配，未执行。')
  else if (item.decision.decision === 'inserted') result = fail('APPROVAL_SUPERSEDED', '用户已选择插入并提交新要求，原操作未执行；根据新要求重新规划，任何新操作必须重新精确审批。')
  else if (item.decision.decision === 'rejected') result = fail('APPROVAL_REJECTED', `用户拒绝本次改期。原因：${item.decision.reason || '未提供'}。请调整方案或回复，不能绕过审批。`)
  else {
    result = await check()
    if (result.ok) {
      const state = item.simulated === false ? null : await tx.doc(MockCalendar), current = state ? state.events[item.arguments.eventId] ?? item.before : item.before
      if (JSON.stringify(current) !== JSON.stringify(item.before)) result = fail('CALENDAR_CONFLICT', '等待审批期间事件已变化；须重新读取并重新审批。')
      else {
        const operation = { id: randomUUID(), taskId: card.taskId, approvalId: item.id, inReplyTo: item.inReplyTo,
          binding: item.binding, toolName: item.toolName, arguments: JSON.parse(JSON.stringify(item.arguments)), before: JSON.parse(JSON.stringify(item.before)),
          decision: JSON.parse(JSON.stringify(item.decision)), createdAt: new Date().toISOString(),
          capabilities: structuredClone(item.simulated === false ? feishuCreateCapability : capabilities), ...(item.simulated === false ? { source: JSON.parse(JSON.stringify(item.source)), botId: item.botId, parametersHash: item.toolName === FEISHU_CREATE_TOOL ? feishuCreateHash(item.arguments) : feishuMutationHash(item.toolName, item.arguments) } : {}), verifications: [], resolution: null }
        if (item.simulated === false) operation.idempotencyKey = operation.id
        const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.action-dispatch-intent', data: operation })
        item.operation = { ...operation, intentEntryId: audit.id }; item.status = 'dispatching'
        return { prepared: true, operation: JSON.parse(JSON.stringify(item.operation)) }
      }
    }
  }
  return saveApprovalReceipt(tx, card, item, result)
}

async function guardRealApproval(tx, card, item, bots, sync) {
  if (item.simulated !== false || HOST_APPROVAL_TOOLS.includes(item.toolName)) return
  if (sync) await sync(tx)
  await (await import('./bot-directory.mjs')).assertBotActive(tx, card.bot.id)
  const { ToolAccess, toolSets } = await import('./tools.mjs')
  const d = await tx.doc(FeishuCalendar), sets = toolSets(card, bots, await tx.doc(ToolAccess))
  if (JSON.stringify(d.binding) !== JSON.stringify(item.source) || d.identity !== item.source.connectionId || card.bot.id !== item.botId || !sets.authorized.includes(item.toolName) || !sets.resources.includes(item.arguments.resource)) throw new TaskInputError(409, 'FEISHU_BINDING_DENIED', '原连接、权限或创建预览已失效。')
}
export function outcomeApi({ harness, context, TaskCard, ChatInput, taskKind, get, collaboration, bots, sync }) {
  return { async verifyAction(id, approvalId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['outcome', 'note'].includes(key)) ||
      !['completed', 'unknown', 'retry'].includes(input.outcome) || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000) {
      throw new TaskInputError(400, 'INVALID_ACTION_VERIFICATION', '仅接受 outcome=completed/unknown/retry 与1–2000字符的核实说明note。此入口不接收新参数或批准。')
    }
    await harness.commit(async (tx) => {
      const record = await tx.task(id)
      if (!record || record.kind !== taskKind) throw new TaskInputError(404, 'TASK_NOT_FOUND', 'Task不存在。')
      await assertNotCancelled(tx, id, record)
      if(collaboration) await collaboration.guard(tx,id,{issueDecision:true})
      const state = await tx.doc(TaskApprovals, id), item = state.items.find((entry) => entry.id === approvalId)
      if (!item) throw new TaskInputError(404, 'APPROVAL_NOT_FOUND', '此Task没有该审批事项。')
      const card = await tx.doc(TaskCard, id), operation = item.operation
      await guardRealApproval(tx, card, item, bots, sync)
      if (!validApprovalBinding(card, item) || !operation || operation.binding !== item.binding || operation.approvalId !== item.id ||
        operation.taskId !== id || JSON.stringify(operation.arguments) !== JSON.stringify(item.arguments) ||
        JSON.stringify(operation.decision) !== JSON.stringify(item.decision)) throw new TaskInputError(409, 'ACTION_BINDING_MISMATCH', '原操作和批准绑定不匹配。')
      const intent = await tx.entry(operation.intentEntryId)
      if (intent?.kind !== 'pidot.action-dispatch-intent' || intent.conversationId !== card.conversationId ||
        intent.data.id !== operation.id || intent.data.taskId !== id || intent.data.approvalId !== item.id || intent.data.inReplyTo !== item.inReplyTo ||
        intent.data.toolName !== item.toolName || intent.data.binding !== item.binding || JSON.stringify(intent.data.arguments) !== JSON.stringify(operation.arguments) ||
        JSON.stringify(intent.data.before) !== JSON.stringify(item.before) || JSON.stringify(intent.data.decision) !== JSON.stringify(item.decision)) {
        throw new TaskInputError(409, 'ACTION_BINDING_MISMATCH', '操作意图审计不匹配。')
      }
      if (operation.resolution) {
        if (operation.resolution.outcome === input.outcome && operation.resolution.note === input.note.trim()) return
        throw new TaskInputError(409, 'ACTION_ALREADY_VERIFIED', '原操作已处理，不可覆盖。')
      }
      if (item.receipt || item.status !== 'outcome-unknown' || state.activeId !== approvalId || record.state.checkpoint?.phase !== 'awaitApproval' ||
        record.state.checkpoint.approvalId !== approvalId || record.state.checkpoint.waitingReason !== 'action-outcome-unknown' ||
        record.state.checkpoint.entryId !== item.inReplyTo || (await tx.doc(ChatInput, id)).entryId !== item.inReplyTo ||
        !['pending', 'running'].includes(record.state.status)) throw new TaskInputError(409, 'ACTION_NOT_WAITING', '原操作当前不在结果核实等待，不能处理。')
      if (operation.idempotency?.attempts.some((attempt) => attempt.status === 'retrying')) throw new TaskInputError(409, 'ACTION_RETRY_IN_PROGRESS', '工具正在按原幂等标识恢复，等待本次尝试结束后再核实。')
      if (operation.query?.attempts.some((attempt) => attempt.status === 'querying')) throw new TaskInputError(409, 'ACTION_QUERY_IN_PROGRESS', '工具正在核实原操作，等待本次有限查询结束后再提交用户核实。')
      const last = operation.verifications.at(-1)
      if (input.outcome === 'unknown' && last?.outcome === 'unknown' && last.note === input.note.trim()) return
      const verification = { taskId: id, approvalId, operationId: operation.id, inReplyTo: item.inReplyTo, binding: item.binding,
        outcome: input.outcome, note: input.note.trim(), source: 'authenticated-user-verification', createdAt: new Date().toISOString() }
      const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.action-verified', data: verification })
      const saved = { ...verification, id: audit.id }
      operation.verifications.push(saved)
      if (input.outcome === 'unknown') return // Quietly retain the very same wait.
      operation.resolution = saved
      if (input.outcome === 'retry') {
        const retry = { taskId: id, conversationId: card.conversationId, inReplyTo: item.inReplyTo, turnId: item.turnId, callId: item.callId,
          toolName: item.toolName, arguments: JSON.parse(JSON.stringify(item.arguments)), before: JSON.parse(JSON.stringify(item.before)), simulated: item.simulated !== false, ...(item.simulated === false ? { source: JSON.parse(JSON.stringify(item.source)), botId: item.botId } : {}),
          retryOf: { approvalId: item.id, operationId: operation.id }, duplicateRisk: '原动作可能已经完成，重新执行可能造成重复修改；无法确认原结果。',
          status: 'pending', decision: null, receipt: null, createdAt: new Date().toISOString() }
        retry.binding = binding(retry)
        const requested = await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-requested', data: retry })
        state.items.push({ ...retry, id: requested.id }); state.activeId = requested.id
        operation.resolution.retryApprovalId = requested.id
      }
    }, context)
    harness.resume()
    return get(id)
  } }
}
export function approvalApi({ harness, context, TaskCard, ChatInput, taskKind, get, collaboration, bots, sync }) {
  return { async submitApprovalInsertion(id, approvalId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
      typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000) {
      throw new TaskInputError(400, 'INVALID_APPROVAL_INSERTION', '请输入1–4000字符的新要求。')
    }
    await harness.commit(async (tx) => {
      const record = await tx.task(id)
      if (!record || record.kind !== taskKind) throw new TaskInputError(404, 'TASK_NOT_FOUND', 'Task不存在。')
      await assertNotCancelled(tx, id, record)
      if(collaboration) await collaboration.guard(tx,id,{issueDecision:true})
      const state = await tx.doc(TaskApprovals, id), item = state.items.find((entry) => entry.id === approvalId)
      if (!item) throw new TaskInputError(404, 'APPROVAL_NOT_FOUND', '此Task没有该审批事项。')
      if (item.decision?.decision !== 'inserted') throw new TaskInputError(409, 'APPROVAL_INSERTION_NOT_SELECTED', '必须先在审批卡选择插入，不能更改原决定。')
      if (item.insertion) {
        if (item.insertion.message === input.message) return
        throw new TaskInputError(409, 'APPROVAL_ALREADY_DECIDED', '新要求已提交，不可更改；请等待新一轮审批。')
      }
      const card = await tx.doc(TaskCard, id), slot = await tx.doc(ChatInput, id)
      const audit = await tx.entry(item.decision.id)
      if (state.activeId !== approvalId || record.state.checkpoint?.phase !== 'awaitApproval' ||
        record.state.checkpoint.approvalId !== approvalId || record.state.checkpoint.entryId !== item.inReplyTo ||
        slot.entryId !== item.inReplyTo || !['pending', 'running'].includes(record.state.status) ||
        item.receipt || item.operation || !validApprovalBinding(card, item) || audit?.kind !== 'pidot.approval-decided' ||
        audit.conversationId !== card.conversationId || audit.data.taskId !== id || audit.data.approvalId !== approvalId ||
        audit.data.inReplyTo !== item.inReplyTo || audit.data.binding !== item.binding || audit.data.decision !== 'inserted' || audit.data.source !== 'authenticated-user') {
        throw new TaskInputError(409, 'APPROVAL_UNAVAILABLE', '原审批或输入已失效，不能提交。')
      }
      const steering = await tx.doc(ChatSteering, id)
      const createdAt = new Date().toISOString()
      const entry = await tx.appendEntry(card.conversationId, { kind: 'pidot.user', data: { role: 'user', content: input.message, createdAt } })
      steering.pending.push({ entryId: entry.id, targetInputId: item.inReplyTo, content: input.message })
      item.insertion = { messageId: entry.id, message: input.message, createdAt }
    }, context)
    harness.resume()
    return get(id)
  }, async decideApproval(id, approvalId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['decision', 'reason', 'acknowledgeDuplicateRisk', 'always'].includes(key)) ||
      !['approved', 'rejected', 'inserted'].includes(input.decision) || (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 2000)) || (input.acknowledgeDuplicateRisk !== undefined && input.acknowledgeDuplicateRisk !== true) || (input.always !== undefined && (input.always !== true || input.decision !== 'approved'))) {
      throw new TaskInputError(400, 'INVALID_APPROVAL_DECISION', '仅接受 decision=approved/rejected/inserted 与可选的2000字符以内 reason；不能修改操作参数。')
    }
    await harness.commit(async (tx) => {
      const record = await tx.task(id)
      if (!record || record.kind !== taskKind) throw new TaskInputError(404, 'TASK_NOT_FOUND', 'Task不存在。')
      await assertNotCancelled(tx, id, record)
      if(collaboration) await collaboration.guard(tx,id,{issueDecision:true})
      const state = await tx.doc(TaskApprovals, id), item = state.items.find((item) => item.id === approvalId)
      if (!item) throw new TaskInputError(404, 'APPROVAL_NOT_FOUND', '此Task没有该审批事项。')
      if (item.retryOf && input.decision === 'approved' && input.acknowledgeDuplicateRisk !== true) throw new TaskInputError(400, 'DUPLICATE_RISK_ACK_REQUIRED', '原结果仍未知：请确认可能重复执行，并再次批准下列精确操作。')
      if (!item.retryOf && input.acknowledgeDuplicateRisk !== undefined) throw new TaskInputError(400, 'INVALID_APPROVAL_DECISION', '此事项不是重复操作确认。')
      if (item.decision) {
        if (item.decision.decision === input.decision && item.decision.reason === (input.reason ?? '')) return
        throw new TaskInputError(409, 'APPROVAL_ALREADY_DECIDED', '此事项已决定，不可覆盖或重复执行。')
      }
      if (state.activeId !== approvalId || record.state.checkpoint?.phase !== 'awaitApproval' || record.state.checkpoint.approvalId !== approvalId) throw new TaskInputError(409, 'APPROVAL_UNAVAILABLE', '此审批当前不能处理。')
      const card = await tx.doc(TaskCard, id)
      if (item.taskId !== id || item.conversationId !== card.conversationId || record.state.checkpoint.entryId !== item.inReplyTo ||
        (await tx.doc(ChatInput, id)).entryId !== item.inReplyTo || !['pending', 'running'].includes(record.state.status)) {
        throw new TaskInputError(409, 'APPROVAL_UNAVAILABLE', '原Task、输入或审批归属不匹配，不能处理。')
      }
      await guardRealApproval(tx, card, item, bots, sync)
      if (input.always && (item.allowAlways === false || item.retryOf)) throw new TaskInputError(400, 'POLICY_RULE_HARD', '暂停中或结果未知的重做不能设为总是允许。')
      const decision = { taskId: id, approvalId, inReplyTo: item.inReplyTo, decision: input.decision, reason: input.reason ?? '',
        binding: item.binding, source: 'authenticated-user', ...(input.acknowledgeDuplicateRisk ? { acknowledgeDuplicateRisk: true } : {}), createdAt: new Date().toISOString() }
      const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.approval-decided', data: decision })
      item.decision = { ...decision, id: audit.id }
      // ADR-012 "总是": the same commit writes an exact allow rule for this Bot and tool (PLAN §8.3).
      if (input.always) await addRule(tx, { botId: card.bot.id, match: { tool: item.toolName, ...(item.toolName === 'bot_manage' ? { action: item.arguments.action } : {}) }, effect: 'allow', origin: 'user' })
    }, context)
    harness.resume()
    return get(id)
  } }
}
