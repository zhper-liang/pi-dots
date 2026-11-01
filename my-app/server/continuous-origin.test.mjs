import test from 'node:test'
import assert from 'node:assert/strict'
import { continuousCollaborationFixture } from './fixtures/continuous-collaboration-fixture.mjs'
import { TaskCard, ChatInput } from './tasks.mjs'
import { resolveContinuousOrigin, continuousOriginRoots, publishContinuousOriginEvent } from './continuous-origin.mjs'
import { Collaboration } from './collaboration.mjs'
import { ContinuousOrigin, ContinuousBudget, TaskProgress } from './continuous-task.mjs'
import { GroupDirectory } from './groups.mjs'
import { createMainSession, MainSessions } from './main-session.mjs'
import { SessionLifecycle } from './session-lifecycle.mjs'
import { ToolAccess } from './tools.mjs'

test('LR05 group origin remains separate from independent execution roots and one-level budget members', async t => {
  const f = await continuousCollaborationFixture(t), first = await f.root(), second = await f.root()
  const child = (await f.assign(first)).data
  assert.equal(first.kind, 'chat')
  await f.tx(async tx => {
    const relations = (await tx.doc(Collaboration)).items
    assert.equal(relations.length, 1)
    assert.equal(relations[0].parentTaskId, first.taskId)
    assert.equal(relations[0].parentInputId, first.executionPolicy.rootInputId)
    assert.equal(relations[0].originTaskId, f.group.taskId)
    assert.equal(relations[0].continuousBinding.submissionRevision, 1)
    assert.equal((await tx.doc(ContinuousBudget, first.taskId)).members[child.childTaskId].relationId, relations[0].id)
    assert.equal((await tx.doc(ContinuousBudget, second.taskId)).members, undefined)
    assert.deepEqual(await continuousOriginRoots(tx, f.group.taskId, { TaskCard }), [first.taskId, second.taskId])
  })
  assert.equal((await f.assign(first)).replayed, true)
  await assert.rejects(f.tx(async tx => f.collaboration.execute(tx, await tx.doc(TaskCard, child.childTaskId), {
    name: 'task_assign', arguments: { operationId: 'recursive', botId: 'chief', goal: '不得再次派发', completionCriteria: ['拒绝'] },
  }, child.childInputId)), { code: 'COLLABORATION_DEPTH_DENIED' })
})

test('LR05 current group membership, source permission and persistent pause guard the next child dispatch', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root(), child = (await f.assign(root)).data
  await f.tx(async tx => { (await tx.doc(GroupDirectory)).items[0].memberBotIds = ['todo','chief'] })
  await assert.rejects(f.tx(tx => f.collaboration.guard(tx, child.childTaskId)), { code: 'GROUP_TARGET_DENIED' })
  await assert.rejects(f.assign(root, 'removed'), { code: 'COLLABORATION_TARGET_DENIED' })
  await f.tx(async tx => {
    ;(await tx.doc(GroupDirectory)).items[0].memberBotIds.push('calendar')
    ;(await tx.doc(TaskProgress, root.taskId)).controlIntent = { action: 'pause' }
  })
  await assert.rejects(f.assign(root, 'while-paused'), { code: 'CONTINUOUS_DISPATCH_STOPPED' })
  await f.tx(async tx => {
    ;(await tx.doc(TaskProgress, root.taskId)).controlIntent = null
    ;(await tx.doc(TaskCard, f.group.taskId)).externalMcpUsedRefs = [{ toolName: 'revoked-source', connectionId: 'missing', catalogRevision: 1 }]
  })
  await assert.rejects(f.tx(tx => resolveContinuousOrigin(tx, root, f.services)), { code: 'CONTINUOUS_ORIGIN_DENIED' })
})

test('LR05 deleted source prevents access while source roots remain discoverable for cancellation', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root()
  await f.tx(async tx => { (await tx.doc(SessionLifecycle)).deleted[f.group.taskId] = { action: 'delete' } })
  await assert.rejects(f.tx(tx => resolveContinuousOrigin(tx, root, f.services)), { code: 'SESSION_DELETED' })
  assert.deepEqual(await f.tx(tx => continuousOriginRoots(tx, f.group.taskId, { TaskCard })), [root.taskId])
})

