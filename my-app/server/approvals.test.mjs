import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { TaskCard } from './tasks.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { TaskApprovals, MockCalendar, CALENDAR_WRITE_TOOL, validCalendarWriteArgs, calendarWriteTool } from './approvals.mjs'
import { CALENDAR_TOOL, CALENDAR_EVENT_TOOL, readMockEvent, CallUsage, ToolAccess } from './tools.mjs'
import { buildTaskContext } from './task-context.mjs'
import { readTaskHistory } from './history-tool.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'approval-fixture', apiKey: 'not-a-key' }
const resource = 'mock:personal', eventId = 'mock-20261020-1'
const args = { resource, eventId, expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00',
  start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' }
const text = (content = '已根据宿主记录继续；模拟数据，不是真实日历。') => ({ mode: 'model', reply: { role: 'assistant', content }, execution: { usage: { input: 4, output: 2, totalTokens: 6 } } })
const call = (name, arguments_, id = name) => ({ type: 'toolCall', id, name, arguments: arguments_ })
const turn = (calls) => ({ ...text('需要具体用户审批。'), toolCalls: calls, assistant: { role: 'assistant', content: calls,
  api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } })
function planner({ writeArgs = args, after, extra = [] } = {}) {
  let count = 0
  return async (message, options) => {
    count++
    if (count === 1) return turn([call(CALENDAR_TOOL, { date: '2026-10-20', resource })])
    if (count === 2) return turn([call(CALENDAR_EVENT_TOOL, { eventId, resource })])
    if (count === 3) return turn([call(CALENDAR_WRITE_TOOL, writeArgs), ...extra])
    return after ? after(message, options, count) : text()
  }
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-approval-')), file = join(dir, 'task.sqlite'), stores = new Set()
  const open = async () => {
    const first = stores.size === 0
    const store = await openTaskStore({ file, bots: listBots(config), modelReply: planner(), ...options })
    if (first) await store.rules.add({ botId: 'calendar', match: { tool: CALENDAR_WRITE_TOOL }, effect: 'ask' })
    stores.add(store); return store
  }
  const close = async (store) => { await store.close(); stores.delete(store) }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store: await open(), open, close }
}
async function until(read, predicate = Boolean) {
  for (let i = 0; i < 600; i++) { const value = await read(); if (predicate(value)) return value; await delay(5) }
  console.error(JSON.stringify(await read(), null, 2)); assert.fail('Approval state did not settle')
}
const waiting = (store, id) => until(() => store.get(id), (task) => task.approvals?.activeId !== null && task.runtime.checkpoint?.phase === 'awaitApproval')
const done = (store, id) => until(() => store.get(id), (task) => task.activeInputId === null && task.queueLength === 0 && task.runtime.checkpoint?.phase === 'awaitInput')
async function begin(store, parameters) {
  const task = await store.create({ botId: 'calendar', ...(parameters ? { parameters } : {}) })
  const input = await store.send(task.taskId, '把2026-10-20方案评审从09:30–10:30改到11:00–12:00，先申请批准。')
  return { id: task.taskId, inputId: input.messageId, task: await waiting(store, task.taskId) }
}
const calendar = (store) => store.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(MockCalendar))), context)
const rejectCode = (code) => (error) => error.code === code

