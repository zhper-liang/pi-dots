import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { CALENDAR_TOOL, readMockSchedule } from './tools.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'steering-fixture', apiKey: 'not-a-key' }
const directive = '上午会议不能调整'
const token = 'iss14-local-test-token-only'
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
async function until(read, predicate = Boolean) {
  for (let i = 0; i < 400; i++) { const value = await read(); if (predicate(value)) return value; await delay(5) }
  assert.fail('Steering state did not settle')
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-steering-'))
  const file = join(dir, 'task.sqlite'), stores = []
  const open = async () => { const store = await openTaskStore({ file, bots: listBots(config), ...options }); stores.push(store); return store }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { file, open, store: await open() }
}
const settled = (store, id) => until(() => store.get(id), (task) => task.activeInputId === null && task.queueLength === 0)
const result = (content) => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 1 } } })
const users = (context) => context.messages.filter((m) => m.role === 'user').map((m) => m.content)
function toolTurn(names = [CALENDAR_TOOL]) {
  const calls = names.map((name, index) => ({ type: 'toolCall', id: `call-${index}`, name,
    arguments: name === CALENDAR_TOOL ? { resource: 'mock:personal', date: '2026-10-16' } : {} }))
  return { ...result('旧计划请求工具'), toolCalls: calls,
    assistant: { role: 'assistant', content: calls, api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}

test('iss14 explicit steering waits for final-response boundary; ordinary FIFO stays isolated; conversion consumes once', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  const requests = []
  const { store } = await fixture(t, { modelReply: async (message, { context }) => {
    requests.push({ message, context: structuredClone(context) })
    if (requests.length === 1) await hold.promise
    return result(`真实回复-${requests.length}`)
  } })
  const task = await store.create({ botId: 'calendar', taskState: { constraints: ['原限制'] } })
  const first = await store.send(task.taskId, '规划全天日程')
  await until(() => requests.length === 1)
  const queued = await store.send(task.taskId, directive)
  const untouched = await store.send(task.taskId, '最后单独处理')
  assert.equal(queued.status, 'queued')
  assert.deepEqual(users(requests[0].context), ['规划全天日程'])
  const convert = await store.steer(task.taskId, { messageId: queued.messageId })
  assert.equal(convert.status, 'steer-pending'); assert.equal(convert.messageId, queued.messageId)
  const pending = await store.get(task.taskId)
  assert.deepEqual(pending.queuedInputIds, [untouched.messageId]); assert.deepEqual(pending.pendingSteerIds, [queued.messageId])
  assert.equal(pending.messages.find((m) => m.id === queued.messageId).deliveryStatus, 'steer-pending')
  assert.deepEqual(pending.taskState.constraints, ['原限制'])
  await assert.rejects(store.steer(task.taskId, { messageId: queued.messageId }), { code: 'MESSAGE_NOT_QUEUED' })
  hold.resolve()
  const done = await settled(store, task.taskId)
  assert.deepEqual(requests.map((r) => r.message), ['规划全天日程', '规划全天日程', '最后单独处理'])
  assert.deepEqual(users(requests[1].context), ['规划全天日程', directive])
  assert.ok(requests[1].context.systemPrompt.includes(directive))
  assert.deepEqual(done.taskState.constraints, ['原限制', directive])
  assert.equal(done.taskStateSources.constraints.type, 'user-steer')
  assert.equal(done.taskStateSources.constraints.messageId, queued.messageId)
  assert.equal(done.messages.filter((m) => m.id === queued.messageId).length, 1)
  assert.equal(done.messages.find((m) => m.id === queued.messageId).deliveryStatus, 'steer-applied')
  assert.equal(done.messages.find((m) => m.content === '真实回复-1').intermediate, true)
  assert.equal(done.messages.find((m) => m.id === first.messageId).deliveryStatus, 'completed')
  assert.deepEqual(requests[1].context.messages.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.equal(done.steerLength, 0)
})

test('iss14 a returned old tool plan closes with skipped receipts before new instruction; only replanned tools execute', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  const requests = [], executed = []
  const { store } = await fixture(t, {
    toolImpl: (args) => { executed.push(args); return readMockSchedule(args) },
    modelReply: async (_message, { context }) => {
      requests.push(structuredClone(context))
      if (requests.length === 1) { await hold.promise; return toolTurn([CALENDAR_TOOL, CALENDAR_TOOL]) }
      if (requests.length === 2) return toolTurn()
      return result('保留上午会议，仅只读查询模拟日程')
    },
  })
  const task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, '安排日程'); await until(() => requests.length === 1)
  const steer = await store.steer(task.taskId, { message: directive })
  assert.equal((await store.get(task.taskId)).taskState.constraints.includes(directive), false)
  hold.resolve()
  const done = await settled(store, task.taskId)
  const receipts = done.messages.filter((m) => m.role === 'tool')
  assert.deepEqual(receipts.map((m) => m.result.error?.code ?? 'ok'), ['TOOL_SKIPPED_STEER', 'TOOL_SKIPPED_STEER', 'ok'])
  assert.equal(executed.length, 1); assert.equal(done.callUsage.toolCalls, 1)
  assert.deepEqual(requests[1].messages.map((m) => m.role), ['user', 'assistant', 'toolResult', 'toolResult', 'user'])
  assert.ok(requests[1].systemPrompt.includes(directive)); assert.ok(requests[2].systemPrompt.includes(directive))
  assert.equal(done.messages.find((m) => m.id === steer.messageId).deliveryStatus, 'steer-applied')
})

