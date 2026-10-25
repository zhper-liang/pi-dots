import { defineDoc } from '@earendil-works/pi-durable'
import { WorkspaceRecords, identityKey, LOCAL_OWNER, ownerLocalGrant, OWNER_LOCAL_GRANT_ID, payloadHash } from './workspace-schema.mjs'
import { BotDirectory } from './bot-directory.mjs'
export const WorkspaceClients = defineDoc({ kind: 'pidot.workspace-clients', version: 1, scope: 'session', initial: () => ({ items: {} }) })
export const sourceResource = sourceId => `workspace:${sourceId}`
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
  if (sourceId !== 'local') {
    const { FeishuCalendar } = await import('./feishu-calendar.mjs')
    const binding = (await tx.doc(FeishuCalendar)).binding
    if (!binding || sourceId !== `feishu:${payloadHash([binding.connectionId, binding.calendarId])}`) return false
  }
  return true
}

// Common historical-data gate used by context, history, artifacts and collaboration.
// Reading stored text is an access decision, not permission to resurrect old Tasks.
export async function workspaceHistoryAllowed(tx, card, sets) {
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
  return !!assigned && workspaceUsedResources(author).every(r => assigned.resources.includes(r))
}
