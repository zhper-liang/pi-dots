import { validContinuousCall } from './continuous-work-tools.mjs'
export { CONTINUOUS_TOOLS, continuousTools, validContinuousCall } from './continuous-work-tools.mjs'
import { createHash } from 'node:crypto'
import { TaskProgress, isContinuousTask } from './continuous-task.mjs'
import { TaskInputError, currentTaskState } from './task-config.mjs'
import { validContinuousEvidenceRef, validateContinuousEvidence } from './continuous-evidence.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 40 && value.every(validContinuousEvidenceRef)
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const signature = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const fail = (code, message) => { throw new TaskInputError(409, code, message) }

function validatePlan(steps, currentStepId, count, oldSteps) {
  const ids = new Set(steps.map(step => step.stepId))
  if (ids.size !== steps.length || !ids.has(currentStepId)) fail('CONTINUOUS_PLAN_INVALID', '步骤ID须唯一且下一步必须存在。')
  const visiting = new Set(), done = new Set(), byId = new Map(steps.map(step => [step.stepId, step]))
  const visit = step => {
    if (visiting.has(step.stepId)) fail('CONTINUOUS_PLAN_INVALID', '步骤依赖不能成环。')
    if (done.has(step.stepId)) return
    visiting.add(step.stepId)
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) fail('CONTINUOUS_PLAN_INVALID', '依赖必须引用本目标的已有步骤。')
      visit(byId.get(dep))
    }
    visiting.delete(step.stepId); done.add(step.stepId)
  }
  for (const step of steps) {
    if (step.criteriaIndices.some(index => index >= count)) fail('CONTINUOUS_PLAN_INVALID', '步骤只能关联当前用户完成标准。')
    visit(step)
  }
  for (const old of oldSteps.filter(step => step.kind !== 'verify' && ['submitted', 'verified'].includes(step.status))) {
    const current = byId.get(old.stepId)
    if (!current || ['title', 'deliverable', 'verification', 'dependsOn', 'criteriaIndices'].some(key =>
      JSON.stringify(current[key]) !== JSON.stringify(old[key] ?? (key === 'criteriaIndices' ? Array.from({ length: count }, (_, index) => index) : undefined)))) {
      fail('CONTINUOUS_PLAN_IMMUTABLE', '已提交或已核验步骤不能删除或覆盖；请增加补充步骤。')
    }
  }
  const selected = oldSteps.find(step => step.stepId === currentStepId)
  if (selected && ['submitted', 'verified', 'superseded'].includes(selected.status) || byId.get(currentStepId).dependsOn.some(dep =>
    oldSteps.find(step => step.stepId === dep)?.status !== 'verified')) fail('CONTINUOUS_STEP_NOT_READY', '下一步必须未提交且所有前置已核验。')
  const covered = new Set(steps.flatMap(step => step.criteriaIndices))
  if (covered.size !== count) fail('CONTINUOUS_PLAN_INCOMPLETE', '计划必须保留每项用户完成标准。')
}

const bindingFor = (card, progress, step) => ({ rootTaskId: card.executionPolicy.rootTaskId, rootInputId: card.executionPolicy.rootInputId,
  goalRevision: progress.goalRevision, planRevision: step.submissionPlanRevision ?? step.planRevision ?? progress.planRevision,
  stepId: step.stepId, submissionRevision: step.submissionRevision })

async function submittedEvidence(tx, card, progress, evidenceRefs, services) {
  if (!refs(evidenceRefs)) return { ok: false }
  const evidence = []
  for (const ref of evidenceRefs) {
    const owner = progress.steps.find(step => step.kind !== 'verify' && step.goalRevision === progress.goalRevision &&
      ['submitted', 'verified'].includes(step.status) && step.evidenceRefs.some(item => signature(item) === signature(ref)))
    if (!owner) return { ok: false }
    const checked = await validateContinuousEvidence(tx, card, [ref], bindingFor(card, progress, owner), services)
    if (!checked.ok) return checked
    evidence.push(...checked.evidence)
  }
  return { ok: true, evidence }
}

