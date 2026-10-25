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
import { ModelReplyError } from './model-reply.mjs'
import { CALENDAR_TOOL, readMockSchedule } from './tools.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'cancel-fixture', apiKey: 'not-a-key' }
const token = 'iss15-test-only-token'
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
async function until(read, predicate = Boolean) {
  for (let i = 0; i < 500; i++) { const value = await read(); if (predicate(value)) return value; await delay(5) }
  assert.fail('Cancellation state did not settle')
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-cancellation-'))
  const file = join(dir, 'task.sqlite'), stores = new Set()
  const open = async () => { const store = await openTaskStore({ file, bots: listBots(config), ...options }); stores.add(store); return store }
  const close = async (store) => { await store.close(); stores.delete(store) }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store: await open(), open, close }
}
const result = (text = '实际回复') => ({ mode: 'model', reply: { role: 'assistant', content: text },
  execution: { provider: 'fixture', api: 'openai-completions', model: config.model, usage: { input: 4, output: 2, totalTokens: 6 } } })
function toolTurn(count = 1) {
  const calls = Array.from({ length: count }, (_, index) => ({ type: 'toolCall', id: `call-${index}`, name: CALENDAR_TOOL,
    arguments: { resource: 'mock:personal', date: '2026-10-16' } }))
  return { ...result('读取模拟日程'), toolCalls: calls,
    assistant: { role: 'assistant', content: calls, api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
const terminal = (store, id) => until(() => store.get(id), (task) => task.runtime.status === 'terminal')
const cancelled = (error) => error.status === 409 && error.code === 'TASK_CANCELLED'

async function assertBlocked(store, id, queuedId) {
  await assert.rejects(store.send(id, '不能恢复'), cancelled)
  await assert.rejects(store.steer(id, { message: '不能插入恢复' }), cancelled)
  if (queuedId) await assert.rejects(store.steer(id, { messageId: queuedId }), cancelled)
  await assert.rejects(store.raiseLimits(id, { modelCalls: 30, toolCalls: 20 }), cancelled)
  await assert.rejects(store.updateState(id, { goal: '不能更新恢复' }), cancelled)
  await assert.rejects(store.activateSkill(id, { skillId: 'calendar-conflict-analysis' }), cancelled)
}

test('iss15 idle Task cancellation is idempotent, durable and isolated without creating work', async (t) => {
  let calls = 0
  const { store, close, open } = await fixture(t, { modelReply: async () => { calls++; return result() } })
  const first = await store.create({ botId: 'calendar' }), other = await store.create({ botId: 'calendar' })
  const snapshots = await Promise.all(Array.from({ length: 5 }, () => store.cancel(first.taskId, {})))
  assert.ok(snapshots.every((item) => item.cancellation.entryId === snapshots[0].cancellation.entryId))
  const stopped = await terminal(store, first.taskId)
  assert.equal(stopped.runtime.outcome.status, 'aborted')
  assert.deepEqual(stopped.messages, []); assert.equal(calls, 0)
  await assertBlocked(store, first.taskId)
  await store.send(other.taskId, '另一个 Task 仍可执行')
  await until(() => store.get(other.taskId), (task) => task.messages.some((item) => item.role === 'assistant'))
  assert.equal(calls, 1)
  await close(store)
  const reopened = await open()
  assert.equal((await reopened.get(first.taskId)).cancellation.entryId, stopped.cancellation.entryId)
  await assertBlocked(reopened, first.taskId)
  await delay(30); assert.equal(calls, 1)
})

test('iss15 model abort stops FIFO and pending steering; known failure usage and original records survive', async (t) => {
  const started = gate(); let calls = 0, aborted = false
  const { store } = await fixture(t, { modelReply: async (_message, { signal }) => {
    calls++; started.resolve()
    await new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }) })
    const error = new ModelReplyError('MODEL_ABORTED'); error.execution = result().execution; throw error
  } })
  const task = await store.create({ botId: 'calendar' })
  const input = await store.send(task.taskId, '当前工作'); await started.promise
  const queued = await store.send(task.taskId, '保留队列'), steer = await store.steer(task.taskId, { message: '保留待插入' })
  await store.cancel(task.taskId, {}); const stopped = await terminal(store, task.taskId)
  assert.equal(aborted, true); assert.equal(calls, 1)
  assert.equal(stopped.activeInputId, input.messageId)
  assert.deepEqual(stopped.queuedInputIds, [queued.messageId]); assert.deepEqual(stopped.pendingSteerIds, [steer.messageId])
  assert.equal(stopped.messages.find((item) => item.id === input.messageId).deliveryStatus, 'cancelled')
  const error = stopped.messages.find((item) => item.role === 'error')
  assert.equal(error.errorCode, 'MODEL_ABORTED'); assert.equal(error.afterCancellation, true)
  assert.equal(error.originTaskId, task.taskId); assert.equal(error.byTaskId, null)
  assert.equal(stopped.callUsage.totalTokens, 6); assert.equal(stopped.callUsage.unknownTokenCalls, 0)
  assert.deepEqual(stopped.taskState.constraints, [])
  await assertBlocked(store, task.taskId, queued.messageId)
})

