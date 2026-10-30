import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createExternalMcpService } from './external-mcp.mjs'
import { createFixtureMcpHttp } from './fixtures/external-mcp-sdk-http.mjs'

const stdioPath = fileURLToPath(new URL('./fixtures/external-mcp-sdk-stdio.mjs', import.meta.url))
const authorize = async () => true
const revision = async (service, id) => (await service.connections()).find(item => item.connectionId === id)?.revision
const check = async (service, id, options = {}) => service.check(id, { expectedRevision: await revision(service, id), ...options })
const save = async (service, input) => service.saveCredential({ expectedRevision: await revision(service, input.connectionId), ...input })
const disable = async (service, input) => service.disable({ expectedRevision: await revision(service, input.connectionId), ...input })
const input = (id, url) => ({ connectionId: id, name: 'Official SDK fixture', transport: 'streamable-http', url, allowLoopback: true })
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pidot-external-mcp-')), services = new Set()
  const open = async () => { const service = await createExternalMcpService({ dataDirectory: directory, ...options }); services.add(service); return service }
  const service = await open()
  t.after(async () => { for (const service of services) await service.close(); await rm(directory, { recursive: true, force: true }) })
  return { service, directory, open }
}
async function withHttp(t, options = {}) {
  const http = await createFixtureMcpHttp(options)
  t.after(() => http.close())
  return http
}
const tool = async (service, originalName) => (await service.toolCatalog()).find(tool => tool.originalName === originalName)

test('official HTTP SDK handshakes, discovers paginated tools, validates schemas and requires a live host authorization', async t => {
  const http = await withHttp(t), { service } = await fixture(t)
  const configured = await service.configure({ requestId: 'sdk-http-configure', config: input('http', http.url) })
  assert.equal(configured.status, 'configured')
  assert.deepEqual(await service.toolCatalog(), [])
  const checked = await service.check('http', { requestId: 'sdk-http-check', expectedRevision: configured.revision })
  assert.equal(checked.status, 'ready'); assert.equal(checked.toolCount, 3)
  const catalog = await service.catalog(), tools = await service.toolCatalog()
  assert.equal(catalog[0].status, 'ready'); assert.equal(catalog[0].toolNames.length, 3)
  assert.ok(tools.every(tool => tool.writeMode === 'ask' && !Object.hasOwn(tool, 'annotations')))
  const echo = await tool(service, 'greeting.echo')
  await assert.rejects(service.invoke({ connectionId: 'http', toolName: echo.name, arguments: { text: 'hello' } }), { code: 'MCP_NOT_AUTHORIZED' })
  await assert.rejects(service.invoke({ connectionId: 'http', toolName: echo.name, arguments: { text: 1 }, authorize }), { code: 'MCP_INVALID_ARGUMENTS' })
  await assert.rejects(service.invoke({ connectionId: 'http', toolName: echo.name, arguments: { text: 'hello' }, authorize: async () => false }), { code: 'MCP_NOT_AUTHORIZED' })
  assert.equal(http.calls.length, 0)
  let bound
  const result = await service.invoke({ connectionId: 'http', toolName: echo.name, arguments: { text: 'hello' }, authorize: async value => { bound = value; return true } })
  assert.deepEqual(result.structuredContent, { echoed: 'hello' })
  assert.deepEqual(bound, { connectionId: 'http', toolName: echo.name, originalName: 'greeting.echo' })
  assert.equal(http.calls.length, 1)
  assert.equal((await service.requestStatus('sdk-http-check')).state, 'succeeded')
})