/** Called after the common live dispatch guard, inside the same Harness commit as its receipt. */
export async function executeContinuousWork(tx, card, call, inputId, services = {}) {
  if (!isContinuousTask(card) || card.executionPolicy.rootTaskId !== card.taskId || card.executionPolicy.rootInputId !== inputId || !validContinuousCall(call)) {
    fail('CONTINUOUS_WORK_DENIED', '工作工具只接受当前持续根目标的有效输入和受控参数。')
  }
  const progress = await tx.doc(TaskProgress, card.taskId), a = call.arguments
  if (progress.finalOutcome || progress.controlIntent || progress.pendingGoalRevision) fail('CONTINUOUS_WORK_CLOSED', '当前目标已结束、受控暂停或正在修订。')
  const hash = signature({ tool: call.name, arguments: a }), prior = progress.workRequests?.[a.requestId]
  if (prior) {
    if (prior.signature !== hash) fail('CONTINUOUS_REQUEST_CONFLICT', '同一requestId不能更换工作内容。')
    // Replays return only bounded IDs/state; original source-derived text is not replayed.
    return { ok: true, data: { ...copy(prior.result), replayed: true } }
  }
  if (a.goalRevision !== card.taskState.goalRevision || a.goalRevision !== progress.goalRevision) fail('CONTINUOUS_REVISION_CONFLICT', '目标修订已变化，请根据当前目标重新规划。')
  const state = currentTaskState(card), current = progress.steps.find(step => step.stepId === progress.currentStepId)
  let data
  if (call.name === 'work_plan') {
    if (a.expectedPlanRevision !== progress.planRevision) fail('CONTINUOUS_REVISION_CONFLICT', '计划修订已变化。')
    if (current?.kind === 'verify' && !['verified', 'blocked'].includes(current.status)) fail('CONTINUOUS_REVIEW_REQUIRED', '核验阶段不能自行替换被评审计划。')
    if (a.steps.some(step => progress.steps.some(old => old.stepId === step.stepId &&
      (old.goalRevision !== a.goalRevision || old.kind === 'verify')))) fail('CONTINUOUS_PLAN_INVALID', '不能重用旧目标或宿主核验步骤ID。')
    validatePlan(a.steps, a.currentStepId, state.completionCriteria.length,
      progress.steps.filter(step => step.goalRevision === a.goalRevision))
    const { TaskBlockers } = await import('./blockers.mjs')
    const pending = new Set((await tx.doc(TaskBlockers, card.taskId)).items.filter(item => item.status === 'pending' &&
      item.continuousBinding?.goalRevision === a.goalRevision).map(item => item.continuousBinding.stepId))
    const protectedSteps = new Set(pending)
    let expanded = true
    while (expanded) {
      expanded = false
      for (const step of progress.steps.filter(row => row.goalRevision === a.goalRevision && row.kind !== 'verify')) {
        if (!protectedSteps.has(step.stepId) && step.dependsOn.some(id => protectedSteps.has(id))) { protectedSteps.add(step.stepId); expanded = true }
      }
    }
    for (const stepId of protectedSteps) {
      const previous = progress.steps.find(step => step.stepId === stepId), proposed = a.steps.find(step => step.stepId === stepId)
      if (!proposed || ['dependsOn', 'criteriaIndices'].some(key => signature(proposed[key]) !== signature(previous[key]))) fail('CONTINUOUS_PLAN_BLOCKED', '必要问题及依赖步骤必须保留原依赖和完成标准，不能通过改计划绕过。')
    }
    if (pending.has(a.currentStepId)) fail('CONTINUOUS_STEP_NOT_READY', '当前步骤仍有未回答的必要问题。')
    const old = new Map(progress.steps.map(step => [step.stepId, step])), planRevision = progress.planRevision + 1
    progress.steps = a.steps.map(step => ({ ...copy(step), kind: old.get(step.stepId)?.kind ?? 'execute',
      goalRevision: a.goalRevision, submissionRevision: old.get(step.stepId)?.submissionRevision ?? 0,
      evidenceRefs: copy(old.get(step.stepId)?.evidenceRefs ?? []), ...(['submitted', 'verified'].includes(old.get(step.stepId)?.status)
        ? copy(old.get(step.stepId)) : { planRevision, status: pending.has(step.stepId) ? 'blocked' : step.stepId === a.currentStepId ? 'active' : 'pending' }) }))
    progress.steps.push(...[...old.values()].filter(step => step.kind === 'verify' && step.goalRevision === a.goalRevision))
    progress.steps.push(...[...old.values()].filter(step => step.goalRevision !== a.goalRevision).map(step =>
      step.status === 'superseded' ? copy(step) : { ...copy(step), previousStatus: step.status, status: 'superseded' }))
    progress.planRevision = planRevision; progress.currentStepId = a.currentStepId
    delete progress.replanRequest
    data = { planRevision, goalRevision: a.goalRevision, currentStepId: a.currentStepId }
  } else {
    if (a.planRevision !== progress.planRevision) fail('CONTINUOUS_REVISION_CONFLICT', '计划修订已变化。')
    const source = progress.steps.find(step => step.stepId === a.stepId && step.goalRevision === a.goalRevision)
    if (!source) fail('CONTINUOUS_STEP_NOT_FOUND', '当前目标没有该步骤。')
    if (call.name === 'work_submit') {
      if (source !== current || source.kind === 'verify' || source.status !== 'active' || source.dependsOn.some(dep => progress.steps.find(step => step.stepId === dep)?.status !== 'verified')) fail('CONTINUOUS_STEP_NOT_READY', '只能提交当前可执行步骤。')
      const checked = await validateContinuousEvidence(tx, card, a.evidenceRefs,
        { ...bindingFor(card, progress, source), submissionRevision: source.submissionRevision + 1 }, services)
      if (!checked.ok) fail('CONTINUOUS_EVIDENCE_UNAVAILABLE', checked.error.message)
      source.status = 'submitted'; source.submissionRevision += 1; source.submissionPlanRevision = a.planRevision
      source.evidenceRefs = copy(a.evidenceRefs); source.summary = a.summary
      progress.evidenceRefs = [...(progress.evidenceRefs ?? []), ...a.evidenceRefs].filter((ref, index, all) => all.findIndex(item => signature(item) === signature(ref)) === index)
      data = { goalRevision: a.goalRevision, planRevision: a.planRevision, stepId: source.stepId, submissionRevision: source.submissionRevision, status: 'submitted' }
    } else {
      if (!['submitted', 'verified'].includes(source.status) || source.submissionRevision !== a.submissionRevision ||
        a.criteriaEvidence.length !== state.completionCriteria.length || state.completionCriteria.some((_, index) => a.criteriaEvidence.filter(row => row.index === index).length !== 1)) fail('CONTINUOUS_COMPLETION_INCOMPLETE', '完成请求必须绑定精确已提交修订并覆盖全部当前标准。')
      for (const row of a.criteriaEvidence) {
        const checked = await submittedEvidence(tx, card, progress, row.evidenceRefs, services)
        if (!checked.ok) fail('CONTINUOUS_EVIDENCE_UNAVAILABLE', '证据不存在、修订不匹配、覆盖不足或当前不可访问。')
      }
      progress.completionRequest = { ...copy(a), requestedAtStepId: current?.stepId, basis: current?.kind === 'verify' ? 'model-review' : 'executor-report' }
      data = { goalRevision: a.goalRevision, planRevision: a.planRevision, stepId: source.stepId, submissionRevision: source.submissionRevision,
        status: 'completion-requested', requiresReview: true }
    }
  }
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.continuous-work', data: {
    toolName: call.name, requestId: a.requestId, inReplyTo: inputId, ...copy(data), createdAt: new Date().toISOString(),
    ...(call.name === 'work_plan' ? { steps: copy(a.steps) } : call.name === 'work_submit' ? { summary: a.summary, evidenceRefs: copy(a.evidenceRefs) } : { request: copy(progress.completionRequest) }) } })
  data.entryId = audit.id
  if (call.name === 'work_submit') progress.steps.find(step => step.stepId === a.stepId).submissionEntryId = audit.id
  ;(progress.workRequests ??= {})[a.requestId] = { signature: hash, result: copy(data) }
  return { ok: true, data: { ...data, replayed: false } }
}

