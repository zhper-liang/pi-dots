import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { TaskCard, ChatTask } from './tasks.mjs'
import { createSessionLifecycle, readLifecycleSession, assertSessionVisible } from './session-lifecycle.mjs'

// Isolated loopback adapter exercises service + real cancellation/persistence over HTTP.
// Production app.mjs route/auth and shared list/history/memory filtering remain Sagan's integration.
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-session-http-'))
  let store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), workspaceEnabled: false, calendarQueryEnabled: false })
  const transaction = fn => store.harness.commit(fn, context)
  let unknown = false
  const service = createSessionLifecycle({ transaction,
    readSession: (tx, id) => readLifecycleSession(tx, id, { TaskCard, taskKind: ChatTask.definition.name }),
    stopSession: async id => { if (unknown) return { status: 'unknown' }; return store.cancel(id, {}) } })
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer isolated-session-test') return send(401, { error: { code: 'UNAUTHORIZED' } })
    const match = /^\/api\/tasks\/(\d+)(\/delete)?$/.exec(req.url)
    if (!match) return send(404, { error: { code: 'NOT_FOUND' } })
    try {
      const id = Number(match[1])
      if (req.method === 'GET' && !match[2]) {
        await transaction(tx => assertSessionVisible(tx, id))
        return send(200, { task: await store.get(id) })
      }
      if (req.method !== 'POST' || !match[2]) return send(405, { error: { code: 'METHOD_NOT_ALLOWED' } })
      let raw = ''
      for await (const chunk of req) raw += chunk
      let input
      try { input = JSON.parse(raw) } catch { return send(400, { error: { code: 'INVALID_JSON' } }) }
      send(200, { data: await service.deleteSession(id, input) })
    } catch (error) { send(error.status ?? 500, { error: { code: error.code ?? 'INTERNAL_ERROR' } }) }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await store.close()
    await rm(dir, { recursive: true, force: true })
  })
  const call = async (id, body, authorized = true) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${id}${body === undefined ? '' : '/delete'}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...(authorized ? { Authorization: 'Bearer isolated-session-test' } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: res.status, body: await res.json() }
  }
  return { service, call, create: () => store.create({ botId: 'calendar' }), get store() { return store },
    setUnknown: value => { unknown = value },
    restart: async () => { await store.close(); store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), workspaceEnabled: false, calendarQueryEnabled: false }) } }
}

test('HTTP deletion uses real cancellation, survives lost response/restart and keeps original audit accessible internally', async t => {
  const f = await fixture(t), task = await f.create(), input = { requestId: 'http-delete', confirmed: true }
  const first = await f.call(task.taskId, input)
  assert.equal(first.status, 200)
  assert.equal(first.body.data.deleted, true)
  assert.equal((await f.call(task.taskId)).status, 410)
  await assert.rejects(f.store.get(task.taskId), { status: 410, code: 'SESSION_DELETED' })
  const audit = await f.store.harness.commit(tx => readLifecycleSession(tx, task.taskId, { TaskCard, taskKind: ChatTask.definition.name }), context)
  assert.equal(audit.taskId, task.taskId)
  await f.restart()
  const replay = await f.call(task.taskId, input)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.data.replayed, true)
  assert.equal(replay.body.data.deletedAt, first.body.data.deletedAt)
  assert.equal((await f.call(task.taskId)).status, 410)
})

test('HTTP unknown is not success; authorization, confirmation and request conflict are not bypassed', async t => {
  const f = await fixture(t), task = await f.create(), other = await f.create(), input = { requestId: 'http-unknown', confirmed: true }
  assert.equal((await f.call(task.taskId, input, false)).status, 401)
  assert.equal((await f.call(task.taskId, { requestId: 'unconfirmed' })).status, 400)
  f.setUnknown(true)
  const unknown = await f.call(task.taskId, input)
  assert.equal(unknown.status, 409)
  assert.equal(unknown.body.error.code, 'SESSION_STOP_UNKNOWN')
  assert.equal((await f.call(task.taskId)).status, 200)
  assert.equal((await f.call(other.taskId, input)).body.error.code, 'SESSION_REQUEST_CONFLICT')
  f.setUnknown(false)
  assert.equal((await f.call(task.taskId, input)).body.data.deleted, true)
})
