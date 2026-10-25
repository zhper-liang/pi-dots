import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelObservation, assertLiveEventRetained } from './fixtures/workspace-acceptance-guards.mjs'

test('09 acceptance observer waits for active model call and rejects observer model calls before dispatch', async () => {
  const o = createModelObservation(); let release, dispatched = 0
  const pending = o.invoke(() => new Promise(resolve => { release = resolve; dispatched++ }))
  assert.throws(() => o.begin(), /settle/)
  release(); await pending
  assert.equal(o.begin().before, 1)
  await assert.rejects(o.invoke(() => { dispatched++; return 'not allowed' }), /forbidden/)
  assert.equal(dispatched, 1); assert.equal(o.calls, 1)
  assert.throws(() => o.finish(), /invalidates/)
  const clean = createModelObservation(); await clean.invoke(async () => 'settled'); clean.begin()
  assert.equal(clean.finish().modelDelta, 0)
})

test('09 acceptance live-event guard rejects cleanup-first deletion and hidden provider mutations', () => {
  const event = { id: 'cache-id', sourceId: 'external', remoteId: 'provider-id', version: 1, remoteVersion: 'hash', deletedAt: null }
  const input = { before: event, after: { ...event }, writesBefore: 1, writesAfter: 1 }
  assertLiveEventRetained(input)
  assert.throws(() => assertLiveEventRetained({ ...input, before: { ...event, deletedAt: 'earlier-cleanup' } }), /live before/)
  assert.throws(() => assertLiveEventRetained({ ...input, after: { ...event, deletedAt: 'cascade' } }), /remain live/)
  assert.throws(() => assertLiveEventRetained({ ...input, writesAfter: 2 }), /must not write/)
  assert.throws(() => assertLiveEventRetained({ ...input, after: { ...event, version: 2 } }), /unchanged/)
})
