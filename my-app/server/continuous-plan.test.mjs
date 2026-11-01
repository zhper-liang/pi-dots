import test from 'node:test'
import assert from 'node:assert/strict'
import { continuousWorkFixture } from './fixtures/continuous-work-fixture.mjs'
import { executeContinuousWork, validContinuousCall, evaluateContinuousCompletion, applyContinuousSubmissionReview } from './continuous-plan.mjs'

const call = (name, args) => ({ name, arguments: args })
const step = (stepId, dependsOn = [], criteriaIndices = [0, 1]) => ({ stepId, title: stepId, dependsOn, criteriaIndices, deliverable: '可回查报告', verification: '出处核对及独立文档评审' })
const plan = (steps, currentStepId = steps[0].stepId) => call('work_plan', { requestId: 'plan-1', expectedPlanRevision: 1, goalRevision: 1, steps, currentStepId })
const submit = (ref, extra = {}) => call('work_submit', { requestId: 'submit-1', goalRevision: 1, planRevision: 1, stepId: 'draft', summary: '报告草稿已保存，等待独立质量核验', evidenceRefs: [ref], ...extra })
const review = (ref, extra = {}) => ({ basis: 'model-review', stepId: 'draft', goalRevision: 1, planRevision: 1, submissionRevision: 1,
  criteriaEvidence: [0, 1].map(index => ({ index, verdict: 'satisfied', reason: index === 0 ? '逐项核对真实出处' : '独立检查正文完整性', evidenceRefs: [ref] })), ...extra })

test('plans retain user criteria, reject cycles/foreign dependencies and select only dependency-ready steps', async () => {
  const f = continuousWorkFixture(), initial = structuredClone(f.card.taskState)
  for (const proposed of [plan([step('a', ['b']), step('b', ['a'])]), plan([step('a', ['other-task-step'])]),
    plan([step('a'), step('a')]), plan([step('a', [], [0])]), plan([step('a'), step('b', ['a'])], 'b')]) {
    await assert.rejects(executeContinuousWork(f.tx, f.card, proposed, 10, { bots: f.bots }), { status: 409 })
    assert.deepEqual(f.card.taskState, initial)
  }
  const result = await executeContinuousWork(f.tx, f.card, plan([step('a', [], [0]), step('b', ['a'], [1])]), 10, { bots: f.bots })
  assert.equal(result.data.planRevision, 2)
  assert.equal(f.progress.steps.find(step => step.stepId === 'a').status, 'active')
  assert.equal(f.progress.steps.find(step => step.stepId === 'b').status, 'pending')
  assert.deepEqual(f.card.taskState, initial)
  const invalid = plan([step('a')])
  invalid.arguments.completionCriteria = []
  assert.equal(validContinuousCall(invalid), false)
})

test('work request identity is idempotent across persistence reconstruction and conflicts do not change submitted data', async () => {
  const f = continuousWorkFixture(), ref = f.receipt(), proposed = submit(ref)
  const first = await executeContinuousWork(f.tx, f.card, proposed, 10, { bots: f.bots }), count = f.entries.length
  // Reconstruct the durable document rather than using a transient in-memory completed flag.
  Object.assign(f.progress, JSON.parse(JSON.stringify(f.progress)))
  const repeated = await executeContinuousWork(f.tx, f.card, proposed, 10, { bots: f.bots })
  assert.equal(repeated.data.replayed, true)
  assert.equal(repeated.data.entryId, first.data.entryId)
  assert.equal(f.entries.length, count)
  assert.equal(f.progress.steps[0].submissionRevision, 1)
  assert.equal(f.progress.steps[0].status, 'submitted')
  assert.equal(f.progress.finalOutcome, null)
  await assert.rejects(executeContinuousWork(f.tx, f.card, submit(ref, { summary: '更换内容' }), 10), { code: 'CONTINUOUS_REQUEST_CONFLICT' })
  f.card.taskState.goalRevision = 2
  assert.equal((await executeContinuousWork(f.tx, f.card, proposed, 10)).data.replayed, true)
  assert.equal(f.progress.steps[0].submissionRevision, 1)
})

test('cross-target, stale and self-verified submissions never pass the controlled tool contract', async () => {
  const f = continuousWorkFixture(), ref = f.receipt()
  assert.equal(validContinuousCall(submit(ref, { status: 'verified' })), false)
  assert.equal(validContinuousCall(submit(ref, { finalOutcome: { status: 'completed' } })), false)
  assert.equal(validContinuousCall(submit(ref, { requestId: '__proto__' })), false)
  await assert.rejects(executeContinuousWork(f.tx, f.card, submit({ taskId: 2, entryId: ref.entryId }), 10, { bots: f.bots }), { code: 'CONTINUOUS_EVIDENCE_UNAVAILABLE' })
  await assert.rejects(executeContinuousWork(f.tx, f.card, submit(ref, { planRevision: 2 }), 10), { code: 'CONTINUOUS_REVISION_CONFLICT' })
  await assert.rejects(executeContinuousWork(f.tx, f.card, submit(ref), 11), { code: 'CONTINUOUS_WORK_DENIED' })
  assert.equal(f.progress.steps[0].status, 'active')
})

