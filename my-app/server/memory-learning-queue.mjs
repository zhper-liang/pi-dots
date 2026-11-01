import { defineDoc } from '@earendil-works/pi-durable'
import { evidenceFingerprint } from './memory-evidence.mjs'

export const MemoryExtraction = defineDoc({ kind: 'pidot.memory-extraction', version: 1, scope: 'session',
  initial: () => ({ jobs: {}, sessions: {}, bots: {}, processed: {}, day: null, calls: 0, reservedTokens: 0, initializedAt: null }) })
export const learningState = state => {
  state.sessions ??= {}; state.bots ??= {}; state.processed ??= {}; state.jobs ??= {}; state.legacyJobs ??= {}
  // v1 used taskId keys with cursor/running but no durable job identity or deadline.
  // Isolate those records once; keep quota and original refs, never treat a failed cursor as success.
  for (const [key, job] of Object.entries(state.jobs)) if (!job.jobId || !job.botId || !Number.isSafeInteger(job.sourceTaskId) || !Array.isArray(job.triggers) || !Number.isFinite(job.dueAt)) {
    state.legacyJobs[key] ??= JSON.parse(JSON.stringify(job))
    delete state.jobs[key]
  }
  state.schema = 2
  return state
}
export const evidenceKey = ref => `${ref.taskId}/${ref.entryId}`
export async function enqueueMemoryEvidence(tx, { botId, sourceTaskId, refs, trigger, revision = null, dueAt = Date.now(), now = Date.now() }) {
  if (!botId || !refs?.length) return null
  const state = learningState(await tx.doc(MemoryExtraction))
  const pending = refs.filter(ref => !state.processed[evidenceKey(ref)])
  if (!pending.length) return null
  const existing = Object.values(state.jobs).find(job => job.botId === botId && job.sourceTaskId === sourceTaskId && !['applied', 'no-change', 'cancelled'].includes(job.state) && JSON.stringify(job.refs) === JSON.stringify(pending))
  if (existing) { existing.dueAt = Math.min(existing.dueAt, dueAt); if (!existing.triggers.includes(trigger)) existing.triggers.push(trigger); return existing.jobId }
  const jobId = `review-${evidenceFingerprint([botId, sourceTaskId, pending]).slice(0, 40)}`
  if (state.jobs[jobId]) return jobId
  state.jobs[jobId] = { jobId, botId, sourceTaskId, trigger, triggers: [trigger], refs: pending, revision, evidenceFingerprint: evidenceFingerprint(pending), dueAt, state: 'pending', attempts: 0, createdAt: now, updatedAt: now, code: null, model: null, usage: null, leaseUntil: null, applied: [] }
  return jobId
}
