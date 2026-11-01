import test from 'node:test'
import assert from 'node:assert/strict'
import { recordContinuousProgress } from './continuous-progress.mjs'

test('repeated text and evidence cause two bounded replans then blocked; waits are not stalled work', () => {
  const state = { stall: { evaluated: 0, replans: 0 } }
  assert.equal(recordContinuousProgress(state, { evaluationId: 1, goalRevision: 1, evidenceKeys: ['artifact-v1'] }).action, 'progress')
  const snapshot = structuredClone(state)
  assert.equal(recordContinuousProgress(state, { evaluationId: 2, goalRevision: 1, waiting: true }).action, 'waiting')
  assert.deepEqual(state, snapshot)
  const actions = []
  for (let evaluationId = 2; evaluationId <= 10; evaluationId++) actions.push(recordContinuousProgress(state, { evaluationId, goalRevision: 1, evidenceKeys: ['artifact-v1'] }).action)
  assert.deepEqual(actions, ['continue', 'continue', 'replan', 'continue', 'continue', 'replan', 'continue', 'continue', 'blocked'])
  assert.equal(state.stall.replans, 2)
})
test('reopen and repeated decisions cannot increment stall or fabricate progress', () => {
  const state = {}
  recordContinuousProgress(state, { evaluationId: 10, goalRevision: 1, evidenceKeys: ['v1'] })
  recordContinuousProgress(state, { evaluationId: 11, goalRevision: 1, evidenceKeys: ['v1'] })
  const reopened = JSON.parse(JSON.stringify(state))
  assert.equal(recordContinuousProgress(reopened, { evaluationId: 11, goalRevision: 1, evidenceKeys: ['fake-new'] }).replayed, true)
  assert.equal(recordContinuousProgress(reopened, { evaluationId: 10, goalRevision: 1, evidenceKeys: ['fake-old'] }).replayed, true)
  assert.deepEqual(reopened, state)
  assert.equal(recordContinuousProgress(reopened, { evaluationId: 12, goalRevision: 1, resolvedDependencies: ['question-answered'] }).action, 'progress')
  assert.equal(reopened.stall.evaluated, 0)
})
test('goal and plan relabelling cannot turn old evidence into new work', () => {
  const state = {}
  recordContinuousProgress(state, { evaluationId: 1, goalRevision: 1, evidenceKeys: ['same-file'] })
  assert.equal(recordContinuousProgress(state, { evaluationId: 2, goalRevision: 2, evidenceKeys: ['same-file'] }).action, 'continue')
  assert.equal(recordContinuousProgress(state, { evaluationId: 3, goalRevision: 2, verifiedCriteria: ['criterion:2:0'] }).action, 'progress')
  assert.equal(recordContinuousProgress(state, { evaluationId: 4, goalRevision: 2, evidenceKeys: ['changed-file'] }).action, 'progress')
})
