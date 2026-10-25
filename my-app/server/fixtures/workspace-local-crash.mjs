// Explicit process fault injection; never loaded by production.
import { openFoundation } from './workspace-foundation.mjs'
import { createActorAuthority } from '../workspace-policy.mjs'
import { createWorkspaceService } from '../workspace-service.mjs'
const [file, mode] = process.argv.slice(2)
if (!file?.startsWith('/tmp/pidot-v2-02-')) throw new Error('Dedicated temporary DB required')
const s = await openFoundation(file), authority = createActorAuthority(), actor = authority.user()
setInterval(() => {}, 1000)
const repository = { ...s.repo, async put(tx, type, record) {
  if (mode === 'before-operation' && type === 'Operation' && record.action === 'create') {
    console.log(JSON.stringify({ point: 'object-outbox-uncommitted' })); await new Promise(() => {})
  }
  return s.repo.put(tx, type, record)
} }
const service = createWorkspaceService({ repository, authority })
await service.manageLocalGrant(actor, { sourceId: 'local', requestId: 'grant-crash', enabled: true, expectedEpoch: 0, confirmed: true })
const input = { sourceId: 'local', type: 'Todo', action: 'create', requestId: 'crash-create', data: { title: 'crash durable' } }
const op = await service.executeLocal(actor, input)
console.log(JSON.stringify({ point: 'committed-before-response', id: op.receipt.target.id }))
