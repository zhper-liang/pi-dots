import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiServer } from './app.mjs'
import { openTaskStore } from './tasks.mjs'
import { groupTools } from './tool-groups.mjs'
import { toolCatalog } from './tools.mjs'

const skill = { id: 'skill:r4-fixture', kind: 'skill', name: '测试 Skill', description: '声明式资料', status: 'ready', revision: '1', requirements: [], toolNames: [] }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r4-capabilities-'))
  const store = await openTaskStore({ file: join(dir, 'tasks.sqlite'), readCapabilityCatalog: async () => [skill] })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return store
}

test('R4 creation defaults to schedule/todos and history, with connected resources and no mock calendar', async t => {
  const store = await fixture(t)
  const input = { name: '默认机器人', requestId: 'r4-create-default' }
  const created = await store.createBot(input)
  const installed = new Set(toolCatalog().map(tool => tool.name))
  const expected = [...groupTools('todos'), ...groupTools('history')].filter(name => installed.has(name))
  assert.deepEqual(created.bot.defaults.tools, expected)
  assert.ok(created.bot.defaults.toolResources.includes('workspace:local'))
  assert.ok(!created.bot.defaults.toolResources.includes('mock:personal'))
  const configuration = await store.getBotConfiguration(created.bot.id)
  assert.deepEqual(configuration.assigned, { tools: expected, resources: ['workspace:local'] })
  assert.deepEqual(configuration.versions[0].defaults, created.bot.defaults)
  assert.equal(configuration.versions.length, 1)
})

test('R4 creation accepts a selected history-only capability', async t => {
  const store = await fixture(t)
  const { bot } = await store.createBot({ name: '只回读', requestId: 'r4-create-history', capabilities: ['tool:history'] })
  assert.deepEqual(bot.defaults.tools, groupTools('history'))
  assert.deepEqual(bot.defaults.toolResources, [])
})

test('R4 unknown capability fails the entire creation transaction', async t => {
  const store = await fixture(t)
  const before = store.bots().map(bot => bot.id)
  await assert.rejects(store.createBot({ name: '无效能力', requestId: 'r4-create-missing', capabilities: ['skill:missing'] }), { status: 404, code: 'CAPABILITY_NOT_FOUND' })
  assert.deepEqual(store.bots().map(bot => bot.id), before)
})

test('R4 old-style request replay returns the original bot and its creation defaults', async t => {
  const store = await fixture(t)
  const input = { name: '重放机器人', requestId: 'r4-create-replay' }
  const first = await store.createBot(input), replay = await store.createBot(input)
  assert.equal(replay.created, false)
  assert.deepEqual(replay.bot, first.bot)
  assert.equal(replay.mainTaskId, first.mainTaskId)
})

test('R4 the first enabled Skill grants mechanism tools and disabling the last removes them', async t => {
  const store = await fixture(t)
  const { bot } = await store.createBot({ name: 'Skill 机器人', requestId: 'r4-create-skill-bot', capabilities: [] })
  for (const enabled of [true, false]) {
    const view = await store.getBotCapabilities(bot.id)
    await store.setBotCapabilityAssignment(bot.id, { requestId: `r4-skill-${enabled}`, expectedRevision: view.revision,
      capabilityId: skill.id, enabled, expectedCatalogRevision: skill.revision })
    const { assigned } = await store.getBotConfiguration(bot.id)
    assert.deepEqual(assigned.tools, enabled ? groupTools('skills') : [])
  }
})

test('R4 global catalog contains merged tools and no bot-specific assignment fields', async t => {
  const store = await fixture(t), server = createApiServer({ token: 'r4-catalog-token', tasks: store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/capabilities`, { headers: { authorization: 'Bearer r4-catalog-token' } })
  assert.equal(response.status, 200)
  const { data: { items } } = await response.json()
  assert.ok(items.some(item => item.id === 'tool:todos'))
  assert.ok(!items.some(item => item.id === 'tool:calendar'))
  assert.ok(items.every(item => !Object.hasOwn(item, 'enabledForBot')))
})
