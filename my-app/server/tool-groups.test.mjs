import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { toolCatalog, ToolAccess } from './tools.mjs'
import { TOOL_GROUPS } from './tool-groups.mjs'
import { decide, WRITE_TOOLS, addRule, setAutomationPause, PolicyRules } from './policy.mjs'
import { openTaskStore as openRawStore } from './tasks.mjs'
import { TOOL_GROUPS_VERSION } from './bot-configuration.mjs'
import { commandSkills } from './skills.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'tool-group-fixture', apiKey: 'never-store' }
const reply = () => ({ mode: 'model', reply: { content: '好。' }, execution: { usage: { totalTokens: 3 } } })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-tool-groups-'))
  const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => reply(),
    skillDirectory: new URL('./skills/', import.meta.url).pathname })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store }
}
let n = 0
const requestId = () => `group-switch-${++n}`

test('every registered tool belongs to exactly one Chinese-labelled group', () => {
  const names = toolCatalog().map((tool) => tool.name)
  const grouped = TOOL_GROUPS.flatMap((group) => group.tools)
  assert.deepEqual(names.filter((name) => !grouped.includes(name)), [])
  assert.equal(new Set(grouped).size, grouped.length)
  for (const group of TOOL_GROUPS) assert.ok(group.label.trim() && group.description.trim())
  assert.equal(TOOL_GROUPS.find((group) => group.id === 'calendar').label, '日历与日程')
})

test('configuration exposes groups with Chinese labels and modes derived from current rules', async (t) => {
  const { store } = await fixture(t)
  const view = await store.getBotConfiguration('calendar')
  const todo = view.toolGroups.find((group) => group.id === 'todos')
  assert.equal(todo.label, '待办与事项')
  assert.equal(todo.mode, 'ask') // the legacy fixture's ask rule on workspace.prepare_change
  assert.ok(todo.tools.every((tool) => !/^workspace\./.test(tool.label)))
  assert.equal(view.toolLabels['workspace.prepare_change'], '新建、修改或删除事项')
  assert.equal(todo.tools.find((tool) => tool.name === 'workspace.prepare_change').write, true)
  assert.equal(todo.tools.find((tool) => tool.name === 'workspace.list').write, false)
  assert.equal(view.toolGroups.find((group) => group.id === 'calendar').mode, 'ask') // the legacy fixture's ask rules on calendar writes
  assert.equal(view.toolGroups.find((group) => group.id === 'skills').mode, 'allow') // no writes to gate
})

test('one group switch sets every write tool in the group, is idempotent and audited', async (t) => {
  const { store } = await fixture(t)
  const input = { groupId: 'calendar', mode: 'allow', requestId: requestId() }
  const first = await store.switchGroup('calendar', input)
  assert.deepEqual(first.tools.sort(), ['calendar_feishu_create_event', 'calendar_feishu_delete_event', 'calendar_feishu_update_event', 'calendar_reschedule_event'].sort())
  const replay = await store.switchGroup('calendar', input)
  assert.deepEqual({ ...replay, tools: [...replay.tools].sort() }, { ...first, tools: [...first.tools].sort() })
  await assert.rejects(store.switchGroup('calendar', { ...input, mode: 'ask' }), { code: 'GROUP_SWITCH_CONFLICT' })
  const view = await store.getBotConfiguration('calendar')
  assert.equal(view.toolGroups.find((group) => group.id === 'calendar').mode, 'allow')
  assert.ok(view.audit.some((event) => event.type === 'tool-group-switched' && event.groupId === 'calendar' && event.mode === 'allow'))
  // Closing the group turns each covered write back to "ask", including deletions.
  await store.switchGroup('calendar', { groupId: 'calendar', mode: 'ask', requestId: requestId() })
  const closed = await store.getBotConfiguration('calendar')
  assert.equal(closed.toolGroups.find((group) => group.id === 'calendar').mode, 'ask')
  const verdict = await store.harness.commit((tx) => decide(tx, { botId: 'calendar', tool: 'calendar_feishu_create_event' }), context)
  assert.equal(verdict.effect, 'ask')
  // Reads are never made noisy by a closed group.
  assert.equal((await store.harness.commit((tx) => decide(tx, { botId: 'calendar', tool: 'calendar_feishu_read_schedule' }), context)).effect, 'allow')
})

