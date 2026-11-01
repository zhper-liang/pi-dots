import { TaskProgress, ContinuousBudget, isContinuousTask } from './continuous-task.mjs'
import { CallLimitError } from './tools.mjs'
import { continuousEvidenceAccess, resolveContinuousEvidence } from './continuous-evidence.mjs'
import { buildContinuousContext } from './continuous-context.mjs'
import { applyContinuousSubmissionReview, evaluateContinuousCompletion } from './continuous-plan.mjs'
import { TaskInputError } from './task-config.mjs'
import { continuousBudgetUsage } from './continuous-budget.mjs'
import { readContinuousControlWatchKey, waitContinuousControlChange } from './continuous-control.mjs'
import { continuousRetryDecision, continuousRetryDue } from './continuous-retry.mjs'
import { recordContinuousProgress } from './continuous-progress.mjs'

const next = (phase, entryId, extra = {}) => ({ status: 'running', checkpoint: { phase, entryId, ...extra } })
export const continuousBinding = (card, progress) => ({ rootTaskId: card.executionPolicy.rootTaskId,
  rootInputId: card.executionPolicy.rootInputId, goalRevision: card.taskState.goalRevision,
  planRevision: progress.planRevision, stepId: progress.currentStepId,
  submissionRevision: progress.steps.find(step => step.stepId === progress.currentStepId)?.submissionRevision ?? 0 })

export async function assertContinuousDispatch(tx, card, entryId, now = Date.now()) {
  if (!isContinuousTask(card)) return
  const progress = await tx.doc(TaskProgress, card.taskId)
  if (card.executionPolicy.rootInputId !== entryId || progress.finalOutcome) throw new TaskInputError(409, 'CONTINUOUS_INPUT_CLOSED', '持续目标已结束或输入绑定无效。')
  const budget = await tx.doc(ContinuousBudget, card.taskId)
  if (now >= Date.parse(budget.deadlineAt)) throw new CallLimitError('deadline')
}

export async function decideContinuousStep(tx, card, entryId) {
  const progress = await tx.doc(TaskProgress, card.taskId)
  if (progress.finalOutcome) return next('awaitInput', undefined, { lastInputId: entryId, lastOutcome: progress.finalOutcome.status })
  if (progress.stall?.lastAction === 'blocked') return next('continuousWait', entryId, {
    rootTaskId: card.taskId, lastOutcome: 'blocked', waitingReason: 'stalled', controlWatchKey: await readContinuousControlWatchKey(tx, card.taskId) })
  const current = progress.steps.find(step => step.stepId === progress.currentStepId)
  const active = progress.steps.filter(step => step.goalRevision === progress.goalRevision && step.kind !== 'verify' && step.status !== 'superseded')
  const { TaskBlockers } = await import('./blockers.mjs')
  const blockers = (await tx.doc(TaskBlockers, card.taskId)).items.filter(item => item.status === 'pending' && item.continuousBinding?.goalRevision === progress.goalRevision)
  const blockedSteps = new Set(blockers.map(item => item.continuousBinding.stepId))
  let selected = active.find(step => step.status === 'submitted')
  if (selected) { progress.currentStepId = selected.stepId; return next('continuousVerify', entryId) }
  selected = active.find(step => ['pending', 'active', 'blocked'].includes(step.status) && !blockedSteps.has(step.stepId) && step.dependsOn.every(id => active.find(other => other.stepId === id)?.status === 'verified'))
  if (selected) {
    selected.status = 'active'; progress.currentStepId = selected.stepId
    delete progress.completionRequest
    return next('reply', entryId)
  }
  if (active.length && active.every(step => step.status === 'verified') && current?.kind === 'verify') {
    current.status = 'active'
    return next('reply', entryId)
  }
  if (blockers.length) return next('awaitBlocker', entryId, { blockerId: blockers[0].id, waitingReason: 'user-blocker', lastOutcome: 'blocked' })
  if (!active.length) {
    const stepId = `execute-${progress.steps.filter(step => step.kind === 'execute').length + 1}`
    progress.planRevision += 1
    progress.steps.push({ stepId, kind: 'execute', title: '完成目标所需的实质工作', dependsOn: [],
      deliverable: '可回查成果及成功工具回执', verification: '按用户全部完成标准独立评审',
      criteriaIndices: card.taskState.completionCriteria.map((_, index) => index),
      status: 'active', goalRevision: card.taskState.goalRevision, planRevision: progress.planRevision, submissionRevision: 0, evidenceRefs: [] })
    progress.currentStepId = stepId
    await tx.appendEntry(card.conversationId, { kind: 'pidot.continuous-decision', data: {
      ...continuousBinding(card, progress), inReplyTo: entryId, action: 'execute', createdAt: new Date().toISOString() } }).then(entry => progress.decisionHistory.push(entry.id))
  }
  return next('reply', entryId)
}