/** A host check result, never a lifecycle mutation or authorization. Called again at final settlement. */
export async function evaluateContinuousCompletion(tx, card, progress, request = progress.completionRequest, services = {}) {
  const missing = reason => ({ accepted: false, basis: 'model-review', reason })
  const current = progress.steps.find(step => step.stepId === progress.currentStepId)
  const source = progress.steps.find(step => step.stepId === request?.stepId)
  const criteria = currentTaskState(card).completionCriteria
  if (!request || progress.finalOutcome || progress.controlIntent || progress.pendingGoalRevision || request.basis !== 'model-review' ||
    current?.kind !== 'verify' || request.requestedAtStepId !== current.stepId || !current.dependsOn.includes(source?.stepId) ||
    request.goalRevision !== card.taskState.goalRevision || request.goalRevision !== progress.goalRevision || request.planRevision !== progress.planRevision ||
    !source || !['submitted', 'verified'].includes(source.status) || source.submissionRevision !== request.submissionRevision ||
    !Array.isArray(request.criteriaEvidence) || request.criteriaEvidence.length !== criteria.length || !text(request.summary, 4000)) return missing('缺少精确修订的独立评审请求。')
  if (progress.steps.some(step => step.goalRevision === progress.goalRevision && step.kind !== 'verify' && step !== source &&
    !['verified', 'superseded'].includes(step.status))) return missing('仍有必需步骤尚未核验。')
  const { TaskApprovals } = await import('./approvals.mjs'), { TaskBlockers } = await import('./blockers.mjs'), { Collaboration } = await import('./collaboration.mjs'), { CallUsage } = await import('./tools.mjs')
  const approvals = await tx.doc(TaskApprovals, card.taskId), blockers = await tx.doc(TaskBlockers, card.taskId)
  const children = (await tx.doc(Collaboration)).items.filter(row => row.parentTaskId === card.taskId && row.parentInputId === card.executionPolicy.rootInputId)
  // Superseded work is audit history, but an unknown side effect remains unresolved risk.
  for (const child of children.filter(row => row.continuousBinding && row.continuousBinding.goalRevision !== progress.goalRevision)) {
    const record = await tx.task(child.childTaskId)
    const archive = record?.state.status === 'terminal' ? await (await import('./cancellation.mjs')).readCancelledArchive(tx, child.childTaskId) : null
    const priorApprovals = archive?.documents[TaskApprovals.definition.kind] ?? (record?.state.status === 'terminal' ? null : await tx.doc(TaskApprovals, child.childTaskId))
    if (!priorApprovals || priorApprovals.items.some(item => item.status === 'unknown' || item.operation && !item.receipt || item.receipt?.error?.unknown)) return missing('旧目标执行仍有未核实的外部操作结果。')
  }
  if (approvals.items.some(item => item.inReplyTo === card.executionPolicy.rootInputId &&
    (['pending', 'unknown'].includes(item.status) || item.operation && !item.receipt)) ||
    blockers.items.some(item => item.inReplyTo === card.executionPolicy.rootInputId && item.status === 'pending' && item.required !== false &&
      (!item.continuousBinding || item.continuousBinding.goalRevision === progress.goalRevision)) ||
    children.some(row => (!row.continuousBinding || row.continuousBinding.goalRevision === progress.goalRevision) && (!row.result || row.reviewRequired && row.businessStatus !== 'accepted')) ||
    (await tx.doc(CallUsage, card.taskId)).unknownTokenCalls > 0) return missing('仍有必要问题、审批、未知操作或未验收子结果。')
  const evidence = []
  for (let index = 0; index < criteria.length; index++) {
    const rows = request.criteriaEvidence.filter(row => row.index === index)
    if (rows.length !== 1 || rows[0].verdict !== 'satisfied' || !text(rows[0].reason, 2000)) return missing('仍有当前完成标准缺少核验或需要评审。')
    const checked = await submittedEvidence(tx, card, progress, rows[0].evidenceRefs, services)
    if (!checked.ok) return missing('完成依据当前不可用；请重新取得合法证据。')
    if (checked.evidence.some(item => item.kind === 'artifact-record' && !item.artifactVersion)) return missing('文件产物缺少当前可回查的完整读取版本；请读取并核对成果。')
    evidence.push({ index, basis: 'model-review', evidence: checked.evidence })
  }
  return { accepted: true, basis: 'model-review', content: request.summary, evidence, reason: '全部当前标准有精确修订的独立模型评审及合法来源；主观质量不是确定性证明。' }
}

