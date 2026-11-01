import { MAIN_MEMORY_TOOLS } from './memory-tools.mjs'
import { SESSION_HISTORY_TOOLS } from './history-search.mjs'
import { INTRINSIC_TOOLS } from './tools.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { ToolAccess } from './tools.mjs'
import { MAIN_TOOLS } from './main-tools.mjs'
import { groupTools } from './tool-groups.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { BotDirectory } from './bot-directory.mjs'
import { shareWithBots } from './resource-sharing.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-bot-equality-'))
  const file = join(dir, 'tasks.sqlite')
  let store = await openTaskStore({ file })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { get store() { return store }, reopen: async () => { await store.close(); store = await openTaskStore({ file }) } }
}

async function configure(store, botId, tools, resources = []) {
  const { bot } = await store.getBotConfiguration(botId)
  return store.updateBotConfiguration(botId, { requestId: randomUUID(), expectedVersion: bot.configRef.version,
    description: bot.description, tools, resources })
}

test('preset and newly created ordinary Bots have identical rights for the same configuration, including after clearing and restart', async t => {
  const f = await fixture(t)
  // A display name never confers Chief identity.
  const created = await f.store.createBot({ name: '主管助理', requestId: 'equality-blank-create' })
  const ids = ['calendar', 'todo', created.bot.id]
  const tools = [...groupTools('todos'), ...groupTools('history'), ...groupTools('collaboration')]
  const sessions = await f.store.mainSessions()
  let expected
  for (const id of ids) {
    await configure(f.store, id, tools, ['workspace:local'])
    const main = await f.store.get(sessions[id])
    const actual = { tools: [...main.toolSets.authorized].sort(), resources: main.toolSets.resources }
    expected ??= actual
    assert.deepEqual(actual, expected)
    assert.ok(!main.toolSets.authorized.includes('bot_manage'))
    await configure(f.store, id, [])
    assert.deepEqual((await f.store.get(sessions[id])).toolSets.authorized, [...INTRINSIC_TOOLS.slice(0, -2), ...SESSION_HISTORY_TOOLS, ...MAIN_MEMORY_TOOLS, ...INTRINSIC_TOOLS.slice(-2)])
  }
  await f.reopen()
  for (const id of ids) {
    const main = await f.store.get(sessions[id])
    assert.deepEqual(main.toolSets.authorized, [...INTRINSIC_TOOLS.slice(0, -2), ...SESSION_HISTORY_TOOLS, ...MAIN_MEMORY_TOOLS, ...INTRINSIC_TOOLS.slice(-2)])
    assert.deepEqual(main.toolSets.resources, [])
  }
  assert.ok((await f.store.get(sessions.chief)).toolSets.authorized.includes('bot_manage'))
  await assert.rejects(f.store.deactivateBot('chief', { confirm: true }), { code: 'CHIEF_DEACTIVATION_FORBIDDEN' })
  for (const id of ids) assert.equal((await f.store.deactivateBot(id, { confirm: true })).bot.status, 'inactive')
})

test('legacy implicit main permissions migrate once to ordinary assignments without restoring revoked rights', async t => {
  const f = await fixture(t)
  const names = [...MAIN_TOOLS, 'automation_pause']
  const sessions = await f.store.mainSessions()
  await f.store.harness.commit(async tx => {
    const access = await tx.doc(ToolAccess)
    access.mainAssignments = { version: 1, bots: ['chief', 'calendar', 'todo'] }
    for (const id of ['calendar', 'todo']) access.assignments[id].tools = access.assignments[id].tools.filter(name => !names.includes(name))
    access.revoked.calendar = ['task_status']
  }, context)
  await f.reopen()
  const { assigned } = await f.store.getBotConfiguration('calendar')
  assert.ok(names.filter(name => name !== 'task_status').every(name => assigned.tools.includes(name)))
  assert.ok(!assigned.tools.includes('task_status'))
  assert.ok(!(await f.store.get(sessions.calendar)).toolSets.authorized.includes('task_status'))
  await f.store.harness.commit(tx => shareWithBots(tx, ['workspace:local']), context)
  assert.deepEqual((await f.store.getBotConfiguration('todo')).assigned.resources, [], 'former routine proposal rights do not grant data sources')
  // Remove through the ordinary configuration API, without writing a special revocation.
  await configure(f.store, 'calendar', [])
  await f.reopen()
  assert.deepEqual((await f.store.get(sessions.calendar)).toolSets.authorized, [...INTRINSIC_TOOLS.slice(0, -2), ...SESSION_HISTORY_TOOLS, ...MAIN_MEMORY_TOOLS, ...INTRINSIC_TOOLS.slice(-2)])
  const todo = await f.store.getBotConfiguration('todo')
  assert.ok(names.every(name => todo.assigned.tools.includes(name)))
})

test('an R4 name-only creation receipt retains its original capabilities after the blank default change and restart', async t => {
  const f = await fixture(t)
  const input = { name: '旧默认机器人', requestId: 'equality-r4-receipt' }
  const original = await f.store.createBot({ ...input, capabilities: ['tool:todos', 'tool:history'] })
  await f.store.harness.commit(async tx => {
    // R4 signed omitted capabilities separately from explicitly selected defaults.
    const receipt = (await tx.doc(BotDirectory)).requests[input.requestId]
    receipt.signature = createHash('sha256').update(JSON.stringify({ description: '', name: input.name, profile: 'general' })).digest('hex')
  }, context)
  await f.reopen()
  const replay = await f.store.createBot(input)
  assert.equal(replay.created, false)
  assert.deepEqual(replay.bot, original.bot)
  assert.equal(replay.mainTaskId, original.mainTaskId)
  assert.equal(f.store.bots().filter(bot => bot.name === input.name).length, 1)
})