test('submission and whole-goal request do not self-accept; separately scheduled review permits only exact criteria and source revision', async () => {
  const f = continuousWorkFixture(), ref = f.receipt()
  f.confirmArtifact(ref)
  await executeContinuousWork(f.tx, f.card, submit(ref), 10, { bots: f.bots })
  const complete = call('work_complete', { requestId: 'complete-executor', goalRevision: 1, planRevision: 1, stepId: 'draft', submissionRevision: 1,
    criteriaEvidence: review(ref).criteriaEvidence, summary: '提供报告和可回查出处' })
  await executeContinuousWork(f.tx, f.card, complete, 10, { bots: f.bots })
  assert.equal((await evaluateContinuousCompletion(f.tx, f.card, f.progress, undefined, { bots: f.bots })).accepted, false)
  assert.equal(f.progress.finalOutcome, null)
  f.progress.steps.push({ stepId: 'review-1', kind: 'verify', goalRevision: 1, dependsOn: ['draft'], status: 'active', submissionRevision: 0, evidenceRefs: [] })
  f.progress.currentStepId = 'review-1'
  await executeContinuousWork(f.tx, f.card, { ...complete, arguments: { ...complete.arguments, requestId: 'complete-review' } }, 10, { bots: f.bots })
  const accepted = await evaluateContinuousCompletion(f.tx, f.card, f.progress, undefined, { bots: f.bots })
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.basis, 'model-review')
  assert.equal(f.progress.finalOutcome, null)
  f.progress.steps[0].submissionRevision = 2
  assert.equal((await evaluateContinuousCompletion(f.tx, f.card, f.progress, undefined, { bots: f.bots })).accepted, false)
})

test('necessary unresolved questions, operations, pending steps and source revocation prevent final acceptance', async () => {
  const f = continuousWorkFixture(), ref = f.receipt('calendar_read_schedule', { date: '2026-11-02', resource: 'mock:personal' }, { ok: true, data: { events: [] } })
  await executeContinuousWork(f.tx, f.card, submit(ref), 10, { bots: f.bots })
  f.progress.steps.push({ stepId: 'review-1', kind: 'verify', goalRevision: 1, dependsOn: ['draft'], status: 'active', submissionRevision: 0, evidenceRefs: [] })
  f.progress.currentStepId = 'review-1'
  f.progress.completionRequest = { ...review(ref), requestedAtStepId: 'review-1', summary: '结果' }
  const check = () => evaluateContinuousCompletion(f.tx, f.card, f.progress, undefined, { bots: f.bots })
  assert.equal((await check()).accepted, true)
  const { TaskBlockers } = await import('./blockers.mjs')
  const blockers = await f.tx.doc(TaskBlockers, 1)
  blockers.items.push({ inReplyTo: 10, status: 'pending' })
  assert.equal((await check()).accepted, false)
  blockers.items.length = 0
  f.progress.steps.push({ stepId: 'required-next', kind: 'execute', goalRevision: 1, status: 'pending' })
  assert.equal((await check()).accepted, false)
  f.progress.steps.pop()
  f.access.assignments.chief.resources = []
  assert.equal((await check()).accepted, false)
})

test('per-stage independent review unlocks dependencies without claiming whole-goal success and cannot overwrite a decision', async () => {
  const f = continuousWorkFixture()
  f.progress.steps[0].criteriaIndices = [0]
  const ref = f.receipt()
  f.confirmArtifact(ref)
  await executeContinuousWork(f.tx, f.card, submit(ref), 10, { bots: f.bots })
  f.progress.steps.push({ stepId: 'review-1', kind: 'verify', goalRevision: 1, dependsOn: ['draft'], status: 'active', submissionRevision: 0, evidenceRefs: [] })
  f.progress.currentStepId = 'review-1'
  const assessment = review(ref, { criteriaEvidence: [review(ref).criteriaEvidence[0]] })
  const first = await applyContinuousSubmissionReview(f.tx, f.card, f.progress, assessment, { bots: f.bots })
  assert.equal(first.accepted, true)
  assert.equal(f.progress.steps[0].status, 'verified')
  assert.equal(f.progress.finalOutcome, null)
  const count = f.entries.length
  assert.equal((await applyContinuousSubmissionReview(f.tx, f.card, f.progress, assessment, { bots: f.bots })).replayed, true)
  assert.equal(f.entries.length, count)
  await assert.rejects(applyContinuousSubmissionReview(f.tx, f.card, f.progress, { ...assessment, criteriaEvidence: [] }), { code: 'CONTINUOUS_REQUEST_CONFLICT' })
})

test('a new goal plan retains superseded prior-goal submissions and their immutable evidence bindings', async () => {
  const f = continuousWorkFixture(), ref = f.receipt()
  await executeContinuousWork(f.tx, f.card, submit(ref), 10, { bots: f.bots })
  f.card.taskState.goalRevision = 2
  f.progress.goalRevision = 2
  const replacement = plan([step('revised-draft')])
  replacement.arguments.goalRevision = 2
  await executeContinuousWork(f.tx, f.card, replacement, 10, { bots: f.bots })
  const retained = f.progress.steps.find(step => step.stepId === 'draft')
  assert.equal(retained.status, 'superseded')
  assert.equal(retained.previousStatus, 'submitted')
  assert.equal(retained.goalRevision, 1)
  assert.deepEqual(retained.evidenceRefs, [ref])
  assert.equal(retained.submissionRevision, 1)
  assert.equal(f.progress.currentStepId, 'revised-draft')
})
