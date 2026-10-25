import { defineDoc } from '@earendil-works/pi-durable'

// PLAN §8.2 change marker, written in the SAME transaction as the data change (T2-01): a
// rolled-back write leaves no mark. Imports nothing from the app, so any writer can use it.
// counts["sourceId|type"] is a monotonic per-kind counter; routine event triggers (PLAN §8.5)
// compare it with their cursor, so the capped item list never loses a change. trigger:false (undo of
// an automatic change) still wakes detectors but is not a routine event, so undo never re-triggers it.
export const DetectorDirty = defineDoc({ kind: 'pidot.detector-dirty', version: 1, scope: 'session', initial: () => ({ revision: 0, items: [], counts: {} }) })
export const dirtyKey = (sourceId, type) => `${sourceId ?? ''}|${type}`
export async function markDirty(tx, ref) {
  const d = await tx.doc(DetectorDirty)
  d.revision += 1
  d.items = [...d.items.slice(-49), { sourceId: ref.sourceId ?? null, type: ref.type, id: String(ref.id ?? ''), at: new Date().toISOString() }]
  if (ref.trigger === false) return
  const key = dirtyKey(ref.sourceId, ref.type)
  d.counts = { ...(d.counts ?? {}), [key]: ((d.counts ?? {})[key] ?? 0) + 1 }
}