test('iss17 exact simulated intent, receipt and awaitApproval checkpoint commit together; quiet wait leaves calendar unchanged', async (t) => {
  let models = 0; const run = planner()
  const { store } = await fixture(t, { modelReply: (...args) => { models++; return run(...args) } })
  const commits = [], off = store.harness.subscribeCommits((event) => commits.push(event)); t.after(off)
  const { id, task, inputId } = await begin(store), item = task.approvals.items[0]
  assert.equal(calendarWriteTool.requiresConfirmation, true); assert.equal(calendarWriteTool.effect, 'write')
  assert.deepEqual(item.arguments, args); assert.equal(item.before.title, '模拟：方案评审')
  assert.equal(item.before.start, args.expectedStart); assert.equal(item.taskId, id); assert.equal(item.inReplyTo, inputId)
  assert.match(item.binding, /^[a-f0-9]{64}$/); assert.equal(item.decision, null); assert.equal(item.receipt, null)
  assert.ok(commits.some((event) => event.changes.some((change) => change.record?.kind === TaskApprovals.definition.kind && change.value?.activeId === item.id) &&
    event.changes.some((change) => change.type === 'task' && change.value.state.checkpoint?.phase === 'awaitApproval')))
  await delay(80); assert.equal(models, 3); assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 approval executes once, keeps original Task/input/config, exposes actual new time to subsequent calendar reads, and preserves FIFO', async (t) => {
  const contexts = []
  const { store } = await fixture(t, { modelReply: planner({ after: (message, options, count) => {
    contexts.push({ message, context: options.context })
    return count === 4 ? turn([call(CALENDAR_TOOL, { date: '2026-10-20', resource }, 'read-after')]) : text()
  } }) })
  const { id, task, inputId } = await begin(store), item = task.approvals.items[0]
  const queued = await store.send(id, '普通消息，请稍后处理，不是批准。')
  await delay(40); assert.equal((await store.get(id)).runtime.checkpoint.phase, 'awaitApproval')
  assert.deepEqual((await calendar(store)).events, {})
  await Promise.all([store.decideApproval(id, item.id, { decision: 'approved' }), store.decideApproval(id, item.id, { decision: 'approved' })])
  const final = await done(store, id), result = final.approvals.items[0]
  assert.equal(result.status, 'executed'); assert.equal(result.decision.source, 'authenticated-user'); assert.equal(result.receipt.result.ok, true)
  assert.equal(result.receipt.result.data.event.start, args.start); assert.equal((await calendar(store)).events[eventId].start, args.start)
  assert.deepEqual(final.configRef, task.configRef); assert.deepEqual(final.parameters, task.parameters)
  assert.equal(final.messages.find((item) => item.id === inputId).deliveryStatus, 'completed')
  assert.equal(final.messages.find((item) => item.id === queued.messageId).deliveryStatus, 'completed')
  const reread = final.messages.find((item) => item.callId === 'read-after' && item.role === 'tool')
  assert.equal(reread.result.data.events.find((item) => item.id === eventId).start, args.start)
  assert.ok(contexts[0].context.messages.some((item) => JSON.stringify(item).includes('pidot.mock-calendar.v1') && JSON.stringify(item).includes('approvalId')))
  const audits = await store.harness.commit(async (tx) => (await tx.scanEntries({ conversationId: task.conversationId, order: 'ascending' }, 100)).items, context)
  assert.equal(audits.filter((item) => item.kind === 'pidot.approval-decided').length, 1)
  assert.equal(audits.filter((item) => item.kind === 'pidot.approval-executed').length, 1)
  assert.equal(final.callUsage.toolCalls, 5) // two reads + intent + authorized execution + reread
  await store.decideApproval(id, item.id, { decision: 'approved' }); assert.equal((await store.get(id)).callUsage.toolCalls, 5)
})

test('iss17 rejection reason reaches original model context, leaves data unchanged, and is not Task failure', async (t) => {
  let resumed
  const { store } = await fixture(t, { modelReply: planner({ after: (_message, options) => { resumed = options.context; return text('收到拒绝，保持会议不变，建议下午另约。') } }) })
  const { id, task } = await begin(store)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'rejected', reason: '11点有事，先别修改；可以考虑下午。' })
  const final = await done(store, id)
  assert.equal(final.approvals.items[0].status, 'rejected'); assert.equal(final.approvals.items[0].receipt.result.error.code, 'APPROVAL_REJECTED')
  assert.match(JSON.stringify(resumed.messages), /11点有事/); assert.deepEqual((await calendar(store)).events, {})
  assert.equal(final.runtime.checkpoint.lastOutcome, 'completed'); assert.equal(final.callUsage.toolCalls, 3)
})

