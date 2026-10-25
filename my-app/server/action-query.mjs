import { assertBotActive } from './bot-directory.mjs'
import { TaskApprovals, MockCalendar, validApprovalBinding, saveApprovalReceipt, markOutcomeUnknown, calendarQueryCapability, supportsCalendarRecovery } from './approvals.mjs'
import { ToolAccess, CallUsage, toolSets, checkToolCall, callLimits, CALENDAR_EVENT_TOOL } from './tools.mjs'
import { TaskCancellation, readCancelledArchive } from './cancellation.mjs'
import { setTimeout as delay } from 'node:timers/promises'

// A transport contract, not a model tool or an idempotency guarantee. The mock
// ledger and effect commit together; an absent row establishes nothing.
export { calendarQueryCapability }
const copy = (x) => JSON.parse(JSON.stringify(x))
export function createActionRecoveryGuard({ TaskCard, ChatInput, bots, collaboration }) {
  async function view(tx, id) {
    const record = await tx.task(id)
    const archive = record?.state.status === 'terminal' ? await readCancelledArchive(tx, id) : null
    const doc = (token) => archive ? archive.documents[token.definition.kind] : tx.doc(token, id)
    return { record, doc, card: await doc(TaskCard), cancelled: Boolean((await doc(TaskCancellation))?.request) }
  }
  async function guard(tx, id, approvalId, mode = 'query', reserved = false) {
    const v = await view(tx, id), state = await v.doc(TaskApprovals), item = state?.items.find((x) => x.id === approvalId)
    if (!item?.operation || item.receipt || item.operation.resolution || v.cancelled || !['pending', 'running'].includes(v.record.state.status)) return { ...v, item, skip: true }
    try { await assertBotActive(tx, v.card.bot.id) } catch (error) { if (error.code === 'BOT_INACTIVE') return { ...v, item, skip: true }; throw error }
    if(collaboration) {try {await collaboration.guard(tx,id)}catch(error){return {...v,item,skip:true,denied:error.code}}}
    const op = item.operation, checkpoint = v.record.state.checkpoint, intent = await tx.entry(op.intentEntryId), decision = await tx.entry(item.decision?.id)
    if (!validApprovalBinding(v.card, item) || item.decision.decision !== 'approved' || state.activeId !== item.id ||
      checkpoint?.phase !== 'awaitApproval' || checkpoint.approvalId !== item.id || checkpoint.entryId !== item.inReplyTo ||
      (await v.doc(ChatInput)).entryId !== item.inReplyTo || op.taskId !== id || op.approvalId !== item.id || op.binding !== item.binding ||
      op.inReplyTo !== item.inReplyTo || op.toolName !== item.toolName || JSON.stringify(op.arguments) !== JSON.stringify(item.arguments) ||
      JSON.stringify(op.before) !== JSON.stringify(item.before) || JSON.stringify(op.decision) !== JSON.stringify(item.decision) ||
      intent?.kind !== 'pidot.action-dispatch-intent' || intent.conversationId !== v.card.conversationId ||
      ['id', 'taskId', 'approvalId', 'binding', 'inReplyTo', 'toolName', 'createdAt'].some((key) => intent.data[key] !== op[key]) ||
      ['arguments', 'before', 'decision', 'capabilities'].some((key) => JSON.stringify(intent.data[key]) !== JSON.stringify(op[key])) ||
      decision?.kind !== 'pidot.approval-decided' || decision.conversationId !== v.card.conversationId ||
      ['taskId', 'approvalId', 'inReplyTo', 'binding', 'source', 'decision', 'reason', 'acknowledgeDuplicateRisk'].some((key) => decision.data[key] !== item.decision[key])) {
      return { ...v, item, denied: 'ACTION_BINDING_MISMATCH' }
    }
    if (!supportsCalendarRecovery(op.capabilities, mode)) return { ...v, item, skip: true }
    const turn = await tx.entry(item.turnId), sets = toolSets(v.card, bots, await tx.doc(ToolAccess))
    if (turn?.byTaskId !== id || turn.conversationId !== v.card.conversationId || turn.data.inReplyTo !== item.inReplyTo ||
      !turn.data.assistant?.content.some((call) => call.id === item.callId && call.name === item.toolName && JSON.stringify(call.arguments) === JSON.stringify(item.arguments))) return { ...v, item, denied: 'ACTION_BINDING_MISMATCH' }
    const access = checkToolCall({ card: v.card, record: v.record, conversation: await tx.conversation(v.card.conversationId),
      call: { name: item.toolName, arguments: item.arguments }, displayed: turn?.data.displayed ?? [], sets, priorEventIds: [item.arguments.eventId] })
    if (!access.ok) return { ...v, item, denied: access.error.code }
    if (mode === 'query' && !sets.authorized.includes(CALENDAR_EVENT_TOOL)) return { ...v, item, denied: 'TOOL_NOT_AUTHORIZED' }
    const usage = await v.doc(CallUsage), limits = callLimits(v.card.parameters)
    if ((reserved ? usage.toolCalls > limits.toolCalls : usage.toolCalls >= limits.toolCalls) || (limits.totalTokens !== undefined && (usage.unknownTokenCalls > 0 || usage.totalTokens >= limits.totalTokens))) return { ...v, item, denied: 'CALL_LIMIT_REACHED' }
    return { ...v, item, usage }
  }
  return { view, guard }
}
export function createActionQuery({ harness, context, TaskCard, ChatInput, bots, queryImpl, collaboration }) {
  const { view, guard } = createActionRecoveryGuard({ TaskCard, ChatInput, bots, collaboration })
  return async function recoverAction(id, approvalId, signal) {
    while (!signal.aborted) {
      const request = await harness.commit(async (tx) => {
        const v = await guard(tx, id, approvalId), item = v.item
        if (v.skip || !item?.operation) return null
        await markOutcomeUnknown(tx, v.card, item)
        item.operation.query ??= { attempts: [], stopped: null }
        const query = item.operation.query
        for (const attempt of query.attempts.filter((x) => x.status === 'querying')) {
          attempt.status = 'interrupted'; attempt.finishedAt = new Date().toISOString()
          await tx.appendEntry(v.card.conversationId, { kind: 'pidot.action-query-interrupted', data: { operationId: item.operation.id, attemptId: attempt.id, createdAt: attempt.finishedAt } })
        }
        const reason = v.denied ?? (query.attempts.length >= calendarQueryCapability.query.maxAttempts ? 'QUERY_ATTEMPTS_EXHAUSTED' : null)
        if (reason) {
          if (query.stopped?.reason !== reason) {
            const data = { taskId: id, approvalId, operationId: item.operation.id, reason, source: 'host-recovery-policy', createdAt: new Date().toISOString() }
            const audit = await tx.appendEntry(v.card.conversationId, { kind: 'pidot.action-query-stopped', data })
            query.stopped = { ...data, id: audit.id }
          }
          return null
        }
        const data = { taskId: id, approvalId, operationId: item.operation.id, binding: item.binding,
          resource: item.arguments.resource, eventId: item.arguments.eventId, number: query.attempts.length + 1,
          source: calendarQueryCapability.query.source, status: 'querying', createdAt: new Date().toISOString() }
        const audit = await tx.appendEntry(v.card.conversationId, { kind: 'pidot.action-query-started', data })
        query.attempts.push({ ...data, id: audit.id }); query.stopped = null; v.usage.toolCalls += 1
        return { ...data, id: audit.id, operation: copy(item.operation) }
      }, context)
      if (!request) return
      const controller = new AbortController(), onAbort = () => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      let timer, result
      try {
        signal.throwIfAborted()
        const execute = () => harness.commit(async (tx) => {
          controller.signal.throwIfAborted()
          // Recheck permissions at actual dispatch without counting the reserved attempt twice.
          const v = await guard(tx, id, approvalId)
          if (v.skip || (v.denied && v.denied !== 'CALL_LIMIT_REACHED')) return { status: 'unknown' }
          const usage = await v.doc(CallUsage), limits = callLimits(v.card.parameters)
          if (usage.toolCalls > limits.toolCalls || (limits.totalTokens !== undefined && (usage.unknownTokenCalls > 0 || usage.totalTokens >= limits.totalTokens))) return { status: 'unknown' }
          const row = (await tx.doc(MockCalendar)).operations?.[request.operationId]
          return row ? { status: 'completed', evidence: copy(row) } : { status: 'unknown' }
        }, context)
        result = await Promise.race([
          Promise.resolve().then(() => queryImpl ? queryImpl(copy(request), { signal: controller.signal, execute }) : execute()),
          new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'timeout' }) }, calendarQueryCapability.query.timeoutMs) }),
        ])
      } catch { result = { status: 'error' } }
      finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
      await harness.commit(async (tx) => {
        const v = await view(tx, id), item = (await v.doc(TaskApprovals)).items.find((x) => x.id === approvalId)
        if (item?.operation?.id !== request.operationId) return
        const attempt = item.operation.query.attempts.find((x) => x.id === request.id)
        if (!attempt || attempt.status !== 'querying') return
        const evidence = result?.evidence, op = request.operation
        const matched = result?.status === 'completed' && evidence && Object.keys(evidence).length === 10 && evidence?.source === calendarQueryCapability.query.source &&
          evidence.operationId === op.id && evidence.taskId === id && evidence.approvalId === approvalId && evidence.binding === op.binding &&
          JSON.stringify(evidence.arguments) === JSON.stringify(op.arguments) && JSON.stringify(evidence.before) === JSON.stringify(op.before) &&
          JSON.stringify(evidence.event) === JSON.stringify({ ...op.before, start: op.arguments.start, end: op.arguments.end }) &&
          Number.isInteger(evidence.revision) && evidence.revision > 0 && typeof evidence.committedAt === 'string' && Number.isFinite(Date.parse(evidence.committedAt))
        attempt.status = matched ? 'completed' : ['timeout', 'error'].includes(result?.status) ? result.status : result?.status === 'completed' ? 'invalid-evidence' : 'unknown'
        attempt.finishedAt = new Date().toISOString()
        // Never persist unvalidated transport data/errors (which could contain secrets).
        if (matched) attempt.evidence = copy(evidence)
        const audit = await tx.appendEntry(v.card.conversationId, { kind: 'pidot.action-query-result', data: copy(attempt) })
        attempt.resultEntryId = audit.id
        if (!matched || item.receipt || item.operation.resolution) return
        // A late reliable receipt can be retained after cancellation, never resume it.
        if (!validApprovalBinding(v.card, item) || JSON.stringify(item.operation.arguments) !== JSON.stringify(op.arguments) || item.binding !== op.binding) return
        const receiptTx = { appendEntry: (...args) => tx.appendEntry(...args), doc: (token) => v.doc(token) }
        await saveApprovalReceipt(receiptTx, v.card, item, { ok: true, data: { simulated: true, source: 'tool-result-query',
          independentlyVerified: true, operationId: op.id, approvalId, queryEntryId: audit.id, evidence: copy(evidence), event: copy(evidence.event) } }, 'tool-result-query')
      }, context)
      if (signal.aborted) return
      await delay(40 * request.number, undefined, { signal }).catch(() => {})
    }
  }
}
