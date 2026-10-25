import { TaskApprovals, markOutcomeUnknown, saveApprovalReceipt, calendarIdempotencyCapability, validApprovalBinding } from './approvals.mjs'
import { createActionRecoveryGuard } from './action-query.mjs'
import { idempotencyWindow, validIdempotentResult } from './calendar-write.mjs'
import { setTimeout as delay } from 'node:timers/promises'
const copy = (x) => JSON.parse(JSON.stringify(x))
export function createActionIdempotency({ harness, context, TaskCard, ChatInput, bots, dispatch, collaboration }) {
  const { view, guard } = createActionRecoveryGuard({ TaskCard, ChatInput, bots, collaboration }), contract = calendarIdempotencyCapability.idempotency
  return async function recoverIdempotently(id, approvalId, signal) {
    while (!signal.aborted) {
      const request = await harness.commit(async (tx) => {
        const v = await guard(tx, id, approvalId, 'idempotency'), item = v.item
        if (v.skip || !item?.operation) return null
        await markOutcomeUnknown(tx, v.card, item)
        item.operation.idempotency ??= { attempts: [], stopped: null }
        const recovery = item.operation.idempotency
        for (const attempt of recovery.attempts.filter((x) => x.status === 'retrying')) {
          attempt.status = 'interrupted'; attempt.finishedAt = new Date().toISOString()
          await tx.appendEntry(v.card.conversationId, { kind: 'pidot.action-idempotency-result', data: copy(attempt) })
        }
        if (recovery.stopped || item.operation.verifications.length) return null
        const reason = v.denied ?? (!idempotencyWindow(item.operation) ? 'IDEMPOTENCY_WINDOW_EXPIRED' :
          recovery.attempts.length >= contract.maxAttempts ? 'IDEMPOTENCY_ATTEMPTS_EXHAUSTED' : null)
        if (reason) {
          const data = { taskId: id, approvalId, operationId: item.operation.id, reason, createdAt: new Date().toISOString() }
          const audit = await tx.appendEntry(v.card.conversationId, { kind: 'pidot.action-idempotency-stopped', data })
          recovery.stopped = { ...data, id: audit.id }; return null
        }
        const data = { taskId: id, approvalId, operationId: item.operation.id, binding: item.binding,
          source: contract.source, number: recovery.attempts.length + 1, status: 'retrying', createdAt: new Date().toISOString() }
        const audit = await tx.appendEntry(v.card.conversationId, { kind: 'pidot.action-idempotency-started', data })
        recovery.attempts.push({ ...data, id: audit.id }); v.usage.toolCalls += 1
        return { ...data, id: audit.id, operation: copy(item.operation) }
      }, context)
      if (!request) return
      const controller = new AbortController(), onAbort = () => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      let timer, response
      try {
        signal.throwIfAborted()
        response = await Promise.race([
          Promise.resolve().then(() => dispatch(request.operation, controller.signal, { recovery: true, attemptId: request.id })),
          new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ timeout: true }) }, contract.timeoutMs) }),
        ])
      } catch { response = { error: true } }
      finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
      await harness.commit(async (tx) => {
        const v = await view(tx, id), item = (await v.doc(TaskApprovals)).items.find((x) => x.id === approvalId)
        if (item?.operation?.id !== request.operationId) return
        const attempt = item.operation.idempotency.attempts.find((x) => x.id === request.id)
        if (!attempt || attempt.status !== 'retrying') return
        const matched = validIdempotentResult(response, request.operation)
        attempt.status = matched ? 'completed' : response?.timeout ? 'timeout' : response?.error ? 'error' : 'unconfirmed'
        attempt.finishedAt = new Date().toISOString()
        if (matched) { attempt.evidence = copy(response.evidence); attempt.replayed = response.replayed }
        const audit = await tx.appendEntry(v.card.conversationId, { kind: 'pidot.action-idempotency-result', data: copy(attempt) })
        attempt.resultEntryId = audit.id
        if (!matched || item.receipt || item.operation.resolution) return
        if (!validApprovalBinding(v.card, item) || JSON.stringify(item.operation.arguments) !== JSON.stringify(request.operation.arguments) || item.binding !== request.operation.binding) return
        const receiptTx = { appendEntry: (...args) => tx.appendEntry(...args), doc: (token) => v.doc(token) }
        await saveApprovalReceipt(receiptTx, v.card, item, { ok: true, data: { ...copy(response.result.data),
          source: 'tool-idempotent-recovery', independentlyVerified: true, retryEntryId: audit.id, replayed: response.replayed,
          evidence: copy(response.evidence) } }, 'tool-idempotent-recovery')
      }, context)
      if (signal.aborted) return
      await delay(40 * request.number, undefined, { signal }).catch(() => {})
    }
  }
}
