import { createHash } from 'node:crypto'
import { resolveCurrentMain, isDeleted } from './session-lifecycle.mjs'

const states = new Set(['succeeded', 'failed', 'cancelled', 'waiting', 'unknown'])
const labels = { succeeded: '已完成', failed: '执行失败', cancelled: '已取消', waiting: '需要处理，尚未完成', unknown: '结果未知，请核对原任务' }
const validTaskId = value => Number.isSafeInteger(value) && value > 0
function fail(code, message) { throw Object.assign(new Error(message), { code }) }

/**
 * No scheduler, persisted permission copy or cached main ID. Call deliver inside the caller's
 * EXISTING atomic transaction. readReceipt/writeReceipt must use the same durable occurrence/
 * operation/delivery storage and transaction as appendMirror. They must not commit separately.
 * readCard must read the ORIGINAL run's frozen card (including archived cards when necessary).
 * canDeliver must check the run Bot's CURRENT tool/source/user permissions; no auto-grant.
 * resolveCurrentMain/isDeleted default to the real R1-03 helpers, not mainParent snapshots.
 */
export function createRoutineDelivery({ readCard, canDeliver, readReceipt, writeReceipt,
  appendMirror = (tx, conversationId, data) => tx.appendEntry(conversationId, { kind: 'pidot.mirror', data }),
  currentMain = resolveCurrentMain, deleted = isDeleted, now = () => new Date().toISOString() }) {
  for (const fn of [readCard, canDeliver, readReceipt, writeReceipt, appendMirror, currentMain, deleted, now]) {
    if (typeof fn !== 'function') fail('ROUTINE_DELIVERY_HOOK_REQUIRED', '投递必须提供受控读取、实时授权与原子持久回执 hooks。')
  }
  return {
    async deliver(tx, { botId, occurrence, result }) {
      if (typeof botId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(botId) || !occurrence ||
        typeof occurrence.id !== 'string' || !occurrence.id || occurrence.id.length > 256 ||
        !validTaskId(occurrence.taskId) || !result || !states.has(result.state) ||
        result.taskId !== undefined && result.taskId !== occurrence.taskId) fail('ROUTINE_DELIVERY_INPUT', '需要原运行、执行 Bot 和明确结果状态。')
      const notSent = reason => ({ delivered: false, state: 'suppressed', reason })
      if (occurrence.test) return notSent('test_run')
      if (await deleted(tx, occurrence.taskId)) return notSent('source_deleted')
      const card = await readCard(tx, occurrence.taskId)
      if (!card || card.taskId !== occurrence.taskId || card.bot?.id !== botId ||
        card.scheduledWorkflow?.occurrenceId !== occurrence.id ||
        occurrence.scheduleId !== undefined && card.scheduledWorkflow.scheduleId !== occurrence.scheduleId) {
        fail('ROUTINE_DELIVERY_BINDING', '原运行归属不匹配；不能随新计划改投其他 Bot。')
      }
      if (card.scheduledWorkflow.test) return notSent('test_run')
      if (!await canDeliver(tx, { botId, occurrence, result, card })) return notSent('authorization_revoked')
      // State is part of the key: waiting/unknown may later settle, but each state is delivered
      // only once globally, not once per main. A cleared main never resurrects an old delivery.
      const key = createHash('sha256').update(JSON.stringify(['routine-mirror-v1', occurrence.id, occurrence.taskId, result.state])).digest('hex')
      const prior = await readReceipt(tx, key)
      if (prior) {
        if (prior.botId !== botId || prior.taskId !== occurrence.taskId || prior.occurrenceId !== occurrence.id || prior.outcome !== result.state || !validTaskId(prior.mainTaskId) || !Number.isSafeInteger(prior.entryId)) fail('ROUTINE_DELIVERY_RECEIPT_INVALID', '投递回执与原运行不匹配。')
        return { ...prior, replayed: true }
      }
      const mainTaskId = await currentMain(tx, botId)
      if (!validTaskId(mainTaskId) || await deleted(tx, mainTaskId)) return notSent('current_main_unavailable')
      const record = await tx.task(mainTaskId), mainCard = await readCard(tx, mainTaskId)
      if (!record || record.state.status === 'terminal' || mainCard?.kind !== 'main' || mainCard.bot?.id !== botId || mainCard.taskId !== mainTaskId || !mainCard.conversationId) return notSent('current_main_unavailable')
      // Resolve again immediately before append; no stored/caller-provided main ID is trusted.
      if (await currentMain(tx, botId) !== mainTaskId || await deleted(tx, occurrence.taskId) || await deleted(tx, mainTaskId)) return notSent('session_changed')
      if (!await canDeliver(tx, { botId, occurrence, result, card })) return notSent('authorization_revoked')
      const data = { mirrorKind: 'finished', childTaskId: occurrence.taskId, childTitle: String(card.title ?? '定时任务').slice(0, 100), botId,
        summary: `定时任务${labels[result.state]}；请查看原会话。`, outcome: result.state === 'waiting' ? 'limited' : result.state, createdAt: now() }
      // Deliberately do not copy source text, approval buttons or claim user receipt/success.
      const entry = await appendMirror(tx, mainCard.conversationId, data)
      if (!Number.isSafeInteger(entry?.id) || entry.id <= 0) fail('ROUTINE_DELIVERY_APPEND_UNCONFIRMED', '镜像写入未确认；不能登记送达。')
      const receipt = { key, botId, occurrenceId: occurrence.id, taskId: occurrence.taskId, mainTaskId, entryId: entry.id,
        outcome: result.state, delivered: true, state: 'recorded', recordedAt: data.createdAt, userReceived: 'unknown' }
      await writeReceipt(tx, key, receipt)
      return { ...receipt, replayed: false }
    },
  }
}
