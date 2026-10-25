import { defineDoc } from '@earendil-works/pi-durable'
import { assertBotActive } from './bot-directory.mjs'
import { TaskInputError } from './task-config.mjs'

// User intent survives refresh/reopen; Harness remains the sole execution state machine.
export const TaskCancellation = defineDoc({
  kind: 'pidot.task-cancellation', version: 1, scope: 'task', initial: () => ({ request: null }),
})
// Harness retires task-scoped Documents at terminal settlement. Keep their final
// read-only values in the Task-owned conversation, not in a parallel Task engine.
export const CancelledTaskArchive = defineDoc({
  kind: 'pidot.cancelled-task-archive', version: 1, scope: 'conversation', initial: () => ({ snapshot: null }),
})
export async function readCancelledArchive(tx, id) {
  const owned = await tx.scanConversations({ ownerTaskId: id }, 2)
  if (owned.items.length !== 1) throw new Error('Invalid cancelled Task conversation')
  return (await tx.doc(CancelledTaskArchive, owned.items[0].id)).snapshot
}
export const cancelledOutcome = () => ({ status: 'terminal', outcome: { status: 'aborted' } })
export async function isCancelled(tx, id) {
  return (await tx.doc(TaskCancellation, id)).request !== null
}
export async function assertNotCancelled(tx, id, record) {
  if (record.abortRequested || record.state.outcome?.status === 'aborted' ||
    (record.state.status !== 'terminal' && await isCancelled(tx, id))) {
    throw new TaskInputError(409, 'TASK_CANCELLED', '此 Task 已取消；已有记录保留，未处理消息不会自动继续。')
  }
  if (record.input?.botId) await assertBotActive(tx, record.input.botId)
  if (record.state.status === 'terminal') throw new TaskInputError(409, 'TASK_UNAVAILABLE', '此 Task 已结束，不能继续执行。')
}

export function cancellationApi({ harness, context, TaskCard, ChatInput, taskKind, get, propagateStops }) {
  return {
    async cancel(id, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
        throw new TaskInputError(400, 'INVALID_CANCEL', '取消指定 Task 仅接受空 JSON 对象。')
      }
      await harness.commit(async (tx) => {
        const record = await tx.task(id)
        if (!record || record.kind !== taskKind) throw new TaskInputError(404, 'TASK_NOT_FOUND', '会话不存在。')
        if (record.state.status === 'terminal') {
          const archived = await readCancelledArchive(tx, id)
          if (archived?.cancellation) return
          throw new TaskInputError(409, 'TASK_UNAVAILABLE', '此 Task 已结束，不能取消。')
        }
        // P-12: a Bot's main session is permanent; cancel its derived Tasks instead.
        if ((await tx.doc(TaskCard, id)).kind === 'main') throw new TaskInputError(409, 'MAIN_SESSION_PERMANENT', '主会话不能取消；可以取消它派出的任务。')
        await requestTaskCancellation(tx, id, { TaskCard, ChatInput })

      }, context)
      // abortTask marks durably before signalling and joins the old invocation. Do not
      // block HTTP on an adapter that ignores abort: its real receipt is saved later.
      void harness.abortTask(id, context).catch(() => { /* shutdown owns outstanding invocations */ })
      if (propagateStops) await propagateStops()
      harness.resume()
      return get(id)
    },
  }
}

export async function requestTaskCancellation(tx, id, { TaskCard, ChatInput }, loadedRecord) {
  const record = loadedRecord ?? await tx.task(id)
  if (!record || record.state.status === 'terminal') return
  const state = await tx.doc(TaskCancellation, id)
  if (state.request) return // Idempotent: no duplicate audit, no new work.
  if (!['pending', 'running', 'waiting'].includes(record.state.status)) {
    throw new TaskInputError(409, 'TASK_UNAVAILABLE', '此 Task 已结束，不能取消。')
  }
  const card = await tx.doc(TaskCard, id)
  const slot = await tx.doc(ChatInput, id)
  const request = { source: 'user-request', requestedAt: new Date().toISOString(),
    activeInputId: slot.entryId ?? (record.state.checkpoint?.lastOutcome === 'limited' ? record.state.checkpoint.lastInputId : null),
    checkpoint: structuredClone(record.state.checkpoint ?? null) }
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.task-cancelled', data: request })
  state.request = { ...request, entryId: audit.id }
}
