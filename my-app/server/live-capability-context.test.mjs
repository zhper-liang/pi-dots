import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ToolAccess } from './tools.mjs'

async function settle(store, id) {
  for (let i = 0; i < 400; i++) {
    const task = await store.get(id)
    if (task.activeInputId === null && !task.queueLength) return task
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('conversation did not settle')
}
async function setCapability(store, botId, enabled) {
  const view = await store.getBotCapabilities(botId)
  return store.setBotCapabilityAssignment(botId, { requestId: randomUUID(), capabilityId: 'tool:todos', enabled,
    expectedRevision: view.revision, expectedCatalogRevision: view.items.find(item => item.id === 'tool:todos').revision })
}

test('existing conversation refreshes schema, source summary and dispatch after enabling then revoking a capability', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-live-capability-context-'))
  const calls = []
  let store
  t.after(async () => { await store?.close(); await rm(dir, { recursive: true, force: true }) })
  store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots: listBots({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic-local-fixture' }),
    modelReply: async (_message, options) => {
      const request = options.context.currentRequest
      calls.push(structuredClone(options.context))
      if (request === 'use the newly enabled calendar' && !options.context.messages.some(item => item.role === 'toolResult' && item.toolName === 'workspace.list')) {
        const call = { type: 'toolCall', id: 'list-newly-enabled', name: 'workspace.list', arguments: { sourceId: 'local', type: 'Event' } }
        return { mode: 'model', reply: { content: '' }, toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() }, execution: { usage: { totalTokens: 1 } } }
      }
      return { mode: 'model', reply: { content: request === 'before grant' ? '没有权限，尚未连接。' : 'Done' }, execution: { usage: { totalTokens: 1 } } }
    } })
  const task = await store.create({ botId: 'todo' })
  const observer = await store.create({ botId: 'todo' })
  await store.send(observer.taskId, 'observe before grant'); await settle(store, observer.taskId)
  await store.send(task.taskId, 'before grant'); await settle(store, task.taskId)
  assert.equal(calls[0].tools.some(tool => tool.name === 'workspace.list'), false)
  await setCapability(store, 'todo', true)
  const ready = (await store.getBotCapabilities('todo')).items.find(item => item.id === 'tool:todos')
  assert.equal(ready.available, true)
  await store.send(task.taskId, 'use the newly enabled calendar')
  const completed = await settle(store, task.taskId)
  const next = calls.find(call => call.currentRequest === 'use the newly enabled calendar')
  assert.ok(next.tools.some(tool => tool.name === 'workspace.list'))
  assert.ok(next.systemPrompt.includes('宿主当前能力状态'))
  assert.ok(next.systemPrompt.includes('workspace:local'))
  assert.ok(next.systemPrompt.includes('日历统一汇总'))
  assert.ok(next.systemPrompt.includes('local 是持久化本地日历'))
  assert.ok(next.systemPrompt.includes('逐条标注来源'))
  assert.ok(next.systemPrompt.includes('结论可能已经过期'))
  const toolResult = completed.messages.find(message => message.toolName === 'workspace.list' && message.role === 'tool')
  assert.equal(toolResult?.result.ok, true, JSON.stringify(toolResult))
  await setCapability(store, 'todo', false)
  await store.send(observer.taskId, 'after revoke'); await settle(store, observer.taskId)
  const revoked = calls.find(call => call.currentRequest === 'after revoke')
  assert.equal(revoked.tools.some(tool => tool.name === 'workspace.list'), false)
  assert.ok(!revoked.systemPrompt.match(/宿主当前能力状态[^\n]+"tools":\[[^\]]*"workspace.list"/))
})

test('enabled source tools without assigned sources report the actual availability gap', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-capability-no-source-'))
  const store = await openTaskStore({ file: join(dir, 'isolated.sqlite') })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  await setCapability(store, 'todo', true)
  await store.harness.commit(async tx => { (await tx.doc(ToolAccess)).assignments.todo.resources = [] }, context)
  const capability = (await store.getBotCapabilities('todo')).items.find(item => item.id === 'tool:todos')
  assert.equal(capability.enabledForBot, true)
  assert.equal(capability.available, false)
  assert.match(capability.unavailableReason, /来源/)
})
