import { defineDoc } from '@earendil-works/pi-durable'
import { payloadHash } from './workspace-schema.mjs'

// External workspace providers. The sourceId prefix decides the adapter; `service` names the Google
// grant a source needs. Feishu keeps its legacy single-binding check. Order is routing order.
export const WORKSPACE_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'feishu', prefix: 'feishu:', account: 'feishu', service: null, itemType: 'Event', label: '飞书日历' }),
  Object.freeze({ id: 'google-calendar', prefix: 'google-calendar:', account: 'google', service: 'calendar', itemType: 'Event', label: 'Google 日历' }),
  Object.freeze({ id: 'google-tasks', prefix: 'google-tasks:', account: 'google', service: 'tasks', itemType: 'Todo', label: 'Google 任务' }),
])
export const providerOfSource = sourceId => typeof sourceId === 'string' ? WORKSPACE_PROVIDERS.find(p => sourceId.startsWith(p.prefix)) ?? null : null
export const providerById = id => WORKSPACE_PROVIDERS.find(p => p.id === id) ?? null
export const providerLabel = sourceId => providerOfSource(sourceId)?.label ?? '外部来源'
export const sourceItemType = sourceId => providerOfSource(sourceId)?.itemType ?? 'Event'
/** Deterministic id an adapter must use: `<prefix><sha256(accountKey, containerId)>`. */
export const externalSourceId = (providerId, accountKey, containerId) => `${providerById(providerId).prefix}${payloadHash([accountKey, containerId])}`

// Display/assignment index for multi-source providers (not Feishu). No tokens, no provider payload.
// Adapters upsert on discovery; the Google account reconciler drops entries on revoke/epoch change.
export const ExternalSourceIndex = defineDoc({ kind: 'pidot.workspace.external-sources', version: 1, scope: 'session', initial: () => ({ items: {} }) })
const label = value => typeof value === 'string' ? [...value].map(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c).join('').trim().slice(0, 200) : ''
export async function registerExternalSource(tx, { sourceId, title, accountKey, authEpoch, readOnly = false }) {
  const provider = providerOfSource(sourceId)
  if (!provider || provider.id === 'feishu' || typeof accountKey !== 'string' || !Number.isSafeInteger(authEpoch) || typeof readOnly !== 'boolean') throw new Error('Invalid external source index entry')
  const index = await tx.doc(ExternalSourceIndex)
  if (!index.items[sourceId] && Object.keys(index.items).length >= 1000) throw new Error('External source index is full')
  index.items[sourceId] = { provider: provider.id, title: label(title), accountKey, authEpoch, readOnly }
  return { ...index.items[sourceId] }
}
export async function dropExternalSources(tx, predicate) {
  const index = await tx.doc(ExternalSourceIndex)
  for (const [sourceId, entry] of Object.entries(index.items)) if (predicate(sourceId, entry)) delete index.items[sourceId]
}

/** Removes every Bot assignment of `workspace:<prefix>…` (the Feishu disconnect rule, ADR-014 §1). */
export function removeResourcesByPrefix(access, prefixes) {
  const resources = prefixes.map(prefix => `workspace:${prefix}`)
  for (const assignment of Object.values(access.assignments ?? {})) assignment.resources = (assignment.resources ?? []).filter(value => !resources.some(prefix => value.startsWith(prefix)))
}

async function googleLive(tx, provider, entry) {
  const { GoogleAccount } = await import('./google-account.mjs')
  const account = await tx.doc(GoogleAccount)
  return account.status === 'connected' && account.services.includes(provider.service) && (!entry || entry.accountKey === account.accountKey && entry.authEpoch === account.authEpoch)
}
/**
 * Transactional liveness of an external source, for history/share/reminder gates. Feishu: the
 * bound calendar is this source. Google: the account is connected, the service is granted and the
 * source's Connection matches the current account and authEpoch. Unknown prefixes fail closed.
 */
export async function externalSourceLive(tx, sourceId, connection) {
  const provider = providerOfSource(sourceId)
  if (!provider) return false
  if (provider.id === 'feishu') {
    const { FeishuCalendar } = await import('./feishu-calendar.mjs')
    const binding = (await tx.doc(FeishuCalendar)).binding
    return !!binding && sourceId === `feishu:${payloadHash([binding.connectionId, binding.calendarId])}`
  }
  return googleLive(tx, provider, connection ? { accountKey: connection.accountKey, authEpoch: connection.authEpoch } : null)
}
/** Assignable `workspace:<sourceId>` resources of live non-Feishu sources, with display titles. */
export async function externalWorkspaceResources(tx) {
  const index = await tx.doc(ExternalSourceIndex), result = []
  for (const [sourceId, entry] of Object.entries(index.items)) {
    const provider = providerOfSource(sourceId)
    if (provider && provider.id === entry.provider && await googleLive(tx, provider, entry)) result.push({ resource: `workspace:${sourceId}`, sourceId, provider: provider.id, label: provider.label, title: entry.title, readOnly: entry.readOnly })
  }
  return result
}
