// Stop only after a real durable commit; parent SIGKILLs and reopens this DB.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
import { TaskApprovals } from '../approvals.mjs'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { readMockSchedule, readMockEvent } from '../tools.mjs'
const [dir, scenario] = process.argv.slice(2)
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'waiting-recovery-fixture', apiKey: 'fixture-only' }
const args = { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' }
const text = (content = 'fixture') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 6, input: 4, output: 2 } } })
const tool = (name, args) => { const calls = [{ type: 'toolCall', id: `call-${name}`, name, arguments: args }]; return { ...text(''), toolCalls: calls, assistant: { role: 'assistant', content: calls, provider: 'bb-api', api: 'openai-completions', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } } }
let count = 0, saved, stopped = false
const log = (kind) => appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ kind }) + '\n')
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => {
  log('model'); count++
  if (scenario.startsWith('blocker')) return tool('report_blocker', { question: '要处理哪天的模拟日程？', requiredInformation: '日期和时区', assignee: 'user' })
  if (scenario === 'limits-unknown') { const result = tool('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }); delete result.execution.usage; return result }
  if (count === 1) return tool('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' })
  if (count === 2) return tool('calendar_read_event', { eventId: args.eventId, resource: 'mock:personal' })
  if (count === 3) return tool('calendar_reschedule_event', args)
  return text('原执行最终结果')
}, toolImpl: async (args) => { log('schedule'); return readMockSchedule(args) }, eventImpl: async (args) => { log('event'); return readMockEvent(args) } })
const limits = { modelCalls: ['limits-pending', 'limits-raised', 'limits-cancelled', 'blocker-budget'].includes(scenario) ? 1 : 15, toolCalls: scenario === 'approval-budget' ? 3 : 15, ...(['limits-token', 'limits-unknown'].includes(scenario) ? { totalTokens: 6 } : {}) }
const task = await store.create({ botId: 'calendar', title: `ISS20 ${scenario}`, parameters: { callLimits: limits }, taskState: { goal: '只处理模拟日历', constraints: ['所有改期需精确批准'] } })
function stop(changes) {
  if (stopped) return
  stopped = true; writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ ...saved, changes })); process.kill(process.pid, 'SIGSTOP')
}
store.harness.subscribeCommits(({ changes }) => {
  if (!saved) return
  const has = (kind) => changes.some((x) => x.type === 'entry' && x.value.kind === kind)
  const record = changes.find((x) => x.type === 'task' && x.value.id === task.taskId)
  if (scenario === 'blocker-answered' && has('pidot.blocker-resolved')) stop(changes)
  if (scenario === 'blocker-continued' && record?.value.state.checkpoint?.resolvedBlockerId) stop(changes)
  if (['approval-approved', 'approval-rejected', 'approval-revoked', 'approval-budget', 'approval-cancelled-response', 'approval-binding'].includes(scenario) && has('pidot.approval-decided')) stop(changes)
  if (scenario === 'approval-inserted' && has('pidot.approval-decided')) stop(changes)
  if (scenario === 'approval-insert-submitted' && changes.some((x) => x.type === 'entry' && x.value.kind === 'pidot.user' && x.value.data.content === '改到下午，重新审批')) stop(changes)
  if (scenario === 'approval-executed' && has('pidot.approval-executed')) stop(changes)
  if (scenario === 'limits-raised' && has('pidot.call-limits')) stop(changes)
  if (['approval-cancelled', 'blocker-cancelled', 'limits-cancelled'].includes(scenario) && has('pidot.task-cancelled')) stop(changes)
})
const input = await store.send(task.taskId, scenario.startsWith('blocker') ? '请整理模拟日程，日期待确认。' : '将2026-10-20方案评审从09:30–10:30改到11:00–12:00，先申请精确审批。')
let waiting
for (let n = 0; n < 1000; n++) {
  waiting = await store.get(task.taskId)
  if (['awaitBlocker', 'awaitApproval'].includes(waiting.runtime.checkpoint?.phase) || waiting.runtime.checkpoint?.lastOutcome === 'limited') break
  await delay(5)
  if (n === 999) throw new Error('Waiting checkpoint not reached')
}
saved = { scenario, taskId: task.taskId, conversationId: task.conversationId, inputId: input.messageId, waiting }
writeFileSync(join(dir, 'waiting.json'), JSON.stringify(saved))
if (['blocker-pending', 'approval-pending', 'limits-pending', 'limits-token', 'limits-unknown', 'blocker-budget'].includes(scenario)) stop([])
else if (['approval-inserted', 'approval-insert-submitted'].includes(scenario)) {
  await store.decideApproval(task.taskId, waiting.approvals.activeId, { decision: 'inserted' })
  if (scenario === 'approval-insert-submitted') await store.submitApprovalInsertion(task.taskId, waiting.approvals.activeId, { message: '改到下午，重新审批' })
}
else if (scenario.startsWith('blocker') && !scenario.endsWith('cancelled')) await store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: '2026-10-20，Asia/Shanghai' })
else if (scenario.startsWith('limits') && !scenario.endsWith('cancelled')) await store.raiseLimits(task.taskId, { modelCalls: 5 })
else if (scenario.endsWith('cancelled')) await store.cancel(task.taskId, {})
else {
  if (scenario === 'approval-binding') await store.harness.commit(async (tx) => { (await tx.doc(TaskApprovals, task.taskId)).items[0].arguments.start = '2026-10-20T14:30:00+08:00' }, ctx)
  if (scenario === 'approval-revoked') await store.revokeTool('calendar', 'calendar_reschedule_event')
  await store.decideApproval(task.taskId, waiting.approvals.activeId, { decision: scenario === 'approval-rejected' ? 'rejected' : 'approved', reason: '重启前保存的决定' })
}
setTimeout(() => { console.error('Expected stop not reached'); process.exit(3) }, 12000)
