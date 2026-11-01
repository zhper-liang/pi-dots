import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskProgress } from './continuous-task.mjs'
import { setAutomationPause } from './policy.mjs'
import { applyPendingContinuousGoal } from './continuous-control.mjs'
import { continuousBudgetUsage, raiseContinuousLimits } from './continuous-budget.mjs'
import { budgetFixture, TestCard, EPOCH } from './fixtures/continuous-budget-fixture.mjs'

const request = (action, expectedVersion, requestId = `${action}-${expectedVersion}`, extra = {}) => ({ action, expectedVersion, requestId, ...extra })

test('LR03 pause blocks next dispatch while in-flight real receipt remains settleable across restart', async t => {
  const f = await budgetFixture(t)
  await f.reserve('in-flight')
  await f.control(request('pause', 1))
  await assert.rejects(f.reserve('after-pause'), { code: 'CONTINUOUS_DISPATCH_STOPPED' })
  await f.settle('in-flight', { totalTokens: 23 })
  await f.restart()
  assert.equal((await f.dispatch()).reason, 'user-paused')
  assert.equal(continuousBudgetUsage(await f.budget()).totalTokens, 23)
  await f.control(request('resume', 2))
  await f.reserve('after-resume')
})

test('LR03 global pause and feature disable cannot be bypassed by target resume', async t => {
  const f = await budgetFixture(t)
  await f.control(request('pause', 1))
  await f.tx(tx => setAutomationPause(tx, { paused: true, by: 'test' }))
  await f.control(request('resume', 2))
  assert.equal((await f.dispatch()).reason, 'global-paused')
  await f.control(request('pause', 3))
  await f.tx(tx => setAutomationPause(tx, { paused: false, by: 'test' }))
  assert.equal((await f.dispatch()).reason, 'user-paused')
  await f.control(request('resume', 4))
  assert.equal((await f.dispatch({ enabled: false })).reason, 'feature-disabled')
})

for (const order of ['cancel-first', 'resume-first']) test(`LR03 cancellation wins ${order} with the same starting version and does not replay its effect`, async t => {
  const f = await budgetFixture(t)
  await f.control(request('pause', 1))
  const resume = request('resume', 2), cancel = request('cancel', 2)
  if (order === 'cancel-first') {
    await f.control(cancel)
    await assert.rejects(f.control(resume), { code: 'TASK_CANCELLED' })
  } else {
    await f.control(resume)
    await f.control(cancel)
  }
  assert.equal((await f.control(cancel)).replayed, true)
  assert.equal(f.cancelCalls, 1)
  await f.restart()
  assert.equal((await f.dispatch()).state, 'cancelled')
  await assert.rejects(f.control(request('resume', (await f.progress()).controlVersion)), { code: 'TASK_CANCELLED' })
})

test('LR03 idempotent control receipts retain content and stale buttons cannot overwrite a goal revision', async t => {
  const f = await budgetFixture(t)
  const revise = request('revise-goal', 1, 'revise', { goalPatch: { goal: '新目标' } })
  const first = await f.control(revise)
  assert.equal((await f.control(revise)).version, first.version)
  await assert.rejects(f.control({ ...revise, goalPatch: { goal: '另一个目标' } }), { code: 'CONTINUOUS_REQUEST_CONFLICT' })
  await assert.rejects(f.control(request('cancel', 1)), { code: 'CONTINUOUS_VERSION_CONFLICT' })
  await assert.rejects(f.control(request('resume', 1)), { code: 'CONTINUOUS_VERSION_CONFLICT' })
})

test('LR03 goal revision waits for in-flight receipt, supersedes old steps and retains original accounting', async t => {
  const f = await budgetFixture(t)
  await f.tx(async tx => {
    const progress = await tx.doc(TaskProgress, f.root.taskId)
    progress.steps.push({ stepId: 'old', goalRevision: 1, status: 'active' })
    progress.stall = { evaluated: 2, replans: 1, lastEvaluationId: 'old-eval', known: { evidence: ['old-file-fingerprint'], criteria: ['old-standard'], resolved: ['old-blocker'] } }
  })
  await f.reserve('old-model')
  await f.control(request('revise-goal', 1, 'revise', { goalPatch: { goal: '新目标', completionCriteria: ['新标准'] } }))
  assert.equal((await f.dispatch()).reason, 'goal-revision-pending')
  const apply = () => f.tx(async tx => applyPendingContinuousGoal(tx, await tx.doc(TestCard, f.root.taskId), f.options()))
  assert.equal((await apply()).reason, 'in-flight')
  await f.settle('old-model', { totalTokens: 22 })
  assert.equal((await apply()).goalRevision, 2)
  assert.equal((await f.card()).taskState.goal, '新目标')
  assert.equal((await f.progress()).steps[0].status, 'superseded')
  assert.deepEqual((await f.progress()).stall, { evaluated: 0, replans: 0, lastEvaluationId: 'old-eval', known: { evidence: ['old-file-fingerprint'], criteria: [], resolved: [] } })
  assert.equal((await f.budget()).attempts['old-model'].goalRevision, 1)
  assert.equal(continuousBudgetUsage(await f.budget()).totalTokens, 22)
  await assert.rejects(f.reserve('stale'), { code: 'CONTINUOUS_BUDGET_BINDING' })
  await f.reserve('new', { goalRevision: 2 })
})

