import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { openGoogleConnection } from './google-connection.mjs'
import { GoogleAccount } from './google-account.mjs'
import { accountKeyOf } from './google-oauth.mjs'
import { composeExternalAdapters, createWorkspaceService, WORKSPACE_ADAPTERS } from './workspace-service.mjs'
import { createWorkspaceRepository } from './workspace-repository.mjs'
import { createActorAuthority } from './workspace-policy.mjs'
import { validateRecord } from './workspace-schema.mjs'
import { workspaceSourceReadable } from './workspace-grants.mjs'
import { externalSourceId, externalWorkspaceResources, registerExternalSource, providerOfSource, WORKSPACE_PROVIDERS } from './workspace-providers.mjs'
import { ToolAccess } from './tools.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT } from './fixtures/fake-google.mjs'
import { externalFixture, eventArgs, askWorkspaceChange } from './fixtures/workspace-external.mjs'

const repoStub = ops => ({ transaction: async fn => fn(null), get: async (_tx, _type, _owner, _source, id) => ops[id] ?? null })
function fakeAdapter(prefix, log, sources = []) {
  const methods = {}
  for (const name of ['syncStatus', 'configureSync', 'refreshSync', 'grantExternal', 'queryExternal', 'getExternal', 'prepareExternal', 'confirmExternal', 'cancelExternal', 'getExternalOperation', 'executeExternal'])
    methods[name] = async (_actor, input) => { log.push(`${prefix}${name}`); return { routed: prefix, input } }
  methods.reminderExternalPermission = async (_tx, _actor, sourceId) => { log.push(`${prefix}permission`); return { sourceId } }
  methods.externalSources = async () => ({ sources, notice: sources.length ? `${prefix}notice` : `${prefix}empty` })
  for (const name of ['recoverExternal', 'tickExternalSync', 'closeExternalSync']) methods[name] = async () => { log.push(`${prefix}${name}`); if (prefix === 'google-calendar:' && name === 'tickExternalSync') throw Error('calendar tick failed') }
  return { prefix, methods }
}

test('R3-01 router: per-source by prefix, per-operation by stored source, aggregates every adapter', async () => {
  const { payloadHash, LOCAL_OWNER } = await import('./workspace-schema.mjs')
  const log = [], ops = { [payloadHash([LOCAL_OWNER, 'g-op'])]: { external: {}, normalizedArgs: { sourceId: 'google-tasks:abc' } } }
  const service = composeExternalAdapters(repoStub(ops), [fakeAdapter('feishu:', log), fakeAdapter('google-calendar:', log, [{ id: 'google-calendar:x' }]), fakeAdapter('google-tasks:', log)])
  assert.equal((await service.queryExternal({}, { sourceId: 'google-calendar:x' })).routed, 'google-calendar:')
  assert.equal((await service.getExternal({}, { sourceId: 'feishu:y' })).routed, 'feishu:')
  assert.equal((await service.prepareExternal({}, { sourceId: 'nobody:z' })).routed, 'feishu:', 'unrouteable input keeps the first adapter\'s own validation')
  assert.equal((await service.executeExternal({}, { requestId: 'g-op' })).routed, 'google-tasks:')
  assert.equal((await service.confirmExternal({}, { requestId: 'missing-op' })).routed, 'feishu:')
  assert.equal((await service.cancelExternal({}, { requestId: '../bad' })).routed, 'feishu:')
  assert.deepEqual(await service.reminderExternalPermission(null, {}, 'google-tasks:q'), { sourceId: 'google-tasks:q' })
  assert.deepEqual(await service.externalSources({}, {}), { sources: [{ id: 'google-calendar:x' }], notice: 'google-calendar:notice' })
  await assert.rejects(service.tickExternalSync(), /calendar tick failed/)
  assert.deepEqual(log.filter(l => l.endsWith('tickExternalSync')), ['feishu:tickExternalSync', 'google-calendar:tickExternalSync', 'google-tasks:tickExternalSync'], 'one failure never skips other providers')
  const single = fakeAdapter('feishu:', [])
  assert.equal(composeExternalAdapters(repoStub({}), [single]), single.methods, 'one adapter is passed through unchanged')
})