test('credential storage is separate, atomic and private; public records contain no bearer or credential ref', async t => {
  const token = 'isolated-fixture-token', http = await withHttp(t, { bearerToken: token }), { service, directory } = await fixture(t)
  const configured = await service.configure({ requestId: 'auth-configure', config: { ...input('auth', http.url), credentialRequired: true } })
  assert.equal(configured.status, 'needs_auth')
  await assert.rejects(check(service, 'auth'), { code: 'MCP_CREDENTIAL_UNAVAILABLE' })
  const saved = await service.saveCredential({ requestId: 'auth-save', connectionId: 'auth', expectedRevision: configured.revision, credential: { bearerToken: token } })
  assert.equal(saved.saved, true); assert.equal(saved.status, 'configured')
  const replay = await service.saveCredential({ requestId: 'auth-save', connectionId: 'auth', expectedRevision: configured.revision, credential: { bearerToken: token } })
  assert.equal(replay.replayed, true); assert.equal(replay.revision, saved.revision)
  await check(service, 'auth')
  const publicJson = JSON.stringify([await service.connections(), await service.catalog(), await service.requestStatus('auth-save')])
  assert.equal(publicJson.includes(token), false); assert.equal(publicJson.includes('mcpcred_'), false)
  assert.equal((await service.connections())[0].hasCredential, true)
  const configFile = await readFile(join(directory, 'connections.json'), 'utf8'), credentialFile = await readFile(join(directory, 'credentials.json'), 'utf8')
  assert.equal(configFile.includes(token), false); assert.equal(credentialFile.includes(token), true)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  for (const file of ['connections.json', 'credentials.json']) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600)
})

test('configuration, removal and request receipts survive restart, but a process-local handshake never pretends to survive', async t => {
  const http = await withHttp(t), f = await fixture(t), service = f.service
  const config = input('persisted', http.url), created = await service.configure({ requestId: 'persist-configure', config })
  assert.equal((await service.configure({ requestId: 'persist-configure', config })).replayed, true)
  await assert.rejects(service.configure({ requestId: 'persist-configure', config: { ...config, name: 'different' } }), { code: 'MCP_CONFIG_CONFLICT' })
  await service.check('persisted', { requestId: 'persist-check', expectedRevision: created.revision })
  const echo = await tool(service, 'greeting.echo')
  await service.close()
  const reopened = await f.open()
  assert.equal((await reopened.connections())[0].status, 'configured')
  assert.deepEqual(await reopened.toolCatalog(), [])
  assert.equal((await reopened.check('persisted', { requestId: 'persist-check', expectedRevision: created.revision })).status, 'configured')
  await assert.rejects(reopened.invoke({ connectionId: 'persisted', toolName: echo.name, arguments: { text: 'must not dispatch' }, authorize }), { code: 'MCP_CONNECTION_UNAVAILABLE' })
  await reopened.reconnect('persisted', { requestId: 'persist-reconnect', expectedRevision: await revision(reopened, 'persisted') })
  assert.equal((await tool(reopened, 'greeting.echo')).name, echo.name)
  const record = (await reopened.connections())[0]
  await assert.rejects(reopened.disable({ connectionId: 'persisted', requestId: 'stale-disable', expectedRevision: 'stale' }), { code: 'MCP_CONFIG_CONFLICT' })
  await reopened.disable({ connectionId: 'persisted', requestId: 'persist-disable', expectedRevision: record.revision })
  await assert.rejects(reopened.invoke({ connectionId: 'persisted', toolName: echo.name, arguments: { text: 'disabled' }, authorize }), { code: 'MCP_CONNECTION_UNAVAILABLE' })
  const removal = { connectionId: 'persisted', requestId: 'persist-remove', expectedRevision: await revision(reopened, 'persisted') }
  const removed = await reopened.remove(removal)
  assert.equal(removed.removed, true); assert.equal((await reopened.catalog()).length, 0)
  await reopened.close()
  const final = await f.open()
  assert.equal((await final.remove(removal)).replayed, true)
  assert.equal((await final.requestStatus('persist-remove')).state, 'succeeded')
  await assert.rejects(final.configure({ requestId: 'do-not-reuse-source', config }), { code: 'MCP_CONFIG_CONFLICT' })
})

