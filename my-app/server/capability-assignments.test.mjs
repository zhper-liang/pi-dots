import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { BotDirectory, parseBotCreation, createDirectoryBot } from './bot-directory.mjs'
import { ToolAccess, toolSets, checkToolCall } from './tools.mjs'
import { PolicyRules, addRule } from './policy.mjs'
import { initializeConfiguration, migrateToolGroups, changeConfiguration } from './bot-configuration.mjs'
import { inferLegacyBotRole, inferBotRole } from './bot-templates.mjs'
import { listBotCapabilities, setCapabilityAssignment, assertCapabilityEnabled } from './capability-assignments.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const mcp = { id: 'mcp:fixture', kind: 'mcp', name: '测试 MCP', description: '受控假服务，不是真实连接', status: 'ready', revision: '1', toolNames: ['mcp_fixture_read', 'mcp_fixture_write'], requirements: [] }
const skill = { id: 'skill:imported', kind: 'skill', name: '测试 Skill', description: '声明式内容', status: 'ready', revision: '1', toolNames: [], requirements: [{ kind: 'tool', id: 'workspace.list' }] }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-capabilities-')), file = join(dir, 'tasks.sqlite')
  let store = await openTaskStore({ file, bots: listBots() })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { get store() { return store }, commit: fn => store.harness.commit(fn, context),
    reopen: async () => { await store.close(); store = await openTaskStore({ file, bots: listBots() }); return store } }
}
let n = 0
async function set(f, botId, capabilityId, enabled, catalog = [], overrides = {}) {
  return f.commit(async tx => {
    const view = await listBotCapabilities(tx, botId, { catalog })
    return setCapabilityAssignment(tx, botId, { requestId: `capability-request-${++n}`, expectedRevision: view.revision,
      expectedCatalogRevision: view.items.find(item => item.id === capabilityId)?.revision ?? '', capabilityId, enabled, ...overrides }, { catalog })
  })
}

test('R1-08 static enable/disable includes read tools and never rewrites ask/allow or resources', async t => {
  const f = await fixture(t)
  const projection = await f.commit(tx => listBotCapabilities(tx, 'todo'))
  const calendar = projection.items.find(item => item.id === 'tool:calendar')
  assert.equal(calendar.name, '日历与日程')
  assert.ok(calendar.description)
  assert.equal(calendar.status, 'ready')
  assert.equal(typeof calendar.enabledForBot, 'boolean')
  await f.commit(tx => addRule(tx, { botId: 'todo', match: { tool: 'calendar_reschedule_event', action: 'update' }, effect: 'ask' }))
  const before = await f.commit(async tx => ({ rules: copy(await tx.doc(PolicyRules)), resources: [...(await tx.doc(ToolAccess)).assignments.todo.resources] }))
  const enabled = await set(f, 'todo', 'tool:calendar', true)
  assert.equal((await f.commit(tx => listBotCapabilities(tx, 'todo'))).items.find(item => item.id === 'tool:calendar').enabledForBot, true)
  assert.ok(enabled.toolNames.includes('calendar_read_schedule'))
  await f.commit(async tx => { assert.deepEqual(await tx.doc(PolicyRules), before.rules); assert.deepEqual((await tx.doc(ToolAccess)).assignments.todo.resources, before.resources) })
  await set(f, 'todo', 'tool:calendar', false)
  await f.commit(async tx => {
    const access = await tx.doc(ToolAccess)
    await assert.rejects(assertCapabilityEnabled(tx, 'todo', 'tool:calendar'), { code: 'CAPABILITY_NOT_ENABLED' })
    const card = { bot: { id: 'todo' }, kind: 'chat' }
    const sets = toolSets(card, listBots(), access)
    assert.ok(!sets.authorized.includes('calendar_read_schedule'))
    assert.ok(!sets.displayed.includes('calendar_read_schedule'))
    assert.deepEqual(await tx.doc(PolicyRules), before.rules)
    const identity = { ...card, taskId: 1, configRef: { botId: 'todo' } }
    const denied = checkToolCall({ card: identity, record: { id: 1, input: { botId: 'todo' } }, conversation: { owner: { taskId: 1 } }, call: { name: 'calendar_read_schedule', arguments: {} }, displayed: ['calendar_read_schedule'], sets })
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'TOOL_NOT_AUTHORIZED')
  })
  await set(f, 'todo', 'tool:calendar', true)
  await f.commit(async tx => { assert.deepEqual(await tx.doc(PolicyRules), before.rules); assert.ok(!(await tx.doc(ToolAccess)).revoked.todo.includes('calendar_read_schedule')) })
})