test('LR05 stage and final delivery uses root/revision/event identity across restart and rejects changed replays', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root(), other = await f.root()
  const event = { eventId: 'stage-1', goalRevision: 1, kind: 'progress', summary: '阶段成果已提交，尚待验收' }
  const publish = (root, event) => f.tx(tx => publishContinuousOriginEvent(tx, root, event, f.services))
  const receipt = await publish(root, event)
  await f.restart()
  assert.equal((await publish(root, event)).entryId, receipt.entryId)
  assert.equal((await publish(root, event)).replayed, true)
  await assert.rejects(publish(root, { ...event, summary: 'changed' }), { code: 'CONTINUOUS_EVENT_CONFLICT' })
  const second = await publish(other, event)
  assert.notEqual(second.entryId, receipt.entryId)
  await assert.rejects(publish(root,{eventId:'early-final',goalRevision:1,kind:'completed',summary:'尚未核验'}),{code:'CONTINUOUS_EVENT_INVALID'})
  await f.tx(async tx => { (await tx.doc(TaskProgress,root.taskId)).finalOutcome={status:'completed',goalRevision:1} })
  await publish(root, { eventId: 'final', goalRevision: 1, kind: 'completed', summary: '已完成且核验' })
  await assert.rejects(publish(root,{eventId:'another-final',goalRevision:1,kind:'completed',summary:'已完成且核验'}),{code:'CONTINUOUS_EVENT_CONFLICT'})
  await f.tx(async tx => {
    const entries = await tx.scanEntries({ conversationId: f.group.conversationId }, 100)
    assert.equal(entries.items.filter(row => row.kind === 'pidot.continuous-event').length, 3)
    assert.equal((await tx.doc(ChatInput, root.taskId)).entryId, root.executionPolicy.rootInputId)
  })
})

test('LR05 clear-main rebinds only delivery and preserves original source/root identities', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root('main')
  const replacement = await f.tx(async tx => {
    const id = await createMainSession(tx, 'todo', { createTask: f.createTask, TaskCard })
    ;(await tx.doc(SessionLifecycle)).deleted[f.mainTaskId] = { action: 'clear-main', botId: 'todo', replacementTaskId: id }
    return id
  })
  await f.tx(async tx => { (await tx.doc(TaskProgress,root.taskId)).finalOutcome={status:'completed',goalRevision:1} })
  const receipt = await f.tx(tx => publishContinuousOriginEvent(tx, root, { eventId: 'final', goalRevision: 1, kind: 'completed', summary: '换新后的最终结果' }, f.services))
  assert.equal(receipt.taskId, replacement)
  await f.tx(async tx => {
    const origin = await tx.doc(ContinuousOrigin, root.taskId)
    assert.equal(origin.originTaskId, f.mainTaskId)
    assert.equal(origin.deliveryTaskId, replacement)
    assert.equal(origin.rootInputId, root.executionPolicy.rootInputId)
    assert.equal((await tx.doc(MainSessions)).byBot.todo, replacement)
  })
})

test('LR05 forged source/coordinator and removed review permission cannot create a child', async t => {
  const f = await continuousCollaborationFixture(t), root = await f.root()
  await f.tx(async tx => { (await tx.doc(ContinuousOrigin, root.taskId)).groupId = 'another-group' })
  await assert.rejects(f.assign(root), { code: 'CONTINUOUS_ORIGIN_DENIED' })
  await f.tx(async tx => {
    ;(await tx.doc(ContinuousOrigin, root.taskId)).groupId = f.group.groupId
    ;(await tx.doc(ToolAccess)).revoked.todo = ['task_review']
  })
  await assert.rejects(f.assign(root), { code: 'REVIEW_NOT_AUTHORIZED' })
  assert.equal((await f.tx(tx => tx.doc(Collaboration))).items.length, 0)
})
