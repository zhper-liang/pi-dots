import { SESSION_HISTORY_TOOLS } from './history-search.mjs'
import * as memoryModule from './memory-tools.mjs'
import { INTRINSIC_TOOLS } from './tools.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { toolCatalog, ToolAccess } from './tools.mjs'
import { TOOL_GROUPS } from './tool-groups.mjs'
import { decide, addRule, setAutomationPause, PolicyRules } from './policy.mjs'
import { openTaskStore as openRawStore } from './tasks.mjs'
import { TOOL_GROUPS_VERSION } from './bot-configuration.mjs'
import { MAIN_TOOLS } from './main-tools.mjs'
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
  assert.equal(TOOL_GROUPS.find((group) => group.id === 'todos').label, '日程与待办')
})

test('configuration exposes groups with Chinese labels and enabled tools', async (t) => {
  const { store } = await fixture(t)
  const view = await store.getBotConfiguration('calendar')
  const todo = view.toolGroups.find((group) => group.id === 'todos')
  assert.equal(todo.label, '日程与待办')
  assert.ok(todo.tools.every((tool) => !/^workspace\./.test(tool.label)))
  assert.equal(view.toolLabels['workspace.prepare_change'], '新建、修改或删除事项')
  assert.equal(todo.tools.find((tool) => tool.name === 'workspace.prepare_change').write, true)
  assert.equal(todo.tools.find((tool) => tool.name === 'workspace.list').write, false)
})

async function rawFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-tool-groups-raw-')), file = join(dir, 'task.sqlite')
  const open = (extra = {}) => openRawStore({ file, bots: listBots(config), modelReply: async () => reply(), ...options, ...extra })
  const state = { store: await open() }
  t.after(async () => { await state.store?.close(); await rm(dir, { recursive: true, force: true }) })
  state.reopen = async (extra) => { await state.store.close(); state.store = null; state.store = await open(extra); return state.store }
  return state
}

test('existing Bots keep seeded and former main rights, management stays Chief-only, and new Bots start blank', async (t) => {
  const { store } = await rawFixture(t)
  for (const seed of listBots(config)) {
    const view = await store.getBotConfiguration(seed.id)
    assert.deepEqual(view.assigned, { tools: [...seed.defaults.tools.filter(name => !INTRINSIC_TOOLS.includes(name)), ...(seed.id === 'chief' ? [] : [...MAIN_TOOLS, 'automation_pause'])], resources: seed.defaults.toolResources })
    assert.deepEqual(view.revoked, [])
    const bots = view.toolGroups.find((group) => group.id === 'bots')
    assert.equal(bots.available, seed.id === 'chief', seed.id)
    if (seed.id !== 'chief') assert.equal(bots.tools.find((tool) => tool.name === 'bot_manage').status, 'chief-only')
  }
  const { bot } = await store.createBot({ name: '新助理', requestId: requestId() })
  const created = await store.getBotConfiguration(bot.id)
  assert.deepEqual(created.assigned, { tools: [], resources: [] })
  const main = await store.get((await store.mainSessions())[bot.id])
  assert.deepEqual([...main.toolSets.authorized].sort(), [...new Set([...INTRINSIC_TOOLS, ...SESSION_HISTORY_TOOLS, ...(memoryModule.MAIN_MEMORY_TOOLS ?? []), ...created.assigned.tools])].sort())
})

test('writes run directly, deletions require confirmation; pause still asks', async (t) => {
  const { store } = await rawFixture(t)
  const verdict = (call) => store.harness.commit((tx) => decide(tx, { botId: 'calendar', ...call }), context)
  const writes = [{ tool: 'workspace.prepare_change', action: 'create' }, { tool: 'workspace.prepare_change', action: 'update' },
    { tool: 'workspace.prepare_change', action: 'delete' }, { tool: 'routine_propose' }]
  for (const call of [...writes, { tool: 'calendar_feishu_delete_event' }]) assert.equal((await verdict(call)).effect, call.action === 'delete' || call.tool === 'calendar_feishu_delete_event' ? 'ask' : 'allow', JSON.stringify(call))
  assert.equal((await store.harness.commit((tx) => decide(tx, { botId: 'chief', tool: 'bot_manage', action: 'deactivate' }), context)).effect, 'allow')
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
  for (const action of ['create', 'update', 'delete'])
    assert.equal((await store.harness.commit((tx) => decide(tx, { botId: 'calendar', tool: 'workspace.prepare_change', action }), context)).effect, action === 'delete' ? 'deny' : 'allow', action)
  const access = await store.harness.snapshot(ToolAccess, undefined, context)
  assert.equal(access.groupsVersion, TOOL_GROUPS_VERSION)
  assert.equal(access.capabilityMigration.strategy, 'preserve-live-access')
  assert.deepEqual({ assignments: access.assignments, revoked: access.revoked, audit: access.groupsMigration, rules: (await store.harness.snapshot(PolicyRules, undefined, context)).items }, before)
  await store.harness.commit(async (tx) => { (await tx.doc(ToolAccess)).revoked.todo = ['shared_read'] }, context)
  const again = await state.reopen({ toolGroupsMigration: true })
  assert.deepEqual((await again.getBotConfiguration('todo')).revoked, ['shared_read'])
  assert.deepEqual((await again.getBotConfiguration('todo')).assigned, before.assignments.todo)
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