test('LR03 stale cancel never bypasses an intervening budget change', async t => {
  const f = await budgetFixture(t)
  await f.tx(tx => raiseContinuousLimits(tx, f.root.taskId, { modelCalls: 30 }, f.options()))
  await assert.rejects(f.control(request('cancel', 1)), { code: 'CONTINUOUS_VERSION_CONFLICT' })
  assert.equal((await f.progress()).controlChanges[0].action, 'limits')
  await f.control(request('cancel', 2))
})

test('LR03 cancel preserves late usage and never applies an already pending revision', async t => {
  const f = await budgetFixture(t)
  await f.reserve('late')
  await f.control(request('revise-goal', 1, 'revise', { goalPatch: { goal: '未应用' } }))
  await f.control(request('cancel', 2))
  await f.settle('late', { totalTokens: 21 })
  const result = await f.tx(async tx => applyPendingContinuousGoal(tx, await tx.doc(TestCard, f.root.taskId), f.options()))
  assert.equal(result.reason, 'goal-closed')
  assert.equal((await f.card()).taskState.goalRevision, 1)
  assert.equal(continuousBudgetUsage(await f.budget()).totalTokens, 21)
})

test('LR03 final success and failure cannot be revived by resume', async t => {
  const f = await budgetFixture(t)
  await f.tx(async tx => { (await tx.doc(TaskProgress, f.root.taskId)).finalOutcome = { status: 'completed', goalRevision: 1 } })
  await assert.rejects(f.control(request('resume', 1)), { code: 'CONTINUOUS_INPUT_CLOSED' })
  await assert.rejects(f.reserve('late'), { code: 'CONTINUOUS_DISPATCH_STOPPED' })
})

test('LR03 durable control watch wakes on global recovery without clearing a manual pause', async t => {
  const f = await budgetFixture(t)
  await f.control(request('pause', 1))
  await f.tx(tx => setAutomationPause(tx, { paused: true, by: 'test' }))
  const observed = await f.watchKey()
  const waiting = f.wait(observed)
  await f.tx(tx => setAutomationPause(tx, { paused: false, by: 'test' }))
  await waiting
  assert.equal((await f.dispatch()).reason, 'user-paused')
})

test('LR03 durable watch notices a control committed before watch installation', async t => {
  const f = await budgetFixture(t)
  await f.control(request('pause', 1))
  const observed = await f.watchKey()
  await f.control(request('resume', 2))
  await f.wait(observed)
  assert.equal((await f.dispatch()).allowed, true)
})

test('LR03 paused waiting wakes at fixed deadline; already expired wait sleeps until explicit extension', async t => {
  const f = await budgetFixture(t)
  await f.control(request('pause', 1))
  const observed = await f.watchKey()
  f.setNow(EPOCH + 59999)
  await f.wait(observed)
  f.setNow(EPOCH + 60000)
  assert.equal((await f.dispatch()).reason, 'deadline')
  let woke = false
  const expiredWait = f.wait(await f.watchKey()).then(() => { woke = true })
  await delay(10)
  assert.equal(woke, false)
  await f.tx(tx => raiseContinuousLimits(tx, f.root.taskId, { deadlineAt: new Date(EPOCH + 120000).toISOString() }, f.options()))
  await expiredWait
  assert.equal((await f.dispatch()).reason, 'user-paused')
})

test('LR03 control wait observes root late settlement and aborts cleanly without a polling loop', async t => {
  const f = await budgetFixture(t)
  await f.reserve('receipt')
  const waiting = f.wait(await f.watchKey())
  await f.settle('receipt')
  await waiting
  const controller = new AbortController()
  const abortWait = f.wait(await f.watchKey(), { signal: controller.signal })
  controller.abort(new Error('fixture abort'))
  await assert.rejects(abortWait, /fixture abort/)
})
