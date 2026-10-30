import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createExternalMcpService } from './external-mcp.mjs'
import { validateMcpConfig, projectMcpConfig, mcpSourceRevision } from './external-mcp-config.mjs'
import { googleHttpConfig } from './external-mcp-transport.mjs'
import { resolveWorkspaceMcpEndpoint, googleWorkspaceMcpTemplate, probeWorkspaceMcp, WORKSPACE_MCP_DEFAULT_URL } from './external-mcp-google.mjs'
import { parseCapabilityManagementCall } from './capability-management-tools.mjs'
import { FAKE_GOOGLE_SECRET_PREFIXES } from './fixtures/fake-google.mjs'
import { googleWorkspaceSetup, createImpostorHealth, fingerprint, WORKSPACE_MCP_CATALOG } from './fixtures/fake-workspace-mcp.mjs'

const code = expected => error => error?.code === expected
const leaks = text => FAKE_GOOGLE_SECRET_PREFIXES.filter(prefix => String(text).includes(prefix))
const allow = async () => true
async function filesText(directory, skip = []) {
  let text = ''
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name)
    if (entry.isFile() && !skip.some(item => path.endsWith(item))) text += await readFile(path, 'latin1')
  }
  return text
}
async function setup(t, { services, clock, mcp: mcpOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-r3-05-'))
  const env = await googleWorkspaceSetup({ dataDirectory: join(root, 'google'), clock, services })
  const opened = new Set()
  const open = async (extra = {}) => {
    const service = await createExternalMcpService({ dataDirectory: join(root, 'external-mcp'), inheritedEnv: {}, workspaceMcpUrl: env.workspace.url,
      googleAccessToken: options => env.google.accessToken(options), googleRejectToken: token => env.google.rejectToken(token), ...mcpOptions, ...extra })
    opened.add(service); return service
  }
  const service = await open()
  t.after(async () => {
    for (const item of opened) await item.close()
    await env.close()
    assert.deepEqual(env.guard.blocked, [], 'no request may reach a real Google host')
    await rm(root, { recursive: true, force: true })
  })
  return { root, ...env, service, open }
}
const revision = async (service, id = 'google-workspace') => (await service.connections()).find(item => item.connectionId === id).revision
async function ready(service, config = googleWorkspaceMcpTemplate()) {
  const configured = await service.configure({ requestId: `configure-${Math.random().toString(36).slice(2)}`, config })
  return service.check(configured.connectionId, { expectedRevision: configured.revision })
}
const toolName = async (service, original) => (await service.toolCatalog()).find(tool => tool.originalName === original).name
const send = { to: 'friend@example.test', subject: 'R3-05', body: 'fixture body' }

test('template: one-sentence shorthand expands to a URL-free Google-sourced config; URLs, bearers and refs are refused', () => {
  const expanded = validateMcpConfig(googleWorkspaceMcpTemplate())
  assert.deepEqual(expanded, { connectionId: 'google-workspace', name: 'Google 邮件与文件', description: expanded.description, transport: 'streamable-http',
    credentialRequired: false, timeoutMs: 30000, credentialSource: 'google', googleServices: ['gmail', 'drive', 'docs', 'sheets'] })
  assert.match(expanded.description, /workspace-mcp/)
  assert.deepEqual(validateMcpConfig(expanded), expanded, 'stored form re-validates unchanged')
  assert.equal(JSON.stringify(expanded).includes('://'), false, 'no URL in the stored config')
  assert.deepEqual(validateMcpConfig({ template: 'google-workspace', googleServices: ['sheets', 'gmail'] }).googleServices, ['gmail', 'sheets'])
  for (const patch of [{ url: 'http://127.0.0.1:8000/mcp' }, { allowLoopback: true }, { credentialRef: `mcpcred_${'a'.repeat(32)}` }, { bearerToken: 'x' },
    { headers: {} }, { template: 'other' }, { credentialSource: 'static' }, { transport: 'stdio' }, { credentialRequired: true },
    { googleServices: [] }, { googleServices: ['calendar'] }, { googleServices: ['gmail', 'gmail'] }, { connectionId: '../x' }]) {
    assert.throws(() => validateMcpConfig({ template: 'google-workspace', ...patch }), code('MCP_INVALID_CONFIG'), JSON.stringify(patch))
  }
  const view = projectMcpConfig(expanded)
  assert.equal(view.credentialSource, 'google'); assert.equal(view.hasCredential, false)
  assert.equal(mcpSourceRevision(expanded), mcpSourceRevision({ ...expanded, name: 'renamed' }))
  assert.notEqual(mcpSourceRevision(expanded), mcpSourceRevision({ ...expanded, googleServices: ['gmail'] }))
  // Chief's mcp_manage: the template is the whole config; the server fills id, name and source.
  const call = { name: 'mcp_manage', arguments: { action: 'add', operationId: 'google-mail-files', targetBotId: 'writer', expectedRevision: 'r1', config: googleWorkspaceMcpTemplate() } }
  const parsed = parseCapabilityManagementCall(call)
  assert.equal(parsed.args.connectionId, 'google-workspace'); assert.equal(parsed.args.config.credentialSource, 'google')
  assert.throws(() => parseCapabilityManagementCall({ ...call, arguments: { ...call.arguments, config: { template: 'google-workspace', url: 'https://evil.example/mcp' } } }))
})

test('endpoint comes from configuration only and must be loopback; the Google transport refuses anything else', () => {
  assert.deepEqual(resolveWorkspaceMcpEndpoint({ env: {} }), { url: WORKSPACE_MCP_DEFAULT_URL, custom: false, invalid: false })
  assert.equal(resolveWorkspaceMcpEndpoint({ env: { PIDOT_WORKSPACE_MCP_URL: 'http://127.0.0.1:18080/mcp' } }).url, 'http://127.0.0.1:18080/mcp')
  assert.equal(resolveWorkspaceMcpEndpoint({ env: { PIDOT_WORKSPACE_MCP_URL: '  ' } }).url, WORKSPACE_MCP_DEFAULT_URL)
  assert.equal(resolveWorkspaceMcpEndpoint({ url: 'http://localhost:9000/mcp', env: {} }).custom, true)
  for (const url of ['https://mcp.vendor.com/mcp', 'http://10.0.0.5:8000/mcp', 'http://user:pw@127.0.0.1:8000/mcp', 'http://127.0.0.1:8000/mcp?token=x', 'ftp://127.0.0.1/mcp']) {
    assert.deepEqual(resolveWorkspaceMcpEndpoint({ url, env: {} }), { url: null, custom: true, invalid: true }, url)
  }
  const config = validateMcpConfig(googleWorkspaceMcpTemplate()), bearer = { token: async () => 'x', reject: () => {} }
  assert.throws(() => googleHttpConfig(config, { url: 'https://mcp.vendor.com/mcp', bearer }), code('MCP_UNSAFE_ENDPOINT'))
  assert.throws(() => googleHttpConfig(config, { url: undefined, bearer }), code('MCP_UNSAFE_ENDPOINT'))
  assert.throws(() => googleHttpConfig(config, { url: 'http://127.0.0.1:1/mcp' }), code('MCP_GOOGLE_NOT_CONNECTED'))
})

test('check and a send-type tool use the live Google access token; nothing static is stored or returned', async t => {
  const f = await setup(t)
  const checked = await ready(f.service)
  assert.equal(checked.status, 'ready'); assert.equal(checked.toolCount, WORKSPACE_MCP_CATALOG.tools.length)
  const names = (await f.service.toolCatalog()).map(tool => tool.originalName).sort()
  assert.deepEqual(names, WORKSPACE_MCP_CATALOG.tools.map(tool => tool.name).sort())
  assert.equal(names.includes('send_gmail_message'), true); assert.equal(names.some(name => /calendar|task/.test(name)), false)
  const result = await f.service.invoke({ connectionId: 'google-workspace', toolName: await toolName(f.service, 'send_gmail_message'), arguments: send, authorize: allow })
  assert.equal(result.isError, undefined); assert.match(result.structuredContent.result, /Email sent!/)
  assert.deepEqual(f.workspace.calls.map(call => [call.name, call.arguments]), [['send_gmail_message', send]])
  // Every request carried a bearer that fake-google issued to Pidot; none was refused.
  const issued = [...f.fake.state.access.keys()].map(fingerprint)
  assert.ok(f.workspace.requests.length >= 3)
  assert.equal(f.workspace.requests.every(request => issued.includes(request.bearer) && request.status !== 401), true)
  const view = (await f.service.connections())[0]
  assert.equal(view.credentialSource, 'google'); assert.equal(view.hasCredential, false); assert.equal(view.credentialRequired, false)
  assert.deepEqual(leaks(JSON.stringify([view, result, await f.service.catalog(), await f.service.googleWorkspaceStatus()])), [])
  assert.deepEqual(leaks(await filesText(join(f.root, 'external-mcp'))), [], 'no Google secret in MCP config or credential files')
  await assert.rejects(f.service.saveCredential({ requestId: 'static-bearer', connectionId: 'google-workspace', expectedRevision: view.revision, credential: { bearerToken: 'static' } }), code('MCP_INVALID_CREDENTIAL'))
  await assert.rejects(f.service.configure({ requestId: 'second-google', config: { template: 'google-workspace', connectionId: 'google-two' } }), code('MCP_GOOGLE_SOURCE_CONFLICT'))
})

test('after Pidot refreshes the Google token, the next call carries the new token', async t => {
  const clock = { t: Date.now() }
  const f = await setup(t, { clock })
  await ready(f.service)
  const alias = await toolName(f.service, 'search_gmail_messages')
  await f.service.invoke({ connectionId: 'google-workspace', toolName: alias, arguments: { query: 'from:a' }, authorize: allow })
  const refreshes = f.fake.count('/token', 'POST')
  clock.t += 3600 * 1000
  await f.service.invoke({ connectionId: 'google-workspace', toolName: alias, arguments: { query: 'from:b' }, authorize: allow })
  assert.equal(f.fake.count('/token', 'POST'), refreshes + 1, 'one refresh at fake-google')
  const [first, second] = f.workspace.calls
  const newest = fingerprint([...f.fake.state.access.keys()].at(-1))
  assert.notEqual(first.bearer, second.bearer); assert.equal(second.bearer, newest)
})

test('a pre-dispatch 401 rejects the token and retries once with a fresh one; a second 401 is a definite failure', async t => {
  const f = await setup(t)
  await ready(f.service)
  const alias = await toolName(f.service, 'send_gmail_message'), before = f.fake.count('/token', 'POST')
  f.workspace.rejectNext(1)
  const ok = await f.service.invoke({ connectionId: 'google-workspace', toolName: alias, arguments: send, authorize: allow })
  assert.match(ok.structuredContent.result, /Email sent!/)
  assert.equal(f.fake.count('/token', 'POST'), before + 1, 'rejectToken forced exactly one refresh')
  const posts = f.workspace.requests.filter(request => request.method === 'POST').slice(-2)
  assert.deepEqual(posts.map(request => request.status), [401, 200]); assert.notEqual(posts[0].bearer, posts[1].bearer)
  assert.equal(f.workspace.count('send_gmail_message'), 1)
  f.workspace.rejectNext(2)
  await assert.rejects(f.service.invoke({ connectionId: 'google-workspace', toolName: alias, arguments: send, authorize: allow }),
    error => error.code === 'MCP_GOOGLE_TOKEN_REJECTED' && error.unknown !== true && error.notSent === true)
  assert.equal(f.workspace.count('send_gmail_message'), 1, 'the tool never ran for the refused request')
})

test('disconnecting Google makes the next call fail immediately, before any request is sent', async t => {
  const f = await setup(t)
  await ready(f.service)
  const alias = await toolName(f.service, 'send_gmail_message')
  await f.google.disconnect({})
  const sent = f.workspace.requests.length
  await assert.rejects(f.service.invoke({ connectionId: 'google-workspace', toolName: alias, arguments: send, authorize: allow }),
    error => error.code === 'MCP_GOOGLE_NOT_CONNECTED' && error.unknown !== true)
  assert.equal(f.workspace.requests.length, sent, 'nothing reached workspace-mcp')
  assert.equal(f.workspace.count('send_gmail_message'), 0)
  await assert.rejects(f.service.check('google-workspace', { expectedRevision: await revision(f.service) }), code('MCP_GOOGLE_NOT_CONNECTED'))
  const view = (await f.service.connections())[0]
  assert.equal(view.status, 'error'); assert.equal(view.lastCheck.error.code, 'MCP_GOOGLE_NOT_CONNECTED')
})

test('an account that did not grant Gmail/Drive/Docs/Sheets cannot be used, and no token wiring means not connected', async t => {
  const f = await setup(t, { services: ['calendar'] })
  const configured = await f.service.configure({ requestId: 'configure-calendar-only', config: googleWorkspaceMcpTemplate() })
  await assert.rejects(f.service.check(configured.connectionId, { expectedRevision: configured.revision }), code('MCP_GOOGLE_NOT_CONNECTED'))
  assert.equal(f.workspace.requests.length, 0)
  const unwired = await f.open({ dataDirectory: join(f.root, 'external-mcp-unwired'), googleAccessToken: undefined, googleRejectToken: undefined })
  const second = await unwired.configure({ requestId: 'configure-unwired', config: googleWorkspaceMcpTemplate() })
  await assert.rejects(unwired.check(second.connectionId, { expectedRevision: second.revision }), code('MCP_GOOGLE_NOT_CONNECTED'))
  assert.equal((await unwired.googleWorkspaceStatus()).googleTokenSource, false)
})

test('a timed-out tool call is recorded as unknown and never resent', async t => {
  const f = await setup(t)
  await ready(f.service, { ...googleWorkspaceMcpTemplate(), timeoutMs: 1500 })
  f.workspace.hang('send_gmail_message')
  await assert.rejects(f.service.invoke({ connectionId: 'google-workspace', toolName: await toolName(f.service, 'send_gmail_message'), arguments: send, authorize: allow }),
    error => error.code === 'MCP_INVOCATION_UNKNOWN' && error.unknown === true && error.retryable === false && error.causeCode === 'MCP_TIMEOUT')
  await delay(300)
  assert.equal(f.workspace.count('send_gmail_message'), 1, 'exactly one dispatch, no automatic resend')
})

test('disabling refuses calls at once; after a restart the connection must be checked again before use', async t => {
  const f = await setup(t)
  await ready(f.service)
  const alias = await toolName(f.service, 'search_gmail_messages')
  const restarted = await f.open()
  assert.equal((await restarted.connections())[0].status, 'configured')
  assert.equal((await restarted.toolCatalog()).length, 0)
  await assert.rejects(restarted.invoke({ connectionId: 'google-workspace', toolName: alias, arguments: { query: 'x' }, authorize: allow }), code('MCP_CONNECTION_UNAVAILABLE'))
  assert.equal((await restarted.check('google-workspace', { expectedRevision: await revision(restarted) })).status, 'ready')
  await restarted.invoke({ connectionId: 'google-workspace', toolName: alias, arguments: { query: 'x' }, authorize: allow })
  await restarted.disable({ requestId: 'disable-google-workspace', connectionId: 'google-workspace', expectedRevision: await revision(restarted) })
  const sent = f.workspace.requests.length
  await assert.rejects(restarted.invoke({ connectionId: 'google-workspace', toolName: alias, arguments: { query: 'y' }, authorize: allow }), code('MCP_CONNECTION_UNAVAILABLE'))
  assert.equal(f.workspace.requests.length, sent); assert.equal(f.workspace.count('search_gmail_messages'), 1)
})

test('a token echoed by the server is redacted from the tool result', async t => {
  const f = await setup(t)
  await ready(f.service)
  f.workspace.echoBearer('get_doc_content')
  const result = await f.service.invoke({ connectionId: 'google-workspace', toolName: await toolName(f.service, 'get_doc_content'), arguments: { document_id: 'doc-1' }, authorize: allow })
  assert.deepEqual(leaks(JSON.stringify(result)), [])
  assert.equal(result._meta['pidot/credential-redacted'], true)
})

test('settings status says honestly whether workspace-mcp is running and what the connection state is', async t => {
  const f = await setup(t)
  const status = async url => (await f.open({ dataDirectory: join(f.root, `status-${Math.random().toString(36).slice(2)}`), workspaceMcpUrl: url })).googleWorkspaceStatus()
  const running = await f.service.googleWorkspaceStatus()
  assert.deepEqual(running.runtime, { state: 'running', version: '2.2.1', expectedVersion: '2.2.1', customAddress: true })
  assert.equal(running.connection, null); assert.equal(running.googleTokenSource, true)
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening')
  const port = closed.address().port; await new Promise(resolve => closed.close(resolve))
  assert.equal((await status(`http://127.0.0.1:${port}/mcp`)).runtime.state, 'not_running')
  const impostor = await createImpostorHealth(); t.after(() => impostor.close())
  assert.equal((await status(impostor.url)).runtime.state, 'unexpected')
  assert.equal((await status('https://mcp.vendor.com/mcp')).runtime.state, 'invalid_config')
  await ready(f.service)
  const connected = await f.service.googleWorkspaceStatus()
  assert.equal(connected.connection.status, 'ready'); assert.equal(connected.connection.toolCount, 41)
  assert.deepEqual(Object.keys(connected.connection).sort(), ['connectionId', 'enabled', 'googleServices', 'lastCheck', 'name', 'revision', 'status', 'toolCount'])
  assert.equal(JSON.stringify(connected).includes('127.0.0.1'), false, 'no address in the public projection')
  assert.equal((await probeWorkspaceMcp(f.workspace.url)).state, 'running')
  assert.equal(f.workspace.requests.some(request => request.method === 'GET' && request.bearer === null), false, 'the probe never hits /mcp')
})