test('iss14 committed action stays successful after later steer and is not replayed', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  const requests = []; let executed = 0
  const { store } = await fixture(t, { toolImpl: (args) => { executed++; return readMockSchedule(args) },
    modelReply: async (_message, { context }) => {
      requests.push(structuredClone(context))
      if (requests.length === 1) return toolTurn()
      if (requests.length === 2) await hold.promise
      return result(requests.length === 2 ? '已读取的真实回执' : '新限制下继续')
    } })
  const task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, '先查询'); await until(() => requests.length === 2)
  await store.steer(task.taskId, { message: directive }); hold.resolve()
  const done = await settled(store, task.taskId)
  assert.equal(executed, 1)
  assert.equal(done.messages.filter((m) => m.role === 'tool').length, 1)
  assert.equal(done.messages.find((m) => m.role === 'tool').result.ok, true)
  assert.equal(done.messages.find((m) => m.content === '已读取的真实回执').intermediate, true)
  assert.deepEqual(users(requests[2]), ['先查询', directive])
})

test('iss14 multiple direct steers apply in transaction order, persist and stay out of other Task context', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  const seen = []
  const { store, open } = await fixture(t, { modelReply: async (message, { context }) => {
    seen.push({ message, context: structuredClone(context) })
    if (message === 'original' && seen.length === 1) await hold.promise
    return result('ok')
  } })
  const a = await store.create({ botId: 'calendar' }), b = await store.create({ botId: 'calendar' })
  await store.send(a.taskId, 'original'); await until(() => seen.length === 1)
  const steers = await Promise.all(Array.from({ length: 8 }, (_, i) => store.steer(a.taskId, { message: `约束-${i}` })))
  await store.send(b.taskId, 'other'); await settled(store, b.taskId)
  assert.deepEqual(users(seen.find((r) => r.message === 'other').context), ['other'])
  hold.resolve(); const done = await settled(store, a.taskId)
  assert.equal(done.taskState.constraints.length, 8)
  assert.deepEqual(done.messages.filter((m) => m.deliveryStatus === 'steer-applied').map((m) => m.id), steers.map((s) => s.messageId))
  await store.close(); const reopened = await open(), restored = await reopened.get(a.taskId)
  assert.deepEqual(restored.taskState, done.taskState)
  assert.equal(restored.messages.filter((m) => m.deliveryStatus === 'steer-applied').length, 8)
  assert.equal(restored.queueLength, 0)
})

