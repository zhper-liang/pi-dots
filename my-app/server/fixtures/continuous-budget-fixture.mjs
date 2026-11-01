import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry, defineDoc, defineTask, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ContinuousBudget, TaskProgress } from '../continuous-task.mjs'
import { Collaboration } from '../collaboration.mjs'
import { registerContinuousChild, reserveContinuousAttempt, settleContinuousAttempt } from '../continuous-budget.mjs'
import { TaskCancellation } from '../cancellation.mjs'
import { applyContinuousControl, continuousDispatchState, readContinuousControlWatchKey, waitContinuousControlChange } from '../continuous-control.mjs'

const Probe = defineTask({ name: 'pidot.test.continuous-budget', version: 1, initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} } })
export const TestCard = defineDoc({ kind: 'pidot.test.continuous-budget-card', version: 1, scope: 'task', initial: () => ({}) })
export const EPOCH = Date.parse('2026-11-02T00:00:00Z')

export async function budgetFixture(t, limits = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-continuous-budget-'))
  let harness, now = EPOCH, cancelCalls = 0
  const open = async () => {
    const registry = createRegistry()
    registry.install({ name: 'continuous-budget-test', tasks: [Probe] })
    harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'isolated.sqlite')), { models: createModels(), registry }, context)
  }
  await open()
  t.after(async () => { await harness.close(context); await rm(dir, { recursive: true, force: true }) })
  const tx = fn => harness.commit(fn, context)
  const root = await tx(async tx => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const taskId = await tx.createTask(Probe, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } })
    const card = { taskId, conversationId: conversation.id, bot: { id: 'fixture' }, executionPolicy: { kind: 'continuous', rootTaskId: taskId, rootInputId: 101 }, taskState: { goal: '保留目标', completionCriteria: ['真实回执'], constraints: [], goalRevision: 1 } }
    Object.assign(await tx.doc(TestCard, taskId), card)
    Object.assign(await tx.doc(ContinuousBudget, taskId), { rootTaskId: taskId, limits: { modelCalls: 20, toolCalls: 40, totalTokens: 1000, durationMs: 60000, ...limits }, startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 60000).toISOString() })
    await tx.doc(TaskProgress, taskId)
    return card
  })
  const options = () => ({ TaskCard: TestCard, now })
  const attempt = (attemptId, extra = {}) => ({ rootTaskId: root.taskId, taskId: root.taskId, inputId: 101, goalRevision: 1, attemptId, kind: 'model', purpose: 'reply', tokenReservation: 100, ...extra })
  return {
    root, tx, attempt, options, get cancelCalls() { return cancelCalls },
    setNow: value => { now = value },
    reserve: (attemptId, extra) => tx(tx => reserveContinuousAttempt(tx, attempt(attemptId, extra), options())),
    settle: (attemptId, usage = { totalTokens: 10 }, extra = {}) => tx(tx => settleContinuousAttempt(tx, { rootTaskId: root.taskId, taskId: root.taskId, attemptId, usage, ...extra }, options())),
    budget: () => harness.snapshot(ContinuousBudget, root.taskId, context),
    progress: () => harness.snapshot(TaskProgress, root.taskId, context),
    card: () => harness.snapshot(TestCard, root.taskId, context),
    watchKey: () => tx(tx => readContinuousControlWatchKey(tx, root.taskId)),
    wait: (observed, extra = {}) => waitContinuousControlChange({ taskId: root.taskId, signal: extra.signal ?? new AbortController().signal, watchDoc: (...args) => harness.watchDoc(...args) }, context, { observed, now: () => now, ...extra }),
    restart: async () => { await harness.close(context); await open() },
    control: input => tx(async tx => applyContinuousControl(tx, await tx.doc(TestCard, root.taskId), input, { now, cancel: async (tx, id) => { cancelCalls++; (await tx.doc(TaskCancellation, id)).request = { source: 'test-user', requestedAt: new Date(now).toISOString() } } })),
    dispatch: (extra = {}) => tx(async tx => continuousDispatchState(tx, await tx.doc(TestCard, root.taskId), 101, { now, ...extra })),
    child: () => tx(async tx => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      const taskId = await tx.createTask(Probe, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } })
      const inputId = taskId + 1000
      const relation = { id: `root:${root.taskId}:child:${taskId}`, parentTaskId: root.taskId, parentInputId: 101, childTaskId: taskId, childInputId: inputId }
      ;(await tx.doc(Collaboration)).items.push(relation)
      await registerContinuousChild(tx, { rootTaskId: root.taskId, rootInputId: 101, taskId, inputId, goalRevision: 1 }, options())
      return { taskId, inputId }
    }),
  }
}