async function currentEvidence(tx, card, progress, step, bots) {
  const access = await continuousEvidenceAccess(tx, card, card.executionPolicy.rootInputId, { bots })
  if (!access) return []
  const evidence = []
  const expected = { ...continuousBinding(card, progress), stepId: step.stepId, planRevision: step.submissionPlanRevision ?? step.planRevision ?? progress.planRevision }
  for (const entry of access.visible) {
    if (entry.kind !== 'pidot.tool-result') continue
    const checked = await resolveContinuousEvidence(tx, card, { taskId: card.taskId, entryId: entry.id }, expected, { bots, access })
    if (checked.ok) evidence.push(checked.evidence.ref)
  }
  return evidence
}

/** Text remains a stage output, never a lifecycle completion or a replacement for evidence. */
export async function stageContinuousReply(tx, card, entryId, { mode, content, execution }, bots) {
  const progress = await tx.doc(TaskProgress, card.taskId)
  const step = progress.steps.find(step => step.stepId === progress.currentStepId)
  if (!step || !['active', 'submitted', 'verified'].includes(step.status)) throw new Error('Continuous stage has no active step')
  const binding = continuousBinding(card, progress)
  if (step.status === 'active') {
    if (step.kind !== 'verify') step.evidenceRefs = await currentEvidence(tx, card, progress, step, bots)
    step.status = 'submitted'; step.submissionRevision += 1; step.submissionPlanRevision = progress.planRevision
  }
  const entry = await tx.appendEntry(card.conversationId, { kind: 'pidot.continuous-stage', data: {
    role: 'assistant', content, mode, inReplyTo: entryId, intermediate: true,
    continuousBinding: { ...binding, submissionRevision: step.submissionRevision },
    ...(execution ? { execution } : {}), createdAt: new Date().toISOString() } })
  step.outputEntryId = entry.id
  progress.evidenceRefs = [...progress.evidenceRefs, ...step.evidenceRefs].filter((ref, index, all) => all.findIndex(item => JSON.stringify(item) === JSON.stringify(ref)) === index)
  return next('continuousVerify', entryId, { stageEntryId: entry.id })
}

