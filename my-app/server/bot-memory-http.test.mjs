import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApiServer } from './app.mjs'
import { TaskInputError } from './task-config.mjs'

async function fixture(t, overrides = {}) {
  const token = randomUUID()
  const calls = []
  const tasks = {
    registerMemorySecrets(value) { assert.equal(value, token) },
    async getBotMemory(botId) { calls.push(['get', botId]); return { botId, version: 1 } },
    async editBotMemory(botId, input) { calls.push(['edit', botId, input]); return { botId, version: 2 } },
    async getPreferences() { calls.push(['preferences']); return { version: 1, entries: [] } },
    async editPreferences(input) { calls.push(['preferences-edit', input]); return { version: 2, entries: [] } },
    ...overrides,
  }
  const server = createApiServer({ token, tasks })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const request = (path, { body, auth = true, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { request, calls }
}

test('T11 memory and preferences routes require authentication before accessing documents', async t => {
  const { request, calls } = await fixture(t)
  for (const path of ['/api/bots/chief/memory', '/api/settings/preferences']) {
    assert.equal((await request(path, { auth: false })).status, 401)
    const response = await request(path, { method: 'DELETE' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, POST')
  }
  assert.deepEqual(calls, [])
})

test('T11 authenticated memory edits preserve request identity and expected version', async t => {
  const { request, calls } = await fixture(t)
  const body = { requestId: 'memory-http-request', expectedVersion: 1, action: 'personality', content: '简洁回答' }
  assert.deepEqual(await (await request('/api/bots/chief/memory')).json(), { data: { botId: 'chief', version: 1 } })
  assert.deepEqual(await (await request('/api/bots/chief/memory', { body })).json(), { data: { botId: 'chief', version: 2 } })
  assert.deepEqual(calls, [['get', 'chief'], ['edit', 'chief', body]])
})

test('T11 shared preferences use one authenticated global endpoint', async t => {
  const { request, calls } = await fixture(t)
  const body = { requestId: 'preferences-http-request', expectedVersion: 1, action: 'delete', id: 'entry-1' }
  assert.equal((await request('/api/settings/preferences')).status, 200)
  assert.equal((await request('/api/settings/preferences', { body })).status, 200)
  assert.deepEqual(calls, [['preferences'], ['preferences-edit', body]])
})

test('T11 memory conflicts remain explicit and unexpected exceptions never expose their details', async t => {
  const { request } = await fixture(t, {
    async editBotMemory() { throw new TaskInputError(409, 'MEMORY_VERSION_CONFLICT', '文档已更新，请读取当前版本后重新确认。') },
    async getPreferences() { throw new Error('private-provider-details') },
  })
  const conflict = await request('/api/bots/chief/memory', { body: {} })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.code, 'MEMORY_VERSION_CONFLICT')
  const failure = await request('/api/settings/preferences')
  assert.equal(failure.status, 500)
  assert.equal((await failure.text()).includes('private-provider-details'), false)
})
