import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { PolicyRules, addRule } from './policy.mjs'
import { ToolAccess } from './tools.mjs'
import { groupTools } from './tool-groups.mjs'
import { PRESET_TEXT } from './r4-migration.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r4-migration-')), file = join(dir, 'tasks.sqlite')
  const bots = listBots().map(bot => ({ ...bot, ...(PRESET_TEXT[bot.id] ? { description: PRESET_TEXT[bot.id].old } : {}) }))
  let store = await openTaskStore({ file, bots })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { get store() { return store }, commit: fn => store.harness.commit(fn, context),
    reopen: async () => { await store.close(); store = await openTaskStore({ file, bots, r4Migration: true }); return store } }
}

test('R4 migration completes the merged group, shares sources, removes asks/mock resources and updates seed copy', async t => {
  const f = await fixture(t)
  await f.commit(async tx => {
    const access = await tx.doc(ToolAccess), directory = await tx.doc(BotDirectory)
    access.assignments.calendar = { tools: ['calendar_read_schedule'], resources: ['mock:personal'] }
    access.revoked.calendar = ['workspace.list']
    access.excludedResources = { calendar: ['mock:personal'] }
    directory.items.find(bot => bot.id === 'calendar').description = PRESET_TEXT.calendar.old
    await addRule(tx, { botId: 'calendar', match: { tool: 'calendar_reschedule_event' }, effect: 'ask', origin: 'group' })
    await addRule(tx, { botId: 'calendar', match: { tool: 'routine_propose' }, effect: 'ask', origin: 'user' })
    await addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', action: 'delete' }, effect: 'deny', origin: 'user' })
  })
  await f.reopen()
  await f.commit(async tx => {
    const access = await tx.doc(ToolAccess), rules = (await tx.doc(PolicyRules)).items
    assert.ok(groupTools('todos').every(name => access.assignments.calendar.tools.includes(name)))
    assert.ok(access.assignments.calendar.resources.includes('workspace:local'))
    assert.ok(!access.revoked.calendar.includes('workspace.list'))
    assert.ok(Object.values(access.assignments).every(assignment => !assignment.resources.includes('mock:personal')))
    assert.deepEqual(access.excludedResources.calendar, [])
    assert.equal(rules.filter(rule => rule.effect === 'ask').length, 0)
    assert.equal(rules.filter(rule => rule.effect === 'deny').length, 1)
    assert.equal((await tx.doc(BotDirectory)).items.find(bot => bot.id === 'calendar').description, PRESET_TEXT.calendar.new)
    assert.ok(access.r4MigratedAt)
  })
})

test('R4 migration runs once and preserves rules added after migration', async t => {
  const f = await fixture(t)
  await f.reopen()
  const marker = await f.commit(async tx => (await tx.doc(ToolAccess)).r4MigratedAt)
  await f.commit(tx => addRule(tx, { botId: 'calendar', match: { tool: 'routine_propose' }, effect: 'ask', origin: 'user' }))
  await f.reopen()
  await f.commit(async tx => {
    assert.equal((await tx.doc(ToolAccess)).r4MigratedAt, marker)
    assert.equal((await tx.doc(PolicyRules)).items.filter(rule => rule.effect === 'ask').length, 1)
  })
})

test('R4 migration updates unchanged preset personality but preserves user-edited personality', async t => {
  const f = await fixture(t)
  const documents = await f.store.getBotMemory('todo')
  await f.store.editBotMemory('todo', { kind: 'personality', action: 'set', content: '我自己写的人格', expectedVersion: documents.personality.version, requestId: 'r4-user-personality' })
  await f.reopen()
  assert.equal((await f.store.getBotMemory('calendar')).personality.content, PRESET_TEXT.calendar.new)
  assert.equal((await f.store.getBotMemory('todo')).personality.content, '我自己写的人格')
})