/** Both work_complete and stage reviews use the same host evidence/identity checks. */
export async function verifyContinuousStep(tx, card, entryId, bots, services = {}) {
  const progress = await tx.doc(TaskProgress, card.taskId)
  const step = progress.steps.find(item => item.stepId === progress.currentStepId)
  if (!step || step.goalRevision !== progress.goalRevision || step.status === 'superseded') {
    return { checkpoint: next('continuousDecide', entryId, { goalRevision: progress.goalRevision }) }
  }
  if (step.kind !== 'verify') {
    const stepId = `verify-${progress.steps.filter(item => item.kind === 'verify').length + 1}`
    progress.steps.push({ stepId, kind: 'verify', title: '逐条核验阶段标准', dependsOn: [step.stepId],
      deliverable: '带来源的逐条评审', verification: '宿主核对来源、修订和必要等待', status: 'active',
      goalRevision: card.taskState.goalRevision, submissionRevision: 0, evidenceRefs: [] })
    progress.currentStepId = stepId
    return { checkpoint: next('reply', entryId) }
  }
  const { TaskApprovals } = await import('./approvals.mjs'), { TaskBlockers } = await import('./blockers.mjs'), { Collaboration } = await import('./collaboration.mjs')
  const waiting = (await tx.doc(TaskApprovals, card.taskId)).items.some(item => item.inReplyTo === entryId && ['pending', 'unknown'].includes(item.status)) ||
    (await tx.doc(TaskBlockers, card.taskId)).items.some(item => item.inReplyTo === entryId && item.status === 'pending' && item.required !== false && (!item.continuousBinding || item.continuousBinding.goalRevision === progress.goalRevision)) ||
    (await tx.doc(Collaboration)).items.some(row => row.parentTaskId === card.taskId && row.parentInputId === entryId &&
      (!row.continuousBinding || row.continuousBinding.goalRevision === progress.goalRevision) && (!row.result || row.reviewRequired && row.businessStatus !== 'accepted'))
  const request = progress.completionRequest
  if (request?.requestedAtStepId === step.stepId && request.basis === 'model-review') {
    const budgetUsage = continuousBudgetUsage(await tx.doc(ContinuousBudget, card.taskId))
    if (budgetUsage.unknownTokenCalls || budgetUsage.inFlight) return { checkpoint: next('continuousWait', entryId, {
      rootTaskId: card.taskId, lastOutcome: budgetUsage.unknownTokenCalls ? 'limited' : 'waiting',
      waitingReason: budgetUsage.unknownTokenCalls ? 'unknown-tokens' : 'in-flight', controlWatchKey: await readContinuousControlWatchKey(tx, card.taskId) }) }
    const { resolveContinuousOrigin, publishContinuousOriginEvent } = await import('./continuous-origin.mjs')
    const resolvedOrigin = services.TaskCard ? await resolveContinuousOrigin(tx, card, { ...services, bots }) : null
    const result = await evaluateContinuousCompletion(tx, card, progress, request, { ...services, bots })
    if (result.accepted) {
      step.status = 'verified'
      progress.steps.find(item => item.stepId === request.stepId).status = 'verified'
      progress.finalOutcome = { status: 'completed', basis: result.basis, goalRevision: card.taskState.goalRevision, content: result.content, completedAt: new Date().toISOString() }
    } else step.status = 'blocked'
    const decision = await tx.appendEntry(card.conversationId, { kind: 'pidot.continuous-decision', data: {
      ...continuousBinding(card, progress), inReplyTo: entryId, accepted: result.accepted, basis: result.basis, reason: result.reason, createdAt: new Date().toISOString() } })
    progress.decisionHistory.push(decision.id)
    if (result.accepted) {
      if (resolvedOrigin) await publishContinuousOriginEvent(tx, card, { eventId: `final-${card.taskState.goalRevision}`,
        goalRevision: card.taskState.goalRevision, kind: 'completed', summary: result.content }, { ...services, bots, resolvedOrigin })
      return { content: result.content, evaluation: { ...result, entryId: decision.id } }
    }
    progress.steps.find(item => item.stepId === request.stepId).status = 'blocked'
    delete progress.completionRequest
    const evaluation = { ...result, entryId: decision.id }
    return { checkpoint: await recordStageProgress(tx, card, entryId, progress, evaluation, waiting), evaluation }
  }
  const source = progress.steps.find(item => item.stepId === step.dependsOn[0])
  const output = step.outputEntryId ? await tx.entry(step.outputEntryId) : null
  const { resolveContinuousOrigin, publishContinuousOriginEvent } = await import('./continuous-origin.mjs')
  const resolvedOrigin = services.TaskCard ? await resolveContinuousOrigin(tx, card, { ...services, bots }) : null
  let review
  try { review = JSON.parse(output?.data.content).stageReview } catch { /* plain output cannot self-verify */ }
  review ??= { basis: 'model-review', goalRevision: progress.goalRevision, planRevision: progress.planRevision, stepId: source.stepId,
    submissionRevision: source.submissionRevision, criteriaEvidence: [] }
  const evaluation = await applyContinuousSubmissionReview(tx, card, progress, review, { ...services, bots })
  if (resolvedOrigin && evaluation.accepted && !evaluation.replayed) await publishContinuousOriginEvent(tx, card, {
    eventId: `stage-${source.stepId}-${source.submissionRevision}`, goalRevision: card.taskState.goalRevision,
    kind: 'progress', summary: `阶段「${source.title}」已通过核验，整个目标仍在继续。`,
  }, { ...services, bots, resolvedOrigin })
  return { checkpoint: await recordStageProgress(tx, card, entryId, progress, evaluation, waiting), evaluation }
}

async function recordStageProgress(tx, card, entryId, progress, evaluation, waiting = false) {
  const rows = evaluation.accepted ? evaluation.evidence ?? [] : []
  const decision = recordContinuousProgress(progress, { evaluationId: evaluation.entryId, goalRevision: progress.goalRevision,
    evidenceKeys: rows.flatMap(row => row.evidence ?? []).map(item => item.fingerprint).filter(Boolean),
    verifiedCriteria: rows.map(row => `criterion:${row.index}`),
    // A step ID or renamed plan is not evidence that a dependency was resolved.
    resolvedDependencies: [], waiting })
  if (decision.reason) progress.stall.reason = decision.reason
  if (decision.action === 'replan') {
    progress.replanRequest = { evaluationId: evaluation.entryId, reason: decision.reason,
      gap: evaluation.reason, goalRevision: progress.goalRevision }
  }
  if (decision.action === 'blocked') return next('continuousWait', entryId, { rootTaskId: card.taskId,
    lastOutcome: 'blocked', waitingReason: 'stalled', controlWatchKey: await readContinuousControlWatchKey(tx, card.taskId) })
  return next('continuousDecide', entryId)
}

