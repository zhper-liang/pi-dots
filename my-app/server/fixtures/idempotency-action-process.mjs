import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
import { TaskCard } from '../tasks.mjs'
import { TaskApprovals } from '../approvals.mjs'
import { ToolAccess, CallUsage } from '../tools.mjs'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
const [dir, scenario = 'effect'] = process.argv.slice(2)
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'unknown-action-fixture', apiKey: 'fixture-only' }
const args = { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' }
const text = { mode: 'model', reply: { content: '继续原工作' }, execution: { usage: { totalTokens: 6, input: 4, output: 2 } } }
const realDate = Date, clockMode = process.env.PIDOT_IDEMPOTENCY_GUARD
if (['expired', 'future'].includes(clockMode)) { const offset = clockMode === 'expired' ? -86410000 : 86400000; globalThis.Date = class extends realDate { constructor(...args) { super(...(args.length ? args : [realDate.now() + offset])) }; static now() { return realDate.now() + offset } } }
let count = 0, identity, stopped = false
function stop(extra = {}) { if (stopped) return; stopped = true; writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ ...identity, ...extra })); process.kill(process.pid, 'SIGSTOP') }
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), calendarQueryEnabled: process.env.PIDOT_NO_QUERY !== '1', calendarIdempotencyEnabled: true, bots: listBots(config), modelReply: async () => {
  count++
  const [name, parameters] = count === 1 ? ['calendar_read_schedule', { date: '2026-10-20', resource: args.resource }] : count === 2 ? ['calendar_read_event', { eventId: args.eventId, resource: args.resource }] : ['calendar_reschedule_event', args]
  if (count > 3) return text
  const calls = [{ type: 'toolCall', id: `call-${count}`, name, arguments: parameters }]
  return { ...text, reply: { content: '' }, toolCalls: calls, assistant: { role: 'assistant', content: calls, provider: 'fixture', api: 'openai-completions', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}, calendarWriteImpl: async (operation, { execute }) => {
  if (scenario === 'intent') { await mutate(operation); stop({ operation, boundary: 'intent-before-effect' }) }
  const result = await execute()
  if (scenario === 'effect') { await mutate(operation); stop({ operation, result, boundary: 'effect-before-receipt' }) }
  if (['verification', 'retry', 'cancel', 'receipt'].includes(scenario)) {
    if (scenario === 'receipt') return result
    throw new Error('Transport result lost after effect')
  }
  return result
} })
async function mutate(operation) {
  const mode = process.env.PIDOT_IDEMPOTENCY_GUARD
  if (!mode) return
  await store.harness.commit(async (tx) => {
    const card = await tx.doc(TaskCard, operation.taskId), item = (await tx.doc(TaskApprovals, operation.taskId)).items[0]
    if (mode.startsWith('revoked')) (await tx.doc(ToolAccess)).revoked.calendar = [mode === 'revoked-write' ? 'calendar_reschedule_event' : 'calendar_read_event']
    const access = await tx.doc(ToolAccess)
    if (mode === 'resource') access.assignments.calendar.resources = []
    if (mode === 'pool-write' || mode === 'bot-write') access.assignments.calendar.tools = access.assignments.calendar.tools.filter((n) => n !== 'calendar_reschedule_event')
    if (mode === 'pool-resource' || mode === 'bot-resource') access.assignments.calendar.resources = []
    if (mode === 'budget') card.parameters.callLimits.toolCalls = 4
    if (mode === 'tokens') { card.parameters.callLimits.totalTokens = 999; (await tx.doc(CallUsage, operation.taskId)).unknownTokenCalls = 1 }
    if (mode === 'model-limit') card.parameters.callLimits.modelCalls = 3
    if (mode === 'identity') card.bot.id = 'chief'
    if (mode === 'binding') item.operation.arguments.start = '2026-10-20T11:30:00+08:00'
    if (mode === 'capabilities') item.operation.capabilities.idempotency.windowMs = 999999999
    if (mode === 'event-changed') { const { MockCalendar } = await import('../approvals.mjs'); (await tx.doc(MockCalendar)).events[item.arguments.eventId].title = '后续编辑过的会议' }
  }, ctx)
}
const task = await store.create({ botId: 'calendar', parameters: { callLimits: { modelCalls: 15, toolCalls: 15 } } })
const input = await store.send(task.taskId, '读取列表和详情后，将2026-10-20方案评审从09:30–10:30改到11:00–12:00并等待审批。')
let waiting
for (let n = 0; n < 1000; n++) { waiting = await store.get(task.taskId); if (waiting.runtime.checkpoint?.phase === 'awaitApproval') break; await delay(5) }
identity = { taskId: task.taskId, inputId: input.messageId, waiting, scenario }
store.harness.subscribeCommits(({ changes }) => {
  const has = (kind) => changes.some((x) => x.type === 'entry' && x.value.kind === kind)
  if (scenario === 'receipt' && has('pidot.approval-executed')) stop({ boundary: 'receipt-saved' })
  if (['verification', 'retry'].includes(scenario) && has('pidot.action-verified')) stop({ boundary: 'verification-saved' })
  if (scenario === 'cancel' && has('pidot.task-cancelled')) stop({ boundary: 'cancel-saved' })
})
await store.decideApproval(task.taskId, waiting.approvals.activeId, { decision: 'approved', reason: '批准原精确操作' })
if (['verification', 'retry', 'cancel'].includes(scenario)) {
  for (let n = 0; n < 1000; n++) { const current = await store.get(task.taskId); if (current.approvals.items[0].status === 'outcome-unknown') break; await delay(5) }
  if (scenario === 'cancel') await store.cancel(task.taskId, {})
  else await store.verifyAction(task.taskId, waiting.approvals.activeId, { outcome: scenario === 'retry' ? 'retry' : 'completed', note: '进程中断前保存的认证核实' })
}
setTimeout(() => { console.error('Expected boundary not reached'); process.exit(3) }, 12000)
