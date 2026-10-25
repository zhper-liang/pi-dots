// Isolated foundation probe. Never registered by production server/index.mjs.
import { createRegistry, defineTask, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createWorkspaceRepository } from '../workspace-repository.mjs'
import { WorkspaceRecords, identityKey } from '../workspace-schema.mjs'
import { BotDirectory } from '../bot-directory.mjs'
import { ToolAccess } from '../tools.mjs'

export const ProbeWakeTask = defineTask({
  name: 'pidot.test.workspace-wake', version: 1,
  initial: input => ({ phase: 'sleep', sourceId: input.sourceId, id: input.id }),
  phases: {
    async sleep(task, runtime, ctx) {
      const key = identityKey('local-owner', task.input.sourceId, task.input.id)
      for (;;) {
        const watch = await runtime.watchDoc(WorkspaceRecords.Schedule, key, ctx)
        if (!watch) throw new Error('Missing probe schedule')
        let resolveChanged
        const changed = new Promise(resolve => { resolveChanged = resolve })
        const revision = watch.value.record.revision
        watch.start(value => { if (value.record.revision !== revision) resolveChanged('changed') })
        try {
          const schedule = watch.value.record
          if (!schedule.enabled) { await changed; continue }
          // sleep() itself is an in-memory wait; durable Schedule + checkpoint and
          // explicit re-read on reservation are the restart source of truth.
          const result = await Promise.race([runtime.sleep(Date.parse(schedule.nextDueAt), ctx).then(() => 'due'), changed])
          if (result !== 'due') continue
          let done = false
          await runtime.commit(async tx => {
            const current = (await tx.doc(WorkspaceRecords.Schedule, key, null)).record
            if (!current.enabled || current.revision !== revision || Date.parse(current.nextDueAt) > runtime.now()) return
            const repo = createWorkspaceRepository({ harness: null, context: ctx })
            const id = `probe:${current.id}:${revision}:${Date.parse(current.nextDueAt)}`
            const previous = await repo.get(tx, 'Occurrence', current.ownerId, current.sourceId, id)
            if (!previous) await repo.put(tx, 'Occurrence', { schemaVersion: 1, ownerId: current.ownerId, sourceId: current.sourceId, id, scheduleId: current.id, revision, scheduledFor: current.nextDueAt, taskId: runtime.taskId, attempts: 1, state: 'succeeded' })
            done = true
            return { status: 'terminal', outcome: { status: 'completed', result: { revision, occurrenceId: id } } }
          }, ctx)
          if (done) return
        } finally { await watch.stop() }
      }
    },
  },
  async abort(task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx) },
})

export async function openFoundation(file, options = {}) {
  const storage = await openNodeSqliteStorage(file)
  const registry = createRegistry(); registry.install({ name: 'workspace-probe', tasks: [ProbeWakeTask] })
  const harness = await Harness.open(storage, { models: createModels(), registry, settings: { documentRetentionMs: 0 } }, context)
  const repo = createWorkspaceRepository({ harness, context, ...options })
  try { await repo.initialize({ migration: options.migration }) } catch (error) { await harness.close(context); throw error }
  return { harness, repo, context, close: () => harness.close(context) }
}
export async function assignWorkspaceBot(foundation, botId = 'calendar', sourceId = 'local') {
  await foundation.harness.commit(async tx => {
    const directory = await tx.doc(BotDirectory), access = await tx.doc(ToolAccess)
    if (!directory.items.some(bot => bot.id === botId)) directory.items.push({ id: botId, status: 'active' })
    access.assignments[botId] = { tools: ['workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status'], resources: [`workspace:${sourceId}`] }
  }, foundation.context)
}
export const probeSchedule = (id, due, revision = 1) => ({ schemaVersion: 1, ownerId: 'local-owner', sourceId: 'local', id, executionPrincipal: { botId: 'probe' }, actionSpec: { kind: 'probe' }, timezone: 'Asia/Shanghai', rule: { type: 'once', at: due }, enabled: true, revision, nextDueAt: due, misfirePolicy: 'latest', retryPolicy: { maxAttempts: 1 }, callLimits: { modelCalls: 0, toolCalls: 0 } })