/** Called only after the real failed attempt has been settled, including unknown usage. */
export async function continuousModelFailure(tx, card, entryId, error, { attemptId, rootTaskId = card.executionPolicy?.rootTaskId, now = Date.now() } = {}) {
  if (!rootTaskId || !attemptId) return null
  const budget = await tx.doc(ContinuousBudget, rootTaskId), progress = await tx.doc(TaskProgress, card.taskId)
  const attempt = budget.attempts[attemptId]
  if (!attempt || attempt.taskId !== card.taskId || attempt.inputId !== entryId || attempt.kind !== 'model') throw new TaskInputError(409, 'CONTINUOUS_RECEIPT_BINDING', '失败调用没有对应的原派发预留。')
  const usage = continuousBudgetUsage(budget)
  if (usage.unknownTokenCalls || attempt.state !== 'settled') return { limited: 'unknown-tokens' }
  if (Object.values(budget.attempts).some(item => item.boundExceeded)) return { limited: 'token-bound-exceeded' }
  const decision = continuousRetryDecision({ error, retry: progress.retry, attemptId, now, deadlineAt: budget.deadlineAt })
  if (decision.action === 'fail') return null
  if (decision.action === 'limited') return { limited: decision.reason }
  progress.retry = decision.retry
  return next('continuousRetry', entryId, { rootTaskId, nextAttemptAt: decision.retry.nextAttemptAt,
    controlWatchKey: await readContinuousControlWatchKey(tx, rootTaskId) })
}

/** Timer and controls wake the existing Harness; neither path dispatches another model. */
export async function waitContinuousRetry(runtime, ctx, checkpoint) {
  if (continuousRetryDue(checkpoint)) return { due: true }
  const remaining = Date.parse(checkpoint.nextAttemptAt) - Date.now()
  if (!Number.isFinite(remaining)) throw new Error('Continuous retry requires a persisted wake time')
  const stop = new AbortController()
  const waitingRuntime = { taskId: runtime.taskId, signal: AbortSignal.any([runtime.signal, stop.signal]),
    watchDoc: (...args) => runtime.watchDoc(...args) }
  let timer
  const control = waitContinuousControlChange(waitingRuntime, ctx, { rootTaskId: checkpoint.rootTaskId, observed: checkpoint.controlWatchKey })
  try {
    await Promise.race([control, new Promise(resolve => {
      const wake = () => {
        const left = Date.parse(checkpoint.nextAttemptAt) - Date.now()
        if (left <= 0) resolve()
        else timer = setTimeout(wake, Math.min(Math.max(1, left), 2147483647))
      }
      timer = setTimeout(wake, Math.min(Math.max(1, remaining), 2147483647))
    })])
    return { due: continuousRetryDue(checkpoint) }
  } finally {
    clearTimeout(timer); stop.abort(new Error('Retry wait ended'))
    await control.catch(() => {})
  }
}

export async function continuousContext(tx, card, bots) {
  const projection = await buildContinuousContext(tx, card, card.executionPolicy?.rootInputId, { bots })
  return projection.prompt
}

export const CONTINUOUS_REVIEW_PROMPT = '\n持续目标只能通过work_complete请求最终完成。活动步骤kind=verify时，是独立评审阶段：不要重做成功动作；核对来源、精确提交版本和标准。若尚有后续必需步骤，仅返回内部阶段评审JSON：{"stageReview":{"basis":"model-review","goalRevision":当前目标版本,"planRevision":当前计划版本,"stepId":"源execute步骤ID","submissionRevision":源提交版本,"criteriaEvidence":[{"index":标准索引,"verdict":"satisfied或unsatisfied或needs-review","reason":"具体核验理由","evidenceRefs":[{"taskId":真实任务ID,"entryId":真实回执ID}]}]}}。如果全部标准满足，用work_complete逐条提交真实依据和最终交付。普通文字只是中间产出，永不自行结束目标；缺证据或主观质量未审应明确缺口。'

export async function waitContinuous(runtime, ctx) {
  const watch = await runtime.watchDoc(TaskProgress, runtime.taskId, ctx)
  let abort
  try {
    await new Promise((resolve, reject) => {
      const check = value => { if (!value.controlIntent && !value.finalOutcome) resolve() }
      abort = () => reject(runtime.signal.reason ?? new Error('Invocation stopped'))
      runtime.signal.addEventListener('abort', abort, { once: true })
      if (runtime.signal.aborted) return abort()
      check(watch.value); watch.start(check)
      void watch.closed.then(() => reject(new Error('Continuous watch closed')))
    })
  } finally { runtime.signal.removeEventListener('abort', abort); await watch.stop() }
}
