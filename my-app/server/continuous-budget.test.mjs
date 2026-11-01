import test from 'node:test'
import assert from 'node:assert/strict'
import { continuousBudgetUsage, continuousModelTokenReservation, recoverContinuousReservations, registerContinuousChild, raiseContinuousLimits } from './continuous-budget.mjs'
import { budgetFixture, TestCard, EPOCH } from './fixtures/continuous-budget-fixture.mjs'

const limited = kind => error => error.code === 'CALL_LIMIT_REACHED' && error.kind === kind

test('LR03 concurrent children cannot reserve the same final root model call; creation cannot reset budget', async t => {
  const f = await budgetFixture(t, { modelCalls: 1 })
  const [first, second] = await Promise.all([f.child(), f.child()])
  const results = await Promise.allSettled([f.reserve('child-1', first), f.reserve('child-2', second)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && limited('modelCalls')(result.reason)).length, 1)
  const child = await f.child()
  await assert.rejects(f.reserve('new-child', child), limited('modelCalls'))
  assert.equal(continuousBudgetUsage(await f.budget()).modelCalls, 1)
})

test('LR03 reservations are durable and idempotent; duplicate settlement records real usage once', async t => {
  const f = await budgetFixture(t)
  assert.equal((await f.reserve('call-1')).dispatch, true)
  assert.equal((await f.reserve('call-1')).dispatch, false)
  await assert.rejects(f.reserve('call-1', { purpose: 'different' }), { code: 'CONTINUOUS_ATTEMPT_CONFLICT' })
  await f.restart()
  assert.equal((await f.reserve('call-1')).dispatch, false)
  await f.settle('call-1', { totalTokens: 17, input: 12, output: 5 })
  assert.equal((await f.settle('call-1', { totalTokens: 17, input: 12, output: 5 })).replayed, true)
  await assert.rejects(f.settle('call-1', { totalTokens: 18 }), { code: 'CONTINUOUS_RECEIPT_CONFLICT' })
  const usage = continuousBudgetUsage(await f.budget())
  assert.equal(usage.totalTokens, 17)
  assert.equal(usage.modelCalls, 1)
  assert.equal(usage.reservedTokens, 0)
})

test('LR03 concurrent token reservations reject insufficient remaining balance and include all model purposes', async t => {
  const f = await budgetFixture(t, { totalTokens: 150 })
  await f.reserve('reply')
  await assert.rejects(f.reserve('compaction', { purpose: 'context-compaction' }), limited('totalTokens'))
  await f.settle('reply', { totalTokens: 20 })
  for (const purpose of ['context-compaction', 'verify', 'retry']) {
    await f.reserve(purpose, { purpose })
    await f.settle(purpose, { totalTokens: 10 })
  }
  const usage = continuousBudgetUsage(await f.budget())
  assert.equal(usage.modelCalls, 4)
  assert.equal(usage.totalTokens, 50)
})

test('LR03 missing usage and restart retain unknown reservations; raising limits never clears unknown', async t => {
  const f = await budgetFixture(t)
  await f.reserve('missing')
  await f.settle('missing', {})
  await f.restart()
  await f.tx(tx => raiseContinuousLimits(tx, f.root.taskId, { totalTokens: 2000 }, f.options()))
  await assert.rejects(f.reserve('new-model'), limited('unknown-tokens'))
  await assert.rejects(f.reserve('new-tool', { kind: 'tool' }), limited('unknown-tokens'))
  assert.equal(continuousBudgetUsage(await f.budget()).reservedTokens, 100)
  await assert.rejects(f.tx(tx => raiseContinuousLimits(tx, f.root.taskId, { totalTokens: null }, f.options())), { code: 'INVALID_CALL_LIMITS' })
  await f.settle('missing', { totalTokens: 15 })
  await f.reserve('after-real-receipt')
  assert.equal(continuousBudgetUsage(await f.budget()).unknownTokenCalls, 0)
})

test('LR03 process interruption cannot release model reservation or replay an uncertain tool', async t => {
  const f = await budgetFixture(t)
  await f.reserve('model')
  await f.reserve('write', { kind: 'tool', purpose: 'native-write' })
  await f.restart()
  const recovered = await f.tx(tx => recoverContinuousReservations(tx, f.root.taskId, f.options()))
  assert.equal(recovered.recovered, 2)
  assert.equal(recovered.usage.unknownTokenCalls, 1)
  assert.equal(recovered.usage.reservedTokens, 100)
  assert.equal((await f.reserve('write', { kind: 'tool', purpose: 'native-write' })).dispatch, false)
  assert.equal((await f.tx(tx => recoverContinuousReservations(tx, f.root.taskId, f.options()))).recovered, 0)
})

test('LR03 fixed deadline survives pause, wait, restart and extension preserves counts', async t => {
  const f = await budgetFixture(t)
  await f.reserve('before')
  await f.settle('before')
  await f.control({ requestId: 'pause', expectedVersion: 1, action: 'pause' })
  await f.restart()
  f.setNow(EPOCH + 60000)
  await f.control({ requestId: 'resume', expectedVersion: 2, action: 'resume' })
  await assert.rejects(f.reserve('expired'), limited('deadline'))
  await f.tx(tx => raiseContinuousLimits(tx, f.root.taskId, { deadlineAt: new Date(EPOCH + 120000).toISOString() }, f.options()))
  await f.reserve('extended')
  assert.equal(continuousBudgetUsage(await f.budget()).modelCalls, 2)
})

test('LR03 foreign roots, children, revisions and receipt ownership are rejected', async t => {
  const f = await budgetFixture(t)
  await assert.rejects(f.tx(tx => registerContinuousChild(tx, { rootTaskId: f.root.taskId, rootInputId: 101, taskId: 999, inputId: 100, goalRevision: 1 }, { TaskCard: TestCard })), { code: 'CONTINUOUS_BUDGET_BINDING' })
  await assert.rejects(f.reserve('fake-child', { taskId: 999 }), { code: 'CONTINUOUS_BUDGET_BINDING' })
  await assert.rejects(f.reserve('old-goal', { goalRevision: 2 }), { code: 'CONTINUOUS_BUDGET_BINDING' })
  await f.reserve('real')
  await assert.rejects(f.settle('real', { totalTokens: 5 }, { taskId: 999 }), { code: 'CONTINUOUS_RECEIPT_BINDING' })
  assert.equal((await f.budget()).attempts.real.state, 'reserved')
})

test('LR03 a model dispatch requires an explicit bounded input and enforced output ceiling', () => {
  assert.equal(continuousModelTokenReservation({ model: { id: 'fixture' }, contextWindows: { fixture: 8192 }, maxOutputTokens: 100 }), 8292)
  assert.throws(() => continuousModelTokenReservation({ model: { id: 'unknown' } }), limited('token-bound-unavailable'))
})

test('LR03 known usage exceeding reservation is retained in full and invalidates the bound even below total limit', async t => {
  const f = await budgetFixture(t, { totalTokens: 1000 })
  await f.reserve('overrun')
  await f.settle('overrun', { totalTokens: 120 })
  assert.equal(continuousBudgetUsage(await f.budget()).totalTokens, 120)
  assert.equal((await f.budget()).attempts.overrun.boundExceeded, true)
  await assert.rejects(f.reserve('after'), limited('token-bound-exceeded'))
  await f.tx(tx => raiseContinuousLimits(tx, f.root.taskId, { totalTokens: 2000 }, f.options()))
  await assert.rejects(f.reserve('after-raise'), limited('token-bound-exceeded'))
  assert.equal((await f.budget()).limits.totalTokens, 2000)
})
