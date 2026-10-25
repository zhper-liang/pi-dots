import { LOCAL_OWNER, payloadHash } from './workspace-schema.mjs'
const iso = time => new Date(time).toISOString()
export async function reminderPages(repo, tx, type, sourceId = 'local') {
  const rows = []; let cursor = 0
  do { const page = await repo.list(tx, type, LOCAL_OWNER, sourceId, { cursor, limit: 100 }); rows.push(...page.items); cursor = page.next; if (rows.length >= 1000 && cursor !== undefined) throw Error('REMINDER_SCAN_BUDGET') } while (cursor !== undefined)
  return rows
}
export function reminderDue(reminder, target) {
  if (reminder.at) return Date.parse(reminder.at)
  const value = target.start ?? target.due
  // Date-only objects have no instant. Never invent midnight or a Todo deadline.
  if (typeof value !== 'string' || !value.includes('T')) return null
  return Date.parse(value) + reminder.offset * 1000
}
export async function reconcileReminders(repo, tx, target, kind, now = Date.now()) {
  for (const r of await reminderPages(repo, tx, 'Reminder', target.sourceId)) {
    if (!r.scheduleId || r.targetRef.type !== kind || r.targetRef.id !== target.id || !r.enabled || r.targetVersion === target.version && !r.invalidated) continue
    const s = await repo.get(tx, 'Schedule', LOCAL_OWNER, 'local', r.scheduleId)
    if (!s || ['completed', 'cancelled'].includes(s.status)) continue // Old prototype records are preserved, not upgraded implicitly.
    const o = s.activeOccurrenceId && await repo.get(tx, 'Occurrence', LOCAL_OWNER, 'local', s.activeOccurrenceId)
    if (o && ['unknown', 'dispatching', 'waiting'].includes(o.state)) {
      await repo.put(tx, 'Reminder', { ...r, invalidated: true, invalidationReason: 'target_changed_with_unresolved_execution', state: 'unknown', reason: 'linked_execution_preserved', updatedAt: iso(now) }); continue
    }
    if (o && ['claimed', 'retry_wait'].includes(o.state)) await repo.put(tx, 'Occurrence', { ...o, state: 'cancelled', reason: 'target_changed', finishedAt: iso(now) })
    const due = reminderDue(r, target), reason = target.deletedAt ? 'target_deleted' : target.status === 'completed' ? 'target_completed' : due === null ? 'target_has_no_instant' : null
    const version = r.version + 1
    await repo.put(tx, 'Reminder', { ...r, version, targetVersion: target.version, invalidated: false, invalidationReason: null, state: reason ? 'suppressed' : 'active', reason, updatedAt: iso(now) })
    await repo.put(tx, 'Schedule', { ...s, revision: s.revision + 1, enabled: !reason, status: reason ? 'suppressed' : 'active', nextDueAt: due === null ? s.nextDueAt : iso(due), rule: { type: 'at', at: due === null ? s.nextDueAt : iso(due) }, activeOccurrenceId: null, actionSpec: { ...s.actionSpec, reminderVersion: version }, updatedAt: iso(now) })
  }
}
export const reminderBase = (sourceId, id) => ({ schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id })
export const notificationKey = (o, version) => payloadHash([LOCAL_OWNER, o.id, 'inbox', version])
