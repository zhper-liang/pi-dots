import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore, TaskCard } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { CallUsage } from './tools.mjs'
import { injectMemoryContext } from './task-context.mjs'
import { MemoryExtraction, createBotMemoryRuntime, memorySourceAllowed, parseMemoryExtraction } from './bot-memory-runtime.mjs'

const config = { baseUrl: 'http://127.0.0.1:1/v1', model: 'memory-runtime-model', apiKey: 'runtime-private-key' }
const result = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
const candidate = (content, refs) => result(JSON.stringify({ memory: [], preferences: [{ content, sourceEntries: refs }] }))
const card = { taskId: 1, conversationId: 2, initiatingUser: 'authenticated-user', kind: 'chat', bot: { id: 'chief' }, parameters: { mode: 'model', model: { id: config.model }, thinkingLevel: 'off', requestTimeoutMs: 1000 } }
const entry = { id: 3, conversationId: 2, kind: 'pidot.user', data: { role: 'user', content: '我偏好简洁回答' } }
const refs = [{ taskId: 1, entryId: 3 }]
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-memory-runtime-')), file = join(dir, 'isolated.sqlite'), calls = []
  const store = await openTaskStore({ file, bots: listBots(config), modelReply: async (message, opts) => {
    calls.push({ message, purpose: opts.purpose, context: structuredClone(opts.context), parameters: structuredClone(opts.parameters) })
    if (opts.purpose === 'memory-extraction') {
      const input = JSON.parse(opts.context.messages[0].content).entries
      return candidate(input[0].content, input.map(({ taskId, entryId }) => ({ taskId, entryId })))
    }
    return result('原回复正常')
  }, ...options })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, calls, file }
}
async function settled(store, id) {
  for (let i = 0; i < 300; i++) {
    const view = await store.get(id)
    if (view.activeInputId === null && view.messages.some(message => message.role === 'assistant')) return view
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('isolated memory task did not settle')
}
const edit = (store, content, version = 1, requestId = `personality-${version}`) => store.editBotMemory('chief', { kind: 'personality', action: 'set', content, expectedVersion: version, requestId })

test('T11b source gate excludes groups, inherited, delegated, automated and unauthenticated entries', () => {
  assert.equal(memorySourceAllowed(card, entry), true)
  for (const change of [{ kind: 'group' }, { initiatingUser: 'external' }, { forkSource: {} }, { groupId: 'g' }, { collaboration: {} }, { mainParent: {} }, { scheduledWorkflow: {} }, { origin: 'event' }]) assert.equal(memorySourceAllowed({ ...card, ...change }, entry), false)
  for (const change of [{ source: 'task-assignment' }, { source: 'main-session' }, { calendarCommand: {} }, { targetBotIds: ['x'] }]) assert.equal(memorySourceAllowed(card, { ...entry, data: { ...entry.data, ...change } }), false)
  assert.equal(memorySourceAllowed(card, { ...entry, conversationId: 99 }), false)
})

test('T11b extraction only accepts evidence-anchored text, exact refs and no tools/calendar/secrets', () => {
  const sources = refs.map(ref => ({ ...ref, content: entry.data.content }))
  assert.equal(parseMemoryExtraction(candidate('偏好简洁回答', refs), sources).preferences[0].content, '偏好简洁回答')
  assert.throws(() => parseMemoryExtraction(candidate('用户总是购买昂贵商品', refs), sources))
  assert.throws(() => parseMemoryExtraction(candidate('简洁回答', [{ taskId: 2, entryId: 3 }]), sources))
  assert.throws(() => parseMemoryExtraction({ ...candidate('简洁回答', refs), toolCalls: [{ name: 'workspace.delete' }] }, sources))
  assert.throws(() => parseMemoryExtraction({ ...candidate('简洁回答', refs), reply: { ...candidate('简洁回答', refs).reply, toolCalls: [{}] } }, sources))
  for (const content of ['明天10:00会议', 'sk-private-key', 'Bearer token', config.apiKey]) assert.throws(() => parseMemoryExtraction(candidate(content, refs), refs.map(ref => ({ ...ref, content })), [config.apiKey]))
})

test('T11b optional context has a hard budget and never clips the core prompt or skills', async () => {
  const core = '目标与规则Skill'.repeat(2000), data = { systemPrompt: core, messages: [{ role: 'user', content: '当前输入' }], tools: [] }
  let requested
  await injectMemoryContext(data, { model: { id: 'x' }, contextWindows: { x: 8192 }, maxOutputTokens: 4096 }, async maxChars => { requested = maxChars; return { text: '', chars: 0, truncated: true, versions: {} } })
  assert.equal(requested, 0)
  assert.equal(data.systemPrompt, core)
  const small = { systemPrompt: '任务限制', messages: [] }
  await injectMemoryContext(small, {}, async maxChars => ({ text: '人格资料'.slice(0, maxChars), chars: 4, truncated: false, versions: { personality: 1 } }))
  assert.ok(small.systemPrompt.startsWith('任务限制'))
})

test('T11b default stores make no extraction calls; live personality replaces description without rewriting cards', async t => {
  const { store, calls } = await fixture(t)
  await edit(store, '人格甲')
  const task = await store.create({ botId: 'chief', taskState: { goal: '固定目标', constraints: ['禁止外发'] } })
  const before = await store.harness.snapshot(TaskCard, task.taskId, context)
  await store.send(task.taskId, '你好'); await settled(store, task.taskId)
  await edit(store, '人格乙', 2)
  await store.send(task.taskId, '继续'); await settled(store, task.taskId)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].context.systemPrompt.includes('人格甲'))
  assert.ok(calls[1].context.systemPrompt.includes('人格乙'))
  assert.ok(!calls[1].context.systemPrompt.includes('人格甲'))
  assert.ok(!calls[1].context.systemPrompt.includes(before.bot.description))
  assert.ok(calls[1].context.systemPrompt.includes('禁止外发'))
  assert.deepEqual((await store.harness.snapshot(TaskCard, task.taskId, context)).bot, before.bot)
  assert.equal((await store.getBotMemory('chief')).history.personality.length, 3)
  await store.memoryWorker.tick(); assert.equal(calls.length, 2)
})

