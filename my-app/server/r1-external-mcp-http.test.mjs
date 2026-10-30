import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createExternalMcpService } from './external-mcp.mjs'
import { createFixtureMcpHttp } from './fixtures/external-mcp-sdk-http.mjs'
import { openTaskStore, TaskCard } from './tasks.mjs'
import { TaskApprovals } from './approvals.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createApiServer } from './app.mjs'
import { listBots } from './bots.mjs'

const config = { baseUrl: 'https://isolated.invalid/v1', model: 'external-fixture', apiKey: 'isolated-model' }
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 2 } } })
const turn = (name, args = { text: 'hello fixture' }) => {
  const call = { id: 'external-fixture-call', type: 'toolCall', name, arguments: args }
  return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
}
async function until(read, ready) {
  let last
  for (let i = 0; i < 300; i++) { last = await read(); if (ready(last)) return last; await delay(10) }
  assert.fail(`external runtime did not reach expected state: ${JSON.stringify({ runtime: last?.runtime, messages: last?.messages?.slice(-4) })}`)
}
async function fixture(t, { httpOptions, modelReply } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-r1-mcp-http-'))
  const remote = await createFixtureMcpHttp(httpOptions)
  let service, store, server
  const start = async () => {
    service = await createExternalMcpService({ dataDirectory: join(root, 'external-mcp') })
    store = await openTaskStore({ file: join(root, 'tasks.sqlite'), externalMcp: service, bots: listBots(config), workspaceEnabled: false, calendarQueryEnabled: false, modelReply: modelReply ?? (async () => text('done')) })
    server = createApiServer({ token: 'isolated-http-owner', tasks: store })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
  }
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close() }
  await start()
  t.after(async () => { await stop(); await remote.close(); await rm(root, { recursive: true, force: true }) })
  const call = async (path = '', body, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/external-mcp${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { authorization: 'Bearer isolated-http-owner' } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  const configure = async (connectionId = 'fixture', extra = {}) => {
    const result = await call('/configure', { requestId: `configure-${connectionId}`, config: { connectionId, name: 'Local official SDK fixture', transport: 'streamable-http', url: remote.url, allowLoopback: true, ...extra } })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return result.body.data
  }
  const check = async connectionId => {
    const connection = (await call()).body.data.items.find(item => item.connectionId === connectionId)
    const result = await call('/check', { requestId: `check-${connectionId}-${connection.revision}`, connectionId, expectedRevision: connection.revision })
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data
  }
  const bind = async (botId, connectionId = 'fixture', enabled = true) => {
    const view = await store.getBotCapabilities(botId), item = view.items.find(item => item.id === `mcp:${connectionId}`)
    return store.setBotCapabilityAssignment(botId, { requestId: randomUUID(), expectedRevision: view.revision,
      expectedCatalogRevision: item.revision, capabilityId: item.id, enabled })
  }
  return { root, remote, call, configure, check, bind, get store() { return store }, get service() { return service }, restart: async () => { await stop(); await start() } }
}

test('production external MCP HTTP configures, saves credentials, checks, binds, disables and removes with truthful receipts', async t => {
  const f = await fixture(t, { httpOptions: { bearerToken: 'synthetic-credential' } })
  assert.equal((await f.call('', undefined, false)).status, 401)
  assert.equal((await f.call('/requests/missing')).status, 404)
  const configured = await f.configure('fixture', { credentialRequired: true })
  assert.equal(configured.status, 'needs_auth')
  const saved = await f.call('/credentials', { requestId: 'credential-fixture', connectionId: 'fixture', expectedRevision: configured.revision, credential: { bearerToken: 'synthetic-credential' } })
  assert.equal(saved.status, 200); assert.equal(saved.body.data.saved, true)
  assert.equal(JSON.stringify(saved.body).includes('synthetic-credential'), false)
  assert.equal(JSON.stringify(saved.body).includes('credentialRef'), false)
  const checked = await f.check('fixture')
  assert.equal(checked.status, 'ready'); assert.equal(checked.toolCount, 3)
  const publicList = (await f.call()).body.data.items
  assert.equal(publicList[0].hasCredential, true)
  assert.equal(JSON.stringify(publicList).includes('synthetic-credential'), false)
  const { bot } = await f.store.createBot({ name: 'MCP blank bot', requestId: 'new-mcp-blank-bot' })
  assert.deepEqual(bot.defaults.tools, [])
  const initial = (await f.store.getBotCapabilities(bot.id)).items.find(item => item.id === 'mcp:fixture')
  assert.equal(initial.enabledForBot, false)
  await f.bind(bot.id)
  const after = await f.call('/disable', { requestId: 'disable-fixture', connectionId: 'fixture', expectedRevision: checked.revision })
  assert.equal(after.status, 200); assert.equal(after.body.data.status, 'disabled')
  assert.equal((await f.call('/requests/disable-fixture')).body.data.state, 'succeeded')
  assert.equal((await f.store.getBotCapabilities(bot.id)).items.find(item => item.id === 'mcp:fixture').available, false)
  const removed = await f.call('/remove', { requestId: 'remove-fixture', connectionId: 'fixture', expectedRevision: after.body.data.revision, confirmGlobal: true, affectedBotIds: [] })
  assert.equal(removed.status, 200, JSON.stringify(removed.body)); assert.deepEqual(removed.body.data.affectedBotIds, [bot.id])
  assert.deepEqual((await f.call()).body.data.items, [])
  const view = await f.store.getBotCapabilities(bot.id)
  await f.store.setBotCapabilityAssignment(bot.id, { requestId: randomUUID(), expectedRevision: view.revision, capabilityId: 'mcp:fixture', enabled: false, expectedCatalogRevision: 'removed' })
  const replay = await f.call('/remove', { requestId: 'remove-fixture', connectionId: 'fixture', expectedRevision: after.body.data.revision, confirmGlobal: true })
  assert.deepEqual(replay.body.data, removed.body.data)
})

test('actual Harness advertises a bound dynamic schema, asks once and stores the official SDK result', async t => {
  let alias, sawSchema = false, turns = 0
  const f = await fixture(t, { modelReply: async (_message, options) => {
    sawSchema ||= options.context.tools?.some(tool => tool.name === alias && tool.parameters.required.includes('text'))
    return turns++ === 0 ? turn(alias) : text('receipt received')
  } })
  await f.configure(); await f.check('fixture')
  alias = (await f.service.toolCatalog()).find(tool => tool.originalName === 'greeting.echo').name
  const { bot } = await f.store.createBot({ name: 'Dynamic user', requestId: 'dynamic-model-bot' })
  await f.bind(bot.id)
  const task = await f.store.create({ botId: bot.id })
  await f.store.send(task.taskId, 'Use the configured echo')
  const waiting = await until(() => f.store.get(task.taskId), task => task.runtime.checkpoint?.phase === 'awaitApproval' && task.approvals.activeId !== null)
  assert.equal(sawSchema, true); assert.equal(f.remote.calls.length, 0)
  const item = waiting.approvals.items.find(item => item.id === waiting.approvals.activeId)
  assert.equal(item.externalMcp.connectionId, 'fixture'); assert.equal(item.allowAlways, false)
  await f.store.decideApproval(task.taskId, item.id, { decision: 'approved' })
  const done = await until(() => f.store.get(task.taskId), task => task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput')
  assert.equal(f.remote.calls.length, 1)
  assert.deepEqual(done.approvals.items[0].receipt.result.data.structuredContent, { echoed: 'hello fixture' })
  assert.equal(done.callUsage.toolCalls, 1)
  assert.equal(done.messages.at(-1).content, 'receipt received')
})

test('restart requires a fresh connection check and a stable catalog keeps an explicit existing binding', async t => {
  const f = await fixture(t)
  await f.configure(); await f.check('fixture'); await f.bind('calendar')
  const view = (await f.store.getBotCapabilities('calendar')).items.find(item => item.id === 'mcp:fixture')
  assert.equal(view.available, true)
  await f.restart()
  const stale = (await f.store.getBotCapabilities('calendar')).items.find(item => item.id === 'mcp:fixture')
  assert.equal(stale.available, false)
  assert.equal((await f.store.toolCatalog()).some(tool => tool.name === view.toolNames[0]), false)
  await f.check('fixture')
  const ready = (await f.store.getBotCapabilities('calendar')).items.find(item => item.id === 'mcp:fixture')
  assert.equal(ready.revision, view.revision); assert.equal(ready.available, true)
  assert.equal((await f.store.toolCatalog()).some(tool => tool.name === view.toolNames[0]), true)
})


test('large official MCP results are stored whole and read through the actual paginated result tool', async t => {
  let alias, chunks = new Map(), received
  const large = 'normal fixture '.repeat(400)
  const f = await fixture(t, { modelReply: async (_message, options) => {
    const messages = options.context.messages
    const reads = messages.filter(message => message.role === 'toolResult' && message.toolName === 'tool_result_read')
    if (reads.length) {
      const result = JSON.parse(reads.at(-1).content[0].text)
      assert.equal(result.ok, true)
      chunks.set(result.data.coverage.offset, result.data.text)
      if (result.data.nextOffset === null) { received = JSON.parse([...chunks.values()].join('')); return text('complete raw result read') }
      return turn('tool_result_read', { resultRef: result.data.resultRef, resource: 'mcp:fixture', view: 'text', offset: result.data.nextOffset, limit: 2048 })
    }
    const execution = messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('宿主记录的具体外部 MCP 调用确认执行回执'))
    if (execution.length) {
      const result = JSON.parse(execution.at(-1).content.split('\n').slice(1).join('\n')).result
      assert.equal(result.data.bounded, true)
      assert.equal(result.data.summary.resource, 'mcp:fixture')
      return turn('tool_result_read', { resultRef: result.data.resultRef, resource: result.data.summary.resource, view: 'text', offset: 0, limit: 2048 })
    }
    return turn(alias, { text: large })
  } })
  await f.configure(); await f.check('fixture')
  alias = (await f.service.toolCatalog()).find(tool => tool.originalName === 'greeting.echo').name
  const { bot } = await f.store.createBot({ name: 'Paged result reader', requestId: 'paged-result-reader' })
  await f.bind(bot.id)
  const current = await f.store.getBotConfiguration(bot.id)
  await f.store.updateBotConfiguration(bot.id, { requestId: 'paged-result-read-tool', expectedVersion: current.bot.configRef.version,
    description: '', tools: [...current.assigned.tools, 'tool_result_read'], resources: [] })
  const task = await f.store.create({ botId: bot.id })
  await f.store.send(task.taskId, 'Read the complete normal fixture result')
  const waiting = await until(() => f.store.get(task.taskId), task => task.approvals.activeId !== null)
  await f.store.decideApproval(task.taskId, waiting.approvals.activeId, { decision: 'approved' })
  const done = await until(() => f.store.get(task.taskId), task => task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput')
  assert.equal(f.remote.calls.length, 1)
  assert.equal(chunks.size > 1, true)
  assert.equal(received.data.structuredContent.echoed, large)
  assert.equal(done.messages.at(-1).content, 'complete raw result read')
})

test('reviewed source replacement retires old context while a new request can consume its new result', async t => {
  let alias
  const rounds = new Map()
  const f = await fixture(t, { modelReply: async (message, options) => {
    const count = rounds.get(message) ?? 0; rounds.set(message, count + 1)
    if (message === 'new request') {
      assert.equal(JSON.stringify(options.context.messages).includes('old source conclusion'), false)
      assert.equal(JSON.stringify(options.context.messages).includes('first generation'), false)
    }
    return count === 0 ? turn(alias, { text: message === 'new request' ? 'second generation' : 'first generation' })
      : text(message === 'new request' ? 'new source conclusion' : 'old source conclusion')
  } })
  await f.configure(); await f.check('fixture')
  alias = (await f.service.toolCatalog()).find(tool => tool.originalName === 'greeting.echo').name
  const { bot } = await f.store.createBot({ name: 'Source replacement', requestId: 'source-replacement-bot' })
  await f.bind(bot.id)
  const task = await f.store.create({ botId: bot.id })
  const run = async message => {
    await f.store.send(task.taskId, message)
    const waiting = await until(() => f.store.get(task.taskId), task => task.approvals.activeId !== null)
    await f.store.decideApproval(task.taskId, waiting.approvals.activeId, { decision: 'approved' })
    return until(() => f.store.get(task.taskId), task => task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput')
  }
  await run('first request')
  const nextRemote = await createFixtureMcpHttp(); t.after(() => nextRemote.close())
  const current = (await f.call()).body.data.items[0]
  const updated = await f.call('/configure', { requestId: 'replace-source-url', expectedRevision: current.revision,
    config: { connectionId: 'fixture', name: 'New reviewed source', transport: 'streamable-http', url: nextRemote.url, allowLoopback: true } })
  assert.equal(updated.status, 200)
  await f.check('fixture'); await f.bind(bot.id)
  const done = await run('new request')
  assert.equal(nextRemote.calls.length, 1)
  assert.equal(done.messages.at(-1).content, 'new source conclusion')
  assert.equal(done.externalMcpHistoryFloor > 0, true)
  assert.equal(done.messages.some(message => message.content === 'old source conclusion'), false)
  assert.equal(done.approvals.items.length, 1)
})

test('disabling an in-flight benign MCP call stores one unknown receipt and never redispatches', async t => {
  let alias, entered, release
  const began = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  let turns = 0
  const f = await fixture(t, { httpOptions: { onCall: () => entered(), wait: () => gate }, modelReply: async () => turns++ === 0 ? turn(alias) : text('final state') })
  try {
    await f.configure(); const checked = await f.check('fixture')
    alias = (await f.service.toolCatalog()).find(tool => tool.originalName === 'records.write').name
    const { bot } = await f.store.createBot({ name: 'Interruption fixture', requestId: 'interruption-fixture' })
    await f.bind(bot.id)
    const task = await f.store.create({ botId: bot.id })
    await f.store.send(task.taskId, 'Run the benign fixture call')
    const waiting = await until(() => f.store.get(task.taskId), task => task.approvals.activeId !== null)
    await f.store.decideApproval(task.taskId, waiting.approvals.activeId, { decision: 'approved' })
    await began
    assert.equal((await f.call('/disable', { requestId: 'disable-inflight', connectionId: 'fixture', expectedRevision: checked.revision })).status, 200)
    const receipt = await until(() => f.store.harness.snapshot(TaskApprovals, task.taskId, context), state => Boolean(state.items[0].receipt))
    assert.equal(receipt.items[0].status, 'outcome-unknown')
    assert.equal((await f.store.get(task.taskId)).approvals.items[0].receipt.result.error.unknown, true)
    assert.deepEqual((await f.store.get(task.taskId)).approvals.items[0].arguments, {})
    assert.equal(receipt.items[0].receipt.result.error.unknown, true)
    assert.equal(receipt.items[0].receipt.result.error.retryable, false)
    assert.equal(f.remote.calls.length, 1)
    release()
    await delay(20)
    assert.equal(f.remote.calls.length, 1)
    const rawCard = await f.store.harness.snapshot(TaskCard, task.taskId, context)
    assert.equal(rawCard.externalMcpUsedRefs[0].toolName, alias)
    await until(() => f.store.get(task.taskId), task => task.activeInputId === null)
    await f.restart()
    const reopened = await f.store.harness.snapshot(TaskApprovals, task.taskId, context)
    assert.deepEqual(reopened.items[0].receipt, receipt.items[0].receipt)
    assert.equal(f.remote.calls.length, 1)
  } finally { release() }
})


test('two real stores keep external schemas and per-Bot assignments isolated', async t => {
  const first = await fixture(t), second = await fixture(t)
  await first.configure(); await first.check('fixture'); await first.bind('calendar')
  const alias = (await first.service.toolCatalog()).find(tool => tool.originalName === 'greeting.echo').name
  assert.equal((await first.store.toolCatalog()).some(tool => tool.name === alias), true)
  assert.equal((await second.store.toolCatalog()).some(tool => tool.name === alias), false)
  assert.equal((await second.store.getBotCapabilities('calendar')).items.some(item => item.id === 'mcp:fixture'), false)
  await first.bind('calendar', 'fixture', false)
  const capability = (await first.store.getBotCapabilities('calendar')).items.find(item => item.id === 'mcp:fixture')
  assert.equal(capability.enabledForBot, false)
  assert.equal((await first.store.getBotCapabilities('chief')).items.find(item => item.id === 'mcp:fixture').enabledForBot, false)
})
