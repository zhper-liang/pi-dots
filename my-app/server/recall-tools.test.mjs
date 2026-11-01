import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore, TaskCard } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { ToolAccess, RECALL_TOOLS, toolSets, toolCatalog } from './tools.mjs'
import { readTaskHistory, HISTORY_TOOL } from './history-tool.mjs'
import { readToolResult, RESULT_READ_TOOL } from './tool-results.mjs'
import { builtinCapabilityCatalog } from './capability-assignments.mjs'
import { BOT_TEMPLATES, visibleCapabilities } from '../src/bot-capabilities.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'recall-fixture', apiKey: 'fixture-only' }
const text = () => ({ mode: 'model', reply: { content: '完成' }, execution: { usage: { totalTokens: 7 } } })
const turn = (name, args) => {
  const content = [{ type: 'toolCall', id: `recall-${name}`, name, arguments: args }]
  return { ...text(), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-recall-')), file = join(root, 'tasks.sqlite'), script = []
  let store = await openTaskStore({ file, bots: listBots(config), modelReply: async () => script.shift() ?? text() })
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  return { get store() { return store }, script,
    async reopen() { await store.close(); store = await openTaskStore({ file, bots: listBots(config), modelReply: async () => script.shift() ?? text() }) } }
}
async function settle(store, id) {
  for (let i = 0; i < 600; i++) {
    const task = await store.get(id)
    if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput') return task
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Recall task did not settle')
}

test('blank Bots always have recall without the optional history group, including stale revocations and restart', async t => {
  const f = await fixture(t)
  const input = { name: '默认回查', requestId: 'recall-legacy-template', capabilities: ['tool:history'] }
  const created = await f.store.createBot(input)
  assert.deepEqual(created.bot.defaults.tools, [])
  await f.store.send(created.mainTaskId, '前一轮的原始记录')
  const initial = await settle(f.store, created.mainTaskId)
  const entry = initial.messages.find(message => message.role === 'user')
  await f.store.harness.commit(async tx => {
    const access = await tx.doc(ToolAccess)
    access.revoked[created.bot.id] = [...RECALL_TOOLS]
    access.assignments[created.bot.id].tools = []
  }, context)
  await f.reopen()
  assert.deepEqual(await f.store.createBot(input), { ...created, created: false })
  f.script.push(turn(HISTORY_TOOL, { entryId: entry.id, limit: 1024 }), text())
  await f.store.send(created.mainTaskId, '回查前一轮原文')
  const done = await settle(f.store, created.mainTaskId)
  const recalled = done.messages.find(message => message.toolName === HISTORY_TOOL).result
  assert.equal(recalled.ok, true)
  assert.ok(recalled.data.text.includes('前一轮的原始记录'))
  assert.deepEqual((await f.store.getBotConfiguration(created.bot.id)).assigned.tools, [])
  assert.ok(RECALL_TOOLS.every(name => done.toolSets.authorized.includes(name)))
  assert.ok(!builtinCapabilityCatalog().some(item => item.id === 'tool:history'))
  assert.ok(toolCatalog().every(tool => !RECALL_TOOLS.includes(tool.name)))
  assert.ok(BOT_TEMPLATES.every(template => !template.capabilities.includes('tool:history')))
  assert.deepEqual(visibleCapabilities([{ id: 'tool:history' }], created.bot.id), [])
  const view = await f.store.getBotCapabilities(created.bot.id)
  await assert.rejects(f.store.setBotCapabilityAssignment(created.bot.id, { requestId: 'recall-cannot-disable', expectedRevision: view.revision,
    expectedCatalogRevision: 'static-1', capabilityId: 'tool:history', enabled: false }), { code: 'CAPABILITY_INTRINSIC' })
})

test('intrinsic readers can page large results but still deny foreign Tasks, revoked source tools and removed resources', async t => {
  const f = await fixture(t), id = (await f.store.mainSessions()).calendar
  f.script.push(turn('calendar_read_schedule', { month: '2026-10', resource: 'mock:personal' }), text())
  await f.store.send(id, '读取一个月的模拟日程')
  const task = await settle(f.store, id)
  const receipt = task.messages.find(message => message.toolName === 'calendar_read_schedule')
  assert.equal(receipt.result.data.bounded, true)
  const args = { resultRef: receipt.result.data.resultRef, resource: 'mock:personal', view: 'text', limit: 1024 }
  f.script.push(turn(RESULT_READ_TOOL, args), text())
  await f.store.send(id, '补读结果的完整片段')
  const done = await settle(f.store, id)
  assert.equal(done.messages.find(message => message.toolName === RESULT_READ_TOOL).result.ok, true)
  const foreign = await f.store.create({ botId: 'calendar' })
  await f.store.harness.commit(async tx => {
    const card = await tx.doc(TaskCard, id), other = await tx.doc(TaskCard, foreign.taskId), access = await tx.doc(ToolAccess)
    let sets = toolSets(card, f.store.bots(), access)
    assert.equal((await readToolResult(tx, other, args, sets)).error.code, 'TOOL_RESULT_NOT_FOUND')
    assert.equal((await readTaskHistory(tx, other, { entryId: receipt.id }, Number.MAX_SAFE_INTEGER, sets)).error.code, 'HISTORY_NOT_FOUND')
    access.revoked.calendar = [...RECALL_TOOLS, 'calendar_read_schedule']
    sets = toolSets(card, f.store.bots(), access)
    assert.ok(RECALL_TOOLS.every(name => sets.authorized.includes(name)))
    assert.equal((await readToolResult(tx, card, args, sets)).error.code, 'TOOL_RESOURCE_DENIED')
    assert.equal((await readTaskHistory(tx, card, { entryId: receipt.id }, Number.MAX_SAFE_INTEGER, sets)).error.code, 'HISTORY_ACCESS_DENIED')
    access.revoked.calendar = []
    access.assignments.calendar.resources = []
    sets = toolSets(card, f.store.bots(), access)
    assert.equal((await readToolResult(tx, card, args, sets)).error.code, 'TOOL_RESOURCE_DENIED')
    assert.equal((await readTaskHistory(tx, card, { entryId: receipt.id }, Number.MAX_SAFE_INTEGER, sets)).error.code, 'HISTORY_ACCESS_DENIED')
  }, context)
})
