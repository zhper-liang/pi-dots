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
import { decide, WRITE_TOOLS, addRule, setAutomationPause } from './policy.mjs'
import { openTaskStore as openRawStore } from './tasks.mjs'
import { allGroupTools, TOOL_GROUPS_VERSION } from './bot-configuration.mjs'
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

// Production defaults: the real store runs the tool-group migration on open.
async function rawFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-tool-groups-raw-')), file = join(dir, 'task.sqlite')
  const open = (extra = {}) => openRawStore({ file, bots: listBots(config), modelReply: async () => reply(), ...options, ...extra })
  const state = { store: await open() }
  t.after(async () => { await state.store?.close(); await rm(dir, { recursive: true, force: true }) })
  state.reopen = async (extra) => { await state.store.close(); state.store = null; state.store = await open(extra); return state.store }
  return state
}

test('T01 every Bot holds every tool group and every switch starts on; Bot management stays Chief-only', async (t) => {
  const { store } = await rawFixture(t)
  for (const id of ['chief', 'calendar', 'todo']) {
    const view = await store.getBotConfiguration(id)
    for (const name of allGroupTools()) assert.ok(view.assigned.tools.includes(name), `${id} ${name}`)
    assert.deepEqual(view.revoked, [])
    for (const group of view.toolGroups) assert.equal(group.mode, 'allow', `${id} ${group.id}`)
    const bots = view.toolGroups.find((group) => group.id === 'bots')
    assert.equal(bots.available, id === 'chief', id)
    // Only groups with a usable write get a switch; read-only groups are always on.
    assert.deepEqual(view.toolGroups.filter((group) => group.switchable).map((group) => group.id), id === 'chief' ? ['calendar', 'todos', 'bots'] : ['calendar', 'todos'], id)
    if (id !== 'chief') assert.equal(bots.tools.find((tool) => tool.name === 'bot_manage').status, 'chief-only')
  }
  const { bot } = await store.createBot({ name: '新助理', requestId: requestId() })
  const created = await store.getBotConfiguration(bot.id)
  for (const name of allGroupTools()) assert.ok(created.assigned.tools.includes(name), name)
  assert.ok(created.toolGroups.every((group) => group.mode === 'allow'))
  assert.deepEqual(created.assigned.resources, ['workspace:local'])
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

test('T01 migration runs once: every Bot gets every group, revocations clear, a group with ask/deny becomes 关, replaced state is kept', async (t) => {
  const state = await rawFixture(t, { toolGroupsMigration: false })
  await state.store.harness.commit(async (tx) => {
    const access = await tx.doc(ToolAccess)
    access.assignments.todo.tools = ['report_blocker']
    access.revoked.calendar = ['calendar_read_event']
    await addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', action: 'delete' }, effect: 'deny' })
    await addRule(tx, { botId: 'calendar', match: { tool: 'calendar_feishu_create_event' }, effect: 'allow' })
  }, context)
  const store = await state.reopen({ toolGroupsMigration: true })
  const calendar = await store.getBotConfiguration('calendar'), todo = await store.getBotConfiguration('todo')
  for (const name of allGroupTools()) { assert.ok(calendar.assigned.tools.includes(name), name); assert.ok(todo.assigned.tools.includes(name), name) }
  assert.deepEqual(calendar.revoked, [])
  assert.equal(calendar.toolGroups.find((group) => group.id === 'todos').mode, 'ask')
  assert.equal(calendar.toolGroups.find((group) => group.id === 'calendar').mode, 'allow')
  for (const action of ['create', 'update', 'delete'])
    assert.equal((await store.harness.commit((tx) => decide(tx, { botId: 'calendar', tool: 'workspace.prepare_change', action }), context)).effect, 'ask', action)
  const access = await store.harness.snapshot(ToolAccess, undefined, context)
  assert.equal(access.groupsVersion, TOOL_GROUPS_VERSION)
  assert.deepEqual(access.groupsMigration.bots.todo.tools, ['report_blocker'])
  assert.deepEqual(access.groupsMigration.bots.calendar.revoked, ['calendar_read_event'])
  assert.equal(access.groupsMigration.bots.calendar.rules.length, 2)
  // A later choice survives reopen: the migration does not run again.
  await store.switchGroup('calendar', { groupId: 'todos', mode: 'allow', requestId: requestId() })
  await store.harness.commit(async (tx) => { (await tx.doc(ToolAccess)).revoked.todo = ['shared_read'] }, context)
  const again = await state.reopen({ toolGroupsMigration: true })
  assert.equal((await again.getBotConfiguration('calendar')).toolGroups.find((group) => group.id === 'todos').mode, 'allow')
  assert.deepEqual((await again.getBotConfiguration('todo')).revoked, ['shared_read'])
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
