import { MAIN_MEMORY_TOOLS } from './memory-tools.mjs'
import { SESSION_HISTORY_TOOLS } from './history-search.mjs'
import { INTRINSIC_TOOLS } from './tools.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeRuntime, NATIVE_TOOLS } from './native-tools.mjs'
import { toolCatalog, toolDefinitions, toolSets } from './tools.mjs'
import { TOOL_GROUPS } from './tool-groups.mjs'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

// Main-only discovery and manual review never become ordinary Task abilities.
const mainIntrinsicTools = () => toolDefinitions([...INTRINSIC_TOOLS, ...SESSION_HISTORY_TOOLS, ...MAIN_MEMORY_TOOLS]).map(tool => tool.name)

const call = (name, args) => ({ name, arguments: args })
async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
test('native file tools support exact edits, pagination, conflicts and independent Bot directories', async t => {
  const root = await folder(t), execute = createNativeRuntime({ root })
  const run = (name, args, botId = 'one') => execute(call(name, args), { botId })
  assert.equal((await run('write', { path: 'nested/file.txt', content: '你好\nalpha alpha' })).ok, true)
  assert.equal((await run('read', { path: 'nested/file.txt', limit: 2 })).data.content, '你好')
  assert.equal((await run('read', { path: 'nested/file.txt', offset: 2 })).data.content, '\nalpha alpha')
  assert.equal((await run('edit', { path: 'nested/file.txt', oldText: 'alpha', newText: 'beta' })).error.code, 'EDIT_MATCH_CONFLICT')
  assert.equal((await run('edit', { path: 'nested/file.txt', oldText: 'alpha', newText: '$&', replaceAll: true })).data.replacements, 2)
  assert.equal((await run('read', { path: 'nested/file.txt' })).data.content, '你好\n$& $&')
  assert.equal((await run('read', { path: 'nested/file.txt' }, 'two')).error.code, 'ENOENT')
  assert.equal((await run('read', { path: join(root, 'one/nested/file.txt') })).ok, true)
  assert.equal((await run('write', { path: 'large.txt', content: '\u0001'.repeat(10000) })).ok, true)
  const page = await run('read', { path: 'large.txt', limit: 4096 })
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 8192)
  assert.equal(page.data.nextOffset, page.data.content.length)
  assert.equal((await run('read', { path: '', extra: true })).error.code, 'TOOL_INVALID_ARGUMENTS')
})

test('native bash executes in the Bot directory and reports failures, bounded output, timeout and cancellation', async t => {
  const execute = createNativeRuntime({ root: await folder(t) })
  const run = (command, extra = {}, signal) => execute(call('bash', { command, ...extra }), { botId: 'one', signal })
  assert.equal((await run('printf hello > note.txt; cat note.txt')).data.stdout, 'hello')
  assert.equal((await run('printf bad >&2; exit 3')).data.exitCode, 3)
  const big = await run('yes abc | head -c 100000')
  assert.equal(big.data.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(big)) < 8192)
  assert.equal((await run('sleep 20', { timeoutMs: 25 })).error.code, 'BASH_TIMEOUT')
  const controller = new AbortController()
  const pending = run('sleep 20', {}, controller.signal)
  setTimeout(() => controller.abort(), 25)
  assert.equal((await pending).error.code, 'TOOL_ABORTED')
})

test('native tools are always present for ordinary Tasks and main chats, outside configurable groups', () => {
  const bot = { id: 'one', defaults: { tools: [], toolResources: [] } }
  for (const kind of ['main', undefined]) {
    const sets = toolSets({ bot: { id: 'one' }, kind }, [bot], { revoked: { one: [...NATIVE_TOOLS] }, assignments: { one: { tools: [], resources: [] } } })
    assert.deepEqual(sets.authorized, kind === 'main' ? mainIntrinsicTools() : [...INTRINSIC_TOOLS])
    assert.equal(sets.authorized.includes('session_search'), kind === 'main')
    assert.equal(sets.authorized.includes('session_history_read'), kind === 'main')
    assert.deepEqual(sets.assigned, [])
    assert.equal(toolDefinitions(sets.displayed).length, kind === 'main' ? mainIntrinsicTools().length : INTRINSIC_TOOLS.length)
  }
  assert.ok(toolCatalog().every(tool => !NATIVE_TOOLS.includes(tool.name)))
  assert.ok(TOOL_GROUPS.every(group => group.tools.every(name => !NATIVE_TOOLS.includes(name))))
})

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'native-fixture', apiKey: 'fixture-only' }
const text = () => ({ mode: 'model', reply: { content: '完成' }, execution: { usage: { totalTokens: 7 } } })
const turn = (name, args) => {
  const content = [{ type: 'toolCall', id: `native-${name}`, name, arguments: args }]
  return { ...text(), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }
}
async function settled(store, id) {
  for (let i = 0; i < 600; i++) {
    const task = await store.get(id)
    if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput') return task
    assert.notEqual(task.runtime.status, 'terminal')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Native task did not settle')
}
test('a newly created blank Bot runs all four native abilities without assignments or credentials and keeps them after reopen', async t => {
  const root = await folder(t), file = join(root, 'tasks.sqlite'), script = [], seen = []
  const modelReply = async (_message, options) => { seen.push(options); return script.shift() ?? text() }
  let store = await openTaskStore({ file, bots: listBots(config), modelReply })
  t.after(() => store.close())
  const created = await store.createBot({ name: '空白测试', requestId: 'native-blank-create' })
  const id = created.mainTaskId, botId = created.bot.id
  script.push(turn('write', { path: 'note.txt', content: 'before' }), turn('edit', { path: 'note.txt', oldText: 'before', newText: 'after' }),
    turn('read', { path: 'note.txt' }), turn('bash', { command: 'cat note.txt' }), text())
  await store.send(id, '写入、修改、读取并检查笔记')
  const done = await settled(store, id)
  const receipts = done.messages.filter(message => NATIVE_TOOLS.includes(message.toolName))
  assert.equal(receipts.length, 4)
  assert.ok(receipts.every(message => message.result.ok), JSON.stringify(receipts))
  assert.equal(receipts.at(-1).result.data.stdout, 'after')
  assert.equal(done.approvals.items.length, 0)
  assert.deepEqual((await store.getBotConfiguration(botId)).assigned.tools, [])
  assert.equal(await readFile(join(root, 'bot-workspaces', botId, 'note.txt'), 'utf8'), 'after')
  assert.ok(seen.length > 0)
  await store.close()
  store = await openTaskStore({ file, bots: listBots(config), modelReply })
  assert.deepEqual((await store.get(id)).toolSets.authorized, mainIntrinsicTools())
})

test('recovery closes an uncertain native dispatch without repeating the command', async t => {
  const root = await folder(t), file = join(root, 'tasks.sqlite')
  const child = spawn(process.execPath, [new URL('./fixtures/native-recovery-process.mjs', import.meta.url).pathname, root], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } })
  let checkpoint
  for (let i = 0; i < 600 && !checkpoint; i++) {
    try { checkpoint = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')) } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  assert.ok(checkpoint)
  child.kill('SIGKILL'); await exited
  const store = await openTaskStore({ file, bots: listBots(config), modelReply: async () => text() })
  t.after(() => store.close())
  const done = await settled(store, checkpoint.taskId)
  assert.equal(done.messages.find(message => message.toolName === 'bash').result.error.code, 'NATIVE_OUTCOME_UNKNOWN')
  await assert.rejects(readFile(join(root, 'bot-workspaces/calendar/duplicated')), { code: 'ENOENT' })
})