test('R1-08 CAS shares the configuration version and receipt replays survive newer changes and restart', async t => {
  const f = await fixture(t)
  const initial = await f.commit(tx => listBotCapabilities(tx, 'todo'))
  const input = { requestId: 'stable-capability-request', capabilityId: 'tool:history', expectedRevision: initial.revision, expectedCatalogRevision: 'static-1', enabled: true }
  const first = await f.commit(tx => setCapabilityAssignment(tx, 'todo', input))
  await assert.rejects(f.commit(tx => setCapabilityAssignment(tx, 'todo', { ...input, requestId: 'different-request' })), { code: 'CONFIG_VERSION_CONFLICT' })
  const current = await f.store.getBotConfiguration('todo')
  assert.equal(current.bot.configRef.version, first.revision)
  await f.store.updateBotConfiguration('todo', { requestId: 'configuration-update', expectedVersion: first.revision, description: '', tools: current.assigned.tools, resources: current.assigned.resources })
  await f.reopen()
  assert.deepEqual(await f.commit(tx => setCapabilityAssignment(tx, 'todo', input)), first)
  await assert.rejects(f.commit(tx => setCapabilityAssignment(tx, 'todo', { ...input, enabled: false })), { code: 'CONFIG_REQUEST_CONFLICT' })
  const stale = await f.commit(tx => changeConfiguration(tx, 'todo', { requestId: 'stale-config-update', expectedVersion: initial.revision, description: '', tools: [], resources: [] }, { models: [] }))
  assert.equal(stale.error.code, 'CONFIG_VERSION_CONFLICT')
})