test('R3-01 adapter table: legacy Feishu shape, table shape, unknown keys rejected, inert Google scaffolds', async () => {
  const { openFoundation } = await import('./fixtures/workspace-foundation.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-table-')), f = await openFoundation(join(dir, 'isolated.sqlite'))
  try {
    const authority = createActorAuthority(), user = authority.user()
    assert.deepEqual(WORKSPACE_ADAPTERS.map(a => a.provider), WORKSPACE_PROVIDERS.map(p => p.id))
    assert.throws(() => createWorkspaceService({ repository: f.repo, authority, external: { dropbox: {} } }), /Unknown workspace adapter/)
    const google = { available: false, api: async () => { throw Error('unused') }, current: async () => ({}), redact: String }
    const service = createWorkspaceService({ repository: f.repo, authority, external: { googleCalendar: { google }, googleTasks: { google } } })
    assert.deepEqual(await service.externalSources(user, {}), { sources: [], notice: '' })
    await assert.rejects(service.queryExternal(user, { sourceId: 'google-calendar:abc', start: 'x', end: 'y', timezone: 'UTC' }), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
    await assert.rejects(service.queryExternal({ ...user }, { sourceId: 'google-calendar:abc' }), e => e.code === 'WORKSPACE_ACTOR')
    await assert.rejects(service.executeExternal(user, { requestId: 'none' }), e => e.code === 'WORKSPACE_OPERATION')
    await service.recoverExternal(); await service.tickExternalSync(); await service.closeExternalSync()
    assert.equal(createWorkspaceService({ repository: f.repo, authority }).queryExternal, undefined, 'no external option, no external surface')
  } finally { await f.close(); await rm(dir, { recursive: true, force: true }) }
})

test('R3-01 Todo optional external fields: same names as Event; local Todos unchanged', () => {
  const base = { schemaVersion: 1, ownerId: 'local-owner', sourceId: 'google-tasks:abc', id: 'todo-1', title: '交报告', status: 'open', version: 1 }
  assert.deepEqual(validateRecord('Todo', { ...base, sourceId: 'local' }), { ...base, sourceId: 'local' })
  const external = { ...base, remoteId: 'task-1', remoteVersion: '"etag-1"', authority: 'external', readOnly: false, observedAt: '2026-10-31T00:00:00Z', providerTask: { id: 'task-1', status: 'needsAction' }, due: '2026-11-03' }
  assert.deepEqual(validateRecord('Todo', external), external)
  for (const bad of [{ remoteId: '' }, { remoteVersion: 7 }, { readOnly: 'no' }, { observedAt: 'later' }, { providerTask: [] }, { authority: 'external', remoteId: undefined }, { authority: 'remote' }])
    assert.throws(() => validateRecord('Todo', { ...external, ...bad }), e => e.code === 'WORKSPACE_SCHEMA')
})

test('R3-01 providers: deterministic source ids and prefixes', () => {
  const id = externalSourceId('google-calendar', 'a'.repeat(64), 'primary@example.test')
  assert.match(id, /^google-calendar:[a-f0-9]{64}$/); assert.equal(providerOfSource(id).id, 'google-calendar')
  assert.equal(providerOfSource('google-tasks:x').itemType, 'Todo'); assert.equal(providerOfSource('local'), null); assert.equal(providerOfSource('feishu:x').id, 'feishu')
})

