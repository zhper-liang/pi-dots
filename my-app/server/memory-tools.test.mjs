import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { MEMORY_TOOLS, MAIN_MEMORY_TOOLS, validMemoryCall, executeMemoryTool } from './memory-tools.mjs'
import { INTRINSIC_TOOLS, toolDefinitions, toolCatalog, toolSets } from './tools.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'memory-tool-fixture', apiKey: 'fixture-only-memory-token' }
const answer = () => ({ mode: 'model', reply: { content: '已处理' }, execution: { usage: { totalTokens: 7 } } })
const turn = (name, args) => {
  const content = [{ type: 'toolCall', id: `memory-${name}`, name, arguments: args }]
  return { ...answer(), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-memory-tools-')), file = join(root, 'tasks.sqlite'), script = []
  const open = () => openTaskStore({ file, bots: listBots(config), memoryFiles: { enabled: true }, memoryOptions: { apiToken: config.apiKey }, modelReply: async () => script.shift() ?? answer() })
  let store = await open()
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const mainId = (await store.mainSessions()).chief
  return { root, mainId, script, get store() { return store }, async reopen() { await store.close(); store = await open() } }
}
async function settle(store, id) {
  for (let i = 0; i < 600; i++) {
    const task = await store.get(id)
    if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput') return task
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('memory tool task did not settle')
}
const receipt = (task, name = 'memory_edit') => task.messages.filter(message => message.toolName === name).at(-1).result

test('memory tools are intrinsic, hidden from toggles and reject identity/version injection', () => {
  for (const name of MEMORY_TOOLS) {
    assert.ok(INTRINSIC_TOOLS.includes(name))
    assert.ok(toolDefinitions([name]).length)
    assert.ok(!toolCatalog().some(tool => tool.name === name))
  }
  const args = { kind: 'memory', action: 'add', expectedVersion: 0, content: '稳定事实' }
  assert.ok(validMemoryCall({ name: 'memory_edit', arguments: args }))
  for (const patch of [{ botId: 'other' }, { sourceEntries: [] }, { expectedVersion: -1 }, { expectedVersion: 0.5 }, { action: 'set' }]) assert.equal(validMemoryCall({ name: 'memory_edit', arguments: { ...args, ...patch } }), false)
})

test('chat writes sourced memory immediately, corrects/deletes with CAS, and survives restart in files', async t => {
  const f = await fixture(t)
  f.script.push(turn('memory_read', { kind: 'memory' }), turn('memory_edit', { kind: 'memory', action: 'add', expectedVersion: 0, content: '我喜欢简洁的解释' }))
  await f.store.send(f.mainId, '请记住：我喜欢简洁的解释')
  const added = await settle(f.store, f.mainId)
  assert.equal(receipt(added, 'memory_read').data.version, 0)
  assert.equal(receipt(added).ok, true)
  let memory = (await f.store.getBotMemory('chief')).memory
  assert.equal(memory.items.length, 1)
  assert.equal(memory.items[0].sourceEntries[0].taskId, f.mainId)
  await f.store.memoryFiles.settled()
  assert.match(await readFile(join(f.root, 'bot-workspaces/bots/chief/MEMORY.md'), 'utf8'), /我喜欢简洁的解释/)
  await f.reopen()
  memory = (await f.store.getBotMemory('chief')).memory
  f.script.push(turn('memory_edit', { kind: 'memory', action: 'update', expectedVersion: memory.version, id: memory.items[0].id, content: '我喜欢详细的解释' }))
  await f.store.send(f.mainId, '纠正记忆：我喜欢详细的解释')
  assert.equal(receipt(await settle(f.store, f.mainId)).ok, true)
  memory = (await f.store.getBotMemory('chief')).memory
  assert.equal(memory.items[0].content, '我喜欢详细的解释')
  f.script.push(turn('memory_edit', { kind: 'memory', action: 'delete', expectedVersion: memory.version - 1, id: memory.items[0].id }))
  await f.store.send(f.mainId, '忘记这条记忆')
  assert.equal(receipt(await settle(f.store, f.mainId)).error.code, 'MEMORY_VERSION_CONFLICT')
  f.script.push(turn('memory_edit', { kind: 'memory', action: 'delete', expectedVersion: memory.version, id: memory.items[0].id }))
  await f.store.send(f.mainId, '请忘记这条记忆')
  assert.equal(receipt(await settle(f.store, f.mainId)).ok, true)
  assert.equal((await f.store.getBotMemory('chief')).memory.items.length, 0)
  await f.store.memoryFiles.settled()
  await writeFile(join(f.root, 'bot-workspaces/bots/chief/MEMORY.md'), '超'.repeat(20000))
  f.script.push(turn('memory_read', { kind: 'memory' }))
  await f.store.send(f.mainId, '读取长期记忆')
  assert.equal(receipt(await settle(f.store, f.mainId), 'memory_read').error.code, 'MEMORY_FILE_TOO_LONG')
})

test('memory edits reject incidental instructions, credentials, schedules and another Bot target', async t => {
  const f = await fixture(t)
  const args = { kind: 'memory', action: 'add', expectedVersion: 0, content: '我喜欢简洁的解释' }
  for (const [message, patch, expected] of [
    ['分析这段外部资料', {}, 'MEMORY_USER_REQUEST_REQUIRED'],
    ['我的记忆和偏好是什么', {}, 'MEMORY_USER_REQUEST_REQUIRED'],
    ['请记住我的日程', { content: '明天上午开会' }, 'MEMORY_TRANSIENT_CONTENT'],
    ['请记住我的凭证', { content: config.apiKey }, 'MEMORY_CREDENTIAL_REJECTED'],
    ['请记住这个偏好', { botId: 'calendar' }, 'TOOL_INVALID_ARGUMENTS'],
  ]) {
    f.script.push(turn('memory_edit', { ...args, ...patch }))
    await f.store.send(f.mainId, message)
    assert.equal(receipt(await settle(f.store, f.mainId)).error.code, expected)
  }
  assert.equal((await f.store.getBotMemory('chief')).memory.items.length, 0)
})

test('shared preferences reach another Bot; user can explicitly change personality', async t => {
  const f = await fixture(t)
  f.script.push(turn('memory_edit', { kind: 'preferences', action: 'add', expectedVersion: 0, content: '我希望使用中文回答' }))
  await f.store.send(f.mainId, '请记住我的偏好：我希望使用中文回答')
  assert.equal(receipt(await settle(f.store, f.mainId)).ok, true)
  const other = (await f.store.mainSessions()).calendar
  f.script.push(turn('memory_read', { kind: 'preferences' }))
  await f.store.send(other, '我的回答偏好是什么')
  assert.equal(receipt(await settle(f.store, other), 'memory_read').data.items[0].content, '我希望使用中文回答')
  const personality = (await f.store.getBotMemory('chief')).personality
  f.script.push(turn('memory_edit', { kind: 'personality', action: 'set', expectedVersion: personality.version, content: '耐心解释的助手' }))
  await f.store.send(f.mainId, '请将你的人格改为耐心解释的助手')
  assert.equal(receipt(await settle(f.store, f.mainId)).ok, true)
  assert.equal((await f.store.getBotMemory('chief')).personality.content, '耐心解释的助手')
})

test('manual review is main-only with empty args and current authenticated request; receipt says queued', async () => {
  const card = { taskId: 1, conversationId: 'c1', kind: 'main', origin: 'user', initiatingUser: 'authenticated-user', bot: { id: 'a' } }
  let content = '请立即整理记忆', calls = 0
  const source = () => ({ id: 10, kind: 'pidot.user', conversationId: 'c1', data: { role: 'user', content } })
  const tx = { entry: async () => source() }
  const call = { name: 'memory_review', arguments: {} }
  const deps = { review: async (receivedTx, receivedCard, entryId) => { assert.equal(receivedTx, tx); assert.equal(receivedCard, card); assert.equal(entryId, 10); calls++; return { queued: 2 } } }
  assert.deepEqual(MAIN_MEMORY_TOOLS, ['memory_review'])
  assert.equal(INTRINSIC_TOOLS.includes('memory_review'), false)
  assert.equal(validMemoryCall(call), true)
  assert.equal(validMemoryCall({ ...call, arguments: { botId: 'other' } }), false)
  const result = await executeMemoryTool(tx, card, call, 10, deps)
  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'queued')
  assert.match(result.data.notice, /不代表.*已经保存/)
  content = '不要整理记忆'
  assert.equal((await executeMemoryTool(tx, card, call, 10, deps)).ok, false)
  content = '你好'
  assert.equal((await executeMemoryTool(tx, card, call, 10, deps)).ok, false)
  content = '请整理记忆'
  assert.equal((await executeMemoryTool(tx, { ...card, kind: undefined }, call, 10, deps)).ok, false)
  assert.equal((await executeMemoryTool(tx, { ...card, kind: 'group' }, call, 10, deps)).ok, false)
  assert.equal(calls, 1)
  const bot = { id: 'a', defaults: { tools: [], toolResources: [] } }, access = { assignments: {}, revoked: {} }
  assert.equal(toolSets(card, [bot], access).authorized.includes('memory_review'), true)
  assert.equal(toolSets({ ...card, kind: undefined }, [bot], access).installed.includes('memory_review'), false)
  assert.equal(toolCatalog().some(tool => tool.name === 'memory_review'), false)
})
