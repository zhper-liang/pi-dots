import { fail } from './workspace-schema.mjs'

// OWNED BY R3-03 (Google Calendar). R3-01 registered this inert scaffold so the adapter table,
// router and store wiring are frozen; R3-03 replaces the body and keeps the export name and the
// method set described in plans/active/r3-google-workspace/CONTRACTS.md §1. Not a feature: it
// exposes no sources and denies every per-source call.
export function createGoogleCalendarWorkspaceService({ repository: _repo, authority, google: _google, now: _now = Date.now, syncOptions: _syncOptions = {} }) {
  const revoked = actor => { authority.check(actor); fail(403, 'WORKSPACE_EXTERNAL_REVOKED', 'Google 日历来源尚未接入。') }
  const missing = actor => { authority.check(actor); fail(404, 'WORKSPACE_OPERATION', '外部操作不存在。') }
  return {
    reminderExternalPermission: async (_tx, actor) => revoked(actor),
    recoverExternal: async () => {}, tickExternalSync: async () => {}, closeExternalSync: async () => {},
    async externalSources(actor) { authority.check(actor); if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_CONFIRMATION_REQUIRED', '只有认证用户可以查看外部来源。'); return { sources: [], notice: '' } },
    syncStatus: async actor => revoked(actor), configureSync: async actor => revoked(actor), refreshSync: async actor => revoked(actor),
    grantExternal: async actor => revoked(actor), queryExternal: async actor => revoked(actor), getExternal: async actor => revoked(actor), prepareExternal: async actor => revoked(actor),
    confirmExternal: async actor => missing(actor), cancelExternal: async actor => missing(actor), getExternalOperation: async actor => missing(actor), executeExternal: async actor => missing(actor),
  }
}
