import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openFoundation } from './fixtures/workspace-foundation.mjs'
import { externalFixture, eventArgs, askWorkspaceChange } from './fixtures/workspace-external.mjs'
import { createActorAuthority } from './workspace-policy.mjs'
import { createWorkspaceService } from './workspace-service.mjs'
import { createWorkspaceScheduler } from './workspace-schedule.mjs'
import { MCP_VERSION } from './workspace-mcp-protocol.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'

const base = { schemaVersion: 1, ownerId: 'local-owner', sourceId: 'local' }
const now = Date.parse('2026-10-19T12:00:00Z')
const consent = s => s.workspace.manageLocalGrant({ requestId: 'joint-local', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
async function mcp(s, token) {
  let session, id = 0
  const send = async (method, params, notification = false) => {
    const response = await s.workspaceMcpMessage(token, session, { jsonrpc: '2.0', ...(!notification ? { id: ++id } : {}), method, ...(params ? { params } : {}) })
    session = response.sessionId; return response.message
  }
  assert.equal((await send('initialize', { protocolVersion: MCP_VERSION, clientInfo: { name: '09-joint-client', version: '1' }, capabilities: {} })).result.protocolVersion, MCP_VERSION)
  await send('notifications/initialized', undefined, true)
  assert.ok((await send('tools/list')).result.tools.length)
  return async (name, args) => {
    const response = await send('tools/call', { name, arguments: args })
    assert.equal(response.error, undefined)
    assert.equal(response.result.isError, false)
    return response.result.structuredContent.data
  }
}

test('09 1000 Todos and 1000 interleaved occurrence histories paginate without gaps after reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-09-growth-')), file = join(dir, 'isolated.sqlite')
  let store, scheduler
  const authority = createActorAuthority(), actor = authority.user()
  const start = performance.now()
  try {
    store = await openFoundation(file)
    let service = createWorkspaceService({ repository: store.repo, authority })
    await service.manageLocalGrant(actor, { requestId: 'growth-consent', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
    scheduler = createWorkspaceScheduler({ repository: store.repo, authority, commitLocal: (...args) => service.commitLocal(...args), now: () => now })
    const plan = (await scheduler.manage(actor, { requestId: 'growth-plan', command: 'create', title: '09 growth', actionSpec: { kind: 'internal_deterministic_record' }, timezone: 'UTC', rule: { type: 'at', at: new Date(now + 60000).toISOString() }, confirmed: true })).receipt.schedule
    // Seed via the existing repository only; this is scale evidence, not 1000 UI actions.
    for (let offset = 0; offset < 1000; offset += 50) await store.repo.transaction(async tx => {
      for (let n = offset; n < offset + 50; n++) {
        await store.repo.put(tx, 'Todo', { ...base, id: `todo-${n}`, title: `growth-${n}`, version: 1, status: 'open' })
        await store.repo.put(tx, 'Occurrence', { ...base, id: `run-${n}`, scheduleId: n % 2 ? 'other-plan' : plan.id, revision: 1, scheduledFor: new Date(now - (n + 1) * 60000).toISOString(), attempts: 1, state: 'succeeded' })
      }
    })
    await scheduler.close(); await store.close(); store = await openFoundation(file)
    service = createWorkspaceService({ repository: store.repo, authority })
    scheduler = createWorkspaceScheduler({ repository: store.repo, authority, commitLocal: (...args) => service.commitLocal(...args), now: () => now })
    let cursor, pages = 0; const todos = [], runs = []
    do { const page = await service.query(actor, { type: 'Todo', sourceId: 'local', limit: 37, ...(cursor !== undefined ? { cursor } : {}) }); todos.push(...page.items); cursor = page.next; assert.equal(page.complete, cursor === undefined); assert(++pages <= 28) } while (cursor !== undefined)
    assert.equal(todos.length, 1000); assert.equal(new Set(todos.map(x => x.id)).size, 1000)
    cursor = undefined; pages = 0
    do { const page = await scheduler.list(actor, { scheduleId: plan.id, limit: 37, ...(cursor !== undefined ? { cursor } : {}) }); runs.push(...page.items); cursor = page.next; assert(++pages <= 28) } while (cursor !== undefined)
    assert.equal(runs.length, 500); assert.equal(new Set(runs.map(x => x.id)).size, 500); assert(runs.every(x => x.scheduleId === plan.id))
    await scheduler.tick(); const after = await scheduler.list(actor, { scheduleId: plan.id, cursor: 999, limit: 1 }); assert.equal(after.next, undefined)
    t.diagnostic(JSON.stringify({ fixture: true, todos: todos.length, totalOccurrences: 1000, selectedOccurrences: runs.length, historyPages: pages, durationMs: Math.round(performance.now() - start), modelCalls: 0, externalWrites: 0 }))
  } finally { await scheduler?.close(); await store?.close(); await rm(dir, { recursive: true, force: true }) }
})

test('09 MCP proposal shares external receipt; explicit cross-source relationship survives restart and Todo deletion', () => externalFixture(async f => {
  await askWorkspaceChange(f.store)
  const s = f.store; await consent(s)
  const todo = (await s.workspace.executeLocal({ requestId: 'joint-todo', sourceId: 'local', type: 'Todo', action: 'create', data: { title: '09 explicit relationship' } })).receipt.target
  const { bot } = await s.getBotConfiguration('calendar')
  await s.updateBotConfiguration('calendar', { requestId: 'joint-workspace-assignment', expectedVersion: bot.configRef.version, description: bot.description, tools: WORKSPACE_TOOLS, resources: [`workspace:${f.sourceId}`] })
  const credential = await s.workspaceAgent.issueClient({ sourceId: f.sourceId, botId: 'calendar', actions: ['read', 'create'], readScope: 'full', ttlSeconds: 600, confirmed: true })
  const call = await mcp(s, credential.token)
  const proposal = await call('workspace.prepare_change', { sourceId: f.sourceId, requestId: 'joint-external', action: 'create', change: { arguments: eventArgs } })
  assert.equal(proposal.state, 'awaiting_confirmation'); assert.equal(f.writes.length, 0)
  await s.workspace.confirmExternal({ requestId: proposal.requestId, payloadHash: proposal.payloadHash, confirmed: true })
  const done = await s.workspace.executeExternal({ requestId: proposal.requestId }); assert.equal(done.state, 'succeeded')
  assert.deepEqual(await call('workspace.operation_status', { sourceId: f.sourceId, requestId: proposal.requestId }), done)
  const external = (await s.workspace.queryExternal({ sourceId: f.sourceId, start: '2026-10-22T00:00:00Z', end: '2026-10-23T00:00:00Z', timezone: 'UTC' })).items[0]
  assert.ok(external.id)
  // Ambiguous legacy identifiers and unrecognized fields remain rejected.
  await assert.rejects(s.workspace.executeLocal({ requestId: 'cross-source-missing', sourceId: 'local', type: 'ItemLink', action: 'create', data: { todoId: todo.id, eventId: external.id, relation: 'related' } }), { code: 'WORKSPACE_LINK_TARGET' })
  await assert.rejects(s.workspace.executeLocal({ requestId: 'cross-source-forged', sourceId: 'local', type: 'ItemLink', action: 'create', data: { todoId: todo.id, eventId: external.id, eventSourceId: f.sourceId, relation: 'related' } }), { code: 'WORKSPACE_INPUT' })
  const link = { requestId: 'explicit-cross-source', sourceId: 'local', type: 'ItemLink', action: 'create', data: { todoRef: { type: 'Todo', ...todo }, eventRef: { type: 'Event', sourceId: f.sourceId, id: external.id }, expectedTodoVersion: 1, expectedEventVersion: external.version, relation: 'related' } }
  const receipt = await s.workspace.executeLocal(link)
  assert.equal(receipt.receipt.eventRef.sourceId, f.sourceId)
  assert.deepEqual(await s.workspace.executeLocal(link), receipt)
  await f.restart()
  assert.deepEqual(await f.store.workspace.getLocalOperation({ sourceId: 'local', requestId: link.requestId }), receipt)
  assert.equal((await f.store.workspace.query({ sourceId: 'local', type: 'ItemLink' })).items[0].eventRef.id, external.id)
  await f.store.workspace.executeLocal({ requestId: 'delete-todo-only', sourceId: 'local', type: 'Todo', action: 'delete', id: todo.id, expectedVersion: 1, confirmedDelete: true })
  assert.equal(f.writes.length, 1); assert.equal(f.events.get(external.remoteId).status, 'confirmed'); assert.equal(f.modelCalls(), 0)
}, { storeOptions: { workspaceScheduleOptions: { autoStart: false } } }))

test('09 provider fixture change -> background sync -> reminder replan -> closed-page inbox -> reopen/revoke', async () => {
  let time = now
  const clock = () => time
  const providerEvent = start => ({ event_id: 'joint-sync-event', summary: 'joint-provider-secret', description: 'not busy-only', start_time: { timestamp: String(start / 1000), timezone: 'UTC' }, end_time: { timestamp: String(start / 1000 + 1800), timezone: 'UTC' }, status: 'confirmed', organizer_calendar_id: 'isolated-calendar' })
  await externalFixture(async f => {
    await consent(f.store)
    f.events.set('joint-sync-event', providerEvent(now + 60000))
    const target = (await f.store.workspace.getExternal({ sourceId: f.sourceId, eventId: 'joint-sync-event' })).items[0]
    const reminder = (await f.store.workspaceReminders.manage({ requestId: 'joint-reminder', command: 'create', targetRef: { sourceId: f.sourceId, type: 'Event', id: target.id }, targetVersion: target.version, offset: 0, channel: 'inbox', confirmed: true })).receipt.reminder
    await f.store.workspace.configureSync({ sourceId: f.sourceId, enabled: true, expectedRevision: 0, confirmed: true, pastDays: 1, futureDays: 1, refreshSeconds: 60, timezone: 'UTC' })
    await f.store.workspaceScheduler.tick()
    f.events.set('joint-sync-event', providerEvent(now + 180000)); time = now + 60001
    await f.store.workspaceScheduler.tick()
    let inbox = await f.store.workspaceReminders.list({})
    assert.equal(inbox.items.length, 0)
    assert.equal(inbox.reminders.find(r => r.id === reminder.id).targetVersion, target.version + 1)
    assert.equal(inbox.reminders[0].schedule.nextDueAt, new Date(now + 180000).toISOString())
    // No HTTP server/browser is opened: generation is wholly backend driven.
    await f.restart(); time = now + 180001; await f.store.workspaceScheduler.tick()
    inbox = await f.store.workspaceReminders.list({}); assert.equal(inbox.items.length, 1)
    const notice = inbox.items[0]; assert.equal(notice.title, 'joint-provider-secret'); assert.equal(notice.targetRef.version, target.version + 1)
    await f.restart(); await f.store.workspaceScheduler.tick()
    assert.equal((await f.store.workspaceReminders.list({})).items[0].id, notice.id)
    await f.store.workspaceReminders.read({ id: notice.id })
    assert.equal((await f.store.workspaceReminders.list({})).items[0].status, 'read')
    const source = (await f.store.workspace.externalSources({})).sources[0]
    await f.store.workspace.grantExternal({ sourceId: f.sourceId, expectedEpoch: source.epoch, enabled: false, readScope: 'full', confirmed: true })
    const redacted = await f.store.workspaceReminders.list({}); assert.equal(redacted.items[0].redacted, true); assert(!JSON.stringify(redacted).includes('joint-provider-secret'))
    assert.equal(f.modelCalls(), 0); assert.equal(f.writes.length, 0)
  }, { storeOptions: { workspaceScheduleOptions: { autoStart: false, now: clock }, workspaceReminderOptions: { now: clock }, workspaceSyncOptions: { now: clock } } })
})
