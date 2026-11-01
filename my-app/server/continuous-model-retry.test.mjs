import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelReply, modelParameters } from './model-reply.mjs'
import { transientModelFailure, continuousRetryDecision } from './continuous-retry.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-retry-secret', model: 'fixture-retry' }
const parameters = modelParameters(config)
test('real model adapter exposes only allowlisted failure metadata and does not perform hidden retries', async () => {
  let calls = 0
  const reply = createModelReply(config, { fetch: async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: config.apiKey } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '9', 'X-Private': config.apiKey } })
  } })
  await assert.rejects(reply('test', { parameters }), error => {
    assert.equal(error.code, 'MODEL_RATE_LIMITED')
    assert.deepEqual(error.retryMetadata, { httpStatus: 429, retryAfterMs: 9000 })
    assert.equal(transientModelFailure(error), true)
    assert.equal(JSON.stringify(error).includes(config.apiKey), false)
    const now = Date.now()
    assert.equal(continuousRetryDecision({ error, attemptId: 'persisted-1', now, deadlineAt: now + 20000 }).retry.nextAttemptAt, new Date(now + 9000).toISOString())
    return true
  })
  assert.equal(calls, 1)
})
test('network causes remain distinguishable from generic failures without retaining raw provider errors', async () => {
  for (const [code, expected] of [['ECONNRESET', true], ['CERT_HAS_EXPIRED', false]]) {
    const reply = createModelReply(config, { fetch: async () => { throw Object.assign(new Error(config.apiKey), { cause: { code, secret: config.apiKey } }) } })
    await assert.rejects(reply('test', { parameters }), error => {
      assert.equal(transientModelFailure(error), expected)
      assert.equal(JSON.stringify(error).includes(config.apiKey), false)
      assert.equal(error.message.includes(config.apiKey), false)
      return true
    })
  }
})
test('unsupported server behavior and malformed output remain non-transient', async () => {
  const reply = createModelReply(config, { fetch: async () => new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 501, headers: { 'Content-Type': 'application/json' } }) })
  await assert.rejects(reply('test', { parameters }), error => {
    assert.equal(error.code, 'MODEL_UNAVAILABLE')
    assert.equal(error.retryMetadata.httpStatus, 501)
    assert.equal(transientModelFailure(error), false)
    return true
  })
})