test('iss14 limited waiting retains pending steering through reopen; only explicit raise resumes original ahead of FIFO', async (t) => {
  const requests = []
  const { store, open } = await fixture(t, { modelReply: async (_message, { context }) => {
    requests.push(structuredClone(context)); return toolTurn()
  } })
  const task = await store.create({ botId: 'calendar', parameters: { callLimits: { modelCalls: 1, toolCalls: 5 } } })
  const original = await store.send(task.taskId, '继续原任务')
  await until(() => store.get(task.taskId), (v) => v.runtime.checkpoint?.lastOutcome === 'limited')
  const queued = await store.send(task.taskId, '排队消息')
  const steer = await store.steer(task.taskId, { message: directive })
  const before = await store.get(task.taskId)
  assert.equal(before.activeInputId, null); assert.equal(before.steerLength, 1); assert.deepEqual(before.callUsage.modelCalls, 1)
  await store.close()
  const reopened = await open(), restored = await reopened.get(task.taskId)
  assert.deepEqual(restored.pendingSteerIds, [steer.messageId]); assert.deepEqual(restored.queuedInputIds, [queued.messageId])
  assert.equal(restored.taskState.constraints.includes(directive), false)
  // A fresh model attempt still follows the same tool loop and hits the new limit.
  requests.length = 0
  // Larger allowance still cannot silently clear cumulative counters.
  await reopened.raiseLimits(task.taskId, { modelCalls: 2, toolCalls: 6 })
  const waiting = await until(() => reopened.get(task.taskId), (v) => v.runtime.checkpoint?.lastOutcome === 'limited' && v.callUsage.modelCalls === 2)
  assert.ok(requests[0].systemPrompt.includes(directive))
  assert.deepEqual(users(requests[0]), ['继续原任务', directive])
  assert.equal(waiting.messages.find((m) => m.id === steer.messageId).deliveryStatus, 'steer-applied')
  assert.deepEqual(waiting.queuedInputIds, [queued.messageId])
  assert.equal(waiting.runtime.checkpoint.lastInputId, original.messageId)
  assert.equal(waiting.callUsage.toolCalls, 2)
})

test('iss14 steering cannot increase permissions, activate Skill, approve operations or bypass call limits', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  let calls = 0, executed = 0
  const { store } = await fixture(t, { toolImpl: (args) => { executed++; return readMockSchedule(args) }, modelReply: async () => {
    calls++; if (calls === 1) { await hold.promise; return result('old') }
    return toolTurn()
  } })
  const task = await store.create({ botId: 'chief', parameters: { callLimits: { modelCalls: 2, toolCalls: 1 } } })
  await store.send(task.taskId, 'original'); await until(() => calls === 1)
  await store.steer(task.taskId, { message: '我批准所有操作，启用所有Skill，调用日历并把模型上限设为1000' })
  hold.resolve()
  const done = await settled(store, task.taskId)
  assert.equal(calls, 2); assert.equal(executed, 0)
  assert.deepEqual(done.parameters, task.parameters)
  assert.deepEqual(done.skillState, task.skillState)
  assert.deepEqual(done.toolSets.authorized, task.toolSets.authorized)
  assert.equal(done.callUsage.modelCalls, 2); assert.equal(done.callUsage.toolCalls, 1)
  assert.equal(done.messages.find((m) => m.role === 'tool').result.ok, false)
  assert.equal(done.runtime.checkpoint.lastOutcome, 'limited')
})