async function googleStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-store-')), fake = await createFakeGoogle(), guard = guardGoogleNetwork()
  const google = await openGoogleConnection({ dataDirectory: join(dir, 'google'), env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch })
  let store
  const connect = async (services = ['calendar', 'tasks']) => { const started = await store.googleConnect({ services }); return store.googlePaste({ redirectUrl: await fake.approve(started.attempt.authorizeUrl) }) }
  try {
    store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), google, workspaceScheduleOptions: { autoStart: false } })
    await store.googleSaveClient({ requestId: 'store-client-0001', ...FAKE_GOOGLE_CLIENT })
    await fn({ get store() { return store }, google, fake, connect, restart: async () => { await store.close(); store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), google, workspaceScheduleOptions: { autoStart: false } }); return store } })
    assert.deepEqual(guard.blocked, [])
  } finally { await store?.close().catch(() => {}); await google.close(); await fake.close(); await rm(dir, { recursive: true, force: true }) }
}
// What an R3-03 adapter writes for one calendar; the test stands in for it.
async function seedGoogleSource(store, sourceId, account) {
  const repo = createWorkspaceRepository({ harness: store.harness, context })
  await repo.transaction(async tx => {
    const connectionId = `google:${account.accountKey.slice(0, 16)}`
    await repo.put(tx, 'Connection', { schemaVersion: 1, ownerId: 'local-owner', sourceId, id: connectionId, provider: 'google', accountKey: account.accountKey, credentialRef: 'google', authEpoch: account.authEpoch, status: 'active' })
    await repo.put(tx, 'Source', { schemaVersion: 1, ownerId: 'local-owner', sourceId, id: sourceId, connectionId, providerContainerId: 'primary@example.test', authority: 'external', capabilities: ['read', 'create', 'update', 'delete'] })
    await repo.put(tx, 'Grant', { schemaVersion: 1, ownerId: 'local-owner', sourceId, id: 'user:authenticated-user', principalKind: 'user', subjectId: 'authenticated-user', actions: ['read', 'create', 'update', 'delete'], readScope: 'full', epoch: 1 })
    await registerExternalSource(tx, { sourceId, title: '我的日历', accountKey: account.accountKey, authEpoch: account.authEpoch })
    const access = await tx.doc(ToolAccess)
    access.assignments.calendar = { tools: [...new Set([...(access.assignments.calendar?.tools ?? []), ...WORKSPACE_TOOLS])], resources: [...new Set([...(access.assignments.calendar?.resources ?? []), `workspace:${sourceId}`])] }
  })
}
const account = store => store.harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(GoogleAccount))), context)
const readable = (store, sourceId) => store.harness.commit(tx => workspaceSourceReadable(tx, 'calendar', sourceId), context)

test('R3-02 account mirror: connect → assignable + readable; disconnect removes Google resources from every Bot', async () => googleStore(async ({ store, connect }) => {
  assert.equal((await store.googleStatus()).connected, false)
  assert.deepEqual(await account(store), { status: 'disconnected', accountKey: null, authEpoch: 0, services: [], version: 0 })
  await connect()
  const live = await account(store)
  assert.deepEqual({ ...live, version: 0 }, { status: 'connected', accountKey: accountKeyOf('fake-sub-0001'), authEpoch: 0, services: ['calendar', 'tasks'], version: 0 })
  const sourceId = externalSourceId('google-calendar', live.accountKey, 'primary@example.test')
  await seedGoogleSource(store, sourceId, live)
  assert.equal(await readable(store, sourceId), true)
  const view = await store.getBotConfiguration('calendar')
  assert.ok(view.resources.includes(`workspace:${sourceId}`)); assert.deepEqual(view.resourceLabels[`workspace:${sourceId}`], { title: '我的日历', note: 'Google 日历' })
  const result = await store.googleDisconnect({})
  assert.deepEqual(result, { disconnected: true, revoked: true })
  const after = await account(store)
  assert.equal(after.status, 'disconnected'); assert.equal(after.authEpoch, 1)
  assert.equal(await readable(store, sourceId), false)
  const access = await store.harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(ToolAccess))), context)
  assert.ok(Object.values(access.assignments).every(a => !a.resources.some(r => r.startsWith('workspace:google-'))))
  assert.ok(!(await store.getBotConfiguration('calendar')).resources.includes(`workspace:${sourceId}`))
  // Reconnecting the same account does not revive records stamped with the old epoch.
  await connect()
  assert.equal((await account(store)).authEpoch, 1)
  await store.harness.commit(async tx => { const a = await tx.doc(ToolAccess); a.assignments.calendar.resources.push(`workspace:${sourceId}`) }, context)
  assert.equal(await readable(store, sourceId), false)
}))