test('iss17 rejects cross-Task decisions, unknown IDs, conflicting repeated decisions and payload parameter overrides', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store), approvalId = task.approvals.activeId
  const other = await store.create({ botId: 'calendar' })
  await assert.rejects(store.decideApproval(other.taskId, approvalId, { decision: 'approved' }), rejectCode('APPROVAL_NOT_FOUND'))
  await assert.rejects(store.decideApproval(id, approvalId + 999, { decision: 'approved' }), rejectCode('APPROVAL_NOT_FOUND'))
  for (const input of [{ decision: 'yes' }, { decision: 'approved', start: args.end }, { decision: 'approved', source: 'authenticated-user' }, { decision: 'rejected', reason: 1 }, { decision: 'rejected', reason: 'x'.repeat(2001) }, []]) {
    await assert.rejects(store.decideApproval(id, approvalId, input), rejectCode('INVALID_APPROVAL_DECISION'))
  }
  await store.decideApproval(id, approvalId, { decision: 'rejected', reason: '不要改' }); await done(store, id)
  await assert.rejects(store.decideApproval(id, approvalId, { decision: 'approved' }), rejectCode('APPROVAL_ALREADY_DECIDED'))
  await assert.rejects(store.decideApproval(id, approvalId, { decision: 'rejected', reason: '新原因' }), rejectCode('APPROVAL_ALREADY_DECIDED'))
})

test('iss17 permission revoked while waiting is checked again before execution', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  await store.revokeTool('calendar', CALENDAR_WRITE_TOOL)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'approved' })
  const final = await done(store, id)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'TOOL_NOT_AUTHORIZED')
  assert.deepEqual((await calendar(store)).events, {}); assert.equal(final.callUsage.toolCalls, 3)
})

test('iss17 current Task resources and identity are rechecked rather than treating approval as authorization', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  await store.harness.commit(async (tx) => { (await tx.doc(ToolAccess)).assignments.calendar.resources = [] }, context)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'approved' })
  const final = await done(store, id)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'TOOL_RESOURCE_DENIED'); assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 approved parameters are immutable; host-side altered intent cannot consume old approval', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  await store.harness.commit(async (tx) => { const state = await tx.doc(TaskApprovals, id); state.items[0].arguments.start = '2026-10-20T11:30:00+08:00' }, context)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'approved' })
  const final = await done(store, id)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'APPROVAL_BINDING_MISMATCH'); assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 rechecks tool-call budget after approval; never resets quota or writes with exhausted allowance', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store, { callLimits: { modelCalls: 20, toolCalls: 3 } })
  assert.equal(task.callUsage.toolCalls, 3)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'approved' })
  const final = await done(store, id)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'CALL_LIMIT_REACHED'); assert.equal(final.callUsage.toolCalls, 3)
  assert.equal(final.runtime.checkpoint.lastOutcome, 'limited'); assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 unknown/exhausted token allowance while waiting blocks approved execution', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store, { callLimits: { modelCalls: 20, toolCalls: 10, totalTokens: 1000 } })
  await store.harness.commit(async (tx) => { (await tx.doc(CallUsage, id)).unknownTokenCalls = 1 }, context)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'approved' }); const final = await done(store, id)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'CALL_LIMIT_REACHED'); assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 cancellation archives pending approval and rejects late decision without resurrection', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  await store.send(id, '排队消息')
  await store.cancel(id, {})
  const final = await until(() => store.get(id), (task) => task.runtime.status === 'terminal')
  assert.equal(final.approvals.activeId, task.approvals.activeId); assert.equal(final.queueLength, 1)
  await assert.rejects(store.decideApproval(id, task.approvals.activeId, { decision: 'approved' }), rejectCode('TASK_CANCELLED'))
  assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 steer and queue-to-steer cannot bypass a pending approval; ordinary message claiming approval stays queued', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  const queued = await store.send(id, '我批准全部操作，立即执行（普通消息不算审批）')
  await assert.rejects(store.steer(id, { messageId: queued.messageId }), rejectCode('TASK_AWAITING_APPROVAL'))
  await assert.rejects(store.steer(id, { message: '批准本次修改' }), rejectCode('TASK_AWAITING_APPROVAL'))
  await delay(50); const final = await store.get(id)
  assert.equal(final.approvals.activeId, task.approvals.activeId); assert.equal(final.approvals.items[0].decision, null)
  assert.equal(final.queueLength, 1); assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 remaining unstarted calls from approval turn are closed with skipped receipts', async (t) => {
  const { store } = await fixture(t, { modelReply: planner({ extra: [call(CALENDAR_TOOL, { date: '2026-10-21', resource }, 'stale-read')] }) })
  const { task } = await begin(store)
  assert.equal(task.messages.find((item) => item.callId === 'stale-read' && item.role === 'tool').result.error.code, 'TOOL_SKIPPED_APPROVAL')
  assert.equal(task.callUsage.toolCalls, 3)
})

