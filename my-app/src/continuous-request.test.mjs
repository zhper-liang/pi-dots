import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createContinuousRequestGate } from './continuous-request.mjs'

function fixture() {
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
  let id = 0
  const gate = key => createContinuousRequestGate({ storage, key, makeId: () => `request-${++id}` })
  return { gate }
}
test('double click is locked and uncertain retry keeps request identity, including after switching back', () => {
  const { gate } = fixture(), first = gate('root-1'), payload = { action: 'pause', expectedVersion: 1 }
  assert.equal(first.begin('/control', 'POST', payload).requestId, 'request-1')
  assert.equal(first.begin('/control', 'POST', payload), null)
  first.finish(false); first.dispose()
  const other = gate('root-2')
  assert.equal(other.begin('/control', 'POST', payload).requestId, 'request-2')
  assert.equal(first.current(), false)
  assert.equal(gate('root-1').begin('/control', 'POST', payload).requestId, 'request-1')
})
test('changed version receives a new request identity and successful receipt clears the old retry', () => {
  const { gate } = fixture(), value = gate('root')
  assert.equal(value.begin('/control', 'POST', { expectedVersion: 1 }).requestId, 'request-1')
  value.finish(false)
  assert.equal(value.begin('/control', 'POST', { expectedVersion: 2 }).requestId, 'request-2')
  value.finish(true)
  assert.equal(value.begin('/control', 'POST', { expectedVersion: 2 }).requestId, 'request-3')
})