test('R3-02 invalid_grant and lost scopes reach the durable mirror; restart reconciles from the file', async () => googleStore(async ({ store, google, fake, connect, restart }) => {
  await connect()
  const live = await account(store), calendarId = externalSourceId('google-calendar', live.accountKey, 'primary@example.test')
  await seedGoogleSource(store, calendarId, live)
  fake.revokeAll(); await google.rejectToken(await google.accessToken())
  // Force a refresh: the cached token is dropped and Google says invalid_grant.
  await assert.rejects(google.api('calendar', '/users/me/calendarList'), e => e.kind === 'needs_auth')
  for (let i = 0; i < 50 && (await account(store)).status !== 'needs_auth'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await account(store)).status, 'needs_auth'); assert.equal((await account(store)).authEpoch, 1)
  assert.equal(await readable(store, calendarId), false)
  assert.equal((await store.googleStatus()).status, 'needs_auth')
  // Reconnect with only Tasks granted: the Calendar service drops out without another epoch bump.
  fake.setGrant({ scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/tasks'] })
  await connect(['calendar', 'tasks'])
  const reconnected = await account(store)
  assert.deepEqual([reconnected.status, reconnected.services, reconnected.authEpoch], ['connected', ['tasks'], 1])
  await google.disconnect({})
  const reopened = await restart()
  assert.equal((await account(reopened)).status, 'disconnected', 'restart mirrors the credentials file')
}))

test('R3-02 Google routes are absent when the instance has no Google connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-none-'))
  const store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), workspaceScheduleOptions: { autoStart: false } })
  try {
    for (const call of [store.googleStatus(), store.googleConnect({ services: ['calendar'] }), store.googleDisconnect({})]) await assert.rejects(call, e => e.code === 'GOOGLE_UNAVAILABLE' && e.status === 503)
    assert.deepEqual(await account(store), { status: 'disconnected', accountKey: null, authEpoch: 0, services: [], version: 0 })
    assert.deepEqual(await store.harness.commit(tx => externalWorkspaceResources(tx), context), [])
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }) }
})

// D4 ("tool group on = external writes run directly"): an Agent's external create AND delete
// execute without a confirmation step; an ask rule (group set to 先问) still waits.
async function configure(s, tools, resources) {
  const { bot } = await s.getBotConfiguration('calendar')
  await s.updateBotConfiguration('calendar', { requestId: `r3-d4-${Math.random().toString(36).slice(2, 10)}`, expectedVersion: bot.configRef.version, description: 'D4 外部直接执行', tools, resources })
}
async function mcpClient(s, token) {
  const { MCP_VERSION } = await import('./workspace-mcp-protocol.mjs')
  let sessionId, id = 1
  const send = async message => { const data = await s.workspaceMcpMessage(token, sessionId, message); sessionId = data.sessionId; return data.message }
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_VERSION, clientInfo: { name: 'r3-d4', version: '1' }, capabilities: {} } })
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return async (name, args) => { const r = await send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }); return r.result.isError ? { error: JSON.parse(r.result.content[0].text).error } : r.result.structuredContent.data }
}
test('R3-01 D4: with the group on, Agent external create runs directly and delete waits for confirmation', async () => externalFixture(async ({ store: s, sourceId, writes }) => {
  await configure(s, WORKSPACE_TOOLS, [`workspace:${sourceId}`])
  const credential = await s.workspaceAgent.issueClient({ sourceId, botId: 'calendar', actions: ['read', 'create', 'delete'], readScope: 'full', ttlSeconds: 600, confirmed: true })
  const call = await mcpClient(s, credential.token)
  const created = await call('workspace.prepare_change', { sourceId, requestId: 'd4-create', action: 'create', change: { arguments: eventArgs } })
  assert.equal(created.state, 'succeeded'); assert.equal(created.external.autoApproved, true); assert.equal(writes.length, 1)
  const eventId = created.receipt.providerReceipt.eventId
  const detail = (await s.workspace.getExternal({ sourceId, eventId })).items[0]
  const removed = await call('workspace.prepare_change', { sourceId, requestId: 'd4-delete', action: 'delete', change: { arguments: { eventId, beforeHash: detail.remoteVersion }, expectedVersion: detail.version } })
  assert.equal(removed.state, 'awaiting_confirmation'); assert.equal(writes.length, 1)
  await s.workspace.confirmExternal({ requestId: removed.requestId, payloadHash: removed.payloadHash, confirmed: true })
  assert.equal((await s.workspace.executeExternal({ requestId: removed.requestId })).state, 'succeeded'); assert.equal(writes.length, 2)
  await askWorkspaceChange(s)
  const asked = await call('workspace.prepare_change', { sourceId, requestId: 'd4-ask', action: 'create', change: { arguments: { ...eventArgs, title: 'ask first' } } })
  assert.equal(asked.state, 'awaiting_confirmation'); assert.equal(writes.length, 2)
}))
