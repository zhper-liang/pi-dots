import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError } from './task-config.mjs'
import { MainSessions } from './main-session.mjs'
import { TaskCancellation, readCancelledArchive } from './cancellation.mjs'

// Session-scoped documents survive Task settlement. Audit, Bot and child records stay intact.
export const SessionLifecycle = defineDoc({
  kind: 'pidot.session-lifecycle', version: 1, scope: 'session',
  initial: () => ({ deleted: {}, requests: {} }),
})
const copy = value => JSON.parse(JSON.stringify(value))
const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
const validId = id => Number.isSafeInteger(id) && id > 0
export async function isDeleted(tx, taskId) {
  return Boolean((await tx.doc(SessionLifecycle)).deleted[String(taskId)])
}
export async function assertSessionVisible(tx, taskId) {
  if (await isDeleted(tx, taskId)) fail(410, 'SESSION_DELETED', '此会话已删除，历史仅保留用于审计。')
}
export async function resolveCurrentMain(tx, botId) {
  const id = (await tx.doc(MainSessions)).byBot[botId] ?? null
  return id !== null && !await isDeleted(tx, id) ? id : null
}
export async function sessionStopConfirmed(tx, taskId) {
  const record = await tx.task(taskId)
  if (!record) return false
  if (record.state.status === 'terminal') return true
  return Boolean((await tx.doc(TaskCancellation, taskId)).request)
}
// readSession(tx, id) must include archived/terminal/deleted cards (never a filtered public get).
// stopSession(id) reuses cancel(id, {}); stopMain(id) must record cancellation without deleting children.
// createMain(tx, oldSession) creates a fresh main Task/conversation in this SAME transaction.
export function createSessionLifecycle({ transaction, readSession, stopSession, stopMain, createMain,
  verifyStopped = sessionStopConfirmed, now = () => new Date().toISOString() }) {
  const active = new Map()
  function parse(id, input) {
    if (!validId(id) || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['requestId', 'confirmed'].includes(key)) || input.confirmed !== true ||
      typeof input.requestId !== 'string' || !/^[\w:-]{1,160}$/.test(input.requestId)) {
      fail(400, 'INVALID_SESSION_DELETE', '须确认删除并提供稳定 requestId。')
    }
  }
  async function run(id, input, action) {
    parse(id, input)
    // Same-target concurrent requests join; a second request still gets its own durable receipt.
    while (active.has(id)) await active.get(id).catch(() => {})
    const operation = perform(id, input, action)
    active.set(id, operation)
    try { return await operation } finally { if (active.get(id) === operation) active.delete(id) }
  }
  async function perform(id, { requestId }, action) {
    const prepared = await transaction(async tx => {
      const doc = await tx.doc(SessionLifecycle), prior = doc.requests[`request:${requestId}`]
      if (prior && (prior.taskId !== id || prior.action !== action)) fail(409, 'SESSION_REQUEST_CONFLICT', '同一 requestId 不能更换会话或操作。')
      if (prior?.state === 'succeeded') return { result: { ...copy(prior.result), replayed: true } }
      const deleted = doc.deleted[String(id)]
      if (deleted) {
        if (deleted.action !== action) fail(409, 'SESSION_ACTION_CONFLICT', '此会话已经完成另一种删除操作。')
        const result = { ...copy(deleted), requestId, replayed: true }
        doc.requests[`request:${requestId}`] = { taskId: id, action, state: 'succeeded', result }
        return { result }
      }
      const session = await readSession(tx, id)
      if (!session || session.taskId !== id) fail(404, 'TASK_NOT_FOUND', '会话不存在。')
      if ((session.kind === 'main') !== (action === 'clear-main')) fail(409, 'SESSION_ACTION_CONFLICT', '主会话须使用清空并开始新会话。')
      if (action === 'clear-main' && (await tx.doc(MainSessions)).byBot[session.bot.id] !== id) fail(409, 'MAIN_SESSION_STALE', '主会话已更新，请刷新。')
      doc.requests[`request:${requestId}`] = { taskId: id, action, state: 'pending', requestedAt: prior?.requestedAt ?? now() }
      return { session: copy(session), stopped: await verifyStopped(tx, id) }
    })
    if (prepared.result) return prepared.result
    try {
      if (!prepared.stopped) {
        const stop = action === 'clear-main' ? stopMain : stopSession
        if (!stop) fail(409, 'SESSION_STOP_UNAVAILABLE', '停止服务尚未接线，会话未删除。')
        const response = await stop(id)
        if (response?.status === 'unknown' || response?.state === 'unknown' || response?.unknown === true) fail(409, 'SESSION_STOP_UNKNOWN', '停止结果未知；请用原 requestId 核实后重试，会话未删除。')
        if (response?.ok === false || response?.status === 'failed' || response?.state === 'failed') fail(409, 'SESSION_STOP_FAILED', '停止失败，会话未删除。')
      }
      return await transaction(async tx => {
        const doc = await tx.doc(SessionLifecycle)
        if (doc.deleted[String(id)]) {
          const result = { ...copy(doc.deleted[String(id)]), requestId, replayed: true }
          doc.requests[`request:${requestId}`] = { taskId: id, action, state: 'succeeded', result }
          return result
        }
        if (!await verifyStopped(tx, id)) fail(409, 'SESSION_STOP_UNKNOWN', '未核实持久停止标记，会话未删除。')
        let replacementTaskId = null
        if (action === 'clear-main') {
          const mappings = await tx.doc(MainSessions)
          if (mappings.byBot[prepared.session.bot.id] !== id) fail(409, 'MAIN_SESSION_STALE', '主会话已更新，请刷新。')
          if (!createMain) fail(409, 'MAIN_SESSION_CREATE_UNAVAILABLE', '新主会话服务尚未接线。')
          replacementTaskId = await createMain(tx, copy(prepared.session))
          if (!validId(replacementTaskId) || replacementTaskId === id) fail(409, 'INVALID_MAIN_REPLACEMENT', '必须创建新的主会话。')
          const fresh = await readSession(tx, replacementTaskId)
          if (fresh?.kind !== 'main' || fresh.bot?.id !== prepared.session.bot.id || !fresh.conversationId ||
            fresh.conversationId === prepared.session.conversationId || await isDeleted(tx, replacementTaskId)) fail(409, 'INVALID_MAIN_REPLACEMENT', '新主会话必须使用相同 Bot 和独立上下文。')
          mappings.byBot[prepared.session.bot.id] = replacementTaskId
        }
        const result = { taskId: id, botId: prepared.session.bot.id, action, deleted: true, deletedAt: now(), replacementTaskId, requestId, replayed: false }
        doc.deleted[String(id)] = copy(result)
        doc.requests[`request:${requestId}`] = { taskId: id, action, state: 'succeeded', result: copy(result) }
        return result
      })
    } catch (error) {
      // Preserve the actual failure. A retry uses the SAME requestId and verifies durable stop first.
      await transaction(async tx => {
        const request = (await tx.doc(SessionLifecycle)).requests[`request:${requestId}`]
        if (request && request.state !== 'succeeded') {
          request.state = error?.code === 'SESSION_STOP_UNKNOWN' ? 'unknown' : 'failed'
          request.code = typeof error?.code === 'string' ? error.code : 'SESSION_STOP_FAILED'
        }
      })
      throw error
    }
  }
  return {
    deleteSession: (id, input) => run(id, input, 'delete'),
    clearMainSession: (id, input) => run(id, input, 'clear-main'),
    requestStatus: requestId => transaction(async tx => copy((await tx.doc(SessionLifecycle)).requests[`request:${requestId}`] ?? null)),
    isDeleted: id => transaction(tx => isDeleted(tx, id)),
    resolveCurrentMain: botId => transaction(tx => resolveCurrentMain(tx, botId)),
  }
}

// Optional raw-card adapter for the integrator; handles retired Task documents without mutation.
export async function readLifecycleSession(tx, id, { TaskCard, taskKind }) {
  const record = await tx.task(id)
  if (!record || (taskKind && record.kind !== taskKind)) return null
  const archive = record.state.status === 'terminal' ? await readCancelledArchive(tx, id) : null
  const card = archive ? archive.documents[TaskCard.definition.kind] : await tx.doc(TaskCard, id)
  return card?.bot ? { ...copy(card), runtime: copy(record.state) } : null
}
