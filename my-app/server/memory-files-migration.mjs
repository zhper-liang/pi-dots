import { createMemoryFiles } from './memory-files.mjs'

/**
 * Startup entry for R2 (README §6). Never rewrites old Documents, revisions, tombstones, receipts or watermarks;
 * migration is only reconcile(): ledger content → new files, pre-existing files → imported with an empty base.
 * enabled: full reconcile of every target, then commit-driven write-back. Returns the live reconciler.
 * disabled (rollback): only targets that already have a file ledger AND an unsynced hand edit are imported, once
 * per distinct file content (same requestId → replayed receipt); no file is written, no ledger is created. Returns null.
 */
export async function openMemoryFiles({ enabled, subscribe, ...options }) {
  const files = createMemoryFiles({ ...options, write: Boolean(enabled) })
  if (!enabled) {
    await files.importPending()
    await files.close({ reconcile: false })
    return null
  }
  await files.reconcileAll()
  files.start(subscribe)
  return files
}