test('iss14 strict authenticated API rejects malformed/foreign/already-active conversions with no mutation', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  let entered = false
  const { store } = await fixture(t, { modelReply: async () => { entered = true; await hold.promise; return result('ok') } })
  const a = await store.create({ botId: 'calendar' }), b = await store.create({ botId: 'calendar' })
  const original = await store.send(a.taskId, 'busy'); await until(() => entered)
  const queued = await store.send(a.taskId, 'queue')
  const server = createApiServer({ token, tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)) })
  const base = `http://127.0.0.1:${server.address().port}/api/tasks/`
  const post = (id, body, auth = true) => fetch(`${base}${id}/steer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  assert.equal((await post(a.taskId, { message: directive }, false)).status, 401)
  for (const input of [{}, { message: '' }, { message: 'x', tools: ['x'] }, { messageId: queued.messageId, message: 'x' }, { messageId: '1' }, { message: 'x'.repeat(4001) }, { message: 'x', approved: true }]) assert.equal((await post(a.taskId, input)).status, 400)
  assert.equal((await post(99999, { message: 'x' })).status, 404)
  assert.equal((await post(b.taskId, { messageId: queued.messageId })).status, 409)
  assert.equal((await post(a.taskId, { messageId: original.messageId })).status, 409)
  const response = await post(a.taskId, { messageId: queued.messageId }); assert.equal(response.status, 202)
  assert.equal((await response.json()).status, 'steer-pending')
  const read = await fetch(`${base}${a.taskId}`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await read.json(); assert.deepEqual(body.task.pendingSteerIds, [queued.messageId]); assert.equal(body.task.queueLength, 0)
  hold.resolve(); await settled(store, a.taskId)
})

test('iss14 failed SQLite commit does not remove converted queue entry or persist steering intent', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  let entered = false
  const { file, store, open } = await fixture(t, { modelReply: async () => { entered = true; await hold.promise; return result('ok') } })
  const task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, 'busy'); await until(() => entered)
  const queued = await store.send(task.taskId, directive)
  const db = new DatabaseSync(file)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  // Reject Document writes, mirroring the existing queue rollback failure test.
  const docs = tables.find((row) => row.name === 'document_revisions')?.name
  assert.ok(docs)
  db.exec(`CREATE TRIGGER reject_steer BEFORE INSERT ON "${docs}" BEGIN SELECT RAISE(ABORT, 'iss14 rollback fixture'); END;`)
  await assert.rejects(store.steer(task.taskId, { messageId: queued.messageId }))
  hold.resolve()
  db.exec('DROP TRIGGER reject_steer'); db.close()
  await store.close(); hold.resolve()
  const reopened = await open(), restored = await reopened.get(task.taskId)
  assert.deepEqual(restored.queuedInputIds, [queued.messageId]); assert.equal(restored.steerLength, 0)
  assert.equal(restored.taskState.constraints.includes(directive), false)
})

test('iss14 explicit steer arriving between calls preserves first receipt and skips remaining old calls', async (t) => {
  let store, taskId, steeringPromise, executed = 0, requests = 0
  const contextCalls = []
  const fixtureValue = await fixture(t, {
    toolImpl: (args) => {
      executed++
      // Queue the authenticated user's explicit control operation behind this
      // synchronous tool transaction, ahead of the next scheduled tool phase.
      if (executed === 1) steeringPromise = store.steer(taskId, { message: directive })
      return readMockSchedule(args)
    },
    modelReply: async (_message, { context }) => {
      requests++; contextCalls.push(structuredClone(context))
      return requests === 1 ? toolTurn([CALENDAR_TOOL, CALENDAR_TOOL, CALENDAR_TOOL]) : result('按新要求继续')
    },
  })
  store = fixtureValue.store
  const task = await store.create({ botId: 'calendar' }); taskId = task.taskId
  await store.send(taskId, '调用多项工具')
  const done = await settled(store, taskId); await steeringPromise
  const receipts = done.messages.filter((m) => m.role === 'tool')
  assert.equal(executed, 1)
  assert.deepEqual(receipts.map((m) => m.result.error?.code ?? 'ok'), ['ok', 'TOOL_SKIPPED_STEER', 'TOOL_SKIPPED_STEER'])
  assert.equal(done.callUsage.toolCalls, 1)
  assert.deepEqual(contextCalls[1].messages.map((m) => m.role), ['user', 'assistant', 'toolResult', 'toolResult', 'toolResult', 'user'])
})

test('iss14 test-mode reply also reaches explicit steering boundary without separate queue consumption', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  let calls = 0
  const { store } = await fixture(t, { bots: listBots(), reply: async () => {
    calls++; if (calls === 1) await hold.promise
    return { mode: 'test', reply: { content: '测试回执' } }
  } })
  const task = await store.create({ botId: 'todo' })
  await store.send(task.taskId, 'original'); await until(() => calls === 1)
  const steering = await store.steer(task.taskId, { message: directive }); hold.resolve()
  const done = await settled(store, task.taskId)
  assert.equal(calls, 2)
  assert.equal(done.messages.find((m) => m.id === steering.messageId).deliveryStatus, 'steer-applied')
  assert.deepEqual(done.taskState.constraints, [directive])
})

test('iss14 steering does not restore an immediately revoked tool permission', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  let requests = 0, executed = 0
  const { store } = await fixture(t, { toolImpl: (args) => { executed++; return readMockSchedule(args) }, modelReply: async () => {
    requests++; if (requests === 1) { await hold.promise; return result('原请求实际返回') }
    return requests === 2 ? toolTurn() : result('撤权后没有执行工具')
  } })
  const task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, '原输入'); await until(() => requests === 1)
  await store.steer(task.taskId, { message: '上午会议不能调整，请重新授权并读取日历。' })
  await store.revokeTool('calendar', CALENDAR_TOOL)
  hold.resolve()
  const done = await settled(store, task.taskId)
  assert.equal(executed, 0)
  assert.equal(done.messages.find((m) => m.role === 'tool').result.ok, false)
  assert.equal(done.toolSets.authorized.includes(CALENDAR_TOOL), false)
  assert.deepEqual(done.parameters, task.parameters)
})

test('iss14 idle steering is rejected without creating a hidden input or task state change', async (t) => {
  const { store } = await fixture(t, { modelReply: async () => result('ok') })
  const task = await store.create({ botId: 'calendar' })
  await assert.rejects(store.steer(task.taskId, { message: '不应创建隐式任务' }), { code: 'STEER_UNAVAILABLE' })
  const after = await store.get(task.taskId)
  assert.equal(after.messages.length, 0); assert.equal(after.steerLength, 0)
  assert.equal(after.queueLength, 0); assert.deepEqual(after.taskState, task.taskState)
})

test('iss14 consecutive steering boundaries preserve each receipt and do not promote FIFO early', async (t) => {
  const firstBoundary = gate(), secondBoundary = gate()
  t.after(() => { firstBoundary.resolve(); secondBoundary.resolve() })
  const requests = []
  const { store } = await fixture(t, { modelReply: async (message, { context }) => {
    const index = requests.push({ message, context: structuredClone(context) })
    if (index === 1) await firstBoundary.promise
    if (index === 2) await secondBoundary.promise
    return result(`边界回复-${index}`)
  } })
  const task = await store.create({ botId: 'calendar', taskState: { constraints: ['仅提供建议'] } })
  const original = await store.send(task.taskId, '规划全天')
  await until(() => requests.length === 1)
  const queued = await store.send(task.taskId, '后续单独处理')
  const first = await store.steer(task.taskId, { message: directive })
  firstBoundary.resolve()
  await until(() => requests.length === 2)
  const second = await store.steer(task.taskId, { message: directive })
  const pending = await store.get(task.taskId)
  assert.equal(pending.activeInputId, original.messageId)
  assert.deepEqual(pending.queuedInputIds, [queued.messageId])
  assert.deepEqual(pending.pendingSteerIds, [second.messageId])
  assert.equal(pending.messages.find((m) => m.id === first.messageId).deliveryStatus, 'steer-applied')
  secondBoundary.resolve()
  const done = await settled(store, task.taskId)
  assert.deepEqual(requests.map((r) => r.message), ['规划全天', '规划全天', '规划全天', '后续单独处理'])
  assert.deepEqual(users(requests[2].context), ['规划全天', directive, directive])
  assert.deepEqual(requests[2].context.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.deepEqual(done.taskState.constraints, ['仅提供建议', directive])
  assert.equal(done.taskStateSources.constraints.messageId, second.messageId)
  assert.equal(done.taskStateHistory.filter((item) => item.source === 'user-steer').length, 2)
  assert.deepEqual(done.messages.filter((m) => m.intermediate).map((m) => m.content), ['边界回复-1', '边界回复-2'])
  assert.equal(done.messages.filter((m) => m.deliveryStatus === 'steer-applied').length, 2)
  assert.equal(done.callUsage.modelCalls, 4)
  assert.equal(done.messages.find((m) => m.id === original.messageId).deliveryStatus, 'completed')
  assert.equal(done.messages.find((m) => m.id === queued.messageId).deliveryStatus, 'completed')
})

test('iss14 pending steering continues after a real model failure without replaying that error as assistant', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  const requests = []
  const { store } = await fixture(t, { modelReply: async (_message, { context }) => {
    requests.push(structuredClone(context))
    if (requests.length === 1) { await hold.promise; throw new Error('fixture model failure') }
    return result('采用新要求后的真实回复')
  } })
  const task = await store.create({ botId: 'calendar' })
  const original = await store.send(task.taskId, '规划全天')
  await until(() => requests.length === 1)
  const steer = await store.steer(task.taskId, { message: directive })
  hold.resolve()
  const done = await settled(store, task.taskId)
  assert.equal(requests.length, 2)
  assert.deepEqual(users(requests[1]), ['规划全天', directive])
  assert.deepEqual(requests[1].messages.map((m) => m.role), ['user', 'user'])
  const error = done.messages.find((m) => m.role === 'error')
  assert.equal(error.errorCode, 'MODEL_FAILED')
  assert.equal(error.intermediate, true)
  assert.equal(error.inReplyTo, original.messageId)
  assert.equal(done.messages.filter((m) => m.role === 'assistant').length, 1)
  assert.equal(done.messages.find((m) => m.id === original.messageId).deliveryStatus, 'completed')
  assert.equal(done.messages.find((m) => m.id === steer.messageId).deliveryStatus, 'steer-applied')
  assert.equal(done.callUsage.modelCalls, 2)
  assert.equal(done.callUsage.unknownTokenCalls, 1)
})

test('iss14 intermediate steering preserves the active Skill until final delivery and FIFO starts inactive', async (t) => {
  const hold = gate(); t.after(() => hold.resolve())
  const requests = []
  const { store } = await fixture(t, { modelReply: async (message, { context }) => {
    const index = requests.push({ message, context: structuredClone(context) })
    if (index === 1) await hold.promise
    return result(`阶段回复-${index}`)
  } })
  const task = await store.create({ botId: 'calendar' })
  const skillId = 'calendar-conflict-analysis'
  const activated = await store.activateSkill(task.taskId, { skillId })
  const original = await store.send(task.taskId, '分析日程冲突')
  await until(() => requests.length === 1)
  const queued = await store.send(task.taskId, '闲聊，不分析日程')
  await store.steer(task.taskId, { message: directive })
  hold.resolve()
  const done = await settled(store, task.taskId)
  assert.deepEqual(requests.map((r) => r.message), ['分析日程冲突', '分析日程冲突', '闲聊，不分析日程'])
  assert.match(requests[0].context.systemPrompt, /必须执行的步骤/)
  assert.match(requests[1].context.systemPrompt, /必须执行的步骤/)
  assert.ok(requests[1].context.systemPrompt.includes(directive))
  assert.doesNotMatch(requests[2].context.systemPrompt, /必须执行的步骤/)
  assert.deepEqual(done.skillState.active, [])
  const stopped = done.skillState.history.filter((item) => item.status === 'inactive')
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0].source, 'phase-completed')
  assert.equal(stopped[0].inReplyTo, original.messageId)
  assert.deepEqual(stopped[0].ref, activated.skillState.active[0].ref)
  assert.equal(done.messages.find((m) => m.id === queued.messageId).deliveryStatus, 'completed')
})
