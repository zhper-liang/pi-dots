import { defineDoc } from '@earendil-works/pi-durable'
import { WORKSPACE_PROVIDERS, removeResourcesByPrefix, dropExternalSources } from './workspace-providers.mjs'

// Durable mirror of the single Google account for in-transaction liveness checks. The credentials
// file is the source of truth; this doc never holds tokens, email or scopes text.
// authEpoch increments whenever the account stops being connected or changes identity, so any
// Connection/Grant an adapter stamped with an older (accountKey, authEpoch) is dead.
export const GoogleAccount = defineDoc({ kind: 'pidot.google-account', version: 1, scope: 'session',
  initial: () => ({ status: 'disconnected', accountKey: null, authEpoch: 0, services: [], version: 0 }) })
const STATUSES = ['connected', 'needs_auth', 'disconnected']
const googleProviders = WORKSPACE_PROVIDERS.filter(p => p.account === 'google')
const copy = value => JSON.parse(JSON.stringify(value))

export async function readGoogleAccount(tx) { return copy(await tx.doc(GoogleAccount)) }

/**
 * Reconcile the doc with a connection view `{ status, accountKey, services }` inside the caller's
 * commit. Removes Google workspace resources from every Bot and drops index entries when the
 * account leaves "connected" or changes, and for each service that is no longer granted.
 */
export async function applyGoogleAccount(tx, view, { ToolAccess }) {
  if (!view || !STATUSES.includes(view.status) || !Array.isArray(view.services)) throw new Error('Invalid Google account view')
  const doc = await tx.doc(GoogleAccount)
  const accountKey = view.accountKey ?? null, services = view.status === 'connected' ? [...new Set(view.services)].sort() : []
  const leaving = doc.status === 'connected' && view.status !== 'connected'
  const switched = accountKey !== null && doc.accountKey !== null && accountKey !== doc.accountKey
  const bump = leaving || switched
  const dropped = googleProviders.filter(p => bump || !services.includes(p.service) && doc.services.includes(p.service))
  if (dropped.length) {
    removeResourcesByPrefix(await tx.doc(ToolAccess), dropped.map(p => p.prefix))
    await dropExternalSources(tx, (_id, entry) => dropped.some(p => p.id === entry.provider))
  }
  const changed = bump || doc.status !== view.status || doc.accountKey !== (view.status === 'disconnected' ? null : accountKey) || JSON.stringify(doc.services) !== JSON.stringify(services)
  if (changed) Object.assign(doc, { status: view.status, accountKey: view.status === 'disconnected' ? null : accountKey, services, authEpoch: doc.authEpoch + (bump ? 1 : 0), version: doc.version + 1 })
  return { changed, bumped: bump, removed: dropped.map(p => p.id), account: copy(doc) }
}