test('official stdio uses an installed executable with selected env and secret bindings, while stderr content stays private', async t => {
  const { service } = await fixture(t, { inheritedEnv: { LANG: 'C.UTF-8', HOME: '/not-inherited', PATH: '/not-inherited', PIDOT_FIXTURE_UNSELECTED: 'not-inherited' } })
  await service.configure({ requestId: 'stdio-configure', config: { connectionId: 'stdio', name: 'Local SDK fixture', transport: 'stdio', executable: process.execPath, args: [stdioPath],
    envKeys: ['LANG'], secretEnvKeys: ['MCP_FIXTURE_TOKEN'], credentialRequired: true } })
  assert.deepEqual((await service.connections())[0].secretEnvKeys, ['MCP_FIXTURE_TOKEN'])
  await save(service, { connectionId: 'stdio', requestId: 'stdio-credential', credential: { env: { MCP_FIXTURE_TOKEN: 'isolated-token' } } })
  const checked = await check(service, 'stdio')
  assert.equal(checked.status, 'ready'); assert.equal(checked.lastCheck.diagnostics.stderrReceived, true)
  assert.deepEqual(Object.keys(checked.lastCheck.diagnostics).sort(), ['stderrReceived', 'stderrTruncated'])
  const envTool = await tool(service, 'fixture.environment')
  const result = await service.invoke({ connectionId: 'stdio', toolName: envTool.name, arguments: {}, authorize })
  assert.deepEqual(JSON.parse(result.content[0].text), { hasHome: false, hasPath: false, hasUnselected: false, hasFixtureSecret: true, language: 'C.UTF-8' })
})

test('an explicitly cancelled in-flight call has an unknown receipt and is never retried', async t => {
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const http = await withHttp(t, { onCall: () => entered(), wait: () => gate }), { service } = await fixture(t)
  try {
    await service.configure({ requestId: 'cancel-configure', config: input('cancel', http.url) }); await check(service, 'cancel')
    const write = await tool(service, 'records.write'), controller = new AbortController()
    const result = service.invoke({ connectionId: 'cancel', toolName: write.name, arguments: { text: 'one benign write' }, authorize, signal: controller.signal }).catch(error => error)
    await started; controller.abort()
    const error = await result
    assert.equal(error.code, 'MCP_INVOCATION_UNKNOWN'); assert.equal(error.unknown, true); assert.equal(error.retryable, false)
    assert.equal(http.calls.length, 1)
  } finally { release() }
})

test('disable aborts an in-flight invocation and blocks every later call immediately', async t => {
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const http = await withHttp(t, { onCall: () => entered(), wait: () => gate }), { service } = await fixture(t)
  try {
    await service.configure({ requestId: 'disable-configure', config: input('disable', http.url) }); await check(service, 'disable')
    const write = await tool(service, 'records.write')
    const result = service.invoke({ connectionId: 'disable', toolName: write.name, arguments: { text: 'one benign write' }, authorize }).catch(error => error)
    await started
    await disable(service, { connectionId: 'disable', requestId: 'disable-live' })
    assert.equal((await result).code, 'MCP_INVOCATION_UNKNOWN')
    await assert.rejects(service.invoke({ connectionId: 'disable', toolName: write.name, arguments: { text: 'must not run' }, authorize }), { code: 'MCP_CONNECTION_UNAVAILABLE' })
    assert.equal(http.calls.length, 1)
  } finally { release() }
})

test('check cancellation cannot publish ready after disable, and a normal process exit is diagnosed without raw stderr', async t => {
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const http = await withHttp(t, { beforeList: async () => { entered(); await gate } }), { service } = await fixture(t)
  try {
    await service.configure({ requestId: 'pending-configure', config: input('pending', http.url) })
    const checking = check(service, 'pending', { requestId: 'pending-check' }).catch(error => error)
    await started; await disable(service, { connectionId: 'pending', requestId: 'pending-disable' })
    assert.equal((await checking).code, 'MCP_CANCELLED')
    assert.equal((await service.connections())[0].status, 'disabled')
    assert.equal((await service.requestStatus('pending-check')).state, 'failed')
  } finally { release() }
  await service.configure({ requestId: 'exit-configure', config: { connectionId: 'exit', name: 'Normal exited process', transport: 'stdio', executable: process.execPath, args: [stdioPath, 'exit'] } })
  await assert.rejects(check(service, 'exit'), { code: 'MCP_CONNECTION_FAILED' })
  assert.equal((await service.connections()).find(record => record.connectionId === 'exit').status, 'error')
})