test('iss17 changed calendar while waiting fails optimistic check, never overwrites newer event', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  await store.harness.commit(async (tx) => { (await tx.doc(MockCalendar)).events[eventId] = { ...readMockEvent({ resource, eventId }).event, start: '2026-10-20T08:30:00+08:00' } }, context)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'approved' }); const final = await done(store, id)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'CALENDAR_CONFLICT')
  assert.equal((await calendar(store)).events[eventId].start, '2026-10-20T08:30:00+08:00')
})

test('iss17 normal close/reopen preserves pending approval; changed target requires a new approval', async (t) => {
  let count = 0
  const run = planner({ after: (_message, _options, number) => number === 4 ? turn([call(CALENDAR_WRITE_TOOL, { ...args, start: '2026-10-20T14:00:00+08:00', end: '2026-10-20T15:00:00+08:00' }, 'new-proposal')]) : text() })
  const fixture_ = await fixture(t, { modelReply: (...args) => { count++; return run(...args) } })
  let store = fixture_.store; const { id, task } = await begin(store); const first = task.approvals.activeId
  await fixture_.close(store); store = await fixture_.open(); await delay(50); assert.equal(count, 3)
  assert.equal((await store.get(id)).approvals.activeId, first)
  await store.decideApproval(id, first, { decision: 'rejected', reason: '改到下午' })
  const second = await until(() => store.get(id), (task) => task.approvals.items.length === 2)
  assert.notEqual(second.approvals.activeId, first); assert.equal(second.approvals.items[1].decision, null)
  assert.deepEqual((await calendar(store)).events, {})
  await store.decideApproval(id, second.approvals.activeId, { decision: 'approved' }); await done(store, id)
  assert.equal((await calendar(store)).events[eventId].start, '2026-10-20T14:00:00+08:00')
})

test('iss17 Task history and context include bounded approval decisions and successful receipts', async (t) => {
  const { store } = await fixture(t), { id, task, inputId } = await begin(store)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'rejected', reason: '今天不改' }); const final = await done(store, id)
  const history = await store.harness.commit(async (tx) => {
    const card = await tx.doc(TaskCard, id), modelContext = await buildTaskContext(tx, card, inputId)
    const result = await readTaskHistory(tx, card, { entryId: final.approvals.items[0].decision.id, limit: 1024 }, inputId, final.toolSets)
    return { modelContext, result }
  }, context)
  assert.match(JSON.stringify(history.modelContext.messages), /今天不改/)
  assert.match(JSON.stringify(history.result), /approval/)
})

test('iss17 strict write schema disallows permission text, extra fields, invalid dates, inverted duration and no-op', () => {
  assert.equal(validCalendarWriteArgs(args), true)
  for (const bad of [{ ...args, approval: true }, { ...args, resource: 'real:personal' }, { ...args, start: '2026-02-30T11:00:00+08:00' },
    { ...args, end: args.start }, { ...args, start: args.expectedStart, end: args.expectedEnd }, { ...args, start: '2026-10-20T11:00:00Z' },
    { ...args, start: '2026-10-20T29:00:00+08:00' }, { ...args, expectedEnd: '2026-10-21T10:30:00+08:00' }]) assert.equal(Boolean(validCalendarWriteArgs(bad)), false)
})

