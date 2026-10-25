import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listBots } from './bots.mjs'
import { openTaskStore, TaskCard } from './tasks.mjs'
import { MCP_VERSION } from './workspace-mcp-protocol.mjs'
import { WorkspaceRecords, identityKey, payloadHash } from './workspace-schema.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ToolAccess, toolSets } from './tools.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { workspaceHistoryAllowed } from './workspace-grants.mjs'

const start = Date.parse('2026-10-19T00:00:00Z')
async function fixture(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-live-permissions-'))
  const bots = options.bots ?? listBots(), calendar = bots.find(bot => bot.id === 'calendar')
  calendar.defaults.tools.push('workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status')
  calendar.defaults.toolResources.push('workspace:local')
  let time = start, store
  try {
    store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots, workspaceScheduleOptions: { autoStart: false, now: () => time }, ...options })
    await store.workspace.manageLocalGrant({ requestId: 'consent', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
    await fn(store, value => { time = value })
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function client(store, token) {
  let sessionId, id = 0
  const send = async (method, params, notification = false) => {
    const response = await store.workspaceMcpMessage(token, sessionId, { jsonrpc: '2.0', ...notification ? {} : { id: ++id }, method, ...params ? { params } : {} })
    sessionId = response.sessionId
    return response.message
  }
  assert.equal((await send('initialize', { protocolVersion: MCP_VERSION, clientInfo: { name: 's2-live', version: '1' }, capabilities: {} })).result.protocolVersion, MCP_VERSION)
  await send('notifications/initialized', undefined, true)
  return { list: () => send('tools/list'), call: (name, args) => send('tools/call', { name, arguments: args }) }
}
async function configure(store, tools, resources = ['workspace:local']) {
  const { bot } = await store.getBotConfiguration('calendar')
  await store.updateBotConfiguration('calendar', { requestId: 'cfg-' + Math.random().toString(36).slice(2), expectedVersion: bot.configRef.version, description: bot.description, tools, resources })
}

test('S2 stdio scope stays narrow while Bot tools and resources change live', () => fixture(async store => {
  const credential = await store.workspaceAgent.issueClient({ sourceId: 'local', botId: 'calendar', actions: ['read'], readScope: 'busy', ttlSeconds: 600, confirmed: true })
  const mcp = await client(store, credential.token)
  assert.ok((await mcp.list()).result.tools.some(tool => tool.name === 'workspace.list'))
  await store.workspace.manageLocalGrant({ requestId: 'consent-rotated', sourceId: 'local', enabled: true, expectedEpoch: 1, confirmed: true })
  assert.ok((await mcp.list()).result.tools.some(tool => tool.name === 'workspace.list'))
  await store.workspace.executeLocal({ requestId: 'event', sourceId: 'local', type: 'Event', action: 'create', data: { title: 'Private', start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z', timezone: 'UTC' } })
  const event = await mcp.call('workspace.list', { sourceId: 'local', type: 'Event' })
  assert.deepEqual(Object.keys(event.result.structuredContent.data.items[0]).sort(), ['end', 'start', 'timezone'])
  await configure(store, ['workspace.list', 'workspace.prepare_change', 'workspace.operation_status'])
  assert.deepEqual((await mcp.list()).result.tools, [])
  await assert.rejects(store.workspaceAgent.issueClient({ sourceId: 'local', botId: 'calendar', actions: ['read'], readScope: 'full', ttlSeconds: 600, confirmed: true }), { code: 'WORKSPACE_FORBIDDEN' })
  await configure(store, ['workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status'])
  assert.ok((await mcp.list()).result.tools.some(tool => tool.name === 'workspace.get'))
  await configure(store, ['workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status'], [])
  assert.deepEqual((await mcp.list()).result.tools, [])
  await store.workspaceAgent.revokeClient({ clientId: credential.clientId, confirmed: true })
  await assert.rejects(mcp.list(), { code: 'WORKSPACE_CLIENT' })
}))

test('S2 routine rechecks Bot and source at dispatch without a configuration hash', () => fixture(async (store, setTime) => {
  const spec = { kind: 'agent_readonly_workflow', botId: 'calendar', sourceIds: ['local'], prompt: 'Read local events', promptVersion: 'v1', callLimits: { modelCalls: 1, toolCalls: 1, totalTokens: 1000 }, notification: 'none' }
  const create = (requestId, at) => store.workspaceSchedules.manage({ requestId, command: 'create', title: requestId, timezone: 'UTC', rule: { type: 'at', at: new Date(at).toISOString() }, actionSpec: spec, confirmed: true })
  const first = (await create('first', start + 60000)).receipt.schedule
  assert.equal(Object.hasOwn(first, 'authorizationSnapshot'), false)
  const { bot, assigned } = await store.getBotConfiguration('calendar')
  await store.updateBotConfiguration('calendar', { requestId: 'description-change', expectedVersion: bot.configRef.version, description: 'changed', tools: assigned.tools, resources: assigned.resources })
  setTime(start + 60000); await store.workspaceScheduler.tick()
  const firstRun = (await store.workspaceSchedules.list({ scheduleId: first.id })).items[0]
  assert.ok(firstRun.taskId, JSON.stringify(firstRun))
  const second = (await create('second', start + 120000)).receipt.schedule
  await configure(store, ['workspace.list', 'workspace.prepare_change', 'workspace.operation_status'])
  setTime(start + 120000); await store.workspaceScheduler.tick()
  const occurrenceId = payloadHash([second.id, second.revision, new Date(start + 120000).toISOString()])
  const run = await store.harness.commit(async tx => JSON.parse(JSON.stringify((await tx.doc(WorkspaceRecords.Occurrence, identityKey('local-owner', 'local', occurrenceId), null)).record)), context)
  assert.equal(run.state, 'cancelled', JSON.stringify(run))
  assert.equal(run.reason, 'WORKSPACE_WORKFLOW_TOOLS')
  assert.equal(run.taskId, undefined)
}))

test('S2 existing Task records actual source use and follows current assignment', () => fixture(async store => {
  const task = await store.create({ botId: 'calendar' })
  const permitted = () => store.harness.commit(async tx => {
    const card = await tx.doc(TaskCard, task.taskId), access = await tx.doc(ToolAccess)
    const bots = (await tx.doc(BotDirectory)).items
    return { snapshot: Object.hasOwn(card, 'workspaceSnapshot'), used: [...card.workspaceUsedResources], allowed: await workspaceHistoryAllowed(tx, card, toolSets(card, bots, access)) }
  }, context)
  assert.deepEqual(await permitted(), { snapshot: false, used: [], allowed: true })
  await store.send(task.taskId, 'Read local events')
  let current
  for (let n = 0; n < 100; n++) { current = await permitted(); if (current.used.length) break; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.deepEqual(current, { snapshot: false, used: ['workspace:local'], allowed: true })
  await configure(store, ['workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status'], [])
  assert.equal((await permitted()).allowed, false)
  await configure(store, ['workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status'])
  assert.equal((await permitted()).allowed, true)
}, { bots: listBots({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture' }), modelReply: async (_message, options) => {
  if (options.context.messages.some(message => message.role === 'toolResult')) return { mode: 'model', reply: { content: 'Done' }, execution: { usage: { totalTokens: 1 } } }
  const call = { type: 'toolCall', id: 'local-read', name: 'workspace.list', arguments: { sourceId: 'local', type: 'Event' } }
  return { mode: 'model', reply: { content: '' }, toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() }, execution: { usage: { totalTokens: 1 } } }
} }))
