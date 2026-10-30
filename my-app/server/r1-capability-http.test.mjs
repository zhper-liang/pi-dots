import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createApiServer } from './app.mjs'
import { openTaskStore } from './tasks.mjs'
import { ToolAccess } from './tools.mjs'
import { PolicyRules, addRule } from './policy.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
async function fixture(t, { readCapabilityCatalog } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r1-capability-http-'))
  const options = { file: join(dir, 'tasks.sqlite'), ...(readCapabilityCatalog ? { readCapabilityCatalog } : {}) }
  const token = randomUUID()
  let store, server
  async function start() {
    store = await openTaskStore(options)
    server = createApiServer({ token, tasks: store })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  }
  async function stop() {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    if (store) await store.close()
  }
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }) })
  await start()
  const request = async (botId = 'todo', { body, method = body === undefined ? 'GET' : 'POST', auth = true, raw, contentType = 'application/json', suffix = 'capabilities' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/${botId}/${suffix}`, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': contentType },
      ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
    })
    return { status: response.status, allow: response.headers.get('allow'), json: await response.json() }
  }
  return { request, get store() { return store }, reopen: async () => { await stop(); await start() },
    commit: fn => store.harness.commit(fn, context) }
}
function assignment(view, { capabilityId = 'tool:calendar', enabled = true, requestId = randomUUID() } = {}) {
  return { requestId, expectedRevision: view.revision, capabilityId, enabled,
    expectedCatalogRevision: view.items.find(item => item.id === capabilityId)?.revision ?? 'static-1' }
}
async function view(f, botId = 'todo') {
  const response = await f.request(botId)
  assert.equal(response.status, 200)
  return response.json.data
}

// Real store + real R1-08 service behind authenticated loopback HTTP. No providers or credentials.
test('R1 capability HTTP authenticates before catalog/service access and bounds methods', async t => {
  const calls = []
  const f = await fixture(t, { readCapabilityCatalog: async (tx, scope) => {
    assert.equal(typeof tx.doc, 'function')
    calls.push(scope.botId)
    return []
  } })
  assert.equal((await f.request('todo', { auth: false })).status, 401)
  assert.equal((await f.request('todo', { auth: false, body: {} })).status, 401)
  const denied = await f.request('todo', { method: 'DELETE' })
  assert.equal(denied.status, 405)
  assert.equal(denied.allow, 'GET, POST')
  assert.deepEqual(calls, [])
  const initial = await view(f)
  assert.equal(initial.botId, 'todo')
  assert.ok(initial.items.length > 0)
  assert.ok(initial.items.every(item => item.kind === 'tool' && item.id.startsWith('tool:')))
  assert.deepEqual(calls, ['todo'])
  assert.equal((await f.request('missing-bot')).status, 404)
})

test('R1 capability HTTP rejects catalog injection, unregistered capabilities and malformed bodies', async t => {
  const f = await fixture(t)
  const initial = await view(f)
  const body = assignment(initial)
  for (const extra of [{ catalog: [] }, { approved: true }, { targetBotId: 'chief' }]) {
    const response = await f.request('todo', { body: { ...body, ...extra } })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'INVALID_CAPABILITY_ASSIGNMENT')
  }
  for (const capabilityId of ['mcp:not-registered', 'skill:not-registered']) {
    const response = await f.request('todo', { body: assignment(initial, { capabilityId }) })
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'CAPABILITY_NOT_FOUND')
  }
  assert.equal((await f.request('todo', { body: null })).status, 400)
  assert.equal((await f.request('todo', { method: 'POST', raw: '{' })).json.error.code, 'INVALID_JSON')
  assert.equal((await f.request('todo', { body, contentType: 'text/plain' })).status, 415)
  assert.equal((await f.request('todo', { method: 'POST', raw: JSON.stringify({ value: 'x'.repeat(17000) }) })).status, 413)
  assert.equal((await view(f)).revision, initial.revision)
})

test('R1 capability HTTP uses real assignments, preserves policy/resources and syncs live Bot catalog', async t => {
  const f = await fixture(t)
  await f.commit(tx => addRule(tx, { botId: 'todo', match: { tool: 'calendar_reschedule_event' }, effect: 'ask' }))
  const before = await f.commit(async tx => ({ access: copy(await tx.doc(ToolAccess)), policy: copy(await tx.doc(PolicyRules)) }))
  const other = await view(f, 'calendar')
  const initial = await view(f)
  const enabled = await f.request('todo', { body: assignment(initial) })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.json.data.enabledForBot, true)
  assert.notEqual(enabled.json.data.revision, initial.revision)
  const item = (await view(f)).items.find(item => item.id === 'tool:calendar')
  assert.equal(item.enabledForBot, true)
  const configuration = await f.store.getBotConfiguration('todo')
  assert.ok(configuration.assigned.tools.includes('calendar_read_schedule'))
  assert.equal(configuration.bot.configRef.version, enabled.json.data.revision)
  assert.equal(f.store.bots().find(bot => bot.id === 'todo').configRef.version, enabled.json.data.revision)
  const disabled = await f.request('todo', { body: assignment(await view(f), { enabled: false }) })
  assert.equal(disabled.status, 200)
  const after = await f.commit(async tx => ({ access: copy(await tx.doc(ToolAccess)), policy: copy(await tx.doc(PolicyRules)) }))
  assert.ok(!after.access.assignments.todo.tools.includes('calendar_read_schedule'))
  assert.ok(after.access.revoked.todo.includes('calendar_read_schedule'))
  assert.deepEqual(after.access.assignments.todo.resources, before.access.assignments.todo.resources)
  assert.deepEqual(after.policy, before.policy)
  assert.equal((await view(f, 'calendar')).revision, other.revision)
  assert.equal(f.store.bots().find(bot => bot.id === 'todo').configRef.version, disabled.json.data.revision)
})

test('R1 capability HTTP CAS conflicts with stale capabilities and old full configuration writes', async t => {
  const f = await fixture(t)
  const initial = await view(f)
  const configuration = await f.store.getBotConfiguration('todo')
  const enabled = await f.request('todo', { body: assignment(initial) })
  assert.equal(enabled.status, 200)
  const stale = await f.request('todo', { body: assignment(initial, { enabled: false }) })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error.code, 'CONFIG_VERSION_CONFLICT')
  const staleConfig = await f.request('todo', { suffix: 'configuration', body: {
    requestId: randomUUID(), expectedVersion: configuration.bot.configRef.version,
    description: configuration.bot.description, tools: configuration.assigned.tools, resources: configuration.assigned.resources,
  } })
  assert.equal(staleConfig.status, 409)
  assert.equal(staleConfig.json.error.code, 'CONFIG_VERSION_CONFLICT')
  const fresh = await view(f)
  const changedCatalog = await f.request('todo', { body: { ...assignment(fresh), expectedCatalogRevision: 'stale-catalog' } })
  assert.equal(changedCatalog.status, 409)
  assert.equal(changedCatalog.json.error.code, 'CAPABILITY_CATALOG_CONFLICT')
  assert.equal((await view(f)).revision, enabled.json.data.revision)
})

test('R1 capability HTTP replays frozen receipts across later changes and restart without stale catalog sync', async t => {
  const f = await fixture(t)
  const input = assignment(await view(f))
  const enabled = await f.request('todo', { body: input })
  const disabled = await f.request('todo', { body: assignment(await view(f), { enabled: false }) })
  assert.equal(enabled.status, 200)
  assert.equal(disabled.status, 200)
  for (const restart of [false, true]) {
    if (restart) await f.reopen()
    const replay = await f.request('todo', { body: input })
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.json, enabled.json)
    const current = await view(f)
    assert.equal(current.revision, disabled.json.data.revision)
    assert.equal(current.items.find(item => item.id === 'tool:calendar').enabledForBot, false)
    assert.equal(f.store.bots().find(bot => bot.id === 'todo').configRef.version, current.revision)
  }
  const conflict = await f.request('todo', { body: { ...input, enabled: false } })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.json.error.code, 'CONFIG_REQUEST_CONFLICT')
})

test('R1 capability HTTP concurrent changes have one CAS winner and inactive Bots cannot mutate', async t => {
  const f = await fixture(t)
  const initial = await view(f)
  const responses = await Promise.all(['tool:calendar', 'tool:history'].map(capabilityId => f.request('todo', { body: assignment(initial, { capabilityId }) })))
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
  const created = await f.store.createBot({ requestId: randomUUID(), name: '空白隔离测试' })
  const blank = await view(f, created.bot.id)
  assert.ok(blank.items.every(item => !item.enabledForBot))
  await f.store.deactivateBot(created.bot.id, { confirm: true })
  const denied = await f.request(created.bot.id, { body: assignment(blank) })
  assert.equal(denied.status, 409)
  assert.equal(denied.json.error.code, 'BOT_INACTIVE')
  assert.ok((await view(f, created.bot.id)).items.every(item => !item.available))
})

test('R1 capability catalog injection seam is server-owned and refreshed in the authenticated transaction', async t => {
  const calls = []
  const f = await fixture(t, { readCapabilityCatalog: async (tx, { botId }) => {
    assert.equal(typeof tx.doc, 'function')
    calls.push(botId)
    return [] // No fabricated external registration; R1-09/10 provide real projections later.
  } })
  const initial = await view(f)
  assert.equal((await f.request('todo', { body: assignment(initial) })).status, 200)
  assert.deepEqual(calls, ['todo', 'todo'])
})
