import { defineDoc } from '@earendil-works/pi-durable'
import { WorkspaceRecords, identityKey, LOCAL_OWNER, ownerLocalGrant, OWNER_LOCAL_GRANT_ID } from './workspace-schema.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { externalSourceLive } from './workspace-providers.mjs'
export const WorkspaceClients = defineDoc({ kind: 'pidot.workspace-clients', version: 1, scope: 'session', initial: () => ({ items: {} }) })
export const sourceResource = sourceId => `workspace:${sourceId}`
export const USER_GRANT_ID = 'user:authenticated-user'

/**
 * D14: a connected external source is usable at once; there is no per-source grant step. Call in the
 * same transaction that (re)stamps the source's Connection with a new authEpoch (first connection,
 * reconnect or rebind): the user grant becomes the source's full capabilities with a new epoch, so
 * pending intents from the old connection go stale. Bots still need the `workspace:<sourceId>`
 * resource on their capability page. A later explicit narrowing (grantExternal) holds until the next
 * reconnect. `repo` is the workspace repository; `capabilities` are the Source's.
 */
export async function seedSourceGrant(repo, tx, { sourceId, capabilities }) {
  const old = await repo.get(tx, 'Grant', LOCAL_OWNER, sourceId, USER_GRANT_ID)
  const readable = capabilities.includes('read')
  return repo.put(tx, 'Grant', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: USER_GRANT_ID, principalKind: 'user', subjectId: 'authenticated-user',
    actions: readable ? [...capabilities] : [], readScope: readable ? 'full' : 'none', epoch: (old?.epoch ?? 0) + 1 })
}
/** A user grant that was seeded empty by the pre-D14 sync and never decided by the user. */
export const undecidedGrant = grant => !!grant && grant.actions.length === 0 && grant.readScope === 'none'
export async function rawWorkspaceRecord(tx, type, sourceId, id) {
  const record = (await tx.doc(WorkspaceRecords[type], identityKey(LOCAL_OWNER, sourceId, id), null)).record
  // Owner implicit local access (ADR-011); only the local source and only the owner principal.
  if (type === 'Grant' && sourceId === 'local' && id === OWNER_LOCAL_GRANT_ID) return ownerLocalGrant(record)
  return record
}
export function workspaceUsedResources(card) {
  const resources = card.workspaceUsedResources ?? (card.workspaceSnapshot ? Object.keys(card.workspaceSnapshot).map(sourceResource) : card.parameters?.toolResources ?? [])
  return resources.filter(r => r.startsWith('workspace:'))
}
export function workspaceUsedTools(card) {
  return card.workspaceUsedTools ?? (card.parameters?.tools ?? []).filter(name => name.startsWith('workspace.'))
}
export async function workspaceSourceReadable(tx, botId, sourceId) {
  const bot = (await tx.doc(BotDirectory)).items.find(b => b.id === botId)
  const { ToolAccess } = await import('./tools.mjs')
  const access = await tx.doc(ToolAccess), assigned = access.assignments?.[botId]
  if (!bot || (bot.status ?? 'active') !== 'active' || !assigned?.resources.includes(sourceResource(sourceId)) || ['workspace.list', 'workspace.get'].some(name => !assigned.tools.includes(name) || access.revoked?.[botId]?.includes(name))) return false
  const source = await rawWorkspaceRecord(tx, 'Source', sourceId, sourceId), user = await rawWorkspaceRecord(tx, 'Grant', sourceId, 'user:authenticated-user'), connection = source && await rawWorkspaceRecord(tx, 'Connection', sourceId, source.connectionId)
  if (!source?.capabilities.includes('read') || !user?.actions.includes('read') || !['busy', 'full'].includes(user.readScope) || connection?.status !== 'active') return false
  // Feishu: the bound calendar is this source. Google: account connected, service granted and the
  // Connection stamped with the current accountKey/authEpoch. Unknown providers fail closed.
  if (sourceId !== 'local' && !await externalSourceLive(tx, sourceId, connection)) return false
  return true
}

// Common historical-data gate used by context, history, artifacts and collaboration.
// Reading stored text is an access decision, not permission to resurrect old Tasks.
export function externalMcpHistoryAllowed(card, sets) {
  return (card.externalMcpUsedRefs ?? []).every(ref => sets.authorized.includes(ref.toolName) &&
    sets.externalTools?.some(tool => tool.name === ref.toolName && tool.connectionId === ref.connectionId && tool.catalogRevision === ref.catalogRevision && tool.enabledBotIds.includes(card.bot.id)))
}

export async function workspaceHistoryAllowed(tx, card, sets) {
  if (!externalMcpHistoryAllowed(card, sets)) return false
  const names = workspaceUsedTools(card)
  const resources = workspaceUsedResources(card)
  if (!names.length && !resources.length) return true
  if (!names.length || !resources.length || names.some(n => !sets.authorized.includes(n))) return false
  for (const r of resources) {
    const id = r.slice(10)
    if (!sets.resources.includes(r) || !await workspaceSourceReadable(tx, card.bot.id, id)) return false
    if ((card.workspaceUsedReadScopes?.[id] ?? 'full') === 'full' && (await rawWorkspaceRecord(tx, 'Grant', id, 'user:authenticated-user')).readScope !== 'full') return false
  }
  return true
}
export function workspaceShareAllowed(author, reader, access) {
  const assigned = access?.assignments?.[reader?.bot?.id]
  return !!assigned && workspaceUsedResources(author).every(r => assigned.resources.includes(r)) &&
    (author.externalMcpUsedRefs ?? []).every(ref => assigned.tools.includes(ref.toolName) && !access.revoked?.[reader.bot.id]?.includes(ref.toolName) &&
      access.externalMcp?.tools?.some(tool => tool.name === ref.toolName && tool.connectionId === ref.connectionId && tool.catalogRevision === ref.catalogRevision && tool.enabledBotIds.includes(reader.bot.id)))
}