test('T11b idle extraction batches consumed user inputs independently and injects shared preferences into another Bot', async t => {
  const { store, calls } = await fixture(t, { memoryOptions: { enabled: true, idleMs: 100000 } })
  const task = await store.create({ botId: 'chief' })
  await store.send(task.taskId, entry.data.content); await settled(store, task.taskId)
  await store.send(task.taskId, '我偏好中文'); await settled(store, task.taskId)
  const usage = structuredClone(await store.harness.snapshot(CallUsage, task.taskId, context))
  await Promise.all([store.memoryWorker.tick(), store.memoryWorker.tick()])
  const extracted = calls.filter(call => call.purpose === 'memory-extraction')
  assert.equal(extracted.length, 1)
  const input = JSON.parse(extracted[0].context.messages[0].content)
  assert.equal(input.entries.length, 2)
  assert.deepEqual(extracted[0].parameters.tools, [])
  assert.equal(extracted[0].context.tools, undefined)
  assert.deepEqual(await store.harness.snapshot(CallUsage, task.taskId, context), usage)
  assert.equal((await store.getPreferences()).items[0].content, entry.data.content)
  await store.memoryWorker.tick(); assert.equal(calls.filter(call => call.purpose === 'memory-extraction').length, 1)
  const other = await store.create({ botId: 'todo' })
  await store.send(other.taskId, '继续'); await settled(store, other.taskId)
  assert.ok(calls.at(-1).context.systemPrompt.includes(entry.data.content))
})

test('T11b depleted extraction quota persists pending status and leaves ordinary replies intact', async t => {
  const { store, calls } = await fixture(t, { memoryOptions: { enabled: true, idleMs: 100000, limits: { calls: 0 } } })
  const task = await store.create({ botId: 'chief' })
  await store.send(task.taskId, entry.data.content); const done = await settled(store, task.taskId)
  await store.memoryWorker.tick()
  assert.ok(done.messages.some(message => message.content === '原回复正常'))
  assert.equal(calls.length, 1)
  const prefs = await store.getPreferences()
  assert.equal(prefs.version, 0); assert.equal(prefs.status.state, 'pending'); assert.equal(prefs.status.code, 'MEMORY_BUDGET_EXHAUSTED')
})

test('T11b failed candidates preserve old docs; errors are TaskInputError and rotated/API keys stay unwritable', async t => {
  let current = { ...config }
  const { store } = await fixture(t, { readModelSettings: async () => current })
  store.registerMemorySecrets('runtime-http-private-token')
  await edit(store, '原人格')
  current = { ...config, apiKey: 'runtime-new-private-key' }
  for (const secret of [config.apiKey, current.apiKey, 'runtime-http-private-token']) await assert.rejects(edit(store, `包含${secret}`, 2, `reject-${secret.length}`), error => error.code === 'MEMORY_CREDENTIAL_REJECTED' && error.constructor.name === 'TaskInputError')
  const documents = await store.getBotMemory('chief')
  assert.equal(documents.personality.content, '原人格'); assert.equal(documents.personality.version, 2)
  await assert.rejects(edit(store, 'CAS冲突', 0, 'cas-conflict'), error => error.status === 409)
  await assert.rejects(store.getBotMemory('missing'), error => error.code === 'BOT_NOT_FOUND')
})

function fakeRuntime({ state = MemoryExtraction.definition.initial(), modelReply = async () => candidate(entry.data.content, refs), validate = async () => true, enabled = true } = {}) {
  let calls = 0
  const documents = { memory: { version: 0, items: [] }, preferences: { version: 0, items: [] } }
  const tx = { doc: async () => state }, transaction = async fn => fn(tx)
  const service = { get: async () => structuredClone(documents), markPending: async () => {}, applyCandidate: async (_tx, input) => ({ ok: true, version: 1, document: documents[input.kind] }) }
  const worker = createBotMemoryRuntime({ enabled, idleMs: 100000, transaction, service, gather: async () => [{ card, entries: [entry] }], validate,
    modelReply: async (...args) => { calls++; return modelReply(...args) }, getSecrets: async () => [], now: () => Date.parse('2026-10-29T00:00:00Z') })
  return { worker, state, calls: () => calls }
}

