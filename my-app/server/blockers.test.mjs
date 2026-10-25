import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { BLOCKER_TOOL, TaskBlockers, validBlockerArgs } from './blockers.mjs'
import { CALENDAR_TOOL, readMockSchedule, checkToolCall } from './tools.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'blocker-fixture', apiKey: 'not-a-key' }
const token = 'iss16-test-only-token'
const args = { question: '你希望按哪个时区分析？请提供 IANA 时区，例如 Asia/Shanghai。', requiredInformation: '分析/展示所用的 IANA 时区', assignee: 'user' }
async function until(read, predicate = Boolean) {
  for (let i = 0; i < 500; i++) { const value = await read(); if (predicate(value)) return value; await delay(5) }
  assert.fail('Blocker state did not settle')
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-blocker-')), file = join(dir, 'task.sqlite'), stores = new Set()
  const open = async () => { const store = await openTaskStore({ file, bots: listBots(config), ...options }); stores.add(store); return store }
  const close = async (store) => { await store.close(); stores.delete(store) }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store: await open(), open, close }
}
const reply = (text = '已按 Asia/Shanghai 继续原任务分析；模拟日程，不是真实日历。') => ({ mode: 'model', reply: { role: 'assistant', content: text },
  execution: { provider: 'fixture', api: 'openai-completions', model: config.model, usage: { input: 4, output: 2, totalTokens: 6 } } })
