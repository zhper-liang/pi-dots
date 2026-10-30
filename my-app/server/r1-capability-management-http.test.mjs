import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createApiServer } from './app.mjs'
import { openTaskStore, TaskCard } from './tasks.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { listBots } from './bots.mjs'
import { createExternalMcpService } from './external-mcp.mjs'
import { createSkillImportService } from './skill-import.mjs'
import { SKILL_DIRECTORY, skillCapabilityCatalog } from './skills.mjs'
import { createFixtureMcpHttp } from './fixtures/external-mcp-sdk-http.mjs'
const config = { baseUrl: 'https://isolated.invalid/v1', model: 'setup-fixture', apiKey: 'synthetic-model-key' }
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 2 } } })
const turn = (name, args) => {
  const call = { id: 'configuration-call', name, type: 'toolCall', arguments: args }
  return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
}
async function until(read, ready) {
  let last
  for (let i = 0; i < 300; i++) { last = await read(); if (ready(last)) return last; await delay(10) }
  assert.fail(`setup did not settle: ${JSON.stringify({ phase: last?.runtime?.checkpoint, messages: last?.messages?.slice(-3), approvals: last?.approvals })}`)
}
async function fixture(t, { modelReply, credentialRequired = false, enabled = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-r1-management-'))
  const remote = await createFixtureMcpHttp(credentialRequired ? { bearerToken: 'synthetic-mcp-token' } : {})
  let mcp = await createExternalMcpService({ dataDirectory: join(root, 'mcp') })
  const skills = createSkillImportService({ dataDirectory: join(root, 'skills') }), directory = { builtinDirectory: SKILL_DIRECTORY, userSkills: skills }
  const source = join(root, 'source'); await mkdir(source)
  await writeFile(join(source, 'SKILL.md'), '---\nname: managed-review\ndescription: Managed declarative review\nversion: "1.0"\n---\nFollow the controlled review steps.\n')
  let store = await openTaskStore({ file: join(root, 'tasks.sqlite'), bots: listBots(config), externalMcp: mcp, skillDirectory: directory,
    readCapabilityCatalog: () => skillCapabilityCatalog(directory), capabilityManagementEnabled: enabled,
    workspaceEnabled: false, calendarQueryEnabled: false, modelReply: modelReply ?? (async () => text('plain reply')) })
  let server = createApiServer({ token: 'isolated-owner-token', tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close(); await remote.close(); await rm(root, { recursive: true, force: true }) })
  const call = async (path, body, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { authorization: 'Bearer isolated-owner-token' } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const approve = async (taskId, approvalId) => {
    const response = await call(`/api/tasks/${taskId}/approvals/${approvalId}/decide`, { decision: 'approved' })
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response
  }
  const waitApproval = (taskId, previous = null) => until(() => store.get(taskId), task => task.runtime.checkpoint?.phase === 'awaitApproval' && task.approvals.activeId !== null && task.approvals.activeId !== previous)
  const idle = taskId => until(() => store.get(taskId), task => task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput')
  const restart = async (nextEnabled = enabled) => {
    enabled = nextEnabled
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close()
    mcp = await createExternalMcpService({ dataDirectory: join(root, 'mcp') })
    store = await openTaskStore({ file: join(root, 'tasks.sqlite'), bots: listBots(config), externalMcp: mcp, skillDirectory: directory,
      readCapabilityCatalog: () => skillCapabilityCatalog(directory), capabilityManagementEnabled: enabled,
      workspaceEnabled: false, calendarQueryEnabled: false, modelReply: modelReply ?? (async () => text('plain reply')) })
    server = createApiServer({ token: 'isolated-owner-token', tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  }
  return { root, remote, get mcp() { return mcp }, skills, get store() { return store }, source, call, approve, waitApproval, idle, restart }
}
function resultFor(options, name) {
  const messages = options.context.messages.filter(message => message.role === 'toolResult' && message.toolName === name)
  return messages.length ? JSON.parse(messages.at(-1).content[0].text) : null
}

test('cold store creates a blank Bot and both direct/scoped main GET work while management registration is off', async t => {
  const f = await fixture(t, { enabled: false })
  const created = await f.call('/api/bots', { name: 'Cold GET fixture', requestId: 'cold-get-new-bot' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const { bot, mainTaskId } = created.body
  assert.deepEqual(bot.defaults.tools, [])
  assert.equal((await f.call(`/api/tasks/${mainTaskId}`)).status, 200)
  assert.equal((await f.call(`/api/bots/${bot.id}/tasks/${mainTaskId}`)).status, 200)
  assert.equal((await f.store.get(mainTaskId)).bot.id, bot.id)
})

test('with the capability group set to ask, Chief configures and binds official MCP only after a genuine precise approval', async t => {
  let targetId
  const f = await fixture(t, { modelReply: async (_message, options) => {
    const inspect = resultFor(options, 'mcp_manage')
    if (!inspect) return turn('mcp_manage', { action: 'inspect', targetBotId: targetId })
    if (inspect.data?.action === 'inspect') return turn('mcp_manage', { action: 'add', operationId: 'configure-echo', targetBotId: targetId, expectedRevision: inspect.data.targetRevision,
      config: { connectionId: 'managed-echo', name: 'Managed SDK fixture', transport: 'streamable-http', url: f.remote.url, allowLoopback: true } })
    return text('Report the real configuration receipt')
  } })
  targetId = (await f.store.createBot({ name: 'Configuration target', requestId: 'configuration-target' })).bot.id
  const main = (await f.store.mainSessions()).chief
  assert.equal((await f.store.get(main)).toolSets.authorized.includes('mcp_manage'), true)
  await f.store.switchGroup('chief', { requestId: 'capabilities-ask-mode', groupId: 'capabilities', mode: 'ask' })
  await f.store.send(main, 'Add the provided fixture MCP to the target Bot')
  const waiting = await f.waitApproval(main)
  assert.deepEqual(await f.mcp.connections(), [])
  assert.equal(f.remote.calls.length, 0)
  const initial = waiting.approvals.items.find(item => item.id === waiting.approvals.activeId)
  assert.equal(initial.capabilityIntent.proposal.targetBotId, targetId)
  await f.approve(main, initial.id)
  const done = await f.idle(main), receipt = done.capabilitySetups[0]
  assert.equal(receipt.state, 'ready', JSON.stringify(receipt))
  assert.equal(receipt.enabledForBot, true)
  const targetMain = (await f.store.mainSessions())[targetId]
  assert.equal((await f.call(`/api/tasks/${targetMain}`)).status, 200)
  assert.equal((await f.call(`/api/bots/${targetId}/tasks/${targetMain}`)).status, 200)
  assert.equal(f.remote.calls.length, 0)
  assert.equal((await f.store.getBotCapabilities(targetId)).items.find(item => item.id === receipt.capabilityId).available, true)
  assert.equal((await f.call(`/api/capability-setups/${receipt.setupId}?taskId=${main}`, undefined, false)).status, 401)
  const lookup = await f.call(`/api/capability-setups/${receipt.setupId}?taskId=${main}`)
  assert.equal(lookup.status, 200); assert.equal(lookup.body.data.requestId, receipt.requestId)
})

test('missing credentials retain the original active input and the same authenticated setup resumes', async t => {
  let targetId, sent = false
  const f = await fixture(t, { credentialRequired: true, modelReply: async () => {
    if (sent) return text('The real resumed receipt is ready')
    sent = true
    const view = await f.store.getBotCapabilities(targetId)
    return turn('mcp_manage', { action: 'add', operationId: 'credential-continuation', targetBotId: targetId, expectedRevision: view.revision,
      config: { connectionId: 'needs-key', name: 'Authenticated SDK fixture', transport: 'streamable-http', url: f.remote.url, allowLoopback: true, credentialRequired: true } })
  } })
  targetId = (await f.store.createBot({ name: 'Credential target', requestId: 'credential-target' })).bot.id
  const main = (await f.store.mainSessions()).chief
  await f.store.send(main, 'Configure the authenticated fixture for the target')
  const paused = await until(() => f.store.get(main), task => task.runtime.checkpoint?.phase === 'capabilitySetup')
  const receipt = paused.capabilitySetups[0]
  assert.equal(receipt.state, 'needs_auth'); assert.equal(paused.activeInputId, receipt.inputId)
  await f.restart()
  const reopened = await f.store.get(main)
  assert.equal(reopened.activeInputId, receipt.inputId)
  assert.equal(reopened.capabilitySetups[0].setupId, receipt.setupId)
  const connection = (await f.call('/api/external-mcp')).body.data.items[0]
  const saved = await f.call('/api/external-mcp/credentials', { requestId: 'ui-save-credential', connectionId: connection.connectionId, expectedRevision: connection.revision, credential: { bearerToken: 'synthetic-mcp-token' } })
  assert.equal(saved.status, 200)
  const resumed = await f.call(`/api/capability-setups/${receipt.setupId}/resume`, { taskId: main, inputId: receipt.inputId })
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body)); assert.equal(resumed.body.data.state, 'ready')
  assert.equal(resumed.body.data.requestId, receipt.requestId)
  const done = await f.idle(main)
  assert.equal(done.capabilitySetups[0].state, 'ready')
  assert.equal(JSON.stringify(done).includes('synthetic-mcp-token'), false)
})

test('an explicit Skill request is configured directly and grants only its three mechanism tools', async t => {
  let targetId, sent = false
  const f = await fixture(t, { modelReply: async () => {
    if (sent) return text('Use only the real Skill setup receipt')
    sent = true
    const view = await f.store.getBotCapabilities(targetId)
    return turn('skill_manage', { action: 'add', operationId: 'add-review-skill', targetBotId: targetId, expectedRevision: view.revision, source: { kind: 'local', path: f.source } })
  } })
  targetId = (await f.store.createBot({ name: 'Skill target', requestId: 'skill-target-bot' })).bot.id
  const main = (await f.store.mainSessions()).chief
  await f.store.send(main, 'Add the local declarative review Skill to the target Bot')
  const done = await f.idle(main)
  const item = done.approvals.items.find(item => item.capabilitySetupSpec)
  assert.equal(item.capabilitySetupSpec.scope, 'skill-mechanisms')
  assert.deepEqual(item.capabilitySetupSpec.tools, ['skill_activate', 'skill_deactivate', 'skill_read_resource'])
  assert.equal(done.approvals.items.every(item => item.decision.source === 'policy-rule'), true)
  assert.equal(done.capabilitySetups[0].state, 'ready', JSON.stringify(done.capabilitySetups[0]))
  const target = await f.store.getBotConfiguration(targetId)
  assert.deepEqual([...target.assigned.tools].sort(), ['skill_activate', 'skill_deactivate', 'skill_read_resource'])
  assert.deepEqual(target.assigned.resources, [])
})


test('a persisted Chief main gains configuration tools without changing its ID and ordinary Bots stay blank', async t => {
  let targetId
  const f = await fixture(t, { enabled: false, modelReply: async (_message, options) => resultFor(options, 'mcp_manage') ? text('inspected') : turn('mcp_manage', { action: 'inspect', targetBotId: targetId }) })
  targetId = (await f.store.createBot({ name: 'Ordinary blank Bot', requestId: 'ordinary-blank-agent' })).bot.id
  const main = (await f.store.mainSessions()).chief
  await f.store.harness.commit(async tx => { (await tx.doc(TaskCard, main)).managementTools = ['bot_inspect', 'bot_manage'] }, context)
  const ordinaryBefore = (await f.store.getBotConfiguration('calendar')).assigned
  assert.equal((await f.store.get(main)).toolSets.authorized.includes('mcp_manage'), false)
  await f.restart(true)
  assert.deepEqual((await f.store.getBotConfiguration('calendar')).assigned, ordinaryBefore)
  assert.equal((await f.store.mainSessions()).chief, main)
  assert.equal((await f.store.get(main)).toolSets.authorized.includes('mcp_manage'), true)
  const ordinaryMain = (await f.store.mainSessions())[targetId]
  assert.equal((await f.store.get(ordinaryMain)).toolSets.authorized.includes('mcp_manage'), false)
  await f.store.send(main, 'Inspect the current ordinary Bot capabilities')
  assert.equal((await f.idle(main)).messages.some(message => message.toolName === 'mcp_manage' && message.result?.ok), true)
})

test('an explicitly host-granted configuration Agent uses only its assigned management tool', async t => {
  let targetId
  const f = await fixture(t, { modelReply: async (_message, options) => resultFor(options, 'mcp_manage') ? text('agent inspected') : turn('mcp_manage', { action: 'inspect', targetBotId: targetId }) })
  targetId = (await f.store.createBot({ name: 'Managed target', requestId: 'explicit-agent-target' })).bot.id
  const agent = (await f.store.createBot({ name: 'Configuration Agent', requestId: 'explicit-config-agent' })).bot
  const current = await f.store.getBotConfiguration(agent.id)
  await f.store.updateBotConfiguration(agent.id, { requestId: 'host-grants-config-tool', expectedVersion: current.bot.configRef.version, description: '', tools: ['mcp_manage'], resources: [] })
  const main = (await f.store.mainSessions())[agent.id], task = await f.store.get(main)
  assert.equal(task.toolSets.authorized.includes('mcp_manage'), true)
  assert.equal(task.toolSets.authorized.includes('skill_manage'), false)
  assert.equal(task.toolSets.authorized.includes('bot_manage'), false)
  await f.store.send(main, 'Inspect the target using the explicitly assigned tool')
  assert.equal((await f.idle(main)).messages.some(message => message.toolName === 'mcp_manage' && message.result?.ok), true)
})
