import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { openGoogleConnection } from './google-connection.mjs'
import { GoogleAccount } from './google-account.mjs'
import { createWorkspaceRepository } from './workspace-repository.mjs'
import { seedSourceGrant, workspaceSourceReadable } from './workspace-grants.mjs'
import { externalSourceId, registerExternalSource } from './workspace-providers.mjs'
import { decide, addRule, itemTypeOf } from './policy.mjs'
import { TOOL_GROUPS } from './tool-groups.mjs'
import { ToolAccess } from './tools.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { MCP_VERSION } from './workspace-mcp-protocol.mjs'
import { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT } from './fixtures/fake-google.mjs'
import { externalFixture, eventArgs } from './fixtures/workspace-external.mjs'

let seq = 0
const rid = name => `r3-07-${name}-${++seq}`
async function assign(s, botId, resources, tools = WORKSPACE_TOOLS) {
  const { bot } = await s.getBotConfiguration(botId)
  await s.updateBotConfiguration(botId, { requestId: rid('assign'), expectedVersion: bot.configRef.version, description: bot.description, tools, resources })
}
// A real MCP session over the stdio-client path: the same business service the Agent host uses.
async function client(s, botId, sourceId, actions = ['read', 'create', 'update', 'delete']) {
  const { token } = await s.workspaceAgent.issueClient({ sourceId, botId, actions, readScope: 'full', ttlSeconds: 600, confirmed: true })
  let sessionId, id = 1
  const send = async message => { const data = await s.workspaceMcpMessage(token, sessionId, message); sessionId = data.sessionId; return data.message }
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_VERSION, clientInfo: { name: 'r3-07', version: '1' }, capabilities: {} } })
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return async (name, args) => { const r = await send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }); if (!r.result) return { error: r.error }; return r.result.isError ? { error: JSON.parse(r.result.content[0].text).error } : r.result.structuredContent.data }
}
const resourcesOf = async s => Object.values((await s.harness.snapshot(ToolAccess, undefined, context)).assignments).flatMap(a => a.resources)
const window = { start: '2026-10-22T00:00:00+08:00', end: '2026-10-23T00:00:00+08:00', timezone: 'Asia/Shanghai' }

test('R3-07 D14 Feishu: bound = usable by an assigned Bot (read and write, no grant step); disconnect drops it from every Bot', async () => externalFixture(async ({ store: s, sourceId, writes }) => {
  const source = (await s.workspace.externalSources({})).sources[0]
  assert.deepEqual([source.authorized, source.readScope], [true, 'full'])
  await assign(s, 'calendar', [`workspace:${sourceId}`]); await assign(s, 'todo', [`workspace:${sourceId}`])
  const call = await client(s, 'calendar', sourceId)
  const created = await call('workspace.prepare_change', { sourceId, requestId: rid('create'), action: 'create', change: { arguments: eventArgs } })
  assert.equal(created.state, 'succeeded'); assert.equal(writes.length, 1)
  const listed = await call('workspace.list', { sourceId, type: 'Event', limit: 5, ...window })
  assert.equal(listed.items[0].title, eventArgs.title)
  await s.feishuCalendar.manage({ action: 'disconnect', confirm: true })
  assert.deepEqual((await s.workspace.externalSources({})).sources, [])
  assert.ok((await resourcesOf(s)).every(r => !r.startsWith('workspace:feishu:')), 'every Bot loses the Feishu source')
  assert.equal((await call('workspace.list', { sourceId, type: 'Event', limit: 5, ...window })).error.message, 'Tool not available', 'the open session loses the tool')
  // Rebind: schedule-enabled Bots regain the source without a separate assignment.
  await s.feishuCalendar.manage({ action: 'bind', calendarId: 'isolated-calendar', confirm: true })
  assert.equal((await s.workspace.externalSources({})).sources[0].authorized, true)
  assert.ok((await resourcesOf(s)).includes(`workspace:${sourceId}`))
  assert.equal((await call('workspace.prepare_change', { sourceId, requestId: rid('after-rebind'), action: 'create', change: { arguments: eventArgs } })).state, 'succeeded')
  assert.equal(writes.length, 2)
}))

test('R3-07 D14 Feishu upgrade: an undecided pre-D14 grant becomes usable on restart; a revoked one stays revoked', async () => {
  const legacy = async (s, sourceId) => { const repo = createWorkspaceRepository({ harness: s.harness, context }); await repo.transaction(async tx => { const g = await repo.get(tx, 'Grant', 'local-owner', sourceId, 'user:authenticated-user'); await repo.put(tx, 'Grant', { ...g, actions: [], readScope: 'none', epoch: g.epoch + 1 }) }) }
  await externalFixture(async f => {
    await legacy(f.store, f.sourceId)
    assert.equal((await f.store.workspace.externalSources({})).sources[0].authorized, false, 'the old empty seed')
    const s = await f.restart(), after = (await s.workspace.externalSources({})).sources[0]
    assert.deepEqual([after.authorized, after.readScope], [true, 'full'])
    const again = (await (await f.restart()).workspace.externalSources({})).sources[0]
    assert.equal(again.epoch, after.epoch, 'the upgrade runs once')
  })
  await externalFixture(async f => {
    const source = (await f.store.workspace.externalSources({})).sources[0]
    await f.store.workspace.grantExternal({ sourceId: f.sourceId, expectedEpoch: source.epoch, enabled: false, readScope: 'full', confirmed: true })
    const s = await f.restart()
    assert.equal((await s.workspace.externalSources({})).sources[0].authorized, false, 'an explicit revoke is kept')
  })
})