/** Per-stage review unlocks dependencies without asserting that the whole goal is complete. */
export async function evaluateContinuousSubmission(tx, card, progress, review, services = {}) {
  const reject = reason => ({ accepted: false, basis: 'model-review', reason })
  const current = progress.steps.find(step => step.stepId === progress.currentStepId)
  const source = progress.steps.find(step => step.stepId === review?.stepId)
  if (!review || review.basis !== 'model-review' || current?.kind !== 'verify' || !current.dependsOn.includes(source?.stepId) ||
    review.goalRevision !== card.taskState.goalRevision || review.goalRevision !== progress.goalRevision || review.planRevision !== progress.planRevision ||
    !source || !['submitted', 'verified'].includes(source.status) || source.submissionRevision !== review.submissionRevision ||
    progress.controlIntent || progress.pendingGoalRevision || progress.finalOutcome || !Array.isArray(review.criteriaEvidence)) return reject('缺少精确修订的独立阶段评审。')
  const indices = source.criteriaIndices ?? currentTaskState(card).completionCriteria.map((_, index) => index)
  const evidence = []
  for (const index of indices) {
    const rows = review.criteriaEvidence.filter(row => row.index === index)
    if (rows.length !== 1 || rows[0].verdict !== 'satisfied' || !text(rows[0].reason, 2000)) return reject('本阶段标准仍有缺口或需要进一步评审。')
    const checked = await validateContinuousEvidence(tx, card, rows[0].evidenceRefs, bindingFor(card, progress, source), services)
    if (!checked.ok) return reject('本阶段依据当前不可用；不能按旧资料验收。')
    if (checked.evidence.some(item => item.kind === 'artifact-record' && !item.artifactVersion)) return reject('本阶段文件成果缺少可回查的完整读取版本。')
    evidence.push({ index, basis: 'model-review', evidence: checked.evidence })
  }
  return { accepted: true, basis: 'model-review', stepId: source.stepId, submissionRevision: source.submissionRevision,
    evidence, reason: '本阶段标准有绑定独立评审及合法来源；其余目标标准仍需单独核验。' }
}