test('T01 group switch never grants tools or resources and owns narrowed rules: the switch shown is the verdict', async (t) => {
  const { store } = await fixture(t)
  const before = await store.getBotConfiguration('calendar')
  const verdict = (action) => store.harness.commit((tx) => decide(tx, { botId: 'calendar', tool: 'workspace.prepare_change', action, sourceId: 'local', type: 'Todo' }), context)
  await store.harness.commit(async (tx) => addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', action: 'delete' }, effect: 'deny' }), context)
  await store.switchGroup('calendar', { groupId: 'todos', mode: 'allow', requestId: requestId() })
  assert.equal((await store.getBotConfiguration('calendar')).toolGroups.find((group) => group.id === 'todos').mode, 'allow')
  for (const action of ['create', 'update', 'delete']) assert.equal((await verdict(action)).effect, 'allow', action)
  await store.harness.commit(async (tx) => addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', action: 'delete', sourceId: 'local', type: 'Todo' }, effect: 'allow' }), context)
  await store.switchGroup('calendar', { groupId: 'todos', mode: 'ask', requestId: requestId() })
  for (const action of ['create', 'update', 'delete']) assert.equal((await verdict(action)).effect, 'ask', action)
  const after = await store.getBotConfiguration('calendar')
  assert.deepEqual(after.assigned, before.assigned)
  assert.deepEqual(after.revoked, before.revoked)
})

test('closing a group makes its writes ask even where the default would allow', async (t) => {
  const { store } = await fixture(t)
  await store.switchGroup('calendar', { groupId: 'calendar', mode: 'allow', requestId: requestId() })
  assert.equal((await store.harness.commit((tx) => decide(tx, { botId: 'calendar', tool: 'calendar_feishu_update_event' }), context)).effect, 'allow')
  await store.switchGroup('calendar', { groupId: 'calendar', mode: 'ask', requestId: requestId() })
  assert.equal((await store.harness.commit((tx) => decide(tx, { botId: 'calendar', tool: 'calendar_feishu_update_event' }), context)).effect, 'ask')
  assert.ok(WRITE_TOOLS.has('calendar_feishu_update_event'))
})

// Production defaults run the marker migration, preserving live per-Bot assignments.
async function rawFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-tool-groups-raw-')), file = join(dir, 'task.sqlite')
  const open = (extra = {}) => openRawStore({ file, bots: listBots(config), modelReply: async () => reply(), ...options, ...extra })
  const state = { store: await open() }
  t.after(async () => { await state.store?.close(); await rm(dir, { recursive: true, force: true }) })
  state.reopen = async (extra) => { await state.store.close(); state.store = null; state.store = await open(extra); return state.store }
  return state
}

test('R1 existing Bots keep their seeded capabilities, management stays Chief-only, and new Bots stay blank', async (t) => {
  const { store } = await rawFixture(t)
  for (const seed of listBots(config)) {
    const view = await store.getBotConfiguration(seed.id)
    assert.deepEqual(view.assigned, { tools: seed.defaults.tools, resources: seed.defaults.toolResources })
    assert.deepEqual(view.revoked, [])
    for (const group of view.toolGroups) assert.equal(group.mode, 'allow', `${seed.id} ${group.id}`)
    const bots = view.toolGroups.find((group) => group.id === 'bots')
    assert.equal(bots.available, seed.id === 'chief', seed.id)
    assert.deepEqual(view.toolGroups.filter((group) => group.switchable).map((group) => group.id), seed.id === 'chief' ? ['bots'] : seed.id === 'calendar' ? ['calendar'] : [], seed.id)
    if (seed.id !== 'chief') assert.equal(bots.tools.find((tool) => tool.name === 'bot_manage').status, 'chief-only')
  }
  const { bot } = await store.createBot({ name: '新助理', requestId: requestId() })
  const created = await store.getBotConfiguration(bot.id)
  assert.deepEqual(created.assigned, { tools: [], resources: [] })
  assert.ok(created.toolGroups.every((group) => !group.enabled && !group.available && !group.switchable))
  assert.ok(created.toolGroups.every((group) => group.mode === 'allow'))
  const main = await store.get((await store.mainSessions())[bot.id])
  assert.deepEqual(main.toolSets.authorized, [])
})

test('T01 open: every write runs directly, deletion included; closed: every write asks; pause still asks', async (t) => {
  const { store } = await rawFixture(t)
  const verdict = (call) => store.harness.commit((tx) => decide(tx, { botId: 'calendar', ...call }), context)
  const writes = [{ tool: 'workspace.prepare_change', action: 'create' }, { tool: 'workspace.prepare_change', action: 'update' },
    { tool: 'workspace.prepare_change', action: 'delete' }, { tool: 'routine_propose' }]
  for (const call of [...writes, { tool: 'calendar_feishu_delete_event' }]) assert.equal((await verdict(call)).effect, 'allow', JSON.stringify(call))
  assert.equal((await store.harness.commit((tx) => decide(tx, { botId: 'chief', tool: 'bot_manage', action: 'deactivate' }), context)).effect, 'allow')
  await store.switchGroup('calendar', { groupId: 'todos', mode: 'ask', requestId: requestId() })
  for (const call of writes) assert.equal((await verdict(call)).effect, 'ask', JSON.stringify(call))
  assert.equal((await verdict({ tool: 'calendar_feishu_delete_event' })).effect, 'allow') // other groups stay on
  await store.switchGroup('calendar', { groupId: 'todos', mode: 'allow', requestId: requestId() })
  await store.harness.commit((tx) => setAutomationPause(tx, { paused: true, by: 'authenticated-user' }), context)
  assert.equal((await verdict({ tool: 'workspace.prepare_change', action: 'delete' })).effect, 'ask')
  assert.equal((await verdict({ tool: 'workspace.list' })).effect, 'allow')
})

test('R1 marker migration preserves live assignments, revocations, narrowed rules and v1 audit across reopens', async (t) => {
  const state = await rawFixture(t, { toolGroupsMigration: false })
  const before = await state.store.harness.commit(async (tx) => {
    const access = await tx.doc(ToolAccess)
    access.groupsVersion = 1
    access.groupsMigration = { version: 1, bots: { todo: { tools: ['workspace.list'], resources: ['workspace:local'] } } }
    access.assignments.todo.tools = ['report_blocker']
    access.revoked.calendar = ['calendar_read_event']
    await addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', action: 'delete' }, effect: 'deny' })
    await addRule(tx, { botId: 'calendar', match: { tool: 'calendar_feishu_create_event' }, effect: 'allow' })
    return JSON.parse(JSON.stringify({ assignments: access.assignments, revoked: access.revoked, audit: access.groupsMigration, rules: (await tx.doc(PolicyRules)).items }))
  }, context)
  const store = await state.reopen({ toolGroupsMigration: true })
  const calendar = await store.getBotConfiguration('calendar'), todo = await store.getBotConfiguration('todo')
  assert.deepEqual(calendar.assigned, before.assignments.calendar)
  assert.deepEqual(todo.assigned, before.assignments.todo)
  assert.deepEqual(calendar.revoked, ['calendar_read_event'])
  assert.equal(calendar.toolGroups.find((group) => group.id === 'todos').mode, 'ask')
  // R3-07 (D15): the untyped deny on workspace deletion also stops schedule deletions, which 日历与日程 now
  // decides, so that switch shows it too (was 'allow' while the same rule already denied them).
  assert.equal(calendar.toolGroups.find((group) => group.id === 'calendar').mode, 'ask')
  for (const action of ['create', 'update', 'delete'])
    assert.equal((await store.harness.commit((tx) => decide(tx, { botId: 'calendar', tool: 'workspace.prepare_change', action }), context)).effect, action === 'delete' ? 'deny' : 'allow', action)
  const access = await store.harness.snapshot(ToolAccess, undefined, context)
  assert.equal(access.groupsVersion, TOOL_GROUPS_VERSION)
  assert.equal(access.capabilityMigration.strategy, 'preserve-live-access')
  assert.deepEqual({ assignments: access.assignments, revoked: access.revoked, audit: access.groupsMigration, rules: (await store.harness.snapshot(PolicyRules, undefined, context)).items }, before)
  await store.switchGroup('calendar', { groupId: 'todos', mode: 'allow', requestId: requestId() })
  await store.harness.commit(async (tx) => { (await tx.doc(ToolAccess)).revoked.todo = ['shared_read'] }, context)
  const again = await state.reopen({ toolGroupsMigration: true })
  assert.equal((await again.getBotConfiguration('calendar')).toolGroups.find((group) => group.id === 'todos').mode, 'allow')
  assert.deepEqual((await again.getBotConfiguration('todo')).revoked, ['shared_read'])
  assert.deepEqual((await again.getBotConfiguration('todo')).assigned, before.assignments.todo)
})

test('HTTP: switch route validates group/mode and unknown Bots fail closed', async (t) => {
  const { store } = await fixture(t)
  const server = createApiServer({ token: 'group-token', tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: 'Bearer group-token', 'Content-Type': 'application/json' }
  const call = (bot, group, body) => fetch(`${base}/api/bots/${bot}/tool-groups/${group}`, { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal((await call('calendar', 'calendar', { mode: 'allow', requestId: requestId() })).status, 200)
  assert.equal((await call('calendar', 'calendar', { mode: 'deny', requestId: requestId() })).status, 400)
  assert.equal((await call('calendar', 'nope', { mode: 'allow', requestId: requestId() })).status, 400)
  assert.equal((await call('ghost', 'calendar', { mode: 'allow', requestId: requestId() })).status, 404)
  assert.equal((await fetch(`${base}/api/bots/calendar/tool-groups/calendar`, { headers })).status, 405)
})

test('"/" Skill menu lists registered Skills for a Bot with a concrete reason when unavailable', async (t) => {
  const { store } = await fixture(t)
  const chief = await store.create({ botId: 'chief' })
  const skills = await store.taskSkills(chief.taskId)
  assert.ok(skills.length >= 1)
  for (const skill of skills) if (!skill.available) assert.notEqual(skill.error?.code, 'SKILL_TOOLS_NOT_GRANTED')
  void commandSkills
  void ToolAccess
  void delay
})
