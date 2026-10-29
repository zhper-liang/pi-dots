import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-t08-calendar-'))
  let modelCalls = 0
  const tasks = await openTaskStore({ file: join(dir, 'isolated.sqlite'), modelReply: async () => { modelCalls++; throw Error('calendar must not call a model') } })
  const server = createApiServer({ tasks, token: 'isolated-calendar-regression' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const post = async (path, input) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workspace/${path}`, { method: 'POST', headers: { authorization: 'Bearer isolated-calendar-regression', 'content-type': 'application/json' }, body: JSON.stringify(input) })
    return { status: response.status, ...(await response.json()) }
  }
  try { await run(post); assert.equal(modelCalls, 0) }
  finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await tasks.close()
    await rm(dir, { recursive: true, force: true })
  }
}
const event = { title: 'T08 改期回归', description: '本地临时库', start: '2026-10-29T09:00:00+08:00', end: '2026-10-29T10:00:00+08:00', timezone: 'Asia/Shanghai' }
const read = id => ({ sourceId: 'local', type: 'Event', id })
const move = (id, requestId, expectedVersion, hour) => ({ ...read(id), action: 'update', requestId, expectedVersion, data: { start: `2026-10-29T${hour}:00:00+08:00`, end: `2026-10-29T${Number(hour) + 1}:00:00+08:00` } })
const create = post => post('command', { sourceId: 'local', type: 'Event', action: 'create', requestId: 'calendar-create', data: event })

test('T08 stale calendar reschedule returns 409 without overwrite; latest version requires explicit new confirmation', () => fixture(async post => {
  const created = await create(post)
  const id = created.data.receipt.target.id
  const tabA = (await post('get', read(id))).data.items[0]
  const tabB = (await post('get', read(id))).data.items[0]
  assert.equal(tabA.version, 1)
  assert.equal((await post('command', move(id, 'tab-a', tabA.version, '11'))).status, 200)
  const stale = await post('command', move(id, 'tab-b', tabB.version, '14'))
  assert.equal(stale.status, 409)
  assert.equal(stale.error.code, 'WORKSPACE_VERSION_CONFLICT')
  const current = (await post('get', read(id))).data.items[0]
  assert.equal(current.version, 2)
  assert.equal(Date.parse(current.start), Date.parse('2026-10-29T11:00:00+08:00'))
  assert.equal(current.title, event.title)
  assert.equal((await post('operation', { sourceId: 'local', requestId: 'tab-b' })).data, null)
  assert.equal((await post('command', move(id, 'tab-b-confirmed-current', current.version, '14'))).status, 200)
  const confirmed = (await post('get', read(id))).data.items[0]
  assert.equal(confirmed.version, 3)
  assert.equal(Date.parse(confirmed.start), Date.parse('2026-10-29T14:00:00+08:00'))
}))

test('T08 lost reschedule response recovers original request receipt; replay never moves or increments twice', () => fixture(async post => {
  const id = (await create(post)).data.receipt.target.id
  const input = move(id, 'lost-response-original-id', 1, '11')
  const original = await post('command', input)
  assert.equal(original.status, 200)
  const recovered = await post('operation', { sourceId: 'local', requestId: input.requestId })
  assert.deepEqual(recovered.data, original.data)
  assert.equal(recovered.data.state, 'succeeded')
  assert.deepEqual((await post('command', input)).data, original.data)
  assert.equal((await post('get', read(id))).data.items[0].version, 2)
  const changed = await post('command', move(id, input.requestId, 2, '15'))
  assert.equal(changed.status, 409)
  assert.equal(changed.error.code, 'WORKSPACE_REQUEST_CONFLICT')
  assert.equal(Date.parse((await post('get', read(id))).data.items[0].start), Date.parse('2026-10-29T11:00:00+08:00'))
}))

test('T08 calendar rejects missing expectedVersion and never changes the event', () => fixture(async post => {
  const id = (await create(post)).data.receipt.target.id
  const input = move(id, 'missing-version', undefined, '11')
  assert.equal((await post('command', input)).status, 400)
  const current = (await post('get', read(id))).data.items[0]
  assert.equal(current.version, 1)
  assert.equal(Date.parse(current.start), Date.parse(event.start))
}))

test('T08 concurrent calendar moves accept one version only and preserve the winning interval', () => fixture(async post => {
  const id = (await create(post)).data.receipt.target.id
  const inputs = [move(id, 'race-a', 1, '11'), move(id, 'race-b', 1, '14')]
  const results = await Promise.all(inputs.map(input => post('command', input)))
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  const winner = results.findIndex(result => result.status === 200)
  const current = (await post('get', read(id))).data.items[0]
  assert.equal(current.version, 2)
  assert.equal(Date.parse(current.start), Date.parse(inputs[winner].data.start))
  assert.equal(Date.parse(current.end), Date.parse(inputs[winner].data.end))
  assert.equal(results[1 - winner].error.code, 'WORKSPACE_VERSION_CONFLICT')
}))

test('T08 deleted calendar event remains deleted after stale reschedule and exposes its current tombstone version', () => fixture(async post => {
  const id = (await create(post)).data.receipt.target.id
  const deleted = await post('command', { ...read(id), action: 'delete', requestId: 'calendar-delete', expectedVersion: 1, confirmedDelete: true })
  assert.equal(deleted.status, 200)
  const stale = await post('command', move(id, 'stale-after-delete', 1, '14'))
  assert.equal(stale.status, 409)
  assert.equal(stale.error.code, 'WORKSPACE_VERSION_CONFLICT')
  const current = (await post('get', read(id))).data.items[0]
  assert.ok(current.deletedAt)
  assert.equal(current.version, 2)
  assert.equal(Date.parse(current.start), Date.parse(event.start))
}))
