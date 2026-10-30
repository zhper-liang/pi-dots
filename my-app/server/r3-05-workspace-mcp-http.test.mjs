import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createApiServer } from './app.mjs'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { createExternalMcpService } from './external-mcp.mjs'
import { mcpToolAlias } from './external-mcp-config.mjs'
import { googleWorkspaceMcpTemplate } from './external-mcp-google.mjs'
import { createSkillImportService } from './skill-import.mjs'
import { SKILL_DIRECTORY, skillCapabilityCatalog } from './skills.mjs'
import { FAKE_GOOGLE_SECRET_PREFIXES } from './fixtures/fake-google.mjs'
import { googleWorkspaceSetup } from './fixtures/fake-workspace-mcp.mjs'

const config = { baseUrl: 'https://isolated.invalid/v1', model: 'r3-05-fixture', apiKey: 'synthetic-model-key' }
const owner = `r3-05-owner-${randomUUID()}`
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 2 } } })
const turn = (name, args) => {
  const call = { id: `call-${randomUUID()}`, type: 'toolCall', name, arguments: args }
  return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
}
const sendAlias = mcpToolAlias('google-workspace', 'send_gmail_message')
const mail = { to: 'friend@example.test', subject: '周报', body: '本周进展见附件。' }
const leaks = value => FAKE_GOOGLE_SECRET_PREFIXES.filter(prefix => String(value).includes(prefix))
const lastResult = (options, name) => {
  const found = options.context.messages.filter(message => message.role === 'toolResult' && message.toolName === name)
  return found.length ? JSON.parse(found.at(-1).content[0].text) : null
}
async function until(read, ready, label) {
  let last
  for (let i = 0; i < 400; i++) { last = await read(); if (ready(last)) return last; await delay(10) }
  assert.fail(`${label} did not settle: ${JSON.stringify({ checkpoint: last?.runtime?.checkpoint, messages: last?.messages?.slice(-3) })}`)
}
async function filesText(directory) {
  let text = ''
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name)
    if (entry.isFile() && !path.endsWith(join('google', 'credentials.json'))) text += await readFile(path, 'latin1')
  }
  return text
}

