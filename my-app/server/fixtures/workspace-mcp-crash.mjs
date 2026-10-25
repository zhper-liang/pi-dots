// Isolated OS crash harness; never imported by production.
import { openFoundation, assignWorkspaceBot } from './workspace-foundation.mjs'
import { createActorAuthority } from '../workspace-policy.mjs'
import { createWorkspaceService } from '../workspace-service.mjs'
import { createWorkspaceMcpBusiness } from '../workspace-mcp-business.mjs'
import { addRule } from '../policy.mjs'
const [file, mode] = process.argv.slice(2)
if (!file?.startsWith('/tmp/pidot-v2-04-')) throw Error('Dedicated temporary DB required')
const s = await openFoundation(file)
setInterval(() => {}, 1000) // Keep idle committed fault point alive until parent SIGKILL.
const repository = { ...s.repo, async put(tx, type, record) {
  if (mode === 'uncommitted' && type === 'Operation' && record.requestId === 'crash-proposal' && record.state === 'succeeded') { console.log('READY-uncommitted'); await new Promise(() => {}) }
  return s.repo.put(tx, type, record)
} }
let business
const authority = createActorAuthority({ resolveClient: (...args) => business.resolveClient(...args) }), actor = authority.user(), service = createWorkspaceService({ repository, authority })
business = createWorkspaceMcpBusiness({ repository, authority, service, resolveTask: async () => null, listBots: async () => [{ id: 'calendar' }] })
await service.manageLocalGrant(actor, { requestId: 'crash-local-consent', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
await assignWorkspaceBot(s)
await s.repo.transaction(tx => addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change' }, effect: 'ask' }))
const credential = await business.issueClient(actor, { botId: 'calendar', sourceId: 'local', actions: ['read', 'create'], readScope: 'full', ttlSeconds: 600, confirmed: true })
const clientActor = await business.authenticateClient(credential.token)
const op = await business.call(clientActor, 'workspace.prepare_change', { sourceId: 'local', requestId: 'crash-proposal', action: 'create', change: { type: 'Todo', data: { title: 'crash-create-once' } } })
if (mode === 'prepared') { console.log('READY-prepared'); await new Promise(() => {}) }
await business.confirmLocal(actor, { sourceId: 'local', requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true })
console.log('READY-committed'); await new Promise(() => {})