const call = (name = BLOCKER_TOOL, arguments_ = args, id = 'question-call') => ({ type: 'toolCall', id, name, arguments: arguments_ })
function turn(calls = [call()]) {
  return { ...reply('还缺少必要时区信息。'), toolCalls: calls,
    assistant: { role: 'assistant', content: calls, api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
const blocked = (store, id) => until(() => store.get(id), (task) => task.blockers?.activeId !== null && task.runtime.checkpoint?.phase === 'awaitBlocker')
const settled = (store, id) => until(() => store.get(id), (task) => task.activeInputId === null && task.queueLength === 0 && task.runtime.checkpoint?.phase === 'awaitInput')

test('iss16 report atomically persists question, assignee, linked Task and durable wait without model polling', async (t) => {
  let calls = 0
  const { store } = await fixture(t, { modelReply: async () => { calls++; return turn() } })
  const commits = []; const off = store.harness.subscribeCommits((event) => commits.push(event)); t.after(off)
  const task = await store.create({ botId: 'calendar' }); const input = await store.send(task.taskId, '查询并分析10月16日的模拟日程，先确认展示时区。')
  const waiting = await blocked(store, task.taskId), item = waiting.blockers.items[0]
  assert.equal(item.question, args.question); assert.equal(item.requiredInformation, args.requiredInformation)
  assert.equal(item.assignee, 'user'); assert.equal(item.taskId, task.taskId); assert.equal(item.inReplyTo, input.messageId)
  assert.equal(waiting.activeInputId, input.messageId)
  assert.ok(commits.some((event) => event.changes.some((change) => change.record?.kind === TaskBlockers.definition.kind && change.value?.activeId === item.id) &&
    event.changes.some((change) => change.type === 'task' && change.value.state.checkpoint?.phase === 'awaitBlocker')))
  await delay(100); assert.equal(calls, 1)
  assert.equal((await store.list()).find((row) => row.taskId === task.taskId).blockers.activeId, item.id)
})

test('iss16 targeted answer resumes original input, preserves config/history/usage, then FIFO consumes normally', async (t) => {
  const seen = []; let originalId
  const { store } = await fixture(t, { modelReply: async (message, options) => {
    seen.push({ message, context: options.context });
    if (seen.length === 1) return turn()
    if (seen.length === 2) return turn([call(CALENDAR_TOOL, { date: '2026-10-16', resource: 'mock:personal' }, 'calendar-call')])
    return reply()
  } })
  const task = await store.create({ botId: 'calendar', taskState: { constraints: ['只读，不修改任何日程'] } })
  const sent = await store.send(task.taskId, '整理10月16日日程，先问时区'); originalId = sent.messageId
  const waiting = await blocked(store, task.taskId)
  const queued = await store.send(task.taskId, '不要把普通消息当回答')
  assert.equal(queued.status, 'queued'); await delay(45); assert.equal(seen.length, 1)
  await store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' })
  const done = await settled(store, task.taskId)
  assert.equal(seen[1].message, seen[0].message)
  const texts = seen[1].context.messages.filter((m) => m.role === 'user').map((m) => m.content)
  assert.ok(texts.some((text) => text.includes('Asia/Shanghai') && text.includes(`问题 #${waiting.blockers.activeId}`)))
  assert.ok(!texts.includes('不要把普通消息当回答'))
  assert.equal(done.blockers.items[0].answer.content, 'Asia/Shanghai'); assert.equal(done.blockers.activeId, null)
  assert.equal(done.messages.find((m) => m.toolName === CALENDAR_TOOL).inReplyTo, originalId)
  assert.equal(done.messages.filter((m) => m.role === 'assistant' && !m.assistant).length, 2)
  assert.deepEqual(done.parameters, task.parameters); assert.deepEqual(done.configRef, task.configRef); assert.deepEqual(done.taskState, task.taskState)
  assert.equal(done.callUsage.modelCalls, 4); assert.equal(done.callUsage.toolCalls, 2); assert.equal(done.callUsage.totalTokens, 24)
})

test('iss16 concurrent duplicate answers append once, do not overwrite and never resume another Task', async (t) => {
  let calls = 0
  const { store } = await fixture(t, { modelReply: async () => ++calls <= 2 ? turn() : reply() })
  const a = await store.create({ botId: 'calendar' }), b = await store.create({ botId: 'calendar' })
  await store.send(a.taskId, 'A'); const wa = await blocked(store, a.taskId)
  await store.send(b.taskId, 'B'); const wb = await blocked(store, b.taskId)
  await assert.rejects(store.resolveBlocker(b.taskId, wa.blockers.activeId, { answer: 'Asia/Shanghai' }), { code: 'BLOCKER_NOT_FOUND' })
  await Promise.all(Array.from({ length: 6 }, () => store.resolveBlocker(a.taskId, wa.blockers.activeId, { answer: 'Asia/Shanghai' })))
  const done = await settled(store, a.taskId); assert.equal(calls, 3)
  assert.equal(done.blockers.items[0].answer.content, 'Asia/Shanghai')
  assert.equal((await store.get(b.taskId)).blockers.activeId, wb.blockers.activeId)
  await assert.rejects(store.resolveBlocker(a.taskId, wa.blockers.activeId, { answer: 'Europe/London' }), { code: 'BLOCKER_ALREADY_RESOLVED' })
  await store.harness.commit(async (tx) => {
    const page = await tx.scanEntries({ conversationId: a.conversationId }, 100)
    assert.equal(page.items.filter((entry) => entry.kind === 'pidot.blocker-resolved').length, 1)
  }, context)
})

test('iss16 closes remaining tool protocol without executing stale plans and resumes with paired transcript', async (t) => {
  let calls = 0, tools = 0, resumed
  const { store } = await fixture(t, { modelReply: async (_message, options) => {
    if (++calls === 1) return turn([call(), call(CALENDAR_TOOL, { resource: 'mock:personal', date: '2026-10-16' }, 'stale-plan')])
    resumed = options.context; return reply()
  }, toolImpl: (...options) => { tools++; return readMockSchedule(...options) } })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '先问时区再查')
  const waiting = await blocked(store, task.taskId)
  assert.equal(tools, 0); assert.equal(waiting.messages.filter((m) => m.role === 'tool').length, 2)
  assert.equal(waiting.messages.find((m) => m.callId === 'stale-plan').result.error.code, 'TOOL_SKIPPED_BLOCKER')
  await store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' }); await settled(store, task.taskId)
  assert.deepEqual(resumed.messages.map((m) => m.role), ['user', 'assistant', 'toolResult', 'toolResult', 'user'])
  assert.equal(tools, 0)
})

test('iss16 normal reopen retains pending question, FIFO and fixed model without reprompting', async (t) => {
  let calls = 0
  const { store, close, open } = await fixture(t, { modelReply: async () => ++calls === 1 ? turn() : reply() })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '需要时区')
  const waiting = await blocked(store, task.taskId); const queued = await store.send(task.taskId, '排队输入')
  await close(store); const reopened = await open()
  const reloaded = await blocked(reopened, task.taskId); assert.deepEqual(reloaded.blockers, waiting.blockers)
  assert.deepEqual(reloaded.queuedInputIds, [queued.messageId]); await delay(60); assert.equal(calls, 1)
  await reopened.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' }); const done = await settled(reopened, task.taskId)
  assert.deepEqual(done.parameters, task.parameters); assert.equal(calls, 3)
})

test('iss16 cancellation archives question, keeps FIFO and rejects late answer without resurrection', async (t) => {
  let calls = 0
  const { store, close, open } = await fixture(t, { modelReply: async () => { calls++; return turn() } })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '需要时区')
  const waiting = await blocked(store, task.taskId); const queued = await store.send(task.taskId, '排队')
  await store.cancel(task.taskId, {})
  const stopped = await until(() => store.get(task.taskId), (value) => value.runtime.status === 'terminal')
  assert.deepEqual(stopped.blockers, waiting.blockers); assert.deepEqual(stopped.queuedInputIds, [queued.messageId])
  await assert.rejects(store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' }), { code: 'TASK_CANCELLED' })
  await close(store); const reopened = await open(); assert.deepEqual((await reopened.get(task.taskId)).blockers, waiting.blockers)
  assert.equal(calls, 1)
})

test('iss16 input validation, live revocation and old snapshots do not create unauthorized questions', async (t) => {
  for (const input of [null, {}, [], { ...args, assignee: 'chief' }, { ...args, question: ' ' }, { ...args, extra: true }]) assert.ok(!validBlockerArgs(input))
  let calls = 0
  const { store } = await fixture(t, { modelReply: async () => ++calls === 1 ? turn() : reply() })
  const task = await store.create({ botId: 'calendar' }); await store.revokeTool('calendar', BLOCKER_TOOL)
  await store.send(task.taskId, '需要时区'); const done = await settled(store, task.taskId)
  assert.equal(done.blockers.activeId, null); assert.equal(done.messages.find((m) => m.role === 'tool').result.error.code, 'TOOL_NOT_AUTHORIZED')
  const bot = listBots(config)[1], card = { taskId: 7, bot, configRef: bot.configRef, parameters: bot.defaults }
  const base = { card, record: { id: 7, input: { botId: bot.id } }, conversation: { owner: { taskId: 7 } },
    call: call(), displayed: [BLOCKER_TOOL], sets: { installed: [BLOCKER_TOOL], authorized: [BLOCKER_TOOL] } }
  assert.equal(checkToolCall(base).ok, true)
  assert.equal(checkToolCall({ ...base, call: call(BLOCKER_TOOL, { ...args, extra: true }) }).error.code, 'TOOL_INVALID_ARGUMENTS')
  const oldBots = listBots(config).map((bot) => ({ ...bot, defaults: { ...bot.defaults, tools: bot.defaults.tools.filter((name) => name !== BLOCKER_TOOL) } }))
  const { store: old } = await fixture(t, { bots: oldBots, modelReply: async () => reply() })
  assert.ok(!(await old.create({ botId: 'calendar' })).parameters.tools.includes(BLOCKER_TOOL))
})

test('iss16 authenticated resolve API validates task ownership, payload, methods, and idempotency', async (t) => {
  let calls = 0
  const { store } = await fixture(t, { modelReply: async () => ++calls === 1 ? turn() : reply() })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '需要时区'); const waiting = await blocked(store, task.taskId)
  const server = createApiServer({ token, tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${task.taskId}/blockers/${waiting.blockers.activeId}/resolve`
  const request = (input, method = 'POST') => fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) })
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await request({}, 'GET')).status, 405)
  for (const input of [null, {}, [], { answer: '' }, { answer: ' ' }, { answer: 'x'.repeat(4001) }, { answer: 'Asia/Shanghai', taskId: task.taskId }]) assert.equal((await request(input)).status, 400)
  assert.equal((await request({ answer: 'Asia/Shanghai' })).status, 200)
  assert.equal((await request({ answer: 'Asia/Shanghai' })).status, 200)
  assert.equal((await request({ answer: 'Europe/London' })).status, 409)
  const done = await settled(store, task.taskId); assert.equal(done.blockers.items[0].answer.source, 'authenticated-user'); assert.equal(calls, 2)
})

test('iss16 blocked Task rejects steering/state/limits/skills but ordinary messages remain queued', async (t) => {
  const { store } = await fixture(t, { modelReply: async () => turn() })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '需要时区'); await blocked(store, task.taskId)
  const queued = await store.send(task.taskId, 'Asia/Shanghai')
  assert.equal(queued.status, 'queued')
  await assert.rejects(store.steer(task.taskId, { message: 'Asia/Shanghai' }), { code: 'TASK_BLOCKED' })
  await assert.rejects(store.steer(task.taskId, { messageId: queued.messageId }), { code: 'TASK_BLOCKED' })
  await assert.rejects(store.updateState(task.taskId, { goal: '新目标' }), { code: 'TASK_BUSY' })
  await assert.rejects(store.raiseLimits(task.taskId, { modelCalls: 30 }), { code: 'TASK_BUSY' })
  await assert.rejects(store.activateSkill(task.taskId, { skillId: 'calendar-conflict-analysis' }), { code: 'TASK_BUSY' })
})

test('iss16 answer keeps accumulated call limits and waits for explicit increase rather than resetting usage', async (t) => {
  let calls = 0
  const { store } = await fixture(t, { modelReply: async () => ++calls === 1 ? turn() : reply() })
  const task = await store.create({ botId: 'calendar', parameters: { callLimits: { modelCalls: 1, toolCalls: 10 } } })
  await store.send(task.taskId, '需要时区'); const waiting = await blocked(store, task.taskId)
  await store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' })
  const limited = await until(() => store.get(task.taskId), (task) => task.runtime.checkpoint?.lastOutcome === 'limited')
  assert.equal(limited.callUsage.modelCalls, 1); assert.equal(limited.callUsage.totalTokens, 6); assert.equal(calls, 1)
  assert.equal(limited.blockers.items[0].status, 'resolved')
  await store.send(task.taskId, '普通队列不提额'); await delay(35); assert.equal(calls, 1)
  await store.raiseLimits(task.taskId, { modelCalls: 5 }); const done = await settled(store, task.taskId)
  assert.equal(done.callUsage.modelCalls, 3); assert.equal(done.blockers.items.length, 1)
})

test('iss16 second question has independent identity and old duplicates cannot resolve the new wait', async (t) => {
  let calls = 0
  const { store } = await fixture(t, { modelReply: async () => ++calls <= 2 ? turn([call(BLOCKER_TOOL,
    calls === 1 ? args : { ...args, question: '请明确要分析哪一天？', requiredInformation: 'YYYY-MM-DD日期' }, `question-${calls}`)]) : reply() })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '整理日程')
  const first = await blocked(store, task.taskId)
  await store.resolveBlocker(task.taskId, first.blockers.activeId, { answer: 'Asia/Shanghai' })
  const second = await until(() => store.get(task.taskId), (task) => task.blockers.items.length === 2 && task.blockers.activeId !== null)
  assert.notEqual(second.blockers.activeId, first.blockers.activeId)
  await store.resolveBlocker(task.taskId, first.blockers.activeId, { answer: 'Asia/Shanghai' }); await delay(30)
  assert.equal(calls, 2); assert.equal((await store.get(task.taskId)).blockers.activeId, second.blockers.activeId)
  await store.resolveBlocker(task.taskId, second.blockers.activeId, { answer: '2026-10-16' })
  assert.ok((await settled(store, task.taskId)).blockers.items.every((item) => item.status === 'resolved'))
})

test('iss16 active Skill remains pinned during wait and answer is readable through bounded history', async (t) => {
  let calls = 0, answerEntryId, readBack
  const { store } = await fixture(t, { modelReply: async (_message, options) => {
    calls++
    if (calls === 1) return turn([call('skill_activate', { skillId: 'calendar-conflict-analysis' }, 'activate')])
    if (calls === 2) return turn()
    if (calls === 3) {
      answerEntryId = Number(options.context.segments.find((segment) => segment.key.startsWith('blocker-answer:')).key.split(':')[1])
      assert.match(options.context.systemPrompt, /必须执行的步骤/)
      assert.ok(options.context.messages.some((m) => m.role === 'user' && m.content.includes('Asia/Shanghai')))
      return turn([call('task_history_read', { entryId: answerEntryId, limit: 1024 }, 'read-answer')])
    }
    readBack = options.context.messages.find((m) => m.role === 'toolResult' && m.toolName === 'task_history_read')
    return reply()
  } })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '分析日程，先确认展示时区')
  const waiting = await blocked(store, task.taskId), pinned = waiting.skillState.active[0]
  assert.ok(pinned); await store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' })
  answerEntryId = (await store.get(task.taskId)).blockers.items[0].answer.id
  const done = await settled(store, task.taskId)
  assert.equal(done.skillState.active.length, 0); assert.equal(done.blockers.items[0].answer.id, answerEntryId)
  assert.ok(readBack)
  const receipt = JSON.parse(readBack.content[0].text)
  assert.equal(receipt.ok, true); assert.ok(receipt.data.text.includes('Asia/Shanghai'))
})

test('iss16 maximum-size Unicode question keeps blocker identity in bounded receipt and still waits', async (t) => {
  let calls = 0
  const longArgs = { question: '问'.repeat(1000), requiredInformation: '需'.repeat(1000), assignee: 'user' }
  const { store } = await fixture(t, { modelReply: async () => ++calls === 1 ? turn([call(BLOCKER_TOOL, longArgs)]) : reply() })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '必要信息')
  const waiting = await blocked(store, task.taskId), receipt = waiting.messages.find((m) => m.toolName === BLOCKER_TOOL)
  assert.equal(waiting.blockers.items[0].question.length, 1000)
  assert.equal(receipt.result.data.blockerId, waiting.blockers.activeId)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt.result)) < 8192)
  await store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' }); await settled(store, task.taskId)
})

test('iss16 after an answered question compaction retains its linked history without reasking or redoing tools', async (t) => {
  let calls = 0, summaries = 0, scheduleCalls = 0, answerId
  const bots = listBots(config, { maxOutputTokens: 1024, contextWindows: { [config.model]: 17000 }, callLimits: { modelCalls: 20, toolCalls: 15 } })
  const { store } = await fixture(t, { bots, modelReply: async (_message, options) => {
    if (options.purpose === 'context-compaction') { summaries++; return reply('用户已从对应事项回答展示时区Asia/Shanghai；日期2026-10-16。日程列表已经查询成功，不要重做。保留只读限制，继续最终分析。') }
    calls++
    if (calls === 1) return turn()
    if (calls === 2) {
      answerId = Number(options.context.segments.find((s) => s.key.startsWith('blocker-answer:')).key.split(':')[1])
      return turn([call(CALENDAR_TOOL, { date: '2026-10-16', resource: 'mock:personal' }, 'read-calendar')])
    }
    if (calls === 3) return turn([call('calendar_read_event', { eventId: 'mock-20261016-1', resource: 'mock:personal' }, 'read-event')])
    assert.ok(options.context.compaction.revision > 0)
    assert.ok(options.context.messages.some((m) => JSON.stringify(m).includes('Asia/Shanghai')))
    if (calls === 4) return turn([call('task_history_read', { entryId: answerId, limit: 1024 }, 'read-answer')])
    return reply()
  }, toolImpl: (args) => { scheduleCalls++; return readMockSchedule(args) }, eventImpl: async (args) => {
    const { readMockEvent } = await import('./tools.mjs')
    const data = readMockEvent(args); data.event.description = '已核实只读资料'.repeat(140); return data
  } })
  const task = await store.create({ botId: 'calendar', taskState: { constraints: ['只读，禁止修改日程'] } })
  await store.send(task.taskId, '先确认时区再分析'); const waiting = await blocked(store, task.taskId)
  await store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' })
  const done = await settled(store, task.taskId)
  assert.ok(summaries > 0); assert.equal(done.blockers.items.length, 1); assert.equal(scheduleCalls, 1)
  assert.equal(done.blockers.items[0].answer.id, answerId)
  const history = done.messages.find((m) => m.toolName === 'task_history_read')
  assert.equal(history.result.ok, true); assert.ok(history.result.data.text.includes('Asia/Shanghai'))
  assert.ok(done.taskState.constraints.includes('只读，禁止修改日程'))
})

test('iss16 answer racing cancellation cannot resurrect a cancelled original Task', async (t) => {
  let calls = 0
  const { store } = await fixture(t, { modelReply: async () => ++calls === 1 ? turn() : reply() })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '需要时区')
  const waiting = await blocked(store, task.taskId)
  const results = await Promise.allSettled([
    store.cancel(task.taskId, {}), store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' }),
  ])
  assert.equal(results[0].status, 'fulfilled')
  const cancelled = await until(() => store.get(task.taskId), (value) => value.runtime.status === 'terminal')
  assert.equal(cancelled.runtime.outcome.status, 'aborted')
  const count = calls; await delay(50); assert.equal(calls, count)
  assert.equal(cancelled.blockers.items.length, 1)
  assert.ok(['pending', 'resolved'].includes(cancelled.blockers.items[0].status))
  await assert.rejects(store.resolveBlocker(task.taskId, waiting.blockers.activeId, { answer: 'Asia/Shanghai' }), { code: 'TASK_CANCELLED' })
})
