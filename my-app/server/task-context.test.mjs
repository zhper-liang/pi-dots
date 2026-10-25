import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { listBots } from './bots.mjs'
import { TaskCard } from './tasks.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { createModelReply, ModelReplyError } from './model-reply.mjs'
import { createApiServer } from './app.mjs'

const config = { baseUrl: 'https://context.example/v1', apiKey: 'context-test-secret', model: 'deepseek-v4.1-flash' }
const token = 'context-test-api-token'
function sse(text) {
  return new Response([{ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
    .map((chunk) => `data: ${JSON.stringify({ id: 'context', model: config.model, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } })
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-context-'))
  const file = join(dir, 'task.sqlite')
  const stores = []
  const calls = []
  const modelReply = createModelReply(config, { fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body)); return sse('已记住你的安排。')
  } })
  const open = async (extra = {}) => {
    const store = await openTaskStore({ file, bots: listBots(config), modelReply, ...options, ...extra })
    stores.push(store); return store
  }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { file, calls, open, store: await open() }
}
async function settled(store, id) {
  for (let n = 0; n < 500; n++) {
    const task = await store.get(id)
    if (task.activeInputId === null) return task
    await delay(5)
  }
  assert.fail('Context task did not settle')
}
async function send(store, task, text) {
  await store.send(task.taskId, text)
  return settled(store, task.taskId)
}
async function apiFixture(t, options) {
  const fixtureData = await fixture(t, options)
  const server = createApiServer({ token, tasks: fixtureData.store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, method, body, auth = token) => fetch(base + path, { method,
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { ...fixtureData, request }
}

test('second round sends fixed Bot, task state and ordered consumed user/assistant history exactly once', async (t) => {
  const { store, calls } = await fixture(t)
  const task = await store.create({ botId: 'calendar', title: '周五安排', taskState: {
    goal: '安排内部会议', completionCriteria: ['给出两个候选时间'], constraints: ['只使用北京时间', '不改动日历'],
  } })
  await send(store, task, '我的代号是松果，周五下午有空。')
  const second = await send(store, task, '我的代号和空闲时间是什么？')
  assert.deepEqual(calls[1].messages.map((message) => message.role), ['system', 'user', 'assistant', 'user'])
  assert.deepEqual(calls[1].messages.slice(1).map((message) => message.content), [
    '我的代号是松果，周五下午有空。', '已记住你的安排。', '我的代号和空闲时间是什么？',
  ])
  const prompt = calls[1].messages[0].content[0].text
  for (const value of ['日程助理', '安排内部会议', '给出两个候选时间', '只使用北京时间', '不改动日历', task.configRef.version]) assert.ok(prompt.includes(value))
  assert.ok(prompt.includes('每次回复和后续行动均须遵守'))
  assert.ok(prompt.includes('1. 只使用北京时间\n2. 不改动日历'))
  assert.equal(second.messages.length, 4)
  assert.deepEqual(calls[1].tools.map((tool) => tool.function.name), ['calendar_read_schedule', 'calendar_read_event', 'tool_result_read', 'task_history_read', 'skill_activate', 'skill_deactivate', 'skill_read_resource', 'report_blocker', 'calendar_reschedule_event'])
  assert.equal(JSON.stringify(calls).includes(config.apiKey), false)
})

test('same Bot Tasks cannot read each other and concurrent Tasks keep independent contexts', async (t) => {
  const { store, calls } = await fixture(t)
  const a = await store.create({ botId: 'chief', taskState: { goal: 'A-私有目标' } })
  const b = await store.create({ botId: 'chief', taskState: { goal: 'B-私有目标' } })
  await Promise.all([send(store, a, 'A-私密-松果'), send(store, b, 'B-私密-银杏')])
  await send(store, a, '继续 A')
  await send(store, b, '继续 B')
  assert.ok(!JSON.stringify(calls[2]).includes('B-私'))
  assert.ok(!JSON.stringify(calls[3]).includes('A-私'))
  assert.ok(JSON.stringify(calls[2]).includes('A-私密-松果'))
  assert.ok(JSON.stringify(calls[3]).includes('B-私密-银杏'))
})

test('normal reopen restores full history, state and pinned Bot even if ordinary preset changes', async (t) => {
  const { store, calls, open } = await fixture(t)
  const task = await store.create({ botId: 'chief', taskState: { goal: '保存的目标' } })
  const first = await send(store, task, '重启前的名字是青禾。')
  const updated = await store.updateState(task.taskId, { constraints: ['只用中文'] })
  await store.close()
  const bots = listBots({ ...config, model: 'new-default' })
  bots[0].name = '新身份'; bots[0].description = '新说明'
  const reopened = await open({ bots })
  const restored = await reopened.get(task.taskId)
  assert.deepEqual(restored.messages, first.messages)
  assert.deepEqual(restored.taskState, updated.taskState)
  assert.deepEqual(restored.taskStateSources, updated.taskStateSources)
  assert.deepEqual(restored.taskStateHistory, updated.taskStateHistory)
  const second = await send(reopened, task, '还记得我的名字吗？')
  assert.ok(calls[1].messages[0].content[0].text.includes('Chief'))
  assert.ok(!calls[1].messages[0].content[0].text.includes('新身份'))
  assert.ok(calls[1].messages[0].content[0].text.includes('只用中文'))
  assert.ok(calls[1].messages.some((message) => message.content === '重启前的名字是青禾。'))
  assert.equal(calls[1].model, config.model)
  assert.deepEqual(second.configRef, task.configRef)
  assert.deepEqual(second.parameters, task.parameters)
  const next = await reopened.create({ botId: 'chief' })
  assert.equal(next.bot.name, task.bot.name); assert.equal(next.parameters.model.id, task.parameters.model.id)
})

test('state updates are sourced, durable, replace effective values and never mutate config or chat history', async (t) => {
  const { store, calls } = await fixture(t)
  const task = await store.create({ botId: 'chief', taskState: { goal: '旧目标', completionCriteria: ['旧标准'], constraints: ['旧限制'] } })
  const changed = await store.updateState(task.taskId, { goal: '新目标', completionCriteria: ['新标准'], constraints: [] })
  assert.deepEqual(changed.taskState, { goal: '新目标', completionCriteria: ['新标准'], constraints: [] })
  assert.equal(changed.taskStateHistory.length, 2)
  const sourceId = changed.taskStateSources.goal.entryId
  const source = await store.harness.commit((tx) => tx.entry(sourceId), ctx)
  assert.equal(source.conversationId, task.conversationId)
  assert.deepEqual(source.data.changes, changed.taskState)
  assert.equal(source.data.source, 'user-request')
  assert.deepEqual(changed.parameters, task.parameters)
  assert.deepEqual(changed.messages, [])
  await send(store, task, '普通聊天不是状态更新')
  const prompt = calls[0].messages[0].content[0].text
  assert.ok(prompt.includes('新目标') && prompt.includes('新标准'))
  for (const value of ['旧目标', '旧标准', '旧限制']) assert.ok(!prompt.includes(value))
  assert.equal((await store.get(task.taskId)).taskStateHistory.length, 2)
})

test('a failed model input remains consumed history but service errors never become assistant speech', async (t) => {
  const seen = []
  const { store } = await fixture(t, { modelReply: async (_text, options) => {
    seen.push(options.context)
    if (seen.length === 1) throw new ModelReplyError('MODEL_UNAVAILABLE')
    return { mode: 'model', reply: { content: '成功' } }
  } })
  const task = await store.create({ botId: 'chief' })
  await send(store, task, '我的名字是竹子')
  const second = await send(store, task, '继续')
  assert.deepEqual(seen[1].messages.map((message) => message.content), ['我的名字是竹子', '继续'])
  assert.ok(seen[1].messages.every((message) => message.role === 'user'))
  assert.deepEqual(second.messages.map((message) => message.role), ['user', 'error', 'user', 'assistant'])
})

test('context scans past 100 entries without dropping first, middle or latest turns', async (t) => {
  let view
  const { store } = await fixture(t, { modelReply: async (_text, options) => { view = options.context; return { mode: 'model', reply: { content: 'done' } } } })
  const task = await store.create({ botId: 'chief', parameters: { callLimits: { modelCalls: 100 } } })
  for (let n = 0; n < 55; n++) await send(store, task, `u-${n}`)
  await send(store, task, 'last')
  assert.equal(view.messages.length, 111)
  assert.equal(view.messages[0].content, 'u-0')
  assert.equal(view.messages[56].content, 'u-28')
  assert.equal(view.messages[109].content[0].text, 'done')
  assert.equal(view.messages[110].content, 'last')
})

test('unconsumed entries and forged replies by a different task are not replayed', async (t) => {
  let view
  const { store } = await fixture(t, { modelReply: async (_text, options) => { view = options.context; return { mode: 'model', reply: { content: 'done' } } } })
  const task = await store.create({ botId: 'chief' })
  await store.harness.commit(async (tx) => {
    const user = await tx.appendEntry(task.conversationId, { kind: 'pidot.user', data: { content: 'unconsumed-private', createdAt: new Date().toISOString() } })
    await tx.appendEntry(task.conversationId, { kind: 'pidot.model-reply', byTaskId: task.taskId + 1000,
      data: { role: 'assistant', content: 'forged-private', inReplyTo: user.id, createdAt: new Date().toISOString() } })
  }, ctx)
  await send(store, task, 'real-input')
  assert.deepEqual(view.messages.map((message) => message.content), ['real-input'])
})

test('legacy task cards synthesize working state without changing frozen parameters or fabricating source entries', async (t) => {
  const { store, calls } = await fixture(t)
  const task = await store.create({ botId: 'chief', title: '旧卡目标' })
  await store.harness.commit(async (tx) => {
    const card = await tx.doc(TaskCard, task.taskId)
    delete card.taskState; delete card.taskStateSources
  }, ctx)
  await send(store, task, '继续旧会话')
  assert.ok(calls[0].messages[0].content[0].text.includes('旧卡目标'))
  assert.ok(calls[0].messages[0].content[0].text.includes('legacy-title'))
  const saved = await store.get(task.taskId)
  assert.equal(saved.taskState, undefined)
  assert.deepEqual(saved.parameters, task.parameters)
  const patched = await store.updateState(task.taskId, { constraints: ['新增限制'] })
  assert.equal(patched.taskState.goal, '旧卡目标')
  assert.equal(patched.taskStateSources.goal.type, 'legacy-title')
  assert.equal(patched.taskStateSources.completionCriteria.type, 'legacy-default')
  assert.equal(patched.taskStateSources.constraints.type, 'user-request')
})

test('creation allows explicit configured ordinary parameters and preserves server-owned model endpoint, identity and tools', async (t) => {
  const { store, calls } = await fixture(t)
  const task = await store.create({ botId: 'chief', parameters: {
    model: { id: config.model }, thinkingLevel: 'off', requestTimeoutMs: 12345,
    callLimits: { modelCalls: 10, toolCalls: 0, totalTokens: 5000 },
  } })
  assert.deepEqual(task.parameters.model, { ...listBots(config)[0].defaults.model, id: config.model })
  assert.deepEqual(task.parameters.tools, ['report_blocker'])
  for (const key of ['model', 'thinkingLevel', 'requestTimeoutMs', 'callLimits']) assert.equal(task.parameterSources[key].type, 'user-request')
  assert.equal(task.parameterSources.tools.type, 'bot-default')
  await send(store, task, '明确模型')
  assert.equal(calls[0].model, config.model)
  assert.deepEqual(calls[0].thinking, { type: 'disabled' })
  assert.equal((await store.get(task.taskId)).messages[1].execution.timeoutMs, 12345)
})

test('invalid or authority-expanding parameter overrides fail atomically, not silently ignored', async (t) => {
  const { store } = await fixture(t)
  for (const parameters of [null, [], {}, { model: { id: 'unconfigured-model' } }, { tools: ['calendar.write'] }, { mode: 'model' }, { configRef: {} },
    { model: 'other' }, { model: { id: 'other', baseUrl: 'https://evil.example' } }, { model: { id: 'other', apiKey: 'secret' } },
    { model: { id: '../bad?model' } }, { thinkingLevel: 'high' }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 600001 },
    { requestTimeoutMs: 1.5 }, { callLimits: {} }, { callLimits: [] }, { callLimits: { modelCalls: -1 } },
    { callLimits: { modelCalls: 1.5 } }, { callLimits: { totalTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { callLimits: { tools: ['grant'] } }]) {
    await assert.rejects(store.create({ botId: 'chief', parameters }), (error) => error.status === 400)
  }
  assert.deepEqual(await store.list(), [])
  const zero = await store.create({ botId: 'chief', parameters: { callLimits: { modelCalls: 0, toolCalls: 0, totalTokens: 0 } } })
  assert.equal(zero.parameters.callLimits.modelCalls, 0)
})

test('test mode cannot be upgraded to a live model by a parameter override', async (t) => {
  const { store } = await fixture(t, { bots: listBots() })
  await assert.rejects(store.create({ botId: 'chief', parameters: { model: { id: 'live-model' } } }), { code: 'INVALID_PARAMETERS' })
})

test('invalid task state creates no partial records and rejected updates preserve state and audit history', async (t) => {
  const { store } = await fixture(t)
  const invalid = [null, [], {}, { goal: '' }, { goal: 'x'.repeat(4001) }, { completionCriteria: 'text' },
    { constraints: [''] }, { constraints: Array(21).fill('x') }, { constraints: ['x'.repeat(1001)] }, { tools: ['grant'] },
    JSON.parse('{"__proto__":{"goal":"fake"}}')]
  for (const taskState of invalid) await assert.rejects(store.create({ botId: 'chief', taskState }), { code: 'INVALID_TASK_STATE' })
  assert.deepEqual(await store.list(), [])
  const task = await store.create({ botId: 'chief' })
  for (const state of invalid) await assert.rejects(store.updateState(task.taskId, state), { code: 'INVALID_TASK_STATE' })
  assert.deepEqual(await store.get(task.taskId), task)
})

test('busy task rejects state updates without changing the active prompt or source record', async (t) => {
  let release
  const { store } = await fixture(t, { modelReply: async () => {
    await new Promise((resolve) => { release = resolve }); return { mode: 'model', reply: { content: 'done' } }
  } })
  const task = await store.create({ botId: 'chief' })
  await store.send(task.taskId, 'slow')
  while (!release) await delay(5)
  try { await assert.rejects(store.updateState(task.taskId, { goal: 'too late' }), { code: 'TASK_BUSY' }) }
  finally { release() }
  await settled(store, task.taskId)
  assert.deepEqual((await store.get(task.taskId)).taskState, task.taskState)
  assert.equal((await store.get(task.taskId)).taskStateHistory.length, 1)
  await store.updateState(task.taskId, { goal: 'next round' })
})

test('state API authenticates, validates, enforces PATCH and returns auditable current state', async (t) => {
  const { store, request } = await apiFixture(t)
  const task = await store.create({ botId: 'chief' })
  const path = `/api/tasks/${task.taskId}/state`
  assert.equal((await request(path, 'PATCH', { goal: 'unauthorized' }, 'wrong')).status, 401)
  const get = await request(path, 'GET')
  assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'PATCH')
  assert.equal((await request('/api/tasks/999999/state', 'PATCH', { goal: 'missing' })).status, 404)
  for (const state of [{ goal: '' }, { parameters: {} }, { constraints: [1] }]) assert.equal((await request(path, 'PATCH', state)).status, 400)
  const updated = await request(path, 'PATCH', { goal: 'API 目标', completionCriteria: ['API 标准'], constraints: ['不发邮件'] })
  assert.equal(updated.status, 200); assert.equal(updated.headers.get('cache-control'), 'no-store')
  const { task: saved } = await updated.json()
  assert.equal(saved.taskState.goal, 'API 目标')
  assert.equal(saved.taskStateHistory.length, 2)
  assert.equal(saved.taskStateSources.goal.entryId, saved.taskStateHistory[1].id)
  assert.deepEqual((await (await request(`/api/tasks/${task.taskId}`, 'GET')).json()).task.taskState, saved.taskState)
  const oversized = await request(path, 'PATCH', { goal: 'x'.repeat(17000) })
  assert.equal(oversized.status, 413)
})

test('creation API accepts explicit ordinary parameters but never tooling, endpoint or source overrides', async (t) => {
  const { request } = await apiFixture(t)
  const response = await request('/api/tasks', 'POST', { botId: 'chief', taskState: { goal: '明示目标' }, parameters: {
    model: { id: config.model }, thinkingLevel: 'off', callLimits: { modelCalls: 3 },
  } })
  assert.equal(response.status, 201)
  const { task } = await response.json()
  assert.equal(task.parameters.model.id, config.model)
  assert.equal(task.taskState.goal, '明示目标')
  for (const input of [{ parameters: { tools: ['grant'] } }, { parameters: { model: { id: 'model', baseUrl: 'https://evil.example' } } },
    { parameterSources: { model: 'fake' } }, { bot: { name: 'fake' } }, { taskStateSources: {} }]) {
    assert.equal((await request('/api/tasks', 'POST', { botId: 'chief', ...input })).status, 400)
  }
})


test('SQLite write failure rolls back task-state fields and their audit entry together', async (t) => {
  const { store, file, open } = await fixture(t)
  const task = await store.create({ botId: 'chief', taskState: { goal: '原目标' } })
  const db = new DatabaseSync(file)
  try {
    db.exec("CREATE TRIGGER fail_context BEFORE INSERT ON document_revisions WHEN EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND json_extract(record, '$.kind') = 'pidot.task-card') BEGIN SELECT RAISE(ABORT, 'context disk failure'); END")
    await assert.rejects(store.updateState(task.taskId, { goal: '不应提交', constraints: ['不应提交'] }))
    db.exec('DROP TRIGGER fail_context')
  } finally { db.close() }
  // A storage failure poisons this Harness session by design: verify durable atomicity after reopen.
  await store.close()
  const reopened = await open()
  assert.deepEqual(await reopened.get(task.taskId), task)
})
