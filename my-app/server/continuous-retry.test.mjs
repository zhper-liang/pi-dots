import test from 'node:test'
import assert from 'node:assert/strict'
import { continuousRetryDecision, continuousRetryDue, safeRetryMetadata, transientModelFailure, retryAfterMs } from './continuous-retry.mjs'

const now = Date.parse('2026-11-02T00:00:00Z')
const deadlineAt = new Date(now + 60000).toISOString()
test('retry classification preserves terminal model errors and only known transient transport causes', () => {
  for (const code of ['MODEL_AUTH_FAILED', 'MODEL_CONFIG_UNAVAILABLE', 'MODEL_REJECTED', 'MODEL_INVALID_REPLY', 'MODEL_OUTPUT_LIMIT', 'MODEL_ABORTED', 'CONTEXT_SUMMARY_INVALID']) assert.equal(transientModelFailure({ code, retryMetadata: { httpStatus: 503 } }), false)
  for (const status of [408, 429, 502, 503, 504]) assert.equal(transientModelFailure({ code: 'MODEL_FAILED', retryMetadata: { httpStatus: status } }), true)
  for (const status of [400, 401, 403, 404, 422, 500, 501]) assert.equal(transientModelFailure({ code: 'MODEL_FAILED', retryMetadata: { httpStatus: status } }), false)
  assert.equal(transientModelFailure({ code: 'MODEL_FAILED', message: 'temporary timeout please retry' }), false)
  assert.equal(transientModelFailure({ code: 'MODEL_FAILED', retryMetadata: { networkCode: 'ECONNRESET' } }), true)
})
test('backoff and retry identity survive serialization; success must explicitly reset the series', () => {
  let retry = null, at = now
  for (const [index, delay] of [1000, 5000, 15000].entries()) {
    const input = { error: { code: 'MODEL_RATE_LIMITED' }, retry, attemptId: `attempt-${index}`, now: at, deadlineAt }
    const decision = continuousRetryDecision(input)
    assert.equal(decision.action, 'retry')
    assert.equal(Date.parse(decision.retry.nextAttemptAt) - at, delay)
    retry = JSON.parse(JSON.stringify(decision.retry))
    const replay = continuousRetryDecision({ ...input, retry, now: at + 250 })
    assert.deepEqual(replay.retry, retry)
    assert.equal(replay.replayed, true)
    assert.equal(continuousRetryDue(retry, at), false)
    at += delay
    assert.equal(continuousRetryDue(retry, at), true)
  }
  assert.deepEqual(continuousRetryDecision({ error: { code: 'MODEL_RATE_LIMITED' }, retry, attemptId: 'attempt-4', now: at, deadlineAt }), { action: 'fail', reason: 'retry-exhausted' })
  assert.equal(continuousRetryDecision({ error: { code: 'MODEL_TIMEOUT' }, retry: null, attemptId: 'after-success', now: at, deadlineAt }).retry.attempts, 1)
})
test('Retry-After is honored without extending the root deadline or saving raw transport details', () => {
  const meta = safeRetryMetadata({ status: 429, retryAfter: '12', networkCode: 'secret-provider-error', now })
  assert.deepEqual(meta, { httpStatus: 429, retryAfterMs: 12000 })
  assert.equal(retryAfterMs(new Date(now + 20000).toUTCString(), now), 20000)
  for (const value of ['-1', 'nonsense', '', '9'.repeat(101)]) assert.equal(retryAfterMs(value, now), null)
  const input = { error: { code: 'MODEL_RATE_LIMITED', retryMetadata: meta }, attemptId: 'a', now, deadlineAt }
  assert.equal(continuousRetryDecision(input).retry.nextAttemptAt, new Date(now + 12000).toISOString())
  assert.deepEqual(continuousRetryDecision({ ...input, deadlineAt: new Date(now + 12000).toISOString() }), { action: 'limited', reason: 'deadline' })
})
