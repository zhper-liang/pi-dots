// Explicit process-only fault injection against a supplied temporary SQLite file.
import { openFoundation, probeSchedule, ProbeWakeTask } from './workspace-foundation.mjs'
const [file, mode] = process.argv.slice(2)
if (!file?.startsWith('/tmp/pidot-v2-01-')) throw new Error('Probe accepts only dedicated temporary DB')
const { repo, harness, context } = await openFoundation(file)
setInterval(() => {}, 1000) // keep fault-injection worker alive until SIGKILL
const log = value => process.stdout.write(JSON.stringify(value) + '\n')
if (mode === 'rollback') {
  const root = await harness.root(context)
  await repo.transaction(async tx => {
    await repo.put(tx, 'Todo', { schemaVersion: 1, ownerId: 'local-owner', sourceId: 'local', id: 'killed', title: 'not committed', status: 'open', version: 1 })
    const taskId = await tx.createTask(ProbeWakeTask, { sourceId: 'local', id: 'killed' }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true })
    await repo.put(tx, 'Operation', { schemaVersion: 1, ownerId: 'local-owner', sourceId: 'operations', id: 'killed', requestId: 'killed', actor: { principalKind: 'user' }, action: 'create', normalizedArgs: {}, payloadHash: 'probe', grantEpoch: 0, state: 'succeeded', receipt: { taskId } })
    await repo.put(tx, 'Outbox', { schemaVersion: 1, ownerId: 'local-owner', sourceId: 'local', id: 'killed', operationId: 'killed', dedupeKey: 'killed', state: 'pending' })
    await repo.put(tx, 'Occurrence', { schemaVersion: 1, ownerId: 'local-owner', sourceId: 'local', id: 'killed', scheduleId: 'killed', revision: 1, scheduledFor: new Date().toISOString(), attempts: 0, taskId, operationId: 'killed', state: 'claimed' })
    log({ point: 'uncommitted', taskId })
    await new Promise(() => {})
  })
} else if (mode === 'wake') {
  const due = new Date(Date.now() + 1500).toISOString()
  await repo.transaction(async tx => { await repo.put(tx, 'Schedule', probeSchedule('restart', due)) })
  const root = await harness.root(context)
  const taskId = await harness.commit(tx => tx.createTask(ProbeWakeTask, { sourceId: 'local', id: 'restart' }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true }), context)
  harness.resume(); log({ point: 'sleeping', taskId, due })
  await new Promise(() => {})
} else if (mode === 'linked') {
  const root = await harness.root(context)
  const taskId = await repo.transaction(async tx => {
    const id = await tx.createTask(ProbeWakeTask, { sourceId: 'local', id: 'linked' }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true })
    await repo.put(tx, 'Occurrence', { schemaVersion: 1, ownerId: 'local-owner', sourceId: 'local', id: 'linked', scheduleId: 'linked', revision: 1, scheduledFor: new Date().toISOString(), attempts: 0, taskId: id, state: 'claimed' })
    return id
  })
  log({ point: 'linked', taskId }); await new Promise(() => {})
}