test('T11b failed/running worker attempts do not replay the same batch after restart', async () => {
  const first = fakeRuntime({ modelReply: async () => { throw new Error('private-model-error') } })
  await first.worker.tick(); assert.equal(first.calls(), 1)
  const restarted = fakeRuntime({ state: first.state })
  await restarted.worker.tick(); assert.equal(restarted.calls(), 0)
  first.state.jobs['1'].state = 'running'; first.state.jobs['1'].cursor = 0
  const crashed = fakeRuntime({ state: first.state }); await crashed.worker.tick()
  assert.equal(crashed.calls(), 0); assert.equal(first.state.jobs['1'].state, 'pending')
  await first.worker.close(); await restarted.worker.close(); await crashed.worker.close()
})

test('T11b cancellation or deactivation between extraction and commit never applies a candidate', async () => {
  let permitted = true
  const run = fakeRuntime({ validate: async () => permitted, modelReply: async () => { permitted = false; return candidate(entry.data.content, refs) } })
  await run.worker.tick()
  assert.equal(run.state.jobs['1'].state, 'pending'); assert.equal(run.state.jobs['1'].cursor, 3)
  await run.worker.close()
})

test('T11b a live local calendar is re-read per call, filtered by current source grants and never stored as memory', async t => {
  const at = Date.parse('2026-10-29T00:00:00Z')
  const bots = listBots(config)
  bots[0].defaults.toolResources = ['workspace:local']
  const { store, calls } = await fixture(t, { bots, memoryOptions: { now: () => at } })
  const created = await store.workspace.executeLocal({ sourceId: 'local', type: 'Event', action: 'create', requestId: 'runtime-calendar-create', data: {
    title: '实时合法日历甲', start: '2026-10-29T09:00:00+08:00', end: '2026-10-29T10:00:00+08:00', timezone: 'Asia/Shanghai',
  } })
  const event = { id: created.receipt.target.id, version: created.receipt.version }
  const task = await store.create({ botId: 'chief' })
  await store.send(task.taskId, '看看日程'); await settled(store, task.taskId)
  assert.ok(calls.at(-1).context.systemPrompt.includes('实时合法日历甲'))
  await store.workspace.executeLocal({ sourceId: 'local', type: 'Event', action: 'update', requestId: 'runtime-calendar-update', id: event.id, expectedVersion: event.version, data: { title: '实时合法日历乙' } })
  await store.send(task.taskId, '重新看日程'); await settled(store, task.taskId)
  assert.ok(calls.at(-1).context.systemPrompt.includes('实时合法日历乙'))
  assert.ok(!calls.at(-1).context.systemPrompt.includes('实时合法日历甲'))
  const documents = await store.getBotMemory('chief')
  assert.deepEqual(documents.memory.items, []); assert.deepEqual(documents.preferences.items, [])
  const { bot } = await store.getBotConfiguration('chief')
  await store.updateBotConfiguration('chief', { requestId: 'runtime-calendar-revoke', expectedVersion: bot.configRef.version, description: bot.description, tools: bot.defaults.tools, resources: [] })
  await store.send(task.taskId, '再次查询'); await settled(store, task.taskId)
  assert.ok(!calls.at(-1).context.systemPrompt.includes('实时合法日历乙'))
})

test('T11b real model adapter extracts JSON over loopback SSE without extra tools or replay', async t => {
  const { createServer } = await import('node:http')
  const { once } = await import('node:events')
  let extractionCalls = 0
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const system = body.messages.filter(message => message.role === 'system').map(message => Array.isArray(message.content) ? message.content.map(part => part.text).join('') : message.content).join('')
    let text = '原回复正常'
    if (system.includes('后台长期记忆提取器')) {
      extractionCalls++
      assert.equal(body.tools?.length ?? 0, 0)
      const data = JSON.parse(body.messages.at(-1).content), first = data.entries[0]
      text = JSON.stringify({ memory: [], preferences: [{ content: first.content, sourceEntries: [{ taskId: first.taskId, entryId: first.entryId }] }] })
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end([{ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }]
      .map(chunk => `data: ${JSON.stringify({ id: 'memory-loopback', model: body.model, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n')
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) })
  const live = { ...config, baseUrl: `http://127.0.0.1:${provider.address().port}/v1` }
  const { store } = await fixture(t, { modelReply: undefined, readModelSettings: async () => live, memoryOptions: { enabled: true, idleMs: 100000 } })
  const task = await store.create({ botId: 'chief' })
  await store.send(task.taskId, '请所有 Bot 使用简短中文回答'); await settled(store, task.taskId)
  await store.memoryWorker.tick()
  const preferences = await store.getPreferences()
  assert.equal(preferences.status.state, 'ready')
  assert.equal(preferences.items[0]?.content, '请所有 Bot 使用简短中文回答')
  assert.equal(extractionCalls, 1)
})