test('iss15 unabortable late model success is retained verbatim, does not promote FIFO or execute tool plan', async (t) => {
  const hold = gate(); let calls = 0, tools = 0
  const { store } = await fixture(t, { modelReply: async () => { calls++; await hold.promise; return toolTurn(2) },
    toolImpl: () => { tools++; return readMockSchedule({ resource: 'mock:personal', date: '2026-10-16' }) } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '旧请求')
  await until(() => calls === 1)
  const queued = await store.send(task.taskId, '不能自动开始')
  const response = await store.cancel(task.taskId, {}) // Must return before transport resolves.
  assert.ok(response.cancellation); assert.equal(tools, 0)
  hold.resolve(); const stopped = await terminal(store, task.taskId)
  const late = stopped.messages.find((item) => item.assistant)
  assert.equal(late.content, '读取模拟日程'); assert.equal(late.afterCancellation, true)
  assert.equal(late.assistant.content.length, 2); assert.equal(stopped.callUsage.totalTokens, 6)
  assert.deepEqual(stopped.queuedInputIds, [queued.messageId]); assert.equal(calls, 1); assert.equal(tools, 0)
})

test('iss15 unabortable late final success stays a real successful result rather than cancellation error', async (t) => {
  const hold = gate(); let started = false
  const { store } = await fixture(t, { modelReply: async () => { started = true; await hold.promise; return result('不可撤回的真实回复') } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '原输入')
  await until(() => started); await store.cancel(task.taskId, {}); hold.resolve()
  const stopped = await terminal(store, task.taskId)
  assert.equal(stopped.messages.at(-1).role, 'assistant'); assert.equal(stopped.messages.at(-1).content, '不可撤回的真实回复')
  assert.equal(stopped.messages.at(-1).afterCancellation, true); assert.equal(stopped.messages.at(-1).errorCode, undefined)
})

test('iss15 cancellation during asynchronous tool preserves late successful receipt and skips remaining calls', async (t) => {
  const hold = gate(); let modelCalls = 0, toolCalls = 0, signal
  const { store } = await fixture(t, { modelReply: async () => { modelCalls++; return toolTurn(2) },
    toolImpl: async (args, options) => { toolCalls++; signal = options.signal; await hold.promise; return readMockSchedule(args) } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '读日程')
  await until(() => toolCalls === 1); const queued = await store.send(task.taskId, '后续工作')
  await store.cancel(task.taskId, {}); await until(() => signal.aborted)
  hold.resolve(); const stopped = await terminal(store, task.taskId)
  const receipts = stopped.messages.filter((item) => item.role === 'tool')
  assert.equal(receipts.length, 1); assert.equal(receipts[0].result.ok, true)
  assert.equal(receipts[0].afterCancellation, true); assert.equal(receipts[0].callId, 'call-0')
  assert.equal(stopped.callUsage.toolCalls, 1); assert.equal(modelCalls, 1); assert.equal(toolCalls, 1)
  assert.deepEqual(stopped.queuedInputIds, [queued.messageId])
})

test('iss15 cooperative tool abort retains a truthful failed receipt without restarting Task', async (t) => {
  let started = false
  const { store } = await fixture(t, { modelReply: async () => toolTurn(2), toolImpl: async (_args, { signal }) => {
    started = true; await new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  } })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '读日程')
  await until(() => started); await store.cancel(task.taskId, {})
  const stopped = await terminal(store, task.taskId), receipt = stopped.messages.find((item) => item.role === 'tool')
  assert.equal(receipt.result.ok, false); assert.equal(receipt.result.error.code, 'TOOL_ABORTED')
  assert.equal(stopped.callUsage.toolCalls, 1); assert.equal(stopped.callUsage.modelCalls, 1)
})

test('iss15 already limited Task cancels with retained counters, successful tools, waiting input and queue', async (t) => {
  let calls = 0, tools = 0
  const { store, close, open } = await fixture(t, { modelReply: async () => { calls++; return toolTurn() },
    toolImpl: (args) => { tools++; return readMockSchedule(args) } })
  const task = await store.create({ botId: 'calendar', parameters: { callLimits: { modelCalls: 1, toolCalls: 2 } } })
  await store.send(task.taskId, '工作')
  const waiting = await until(() => store.get(task.taskId), (value) => value.runtime.checkpoint?.lastOutcome === 'limited')
  const queued = await store.send(task.taskId, '待处理'), steer = await store.steer(task.taskId, { message: '仍待插入' })
  await store.cancel(task.taskId, {}); const stopped = await terminal(store, task.taskId)
  assert.deepEqual(stopped.callUsage, waiting.callUsage)
  assert.deepEqual(stopped.queuedInputIds, [queued.messageId]); assert.deepEqual(stopped.pendingSteerIds, [steer.messageId])
  assert.ok(stopped.messages.some((item) => item.role === 'tool' && item.result.ok))
  assert.ok(stopped.messages.some((item) => item.errorCode === 'CALL_LIMIT_REACHED'))
  await assertBlocked(store, task.taskId, queued.messageId)
  await close(store); const reopened = await open(); reopened.harness.resume(); await delay(30)
  const again = await reopened.get(task.taskId)
  assert.equal(again.runtime.status, 'terminal'); assert.deepEqual(again.queuedInputIds, [queued.messageId])
  assert.equal(calls, 1); assert.equal(tools, 1)
})

test('iss15 cancellation of current Task does not relabel earlier completed work as unexecuted', async (t) => {
  let calls = 0
  const hold = gate()
  const { store } = await fixture(t, { modelReply: async () => { if (++calls === 2) await hold.promise; return result(`真实回复${calls}`) } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'calendar' }); const previous = await store.send(task.taskId, '已经完成')
  const before = await until(() => store.get(task.taskId), (value) => value.messages.some((item) => item.role === 'assistant'))
  const prior = before.messages.find((item) => item.role === 'assistant')
  await store.send(task.taskId, '将取消'); await until(() => calls === 2)
  await store.cancel(task.taskId, {}); hold.resolve(); const stopped = await terminal(store, task.taskId)
  assert.deepEqual(stopped.messages.find((item) => item.id === prior.id), prior)
  assert.equal(stopped.messages.find((item) => item.id === previous.messageId).deliveryStatus, 'completed')
})

test('iss15 native abort mark blocks fresh mutations even before user cancellation snapshot exists', async (t) => {
  const { store } = await fixture(t)
  const task = await store.create({ botId: 'chief' })
  await store.harness.abortTask(task.taskId, context)
  store.harness.resume()
  await assert.rejects(store.send(task.taskId, '不允许'), cancelled)
  assert.equal((await terminal(store, task.taskId)).runtime.outcome.status, 'aborted')
})

test('iss15 cancellation HTTP validates authentication, methods, payload, target and idempotency', async (t) => {
  const { store } = await fixture(t)
  const server = createApiServer({ token, tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise((done) => { server.close(done); server.closeAllConnections() }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, body = '{}', method = 'POST', auth = token) => fetch(base + path, { method, body: method === 'GET' ? undefined : body,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` } })
  const task = await store.create({ botId: 'calendar' }), path = `/api/tasks/${task.taskId}/cancel`
  assert.equal((await request(path, '{bad', 'POST', 'wrong')).status, 401)
  assert.equal((await request(path, '{}', 'GET')).status, 405)
  for (const body of ['{', 'null', '[]', '{"taskId":1}', '{"message":"cancel"}']) assert.equal((await request(path, body)).status, 400)
  assert.equal((await request('/api/tasks/999999/cancel')).status, 404)
  const response = await request(path); assert.equal(response.status, 200)
  const { task: stopped } = await response.json(); assert.equal(stopped.taskId, task.taskId); assert.ok(stopped.cancellation)
  const repeat = await (await request(path)).json(); assert.equal(repeat.task.cancellation.entryId, stopped.cancellation.entryId)
  const persisted = (await store.get(task.taskId)).cancellation
  assert.equal(persisted.source, 'user-request')
})

test('iss15 test-mode in-flight cancellation retains late deterministic reply without consuming FIFO', async (t) => {
  const hold = gate(); let calls = 0, signal
  const { store } = await fixture(t, { bots: listBots(), reply: async (_text, options) => {
    calls++; signal = options.signal; await hold.promise; return { mode: 'test', reply: { content: '实际测试结果' } }
  } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'chief' }); await store.send(task.taskId, '原输入')
  await until(() => calls === 1); const queued = await store.send(task.taskId, '保留未处理')
  await store.cancel(task.taskId, {}); await until(() => signal.aborted); hold.resolve()
  const stopped = await terminal(store, task.taskId)
  assert.equal(stopped.messages.at(-1).content, '实际测试结果'); assert.equal(stopped.messages.at(-1).mode, 'test')
  assert.equal(stopped.messages.at(-1).afterCancellation, true); assert.equal(calls, 1)
  assert.deepEqual(stopped.queuedInputIds, [queued.messageId]); assert.equal(stopped.callUsage.modelCalls, 0)
})

test('iss15 large tool receipt and exact raw artifact survive cancellation and normal reopen', async (t) => {
  const { CancelledTaskArchive } = await import('./cancellation.mjs')
  const { ToolResults } = await import('./tool-results.mjs')
  const hold = gate(); let modelCalls = 0, started = false
  const { store, close, open } = await fixture(t, { modelReply: async () => { modelCalls++; return toolTurn(2) },
    toolImpl: async (args) => {
      started = true; await hold.promise
      const data = readMockSchedule(args)
      data.events = Array.from({ length: 40 }, (_, index) => ({ ...data.events[0], id: `mock-large-${index}`, title: '完整真实工具结果'.repeat(15) }))
      return data
    } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '读完整工具结果')
  await until(() => started); await store.cancel(task.taskId, {}); hold.resolve()
  const stopped = await terminal(store, task.taskId), receipt = stopped.messages.find((item) => item.role === 'tool')
  assert.equal(receipt.result.data.bounded, true); assert.equal(receipt.result.ok, true)
  const ref = receipt.result.data.resultRef
  const snapshot = await store.harness.snapshot(CancelledTaskArchive, task.conversationId, context)
  const artifact = snapshot.snapshot.documents[ToolResults.definition.kind].artifacts[ref]
  assert.ok(artifact.raw.includes('完整真实工具结果'.repeat(15)))
  assert.equal(artifact.taskId, task.taskId); assert.equal(artifact.conversationId, task.conversationId)
  await close(store); const reopened = await open()
  const again = await reopened.harness.snapshot(CancelledTaskArchive, task.conversationId, context)
  assert.deepEqual(again.snapshot.documents[ToolResults.definition.kind].artifacts[ref], artifact)
  assert.equal((await reopened.get(task.taskId)).messages.find((item) => item.role === 'tool').result.data.resultRef, ref)
  assert.equal(modelCalls, 1)
})

test('iss15 cancellation interrupts compaction too; late summary does not apply or restart business work', async (t) => {
  const hold = gate(); let normalCalls = 0, summaries = 0, signal
  const bots = listBots(config, { maxOutputTokens: 1024, contextWindows: { [config.model]: 16000 }, callLimits: { modelCalls: 50, toolCalls: 40 } })
  const { store } = await fixture(t, { bots, modelReply: async (_message, options) => {
    if (options.purpose === 'context-compaction') { summaries++; signal = options.signal; await hold.promise; return result('取消后迟到摘要') }
    normalCalls++; return result('已核实事实，尚未解决的事项保留原文。'.repeat(200))
  } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '第一轮背景')
  await until(() => store.get(task.taskId), (value) => value.activeInputId === null)
  await store.send(task.taskId, '继续'); await until(() => summaries === 1)
  const queued = await store.send(task.taskId, '后续仍不执行')
  await store.cancel(task.taskId, {}); await until(() => signal.aborted); hold.resolve()
  const stopped = await terminal(store, task.taskId)
  assert.equal(stopped.compaction.revision, 0); assert.equal(stopped.compactionHistory.length, 0)
  assert.equal(stopped.messages.at(-1).purpose, 'context-compaction'); assert.equal(stopped.messages.at(-1).afterCancellation, true)
  assert.deepEqual(stopped.queuedInputIds, [queued.messageId]); assert.equal(normalCalls, 1); assert.equal(summaries, 1)
})

test('iss15 cancellation preserves pinned active Skill facts and prevents all later activation/deactivation', async (t) => {
  const hold = gate(); let started = false
  const { store } = await fixture(t, { modelReply: async () => { started = true; await hold.promise; return result() } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'calendar' })
  await store.activateSkill(task.taskId, { skillId: 'calendar-conflict-analysis' })
  const before = await store.get(task.taskId)
  await store.send(task.taskId, '工作'); await until(() => started)
  await store.cancel(task.taskId, {}); hold.resolve(); const stopped = await terminal(store, task.taskId)
  assert.deepEqual(stopped.skillState, before.skillState)
  await assert.rejects(store.deactivateSkill(task.taskId, { skillId: 'calendar-conflict-analysis' }), cancelled)
  await assert.rejects(store.activateSkill(task.taskId, { skillId: 'calendar-conflict-analysis' }), cancelled)
})

test('iss15 intent-to-native-abort race archives state and saves late usage without restarting', async (t) => {
  const hold = gate(); let calls = 0
  const { store } = await fixture(t, { modelReply: async () => { calls++; await hold.promise; return result('边界上真实成功') } })
  t.after(() => hold.resolve())
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '竞态输入')
  await until(() => calls === 1)
  const nativeAbort = store.harness.abortTask.bind(store.harness)
  // Simulate the short gap after durable user intent, before native abort marks.
  store.harness.abortTask = async () => 'marked'
  await store.cancel(task.taskId, {}); hold.resolve()
  const stopped = await terminal(store, task.taskId)
  const complete = await until(() => store.get(task.taskId), (value) => value.messages.some((item) => item.afterCancellation))
  assert.equal(stopped.runtime.outcome.status, 'aborted')
  assert.equal(complete.messages.at(-1).content, '边界上真实成功'); assert.equal(complete.messages.at(-1).afterCancellation, true)
  assert.equal(complete.callUsage.totalTokens, 6); assert.equal(complete.callUsage.unknownTokenCalls, 0)
  assert.equal(calls, 1)
  store.harness.abortTask = nativeAbort
})
