import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { externalFixture, eventArgs } from './fixtures/workspace-external.mjs'
import { openFoundation, assignWorkspaceBot } from './fixtures/workspace-foundation.mjs'
import { createWorkspaceService } from './workspace-service.mjs'
import { createActorAuthority } from './workspace-policy.mjs'
import { validateRecord } from './workspace-schema.mjs'
const options = { storeOptions: { workspaceScheduleOptions: { autoStart: false } } }
const query = { sourceId: 'local', type: 'ItemLink' }
async function seed(f) {
  const s = f.store
  await s.workspace.manageLocalGrant({ requestId: 'consent', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
  const todo = (await s.workspace.executeLocal({ sourceId: 'local', type: 'Todo', action: 'create', requestId: 'todo', data: { title: 'local task' } })).receipt.target
  const op = await s.workspace.prepareExternal({ sourceId: f.sourceId, requestId: 'event', action: 'create', arguments: eventArgs })
  await s.workspace.confirmExternal({ requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true })
  await s.workspace.executeExternal({ requestId: op.requestId })
  const event = (await s.workspace.queryExternal({ sourceId: f.sourceId, start: '2026-10-22T00:00:00Z', end: '2026-10-23T00:00:00Z', timezone: 'UTC' })).items[0]
  return { ...query, action: 'create', requestId: 'link', data: { todoRef: { ...todo, type: 'Todo' }, eventRef: { type: 'Event', sourceId: f.sourceId, id: event.id }, expectedTodoVersion: 1, expectedEventVersion: event.version, relation: 'related' } }
}
async function grant(f, enabled, readScope = 'full') {
  const source = (await f.store.workspace.externalSources({})).sources[0]
  return f.store.workspace.grantExternal({ sourceId: f.sourceId, enabled, readScope, expectedEpoch: source.epoch, confirmed: true })
}

test('09 cross-source link concurrent requests persist one relation, preserve original receipt/version and never write provider', () => externalFixture(async f => {
  const input = await seed(f), before = f.writes.length
  const ops = await Promise.all([f.store.workspace.executeLocal(input), f.store.workspace.executeLocal(input)])
  assert.deepEqual(ops[0], ops[1]); assert.equal((await f.store.workspace.query(query)).items.length, 1)
  assert.equal(ops[0].receipt.eventRef.sourceId, f.sourceId); assert.equal(ops[0].receipt.eventVersion, 1)
  await assert.rejects(f.store.workspace.executeLocal({ ...input, data: { ...input.data, expectedEventVersion: 2 } }), { code: 'WORKSPACE_REQUEST_CONFLICT' })
  await f.restart()
  assert.deepEqual(await f.store.workspace.executeLocal(input), ops[0])
  assert.equal(f.writes.length, before); assert.equal(f.modelCalls(), 0)
}, options))

test('09 busy-only and revoked external permission hide relations and deny creation, replay and receipt; regrant preserves history', () => externalFixture(async f => {
  const input = await seed(f), original = await f.store.workspace.executeLocal(input)
  for (const [enabled, scope] of [[true, 'busy'], [false, 'full']]) {
    await grant(f, enabled, scope)
    assert.deepEqual((await f.store.workspace.query(query)).items, [])
    for (const requestId of ['link', 'new-link']) await assert.rejects(f.store.workspace.executeLocal({ ...input, requestId }), { code: 'WORKSPACE_FORBIDDEN' })
    await assert.rejects(f.store.workspace.getLocalOperation({ sourceId: 'local', requestId: 'link' }), { code: 'WORKSPACE_FORBIDDEN' })
  }
  await grant(f, true)
  assert.deepEqual(await f.store.workspace.getLocalOperation({ sourceId: 'local', requestId: 'link' }), original)
  assert.equal((await f.store.workspace.query(query)).items.length, 1)
  // ADR-011: owner local access cannot be revoked; external revocation above still hides relations.
  await assert.rejects(f.store.workspace.manageLocalGrant({ requestId: 'revoke-local', sourceId: 'local', enabled: false, expectedEpoch: 1, confirmed: true }), { code: 'WORKSPACE_OWNER_IMPLICIT' })
  assert.equal((await f.store.workspace.query(query)).items.length, 1)
}, options))

test('09 external live binding rotation hides cached link and denies historical receipts across restart', () => externalFixture(async f => {
  const input = await seed(f); await f.store.workspace.executeLocal(input)
  f.env.FEISHU_APP_SECRET = 'changed-identity-test-only'
  assert.deepEqual((await f.store.workspace.query(query)).items, [])
  await assert.rejects(f.store.workspace.executeLocal(input), { code: 'WORKSPACE_EXTERNAL_REVOKED' })
  await assert.rejects(f.store.workspace.getLocalOperation({ sourceId: 'local', requestId: 'link' }), { code: 'WORKSPACE_EXTERNAL_REVOKED' })
  await f.restart(); assert.deepEqual((await f.store.workspace.query(query)).items, [])
}, options))

test('09 precise versions, malformed references and tombstones cannot create ambiguous cross-source links', () => externalFixture(async f => {
  const input = await seed(f)
  for (const field of ['expectedTodoVersion', 'expectedEventVersion']) await assert.rejects(f.store.workspace.executeLocal({ ...input, data: { ...input.data, [field]: 99 } }), { code: 'WORKSPACE_VERSION_CONFLICT' })
  for (const data of [{ ...input.data, expectedTodoVersion: undefined }, { ...input.data, todoId: 'mixed' }, { ...input.data, todoRef: { ...input.data.todoRef, sourceId: f.sourceId } }, { ...input.data, eventRef: { ...input.data.eventRef, ownerId: 'forged' } }]) await assert.rejects(f.store.workspace.executeLocal({ ...input, data }), e => e.status === 400)
  const original = await f.store.workspace.executeLocal(input)
  const remote = [...f.events.values()][0]; remote.status = 'cancelled'
  await f.store.workspace.getExternal({ sourceId: f.sourceId, eventId: remote.event_id })
  assert.equal((await f.store.workspace.query(query)).items[0].eventState, 'deleted')
  assert.deepEqual(await f.store.workspace.executeLocal(input), original)
  await assert.rejects(f.store.workspace.executeLocal({ ...input, requestId: 'after-delete' }), { code: 'WORKSPACE_LINK_TARGET' })
}, options))

test('09 duplicate IDs across sources and legacy same-source links remain distinct without rewriting history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-link-identity-')), store = await openFoundation(join(dir, 'isolated.sqlite'))
  const authority = createActorAuthority(), actor = authority.user(), service = createWorkspaceService({ repository: store.repo, authority })
  try {
    await service.manageLocalGrant(actor, { requestId: 'consent', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
    const base = { schemaVersion: 1, ownerId: actor.ownerId }
    await store.repo.transaction(async tx => {
      await store.repo.put(tx, 'Todo', { ...base, sourceId: 'local', id: 'same', title: 'Todo', status: 'open', version: 1 })
      for (const sourceId of ['local', 'other']) {
        if (sourceId !== 'local') {
          await store.repo.put(tx, 'Connection', { ...base, sourceId, id: 'connection', provider: 'fixture', accountKey: 'fixture', authEpoch: 1, status: 'active' })
          await store.repo.put(tx, 'Source', { ...base, sourceId, id: sourceId, connectionId: 'connection', authority: 'external', capabilities: ['read'] })
          await store.repo.put(tx, 'Grant', { ...base, sourceId, id: 'user:authenticated-user', principalKind: 'user', subjectId: actor.subjectId, actions: ['read'], readScope: 'full', epoch: 1 })
        }
        await store.repo.put(tx, 'Event', { ...base, sourceId, id: 'same', title: sourceId, authority: sourceId === 'local' ? 'local' : 'external', start: '2026-10-22T01:00:00Z', end: '2026-10-22T02:00:00Z', timezone: 'UTC', version: 1 })
      }
    })
    // Explicit internal fixture seam; real provider live-binding checks are tested above.
    service.reminderExternalPermission = (tx, a, sourceId) => authority.authorize(store.repo, tx, a, sourceId, 'read')
    const legacy = { ...query, action: 'create', requestId: 'legacy', data: { todoId: 'same', eventId: 'same', relation: 'related' } }
    await service.executeLocal(actor, legacy)
    const before = (await store.repo.transaction(tx => store.repo.list(tx, 'ItemLink', actor.ownerId, 'local'))).items[0]
    const explicit = { ...legacy, requestId: 'explicit', data: { todoRef: { type: 'Todo', sourceId: 'local', id: 'same' }, eventRef: { type: 'Event', sourceId: 'other', id: 'same' }, expectedTodoVersion: 1, expectedEventVersion: 1, relation: 'related' } }
    const faultyRepo = { ...store.repo, put(tx, type, row) { if (type === 'Operation' && row.normalizedArgs.type === 'ItemLink') throw Error('link transaction interrupted'); return store.repo.put(tx, type, row) } }
    const faulty = createWorkspaceService({ repository: faultyRepo, authority })
    faulty.reminderExternalPermission = service.reminderExternalPermission
    await assert.rejects(faulty.executeLocal(actor, explicit), /link transaction interrupted/)
    assert.equal((await store.repo.transaction(tx => store.repo.list(tx, 'ItemLink', actor.ownerId, 'local'))).items.length, 1)
    await service.executeLocal(actor, explicit)
    await service.executeLocal(actor, { ...explicit, requestId: 'explicit-local', data: { ...explicit.data, eventRef: { ...explicit.data.eventRef, sourceId: 'local' } } })
    const rows = (await store.repo.transaction(tx => store.repo.list(tx, 'ItemLink', actor.ownerId, 'local'))).items
    assert.equal(rows.length, 2); assert.deepEqual(rows.find(r => r.id === before.id), before)
    assert.notEqual(rows[0].id, rows[1].id)
    await assignWorkspaceBot(store, 'test-bot')
    const agentAuthority = createActorAuthority({ resolveAgent: async () => ({ botId: 'test-bot', scope: { tools: ['workspace.list', 'workspace.get'], sources: ['local'], actions: ['read'], readScope: 'full' } }) })
    const agent = await agentAuthority.agent('fixture-task'), agentService = createWorkspaceService({ repository: store.repo, authority: agentAuthority })
    agentService.reminderExternalPermission = (tx, a, sourceId) => agentAuthority.authorize(store.repo, tx, a, sourceId, 'read')
    const visible = await agentService.query(agent, query)
    assert.equal(visible.items.length, 1); assert.equal(visible.items[0].eventRef.sourceId, 'local')
    await assert.rejects(agentService.query({ ...agent }, query), { code: 'WORKSPACE_ACTOR' })
    await assert.rejects(agentService.executeLocal(agent, explicit), { code: 'WORKSPACE_CONFIRMATION_REQUIRED' })
    assert.throws(() => validateRecord('ItemLink', { ...rows[1], eventRef: { ...rows[1].eventRef, id: 'mismatch' } }), { code: 'WORKSPACE_SCHEMA' })
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }) }
})