test('R1-08 concurrent capability updates choose one complete revision, failure rolls back', async t => {
  const f = await fixture(t), view = await f.commit(tx => listBotCapabilities(tx, 'todo'))
  const results = await Promise.allSettled(['history', 'calendar'].map(id => f.commit(tx => setCapabilityAssignment(tx, 'todo', {
    requestId: `concurrent-${id}`, expectedRevision: view.revision, expectedCatalogRevision: 'static-1', capabilityId: `tool:${id}`, enabled: true
  }))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'CONFIG_VERSION_CONFLICT')
  const before = await f.commit(async tx => copy(await tx.doc(ToolAccess)))
  await assert.rejects(f.commit(async tx => { const current = await listBotCapabilities(tx, 'todo'); await setCapabilityAssignment(tx, 'todo', {
    requestId: 'rollback-test-request', expectedRevision: current.revision, expectedCatalogRevision: 'static-1', capabilityId: 'tool:calendar', enabled: false
  }); throw new Error('injected transaction failure') }))
  assert.deepEqual(await f.commit(async tx => copy(await tx.doc(ToolAccess))), before)
})

test('R1-08 external registration never grants, only target binds, discovery additions stay unassigned', async t => {
  const f = await fixture(t)
  const a = await f.commit(tx => listBotCapabilities(tx, 'todo', { catalog: [mcp] }))
  assert.equal(a.items.find(item => item.id === mcp.id).enabledForBot, false)
  await set(f, 'todo', mcp.id, true, [mcp])
  const next = { ...mcp, revision: '2', toolNames: [...mcp.toolNames, 'mcp_fixture_new'] }
  await f.commit(async tx => {
    const todo = (await listBotCapabilities(tx, 'todo', { catalog: [next] })).items.find(item => item.id === mcp.id)
    assert.equal(todo.partiallyEnabled, true)
    assert.ok(!todo.assignedToolNames.includes('mcp_fixture_new'))
    assert.equal((await listBotCapabilities(tx, 'calendar', { catalog: [next] })).items.find(item => item.id === mcp.id).enabledForBot, false)
  })
  await assert.rejects(set(f, 'todo', mcp.id, true, [next], { expectedCatalogRevision: '1' }), { code: 'CAPABILITY_CATALOG_CONFLICT' })
  await set(f, 'todo', mcp.id, false, [next])
  await assert.rejects(f.commit(tx => assertCapabilityEnabled(tx, 'todo', mcp.id, { catalog: [next] })), { code: 'CAPABILITY_NOT_ENABLED' })
  await f.reopen()
  const access = await f.commit(async tx => copy(await tx.doc(ToolAccess)))
  assert.ok(mcp.toolNames.every(name => !access.assignments.todo.tools.includes(name)))
})

test('R1-08 saved MCP binding can be revoked without a reachable provider or current catalog', async t => {
  const f = await fixture(t)
  await set(f, 'todo', mcp.id, true, [mcp])
  await set(f, 'todo', mcp.id, false)
  const access = await f.commit(async tx => copy(await tx.doc(ToolAccess)))
  assert.ok(mcp.toolNames.every(name => !access.assignments.todo.tools.includes(name)))
})

test('R1-08 Skill selection never grants its dependencies and revocation supersedes old snapshots', async t => {
  const f = await fixture(t)
  const before = await f.commit(async tx => copy(await tx.doc(ToolAccess)))
  await set(f, 'todo', skill.id, true, [skill])
  assert.equal((await f.commit(tx => assertCapabilityEnabled(tx, 'todo', skill.id, { catalog: [skill] }))).id, skill.id)
  assert.deepEqual(await f.commit(async tx => copy(await tx.doc(ToolAccess))), before)
  await set(f, 'todo', skill.id, false, [skill])
  await f.reopen()
  await assert.rejects(f.commit(tx => assertCapabilityEnabled(tx, 'todo', skill.id, { catalog: [skill] })), { code: 'CAPABILITY_NOT_ENABLED' })
})

test('R1-08 legacy built-in Skills preserve selection; dynamically imported names never auto-enable', async t => {
  const f = await fixture(t)
  const builtin = { ...skill, id: 'skill:calendar-conflict-analysis' }
  const view = await f.commit(tx => listBotCapabilities(tx, 'calendar', { catalog: [builtin, skill] }))
  assert.equal(view.items.find(item => item.id === builtin.id).enabledForBot, true)
  assert.equal(view.items.find(item => item.id === skill.id).enabledForBot, false)
  const fresh = await f.store.createBot({ name: '日历新 Bot', requestId: 'blank-skill-request' })
  assert.equal((await f.commit(tx => listBotCapabilities(tx, fresh.bot.id, { catalog: [builtin] }))).items.find(item => item.id === builtin.id).enabledForBot, false)
})

test('R1-08 missing auth never becomes ready, disabled and empty connections cannot bind', async t => {
  const f = await fixture(t), pending = { ...mcp, status: 'needs_auth' }
  const result = await set(f, 'todo', pending.id, true, [pending])
  assert.equal(result.status, 'needs_auth')
  await assert.rejects(f.commit(tx => assertCapabilityEnabled(tx, 'todo', mcp.id, { catalog: [pending] })), { code: 'CAPABILITY_UNAVAILABLE' })
  await assert.rejects(set(f, 'todo', mcp.id, true, [{ ...mcp, status: 'disabled' }]), { code: 'CAPABILITY_UNAVAILABLE' })
  await assert.rejects(set(f, 'todo', mcp.id, true, [{ ...mcp, toolNames: [] }]), { code: 'CAPABILITY_UNAVAILABLE' })
})

test('R1-08 malformed/forged aliases, prototype ids, stopped Bots, no-op request conflicts fail closed', async t => {
  const f = await fixture(t)
  for (const item of [{ ...mcp, toolNames: ['bot_manage'] }, { ...mcp, toolNames: ['task_create'] }, { ...mcp, toolNames: ['workspace.list'] }, { ...skill, toolNames: ['workspace.list'] }])
    await assert.rejects(f.commit(tx => listBotCapabilities(tx, 'todo', { catalog: [item] })), { code: 'INVALID_CAPABILITY_CATALOG' })
  const view = await f.commit(tx => listBotCapabilities(tx, 'todo'))
  await assert.rejects(f.commit(tx => setCapabilityAssignment(tx, 'todo', { requestId: 'constructor', capabilityId: 'tool:history', enabled: true, expectedRevision: view.revision, expectedCatalogRevision: 'static-1' })), { code: 'INVALID_CAPABILITY_ASSIGNMENT' })
  await f.commit(async tx => { (await tx.doc(BotDirectory)).items.find(item => item.id === 'todo').status = 'inactive' })
  await assert.rejects(set(f, 'todo', 'tool:history', true), { code: 'BOT_INACTIVE' })
})

test('R1-08 marker migration preserves every live assignment, revocation, resource, rule and v1 audit', () => {
  const directory = { items: listBots() }, access = { assignments: { todo: { tools: ['workspace.list'], resources: ['workspace:local'] } }, revoked: { todo: ['workspace.list'] }, groupsVersion: 1, groupsMigration: { version: 1, bots: { todo: { tools: [] } } } }
  initializeConfiguration(directory, access)
  const rules = { items: [{ botId: 'todo', match: { tool: 'workspace.prepare_change', action: 'delete' }, effect: 'deny' }] }
  const before = structuredClone({ assignments: access.assignments, revoked: access.revoked, rules, migration: access.groupsMigration })
  assert.equal(migrateToolGroups(directory, access, rules), true)
  assert.deepEqual({ assignments: access.assignments, revoked: access.revoked, rules, migration: access.groupsMigration }, before)
  assert.equal(migrateToolGroups(directory, access, rules), false)
})

test('R1-08 new Bot is business-blank even for legacy profile, restart never fills it and a conversation can be created', async t => {
  const f = await fixture(t)
  const result = await f.store.createBot({ name: '日程费用助手', requestId: 'blank-bot-request', profile: 'mock-calendar' })
  assert.equal(result.bot.description, '')
  assert.equal(inferBotRole('日程费用助手').role, '')
  assert.deepEqual(result.bot.defaults.tools, [])
  assert.deepEqual(result.bot.defaults.toolResources, [])
  assert.equal(result.bot.capabilityDefaultsVersion, 2)
  await f.reopen()
  const view = await f.store.getBotConfiguration(result.bot.id)
  assert.deepEqual(view.assigned, { tools: [], resources: [] })
  const replay = await f.store.createBot({ name: '日程费用助手', requestId: 'blank-bot-request', profile: 'mock-calendar' })
  assert.equal(replay.bot.id, result.bot.id)
  const task = await f.store.create({ botId: result.bot.id, title: '空白 Bot 可创建会话' })
  assert.ok(task.taskId)
})

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const signature = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
test('R1-08 both old receipt generations replay inferred names, no regrant or personality rewrite', () => {
  const parsed = parseBotCreation({ name: '日程助手', requestId: 'legacy-create-request' })
  const description = inferLegacyBotRole(parsed.name).description
  const old = { id: 'old', name: parsed.name, description, profile: 'general', configRef: { botId: 'old', version: 'old' }, defaults: { ...listBots()[0].defaults, tools: ['report_blocker'], toolResources: [] } }
  for (const frozen of [true, false]) {
    const directory = { items: [...listBots(), structuredClone(old)], requests: {} }
    directory.requests[parsed.requestId] = { botId: old.id, signature: signature({ name: parsed.name, description, profile: 'general', ...(frozen ? {} : { defaults: old.defaults }) }), ...(frozen ? { bot: structuredClone(old) } : {}) }
    const replay = createDirectoryBot(directory, parsed)
    assert.equal(replay.created, false)
    assert.deepEqual(replay.bot, old)
    assert.throws(() => createDirectoryBot(directory, parseBotCreation({ name: parsed.name, description: 'changed', requestId: parsed.requestId })), { code: 'BOT_REQUEST_CONFLICT' })
  }
})