test('catalog revision is stable across checks, credential rotation and restart, while mutation CAS remains independent', async t => {
  const http = await withHttp(t), f = await fixture(t), { service } = f
  await service.configure({ requestId: 'revision-configure', config: input('revision', http.url) })
  await check(service, 'revision')
  const catalog = (await service.catalog())[0], connection = (await service.connections())[0]
  assert.equal(catalog.revision, connection.catalogRevision)
  await service.reconnect('revision', { expectedRevision: await revision(service, 'revision') })
  assert.equal((await service.catalog())[0].revision, catalog.revision)
  await save(service, { connectionId: 'revision', requestId: 'revision-credential', credential: { bearerToken: 'isolated-rotated-token' } })
  assert.notEqual((await service.connections())[0].revision, connection.revision)
  assert.equal((await service.catalog())[0].revision, catalog.revision)
  await check(service, 'revision')
  assert.equal((await service.catalog())[0].revision, catalog.revision)
  await service.close()
  const reopened = await f.open(); await check(reopened, 'revision')
  assert.equal((await reopened.catalog())[0].revision, catalog.revision)
})

test('bounded normal discovery timeout persists a failed check, never a ready connection', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const http = await withHttp(t, { beforeList: () => gate }), { service } = await fixture(t)
  try {
    await service.configure({ requestId: 'timeout-configure', config: { ...input('timeout', http.url), timeoutMs: 1000 } })
    await assert.rejects(check(service, 'timeout', { requestId: 'timeout-check' }), { code: 'MCP_TIMEOUT' })
    assert.equal((await service.requestStatus('timeout-check')).state, 'failed')
    assert.equal((await service.connections())[0].status, 'error')
    assert.deepEqual(await service.toolCatalog(), [])
  } finally { release() }
})


test('every existing connection mutation requires an explicit current CAS revision', async t => {
  const http = await withHttp(t), { service } = await fixture(t), config = input('cas', http.url)
  const created = await service.configure({ requestId: 'cas-create', config })
  const calls = [
    () => service.configure({ requestId: 'cas-reconfigure', config }),
    () => service.saveCredential({ requestId: 'cas-credential', connectionId: 'cas', credential: { bearerToken: 'isolated-only' } }),
    () => service.check('cas', { requestId: 'cas-check' }),
    () => service.reconnect('cas', { requestId: 'cas-reconnect' }),
    () => service.disable({ requestId: 'cas-disable', connectionId: 'cas' }),
    () => service.remove({ requestId: 'cas-remove', connectionId: 'cas' }),
  ]
  for (const call of calls) await assert.rejects(call(), { code: 'MCP_CONFIG_CONFLICT' })
  assert.equal((await service.connections())[0].revision, created.revision)
  assert.equal(http.calls.length, 0)
})

test('normal authorization failure is needs_auth, and a corrected privately saved token can be checked successfully', async t => {
  const http = await withHttp(t, { bearerToken: 'isolated-correct-token' }), { service } = await fixture(t)
  await service.configure({ requestId: 'correctable-auth', config: { ...input('correctable', http.url), credentialRequired: true } })
  await save(service, { connectionId: 'correctable', requestId: 'wrong-fixture-token', credential: { bearerToken: 'isolated-wrong-token' } })
  await assert.rejects(check(service, 'correctable', { requestId: 'wrong-token-check' }), { code: 'MCP_AUTH_REQUIRED' })
  assert.equal((await service.connections())[0].status, 'needs_auth')
  await save(service, { connectionId: 'correctable', requestId: 'correct-fixture-token', credential: { bearerToken: 'isolated-correct-token' } })
  assert.equal((await check(service, 'correctable')).status, 'ready')
})