/** Host-only entry, not a model tool. The reviewer is the separately scheduled verify stage. */
export async function applyContinuousSubmissionReview(tx, card, progress, review, services = {}) {
  const current = progress.steps.find(step => step.stepId === progress.currentStepId)
  const source = progress.steps.find(step => step.stepId === review?.stepId)
  if (!current || !source) fail('CONTINUOUS_REVIEW_REQUIRED', '没有精确绑定的阶段评审。')
  const key = `${current.stepId}:${source.submissionRevision}`, hash = signature(review), prior = progress.stageReviews?.[key]
  if (prior) {
    if (prior.signature !== hash) fail('CONTINUOUS_REQUEST_CONFLICT', '同一阶段评审不能覆盖已保存决定。')
    const fresh = await evaluateContinuousSubmission(tx, card, progress, review, services)
    return { ...fresh, entryId: prior.result.entryId, replayed: true }
  }
  const result = await evaluateContinuousSubmission(tx, card, progress, review, services)
  source.status = result.accepted ? 'verified' : 'blocked'
  current.status = result.accepted ? 'verified' : 'blocked'
  const entry = await tx.appendEntry(card.conversationId, { kind: 'pidot.continuous-decision', data: {
    ...bindingFor(card, progress, source), inReplyTo: card.executionPolicy.rootInputId, reviewerStepId: current.stepId,
    accepted: result.accepted, basis: result.basis, reason: result.reason, createdAt: new Date().toISOString() } })
  progress.decisionHistory.push(entry.id)
  const response = { ...result, entryId: entry.id }
  ;(progress.stageReviews ??= {})[key] = { signature: hash, result: copy(response) }
  return response
}