test('iss17 HTTP endpoint requires authentication and POST, rejects changed parameters, and consumes one decision', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  const server = createApiServer({ token: 'approval-test-only-token', tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${id}/approvals/${task.approvals.activeId}/decide`
  const request = (body, headers = { Authorization: 'Bearer approval-test-only-token' }, method = 'POST') => fetch(url, { method,
    headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  assert.equal((await request({ decision: 'approved' }, {})).status, 401)
  assert.equal((await request(null, undefined, 'GET')).status, 405)
  assert.equal((await request({ decision: 'approved', parameters: args })).status, 400)
  assert.equal((await request({ decision: 'rejected', reason: '不改' })).status, 200)
  assert.equal((await request({ decision: 'rejected', reason: '不改' })).status, 200)
  assert.equal((await request({ decision: 'approved' })).status, 409)
  await done(store, id); assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 native Task/Bot identity is rechecked on approval, not inherited from intent', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  await store.harness.commit(async (tx) => { (await tx.doc(TaskCard, id)).configRef.botId = 'chief' }, context)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'approved' }); const final = await done(store, id)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'TOOL_IDENTITY_DENIED'); assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 cancelling concurrently with approval cannot write after cancellation committed', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store)
  const outcomes = await Promise.allSettled([store.cancel(id, {}), store.decideApproval(id, task.approvals.activeId, { decision: 'approved' })])
  const final = await until(() => store.get(id), (task) => task.runtime.status === 'terminal')
  assert.ok(outcomes[0].status === 'fulfilled'); assert.ok(final.cancellation)
  assert.deepEqual((await calendar(store)).events, {})
  await assert.rejects(store.decideApproval(id, task.approvals.activeId, { decision: 'approved' }), rejectCode('TASK_CANCELLED'))
})

test('iss17 moved simulated event disappears from old day and is readable on its new date by another Task', async (t) => {
  const { store } = await fixture(t, { modelReply: planner({ writeArgs: { ...args, start: '2026-10-21T11:00:00+08:00', end: '2026-10-21T12:00:00+08:00' } }) })
  const { id, task } = await begin(store)
  await store.decideApproval(id, task.approvals.activeId, { decision: 'approved' }); await done(store, id)
  const { overlayMockSchedule, overlayMockEvent } = await import('./approvals.mjs')
  await store.harness.commit(async (tx) => {
    const old = await overlayMockSchedule(tx, (await import('./tools.mjs')).readMockSchedule({ date: '2026-10-20', resource }), { date: '2026-10-20', resource })
    const next = await overlayMockSchedule(tx, (await import('./tools.mjs')).readMockSchedule({ date: '2026-10-21', resource }), { date: '2026-10-21', resource })
    assert.ok(!old.events.some((event) => event.id === eventId)); assert.ok(next.events.some((event) => event.id === eventId))
    const detail = await overlayMockEvent(tx, readMockEvent({ resource, eventId }), { resource, eventId })
    assert.equal(detail.event.start, '2026-10-21T11:00:00+08:00')
  }, context)
})

test('iss17 pinned active Skill and explicit Task constraints survive approval wait; compaction restoration keeps exact outcome and reason', async (t) => {
  const { ContextCompaction } = await import('./context-compaction.mjs')
  const { TaskSkills } = await import('./skills.mjs')
  const { store } = await fixture(t)
  const task = await store.create({ botId: 'calendar', taskState: { goal: '审批改期', constraints: ['不修改其他会议'] } })
  await store.activateSkill(task.taskId, { skillId: 'calendar-conflict-analysis' })
  const original = await store.get(task.taskId)
  const input = await store.send(task.taskId, '把方案评审改到11点，等审批')
  const pending = await waiting(store, task.taskId)
  assert.deepEqual(pending.skillState.active, original.skillState.active)
  await store.decideApproval(task.taskId, pending.approvals.activeId, { decision: 'rejected', reason: '保持原状，明天再安排' })
  const final = await done(store, task.taskId)
  await store.harness.commit(async (tx) => {
    const card = await tx.doc(TaskCard, task.taskId), compaction = await tx.doc(ContextCompaction, task.taskId)
    const before = await buildTaskContext(tx, card, input.messageId)
    compaction.revision = 1
    compaction.coveredKeys = before.segments.map((segment) => segment.key)
    compaction.latest = { summary: '历史摘要省略了审批内容。', createdAt: new Date().toISOString() }
    const after = await buildTaskContext(tx, card, input.messageId)
    assert.match(after.systemPrompt, /宿主模拟审批记录/); assert.match(after.systemPrompt, /保持原状，明天再安排/)
    assert.match(after.systemPrompt, /APPROVAL_REJECTED/); assert.match(after.systemPrompt, /不修改其他会议/)
    assert.equal((await tx.doc(TaskSkills, task.taskId)).active.length, 0) // normal phase completion, not approval wait
  }, context)
  assert.equal(final.approvals.items[0].status, 'rejected')
})

test('iss17 an unassigned write tool remains unavailable to an existing Task', async (t) => {
  const bots = listBots(config); bots.find((bot) => bot.id === 'calendar').defaults.tools = bots.find((bot) => bot.id === 'calendar').defaults.tools.filter((name) => name !== CALENDAR_WRITE_TOOL)
  const { store } = await fixture(t, { bots })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '试图越权改期')
  const final = await done(store, task.taskId)
  assert.ok(!final.parameters.tools.includes(CALENDAR_WRITE_TOOL)); assert.ok(!final.toolSets.displayed.includes(CALENDAR_WRITE_TOOL))
  const receipt = final.messages.find((item) => item.toolName === CALENDAR_WRITE_TOOL && item.role === 'tool')
  assert.equal(receipt.result.error.code, 'TOOL_NOT_AUTHORIZED'); assert.equal(final.approvals.items.length, 0)
  assert.deepEqual((await calendar(store)).events, {})
})

test('iss17 successful write invalidates compacted old calendar read replay so reread returns current data', async (t) => {
  const { ContextCompaction } = await import('./context-compaction.mjs')
  let store, taskId, reads = 0
  const run = planner({ after: async (_message, _options, count) => {
    if (count === 4) {
      const current = await store.get(taskId)
      const original = current.messages.find((item) => item.role === 'tool' && item.toolName === CALENDAR_TOOL)
      await store.harness.commit(async (tx) => { (await tx.doc(ContextCompaction, taskId)).coveredKeys = [`turn:${original.turnId}`] }, context)
      return turn([call(CALENDAR_TOOL, { date: '2026-10-20', resource }, 'current-after-compaction')])
    }
    return text()
  } })
  const fixture_ = await fixture(t, { modelReply: run, toolImpl: async (args) => { reads++; return (await import('./tools.mjs')).readMockSchedule(args) } })
  store = fixture_.store; const started = await begin(store); taskId = started.id
  await store.decideApproval(taskId, started.task.approvals.activeId, { decision: 'approved' })
  const final = await done(store, taskId)
  const receipt = final.messages.find((item) => item.role === 'tool' && item.callId === 'current-after-compaction')
  assert.equal(reads, 2); assert.equal(receipt.result.replay, undefined)
  assert.equal(receipt.result.calendarRevision, 1)
  assert.equal(receipt.result.data.events.find((event) => event.id === eventId).start, args.start)
})

test('iss17 concurrent Task approvals share simulated calendar and refuse stale second write', async (t) => {
  const models = new Map()
  const { store } = await fixture(t, { modelReply: (message, options) => {
    if (!models.has(message)) models.set(message, planner())
    return models.get(message)(message, options)
  } })
  const first = await begin(store), other = await store.create({ botId: 'calendar' })
  await store.send(other.taskId, '另一Task申请同一个会议改期')
  const second = await waiting(store, other.taskId)
  await Promise.all([store.decideApproval(first.id, first.task.approvals.activeId, { decision: 'approved' }),
    store.decideApproval(other.taskId, second.approvals.activeId, { decision: 'approved' })])
  const results = await Promise.all([done(store, first.id), done(store, other.taskId)])
  const receipts = results.map((task) => task.approvals.items[0].receipt.result)
  assert.equal(receipts.filter((result) => result.ok).length, 1)
  assert.equal(receipts.find((result) => !result.ok).error.code, 'CALENDAR_CONFLICT')
  assert.equal((await calendar(store)).revision, 1)
})

test('approval insertion locks the card durably before text, submits once, and requires a new exact approval', async (t) => {
  const requests = [], run = planner({ after: (_message, _options, n) => n === 4 ? turn([call(CALENDAR_WRITE_TOOL, { ...args, start: '2026-10-20T14:00:00+08:00', end: '2026-10-20T15:00:00+08:00' }, 'inserted-proposal')]) : text() })
  const f = await fixture(t, { modelReply: (message, options) => { requests.push(options.context); return run(message, options) } })
  let store = f.store
  const { id, task } = await begin(store), first = task.approvals.activeId
  await assert.rejects(store.submitApprovalInsertion(id, first, { message: '改到下午' }), rejectCode('APPROVAL_INSERTION_NOT_SELECTED'))
  await store.decideApproval(id, first, { decision: 'inserted' })
  await store.decideApproval(id, first, { decision: 'inserted' })
  for (const decision of ['approved', 'rejected']) await assert.rejects(store.decideApproval(id, first, { decision }), rejectCode('APPROVAL_ALREADY_DECIDED'))
  await store.send(id, '排队后续问题')
  await delay(60); assert.equal(requests.length, 3); assert.deepEqual((await calendar(store)).events, {})
  await f.close(store); store = await f.open(); await delay(60)
  assert.equal((await store.get(id)).waiting.status, 'insertion-pending'); assert.equal(requests.length, 3)
  await assert.rejects(store.submitApprovalInsertion(id, first, { message: ' ' }), rejectCode('INVALID_APPROVAL_INSERTION'))
  const message = '请将方案评审改到14:00–15:00，重新申请审批。'
  await store.submitApprovalInsertion(id, first, { message })
  const second = await until(() => store.get(id), (task) => task.approvals.items.length === 2)
  const next = second.approvals.activeId
  assert.notEqual(next, first); assert.equal(second.approvals.items[0].receipt.result.error.code, 'APPROVAL_SUPERSEDED')
  assert.equal(second.approvals.items[1].decision, null); assert.deepEqual((await calendar(store)).events, {})
  assert.ok(second.taskState.constraints.includes(message)); assert.match(JSON.stringify(requests[3]), /14:00/)
  assert.equal(second.queueLength, 1)
  await store.submitApprovalInsertion(id, first, { message })
  await assert.rejects(store.submitApprovalInsertion(id, first, { message: '再次改主意' }), rejectCode('APPROVAL_ALREADY_DECIDED'))
  await assert.rejects(store.decideApproval(id, first, { decision: 'approved' }), rejectCode('APPROVAL_ALREADY_DECIDED'))
  await store.decideApproval(id, next, { decision: 'approved' }); const final = await done(store, id)
  assert.equal((await calendar(store)).revision, 1); assert.equal((await calendar(store)).events[eventId].start, '2026-10-20T14:00:00+08:00')
  assert.equal(final.messages.filter((m) => m.content === message && m.role === 'user').length, 1)
})

test('approval three-way race admits exactly one immutable choice', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store), approvalId = task.approvals.activeId
  const outcomes = await Promise.allSettled(['inserted', 'approved', 'rejected'].map((decision) => store.decideApproval(id, approvalId, { decision })))
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1)
  for (const outcome of outcomes.filter((x) => x.status === 'rejected')) assert.equal(outcome.reason.code, 'APPROVAL_ALREADY_DECIDED')
})

test('cancelled insertion cannot submit, resume the Task, or write the calendar', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store), approvalId = task.approvals.activeId
  await store.decideApproval(id, approvalId, { decision: 'inserted' }); await store.cancel(id, {})
  await assert.rejects(store.submitApprovalInsertion(id, approvalId, { message: '继续执行' }), rejectCode('TASK_CANCELLED'))
  assert.deepEqual((await calendar(store)).events, {})
})

test('approval insertion HTTP authenticates and validates method, target and payload', async (t) => {
  const { store } = await fixture(t), { id, task } = await begin(store), approvalId = task.approvals.activeId
  const server = createApiServer({ token: 'insert-test-token', tasks: store })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${id}/approvals/${approvalId}/insert`
  const headers = { Authorization: 'Bearer insert-test-token', 'Content-Type': 'application/json' }
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(url, { headers })).status, 405)
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: '新要求' }) })).status, 409)
  await store.decideApproval(id, approvalId, { decision: 'inserted' })
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: '' }) })).status, 400)
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: '新要求' }) })).status, 200)
})