test('a normal localhost name uses the validated lookup answers in actual SDK HTTP sockets', async t => {
  const http = await withHttp(t)
  let lookups = 0
  const { service } = await fixture(t, { lookup: async hostname => { assert.equal(hostname, 'localhost'); lookups++; return [{ address: '127.0.0.1', family: 4 }] } })
  await service.configure({ requestId: 'pinned-local-name', config: input('pinned', http.url.replace('127.0.0.1', 'localhost')) })
  await check(service, 'pinned')
  const echo = await tool(service, 'greeting.echo')
  await service.invoke({ connectionId: 'pinned', toolName: echo.name, arguments: { text: 'normal pinned connection' }, authorize })
  assert.ok(lookups >= 4)
  assert.ok(http.addresses.length >= 4)
  assert.ok(http.addresses.every(address => address === '127.0.0.1'))
})

test('a normal provider schema mismatch remains an unconfirmed result and does not trigger a retry', async t => {
  const http = await withHttp(t, { transformResult: result => ({ ...result, structuredContent: { echoed: 1 } }) }), { service } = await fixture(t)
  await service.configure({ requestId: 'output-schema-configure', config: input('output', http.url) }); await check(service, 'output')
  const echo = await tool(service, 'greeting.echo')
  await assert.rejects(service.invoke({ connectionId: 'output', toolName: echo.name, arguments: { text: 'one attempt' }, authorize }), error => error.code === 'MCP_INVOCATION_UNKNOWN' && error.unknown === true && error.retryable === false)
  assert.equal(http.calls.length, 1)
})


test('normal resolver cancellation and service close finish before a delayed lookup and never open a late socket', async t => {
  const http = await withHttp(t)
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const { service } = await fixture(t, { lookup: async () => { entered(); await gate; return [{ address: '127.0.0.1', family: 4 }] } })
  try {
    await service.configure({ requestId: 'resolver-configure', config: input('resolver', http.url.replace('127.0.0.1', 'localhost')) })
    const checking = check(service, 'resolver', { requestId: 'resolver-check' }).catch(error => error)
    await started
    await service.close()
    assert.equal((await checking).code, 'MCP_CANCELLED')
    assert.equal(http.addresses.length, 0)
    release(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(http.addresses.length, 0)
  } finally { release() }
})


test('one check deadline bounds the whole paginated discovery rather than restarting its budget for each page', async t => {
  const http = await withHttp(t, { beforeList: () => delay(600) }), { service } = await fixture(t)
  await service.configure({ requestId: 'pagination-deadline-configure', config: { ...input('deadline', http.url), timeoutMs: 1000 } })
  await assert.rejects(check(service, 'deadline', { requestId: 'pagination-deadline-check' }), { code: 'MCP_TIMEOUT' })
  assert.equal((await service.connections())[0].status, 'error')
})


test('source-only revision survives credentials and discovery but changes for an edited endpoint', async t => {
  const first = await withHttp(t), second = await withHttp(t), { service } = await fixture(t)
  const config = input('source-only', first.url)
  const configured = await service.configure({ requestId: 'source-only-configure', config })
  assert.equal(typeof configured.sourceRevision, 'string')
  assert.equal(configured.sourceRevision.length, 64)
  const saved = await save(service, { connectionId: 'source-only', requestId: 'source-only-credential', credential: { bearerToken: 'isolated-source-token' } })
  assert.equal(saved.sourceRevision, configured.sourceRevision)
  const checked = await check(service, 'source-only')
  assert.equal(checked.sourceRevision, configured.sourceRevision)
  assert.notEqual(checked.catalogRevision, configured.catalogRevision)
  const renamed = await service.configure({ requestId: 'source-label-only', expectedRevision: await revision(service, 'source-only'), config: { ...config, name: 'A different label', timeoutMs: 1000 } })
  assert.equal(renamed.sourceRevision, configured.sourceRevision)
  const edited = await service.configure({ requestId: 'source-endpoint-edit', expectedRevision: await revision(service, 'source-only'), config: { ...config, url: second.url } })
  assert.notEqual(edited.sourceRevision, configured.sourceRevision)
})
