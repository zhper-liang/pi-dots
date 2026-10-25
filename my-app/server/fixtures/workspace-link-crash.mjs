// Isolated fault-injection fixture. Never imported by the production server.
import { openFoundation } from './workspace-foundation.mjs'
import { createActorAuthority } from '../workspace-policy.mjs'
import { createWorkspaceService } from '../workspace-service.mjs'

export const linkInput = {
  sourceId: 'local', type: 'ItemLink', action: 'create', requestId: 'cross-source-kill',
  data: { todoRef: { type: 'Todo', sourceId: 'local', id: 'same-id' }, eventRef: { type: 'Event', sourceId: 'external-fixture', id: 'same-id' }, expectedTodoVersion: 1, expectedEventVersion: 1, relation: 'related' },
}
export async function openLinkFixture(file, boundary) {
  const store = await openFoundation(file), authority = createActorAuthority(), actor = authority.user()
  const repo = { ...store.repo, async put(tx, type, row) {
    if (boundary === 'before-operation' && type === 'Operation' && row.requestId === linkInput.requestId) {
      process.send({ point: 'link-and-outbox-uncommitted' })
      await new Promise(() => {})
    }
    return store.repo.put(tx, type, row)
  } }
  const service = createWorkspaceService({ repository: repo, authority })
  // This fixture exercises SQLite atomicity, NOT provider live-binding behavior.
  // The latter remains covered by workspace-links.test.mjs with the real adapter.
  service.reminderExternalPermission = (tx, a, sourceId) => authority.authorize(repo, tx, a, sourceId, 'read')
  return { ...store, authority, actor, service }
}
export async function seedLinkFixture(s) {
  await s.service.manageLocalGrant(s.actor, { requestId: 'consent', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
  const base = { schemaVersion: 1, ownerId: s.actor.ownerId }
  await s.repo.transaction(async tx => {
    await s.repo.put(tx, 'Todo', { ...base, sourceId: 'local', id: 'same-id', title: 'isolated Todo', status: 'open', version: 1 })
    await s.repo.put(tx, 'Connection', { ...base, sourceId: 'external-fixture', id: 'connection', provider: 'fixture', accountKey: 'fixture', authEpoch: 1, status: 'active' })
    await s.repo.put(tx, 'Source', { ...base, sourceId: 'external-fixture', id: 'external-fixture', connectionId: 'connection', authority: 'external', capabilities: ['read'] })
    await s.repo.put(tx, 'Grant', { ...base, sourceId: 'external-fixture', id: 'user:authenticated-user', principalKind: 'user', subjectId: s.actor.subjectId, actions: ['read'], readScope: 'full', epoch: 1 })
    for (const sourceId of ['local', 'external-fixture']) await s.repo.put(tx, 'Event', { ...base, sourceId, id: 'same-id', title: sourceId, authority: sourceId === 'local' ? 'local' : 'external', start: '2026-10-22T01:00:00Z', end: '2026-10-22T02:00:00Z', timezone: 'UTC', version: 1 })
  })
  await s.service.executeLocal(s.actor, { ...linkInput, requestId: 'legacy-local', data: { todoId: 'same-id', eventId: 'same-id', relation: 'related' } })
}