test('R3-07 D14 Google: a discovered source seeded through the hook is usable at once; disconnect drops it from every Bot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-07-google-')), fake = await createFakeGoogle(), guard = guardGoogleNetwork()
  const google = await openGoogleConnection({ dataDirectory: join(dir, 'google'), env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch })
  const s = await openTaskStore({ file: join(dir, 'isolated.sqlite'), google, workspaceScheduleOptions: { autoStart: false } })
  try {
    await s.googleSaveClient({ requestId: 'r3-07-client-0001', ...FAKE_GOOGLE_CLIENT })
    const started = await s.googleConnect({ services: ['calendar', 'tasks'] })
    await s.googlePaste({ redirectUrl: await fake.approve(started.attempt.authorizeUrl) })
    const account = await s.harness.snapshot(GoogleAccount, undefined, context)
    const writable = externalSourceId('google-calendar', account.accountKey, 'primary@example.test'), reader = externalSourceId('google-calendar', account.accountKey, 'holidays@example.test')
    // What R3-03 does on discovery: Connection + Source + index, and the D14 hook instead of a grant step.
    const repo = createWorkspaceRepository({ harness: s.harness, context })
    await repo.transaction(async tx => {
      for (const [sourceId, capabilities] of [[writable, ['read', 'create', 'update', 'delete']], [reader, ['read']]]) {
        const connectionId = `google:${account.accountKey.slice(0, 16)}`
        await repo.put(tx, 'Connection', { schemaVersion: 1, ownerId: 'local-owner', sourceId, id: connectionId, provider: 'google', accountKey: account.accountKey, credentialRef: 'google', authEpoch: account.authEpoch, status: 'active' })
        await repo.put(tx, 'Source', { schemaVersion: 1, ownerId: 'local-owner', sourceId, id: sourceId, connectionId, providerContainerId: sourceId, authority: 'external', capabilities })
        await seedSourceGrant(repo, tx, { sourceId, capabilities })
        await registerExternalSource(tx, { sourceId, title: '日历', accountKey: account.accountKey, authEpoch: account.authEpoch, readOnly: capabilities.length === 1 })
      }
    })
    await assign(s, 'calendar', [`workspace:${writable}`, `workspace:${reader}`]); await assign(s, 'todo', [`workspace:${writable}`])
    assert.equal(await s.harness.commit(tx => workspaceSourceReadable(tx, 'calendar', writable), context), true)
    // issueClient runs the live authority for every action: read and write pass with no grant step.
    await s.workspaceAgent.issueClient({ sourceId: writable, botId: 'calendar', actions: ['read', 'create', 'update', 'delete'], readScope: 'full', ttlSeconds: 600, confirmed: true })
    await s.workspaceAgent.issueClient({ sourceId: reader, botId: 'calendar', actions: ['read'], readScope: 'full', ttlSeconds: 600, confirmed: true })
    await assert.rejects(s.workspaceAgent.issueClient({ sourceId: reader, botId: 'calendar', actions: ['create'], readScope: 'full', ttlSeconds: 600, confirmed: true }), e => e.code === 'WORKSPACE_FORBIDDEN', 'a read-only calendar is seeded read-only')
    await s.googleDisconnect({})
    assert.equal(await s.harness.commit(tx => workspaceSourceReadable(tx, 'calendar', writable), context), false)
    assert.ok((await resourcesOf(s)).every(r => !r.startsWith('workspace:google-')), 'every Bot loses the Google sources')
    assert.deepEqual(guard.blocked, [])
  } finally { await s.close(); await google.close(); await fake.close(); await rm(dir, { recursive: true, force: true }) }
})

test('R3-07 stale text: capability configuration no longer claims every change needs confirmation (ADR-018)', () => {
  const capabilities = TOOL_GROUPS.find(g => g.id === 'capabilities').description
  assert.equal(capabilities, '在对话里添加、更新和停用 MCP 与 Skill。')
})

test('R3-07 source item types remain provider-defined after merging schedule and todo groups', async () => {
  assert.equal(itemTypeOf({ sourceId: 'feishu:abc', type: 'Todo' }), 'Event')
  assert.equal(itemTypeOf({ sourceId: 'google-calendar:abc', type: 'Todo' }), 'Event')
  assert.equal(itemTypeOf({ sourceId: 'google-tasks:abc', type: 'Event' }), 'Todo')
  const docs = new Map(), tx = { async doc(token) { const key = token.definition.kind; if (!docs.has(key)) docs.set(key, token.definition.initial()); return docs.get(key) } }
  await addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', type: 'Event' }, effect: 'ask' })
  assert.equal((await decide(tx, { botId: 'calendar', tool: 'workspace.prepare_change', action: 'create', sourceId: 'feishu:abc', type: 'Todo' })).effect, 'ask')
  assert.equal((await decide(tx, { botId: 'calendar', tool: 'workspace.prepare_change', action: 'create', sourceId: 'local', type: 'Todo' })).effect, 'allow')
})
