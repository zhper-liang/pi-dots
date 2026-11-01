import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { decide } from './policy.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'default-access-fixture', apiKey: 'fixture-only' }
const text = () => ({ mode: 'model', reply: { content: '已处理' }, execution: { usage: { totalTokens: 7 } } })
const turn = args => {
  const content = [{ type: 'toolCall', id: randomUUID(), name: 'workspace.prepare_change', arguments: args }]
  return { ...text(), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }
}
async function settle(store, id) {
  for (let i = 0; i < 600; i++) {
    const task = await store.get(id)
    if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput') return task
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Agent did not settle')
}

test('in-app Agent needs no client credential: create/update execute directly and delete waits for exact chat confirmation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pidot-default-access-')), script = []
  const store = await openTaskStore({ file: join(root, 'tasks.sqlite'), bots: listBots(config), modelReply: async () => script.shift() ?? text() })
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const created = await store.createBot({ name: '日程机器人', requestId: 'default-access-create' })
  await store.updateBotConfiguration(created.bot.id, { requestId: 'default-access-config', expectedVersion: created.bot.configRef.version,
    description: '', tools: WORKSPACE_TOOLS, resources: ['workspace:local'] })
  const id = created.mainTaskId
  async function perform(action, change) {
    script.push(turn({ sourceId: 'local', requestId: randomUUID(), action, change }), text())
    await store.send(id, `${action}测试事项`)
    const task = await settle(store, id)
    return task.messages.filter(message => message.toolName === 'workspace.prepare_change').at(-1).result.data
  }
  assert.deepEqual((await store.workspaceAgent.listClients({})).items, [])
  assert.equal((await perform('create', { type: 'Todo', data: { title: '确认规则' } })).state, 'succeeded')
  let item = (await store.workspace.query({ sourceId: 'local', type: 'Todo' })).items[0]
  assert.equal((await perform('update', { type: 'Todo', id: item.id, expectedVersion: item.version, data: { title: '更新后' } })).state, 'succeeded')
  item = (await store.workspace.query({ sourceId: 'local', type: 'Todo' })).items[0]
  const deletion = await perform('delete', { type: 'Todo', id: item.id, expectedVersion: item.version })
  assert.equal(deletion.state, 'awaiting_confirmation')
  assert.equal(deletion.confirmation.allowAlways, false)
  assert.equal((await store.workspace.query({ sourceId: 'local', type: 'Todo' })).items.length, 1)
  const confirmation = { sourceId: 'local', requestId: deletion.requestId, payloadHash: deletion.payloadHash, confirmed: true }
  await assert.rejects(store.workspaceAgent.confirmLocal({ ...confirmation, always: true }), { code: 'POLICY_RULE_HARD' })
  assert.equal((await store.workspaceAgent.confirmLocal(confirmation)).state, 'succeeded')
  assert.ok((await store.workspace.query({ sourceId: 'local', type: 'Todo' })).items[0].deletedAt)
  assert.deepEqual((await store.workspaceAgent.listClients({})).items, [])
})

test('external MCP read/create/update run directly; delete names and action parameters require one-time confirmation', async () => {
  const docs = new Map()
  const tx = { async doc(token) { if (!docs.has(token.definition.kind)) docs.set(token.definition.kind, token.definition.initial()); return docs.get(token.definition.kind) } }
  for (const [originalName, args, effect] of [['get_task', {}, 'allow'], ['create_task', {}, 'allow'], ['update_task', {}, 'allow'],
    ['delete_task', {}, 'ask'], ['removeTask', {}, 'ask'], ['manage_task', { action: 'delete' }, 'ask']]) {
    const verdict = await decide(tx, { botId: 'one', tool: 'mcp_alias', args }, { externalTool: { name: 'mcp_alias', originalName } })
    assert.equal(verdict.effect, effect, originalName)
    assert.equal(verdict.allowAlways, false)
  }
})