// One store + HTTP server over fake Google, a connected account and the fake workspace-mcp.
async function fixture(t, { modelReply }) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-r3-05-http-'))
  const env = await googleWorkspaceSetup({ dataDirectory: join(root, 'google') })
  const skills = createSkillImportService({ dataDirectory: join(root, 'skills') }), skillDirectory = { builtinDirectory: SKILL_DIRECTORY, userSkills: skills }
  await mkdir(join(root, 'skills'), { recursive: true })
  let store, server, mcp
  const start = async () => {
    // Same wiring as index.mjs; workspaceMcpUrl stands in for PIDOT_WORKSPACE_MCP_URL.
    mcp = await createExternalMcpService({ dataDirectory: join(root, 'external-mcp'), inheritedEnv: {}, workspaceMcpUrl: env.workspace.url,
      googleAccessToken: options => env.google.accessToken(options), googleRejectToken: token => env.google.rejectToken(token) })
    store = await openTaskStore({ file: join(root, 'tasks.sqlite'), bots: listBots(config), externalMcp: mcp, skillDirectory, capabilityManagementEnabled: true,
      readCapabilityCatalog: () => skillCapabilityCatalog(skillDirectory), workspaceEnabled: false, calendarQueryEnabled: false, modelReply })
    server = createApiServer({ token: owner, tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  }
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close() }
  await start()
  t.after(async () => {
    await stop(); await env.close()
    assert.deepEqual(env.guard.blocked, [], 'no request may reach a real Google host')
    await rm(root, { recursive: true, force: true })
  })
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const idle = taskId => until(() => store.get(taskId), task => task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput', `task ${taskId}`)
  // Direct (UI/HTTP) setup path, used where the test is not about Chief.
  const connect = async (botId, extra = {}) => {
    const configured = await call('/api/external-mcp/configure', { requestId: `configure-${randomUUID()}`, config: { ...googleWorkspaceMcpTemplate(), ...extra } })
    assert.equal(configured.status, 200, JSON.stringify(configured.body))
    const checked = await call('/api/external-mcp/check', { requestId: `check-${randomUUID()}`, connectionId: 'google-workspace', expectedRevision: configured.body.data.revision })
    assert.equal(checked.body.data.status, 'ready', JSON.stringify(checked.body))
    const view = await store.getBotCapabilities(botId), item = view.items.find(item => item.id === 'mcp:google-workspace')
    await store.setBotCapabilityAssignment(botId, { requestId: randomUUID(), expectedRevision: view.revision, expectedCatalogRevision: item.revision, capabilityId: item.id, enabled: true })
  }
  return { root, ...env, call, idle, connect, get store() { return store }, get mcp() { return mcp }, restart: async () => { await stop(); await start() } }
}

test('Chief connects workspace-mcp from one sentence, assigns it to the target Bot, which sends mail directly', async t => {
  let targetId, sawSendTool = false
  const f = await fixture(t, { modelReply: async (_message, options) => {
    const tools = options.context.tools ?? []
    if (tools.some(tool => tool.name === 'mcp_manage')) {
      const result = lastResult(options, 'mcp_manage')
      if (!result) return turn('mcp_manage', { action: 'inspect', targetBotId: targetId })
      if (result.data?.action === 'inspect') return turn('mcp_manage', { action: 'add', operationId: 'google-mail-files', targetBotId: targetId,
        expectedRevision: result.data.targetRevision, config: googleWorkspaceMcpTemplate() })
      return text(`配置回执：${result.data?.state}`)
    }
    sawSendTool ||= tools.some(tool => tool.name === sendAlias && tool.parameters?.properties?.to)
    return lastResult(options, sendAlias) ? text('邮件已发出') : turn(sendAlias, mail)
  } })
  targetId = (await f.store.createBot({ name: '写信助手', requestId: 'r3-05-writer' })).bot.id
  const chief = (await f.store.mainSessions()).chief
  await f.store.send(chief, '接上 Google 邮件和文件，给写信助手用')
  const configured = await f.idle(chief), setup = configured.capabilitySetups[0]
  assert.equal(setup.state, 'ready', JSON.stringify(setup))
  assert.equal(setup.connectionId, 'google-workspace'); assert.equal(setup.enabledForBot, true); assert.equal(setup.targetBotId, targetId)
  assert.equal(configured.approvals.items.every(item => item.decision?.source === 'policy-rule'), true, 'no confirmation card (ADR-018)')
  const capability = (await f.store.getBotCapabilities(targetId)).items.find(item => item.id === 'mcp:google-workspace')
  assert.equal(capability.enabledForBot, true); assert.equal(capability.available, true)
  assert.equal((await f.store.getBotCapabilities('chief')).items.find(item => item.id === 'mcp:google-workspace').enabledForBot, false, 'only the target Bot')

  const targetMain = (await f.store.mainSessions())[targetId]
  await f.store.send(targetMain, '给 friend@example.test 发周报')
  const done = await f.idle(targetMain), item = done.approvals.items.find(item => item.toolName === sendAlias)
  assert.equal(sawSendTool, true)
  assert.equal(item.decision.source, 'policy-rule'); assert.equal(item.externalMcp.connectionId, 'google-workspace')
  assert.equal(item.receipt.result.ok, true); assert.match(item.receipt.result.data.structuredContent.result, /Email sent!/)
  assert.deepEqual(f.workspace.calls.map(call => [call.name, call.arguments]), [['send_gmail_message', mail]])
  assert.equal(done.messages.at(-1).content, '邮件已发出')
  // Secret scan: Task history, HTTP projections, the database and MCP files (only google/credentials.json may hold secrets).
  const list = await f.call('/api/external-mcp')
  assert.equal(list.body.data.items[0].credentialSource, 'google')
  for (const value of [JSON.stringify(configured), JSON.stringify(done), JSON.stringify(list.body), await filesText(f.root)]) assert.deepEqual(leaks(value), [])
})

test('through the Harness: a timeout is unknown and never resent, also after restart; a restart needs a fresh check', async t => {
  let turns = 0
  const f = await fixture(t, { modelReply: async () => turns++ % 2 === 0 ? turn(sendAlias, mail) : text('已记录') })
  const { bot } = await f.store.createBot({ name: '超时助手', requestId: 'r3-05-timeout' })
  await f.connect(bot.id, { timeoutMs: 1500 })
  f.workspace.hang('send_gmail_message')
  const task = await f.store.create({ botId: bot.id })
  await f.store.send(task.taskId, '发周报')
  const done = await f.idle(task.taskId), item = done.approvals.items[0]
  assert.equal(item.status, 'outcome-unknown')
  assert.equal(item.receipt.result.error.unknown, true); assert.equal(item.receipt.result.error.retryable, false)
  assert.equal(f.workspace.count('send_gmail_message'), 1)
  await f.restart()
  await delay(200)
  assert.equal(f.workspace.count('send_gmail_message'), 1, 'not resent after restart')
  assert.deepEqual((await f.store.get(task.taskId)).approvals.items[0].receipt, item.receipt)
  const capability = (await f.store.getBotCapabilities(bot.id)).items.find(item => item.id === 'mcp:google-workspace')
  assert.equal(capability.available, false, 'a restarted connection is not usable until checked')
  assert.equal((await f.call('/api/external-mcp')).body.data.items[0].status, 'configured')
})

test('through the Harness: after disconnecting Google the call fails definitely; after disabling it is refused', async t => {
  let turns = 0
  const f = await fixture(t, { modelReply: async () => turns++ % 2 === 0 ? turn(sendAlias, mail) : text('已处理') })
  const { bot } = await f.store.createBot({ name: '断开助手', requestId: 'r3-05-disconnect' })
  await f.connect(bot.id)
  await f.google.disconnect({})
  const sent = f.workspace.requests.length
  const task = await f.store.create({ botId: bot.id })
  await f.store.send(task.taskId, '发周报')
  const first = await f.idle(task.taskId), receipt = first.approvals.items[0].receipt.result
  assert.equal(receipt.ok, false); assert.equal(receipt.error.code, 'MCP_GOOGLE_NOT_CONNECTED'); assert.equal(receipt.error.unknown, undefined)
  assert.equal(f.workspace.requests.length, sent, 'nothing reached workspace-mcp')

  const connection = (await f.call('/api/external-mcp')).body.data.items[0]
  const disabled = await f.call('/api/external-mcp/disable', { requestId: 'disable-google-workspace', connectionId: 'google-workspace', expectedRevision: connection.revision })
  assert.equal(disabled.body.data.status, 'disabled')
  assert.equal((await f.store.getBotCapabilities(bot.id)).items.find(item => item.id === 'mcp:google-workspace').available, false)
  await f.store.send(task.taskId, '再发一次')
  const second = await f.idle(task.taskId)
  const refused = second.messages.filter(message => message.toolName === sendAlias).at(-1)
  assert.equal(refused.result.ok, false); assert.equal(refused.result.error.code, 'TOOL_NOT_INSTALLED', 'refused before dispatch')
  assert.equal(f.workspace.requests.length, sent); assert.equal(f.workspace.count('send_gmail_message'), 0)
})
