import test from 'node:test'
import assert from 'node:assert/strict'
import { continuousCollaborationFixture } from './fixtures/continuous-collaboration-fixture.mjs'
import { resolveContinuousChildEvidence, Collaboration } from './collaboration.mjs'
import { TaskProgress, ContinuousBudget } from './continuous-task.mjs'
import { TaskApprovals } from './approvals.mjs'
import { TaskBlockers } from './blockers.mjs'
import { TaskCard, ChatInput } from './tasks.mjs'
import { CallUsage, ToolAccess } from './tools.mjs'
const copy=value=>JSON.parse(JSON.stringify(value))

test('LR06 child submitted is not accepted or root complete; exact review yields independently reviewed evidence', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root(), child = (await f.assign(root)).data
  const relation = await f.publish(child)
  assert.equal(relation.businessStatus, 'submitted')
  assert.equal(relation.result.evidenceRefs.length, 1)
  const ref = { kind: 'child-result', relationId: relation.id, revision: 1 }, binding = relation.continuousBinding
  const resolve = expected => f.tx(tx => resolveContinuousChildEvidence(tx, root, ref, expected, f.services))
  assert.equal((await resolve(binding)).ok, false)
  const decision = await f.review(root, relation)
  assert.deepEqual(decision.data.continuousBinding, binding)
  assert.equal((await f.review(root, relation)).replayed, true)
  const checked = await resolve(binding)
  assert.equal(checked.ok, true)
  assert.equal(checked.evidence.kind, 'independent-review')
  assert.equal((await resolve({ ...binding, stepId: 'wrong-step' })).ok, false)
  assert.equal((await f.tx(tx => tx.doc(TaskProgress, root.taskId))).finalOutcome, null)
  assert.equal((await f.tx(tx => tx.doc(ChatInput, root.taskId))).entryId, root.executionPolicy.rootInputId)
})

test('LR06 no evidence, wrong binding, stale result and necessary unknown/problem cannot be accepted', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root(), child = (await f.assign(root)).data
  let relation = await f.publish(child, { evidence: false })
  await assert.rejects(f.review(root, relation), { code: 'CONTINUOUS_EVIDENCE_UNAVAILABLE' })
  await f.tx(async tx => { (await tx.doc(Collaboration)).items[0].result = null })
  relation = await f.publish(child)
  await assert.rejects(f.review(root, relation, { continuousBinding: { ...relation.continuousBinding, goalRevision: 9 } }), { code: 'REVIEW_STALE' })
  await assert.rejects(f.review(root, relation, { revision: 99 }), { code: 'REVIEW_STALE' })
  await f.tx(async tx => { (await tx.doc(TaskApprovals, child.childTaskId)).items.push({ operation: { id: 'unknown-write' }, receipt: null }) })
  await assert.rejects(f.review(root, relation), { code: 'REVIEW_CHILD_BUSY' })
  await f.tx(async tx => { (await tx.doc(TaskApprovals,child.childTaskId)).items=[{status:'unknown',operation:{id:'unknown-write'},receipt:{ok:false,error:{unknown:true}}}] })
  await assert.rejects(f.review(root,relation),{code:'REVIEW_CHILD_BUSY'})
  await f.tx(async tx => {
    ;(await tx.doc(TaskApprovals, child.childTaskId)).items = []
    ;(await tx.doc(TaskBlockers, child.childTaskId)).items.push({ status: 'pending' })
  })
  await assert.rejects(f.review(root, relation), { code: 'REVIEW_CHILD_BUSY' })
})

test('LR06 rework stays on the same task/input with durable two-round limit and preserved usage', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root(), child = (await f.assign(root)).data
  const member = await f.tx(async tx => copy((await tx.doc(ContinuousBudget, root.taskId)).members[child.childTaskId]))
  for (let round = 1; round <= 2; round++) {
    const relation = await f.publish(child)
    const response = await f.review(root, relation, { decision: 'request-rework' })
    assert.equal(response.data.childTaskId, child.childTaskId)
    assert.equal((await f.review(root, relation, { decision: 'request-rework' })).replayed, true)
    assert.equal((await f.tx(tx => tx.doc(ChatInput, child.childTaskId))).entryId, child.childInputId)
    assert.equal((await f.tx(tx => tx.doc(CallUsage, child.childTaskId))).toolCalls, round)
  }
  await f.restart()
  const relation = await f.publish(child)
  await assert.rejects(f.review(root, relation, { decision: 'request-rework' }), { code: 'REVIEW_REWORK_LIMIT' })
  await f.tx(async tx => {
    assert.equal((await tx.doc(Collaboration)).items.length, 1)
    assert.equal((await tx.doc(Collaboration)).items[0].reworkCount, 2)
    assert.deepEqual((await tx.doc(ContinuousBudget, root.taskId)).members[child.childTaskId], member)
    assert.equal((await tx.doc(CallUsage, child.childTaskId)).toolCalls, 3)
  })
})

test('LR06 old-goal late child result stays old and cannot be accepted as the new goal', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root(), child = (await f.assign(root)).data
  await f.tx(async tx => {
    ;(await tx.doc(TaskCard, root.taskId)).taskState.goalRevision = 2
    ;(await tx.doc(TaskProgress, root.taskId)).goalRevision = 2
  })
  const relation = await f.publish(child)
  assert.equal(relation.result.continuousBinding.goalRevision, 1)
  await assert.rejects(f.review(root, relation), { code: 'REVIEW_STALE' })
  await assert.rejects(f.tx(tx => f.collaboration.guard(tx, child.childTaskId)), { code: 'CONTINUOUS_REVISION_CONFLICT' })
  const latest = await f.tx(tx => tx.doc(TaskCard, root.taskId))
  assert.equal((await f.tx(tx => resolveContinuousChildEvidence(tx, latest, { kind: 'child-result', relationId: relation.id, revision: 1 },
    { ...relation.continuousBinding, goalRevision: 2 }, f.services))).ok, false)
})

test('LR06 source revocation after acceptance invalidates evidence without exposing a cached result', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root(), child = (await f.assign(root)).data
  const relation = await f.publish(child)
  await f.review(root, relation)
  await f.tx(async tx => { (await tx.doc(ToolAccess)).revoked.calendar = ['calendar_read_schedule'] })
  const result = await f.tx(tx => resolveContinuousChildEvidence(tx, root, { kind: 'child-result', relationId: relation.id, revision: 1 }, relation.continuousBinding, f.services))
  assert.deepEqual(result, { ok: false })
})
