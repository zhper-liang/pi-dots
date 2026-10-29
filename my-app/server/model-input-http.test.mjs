import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApiServer } from './app.mjs'

test('T10 messages accept only a model id and forward it with the selected Skill', async t => {
  const token = randomUUID(), calls = []
  const server = createApiServer({ token, tasks: { async get() { return { taskId: 1 } }, async send(...args) { calls.push(args); return { accepted: true } } } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const send = body => fetch(`http://127.0.0.1:${server.address().port}/api/tasks/1/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await send({ message: '测试', model: { id: 'test/model-v2' }, skillId: 'test-skill' })).status, 202)
  assert.deepEqual(calls, [[1, '测试', undefined, { skillId: 'test-skill', model: { id: 'test/model-v2' } }]])
  for (const model of [null, 'test/model', {}, [], { id: '' }, { id: 'a?key' }, { id: 'model', baseUrl: 'http://localhost' }, { id: 'model', apiKey: 'not-a-real-credential' }]) {
    assert.equal((await send({ message: '测试', model })).status, 400)
  }
  assert.equal(calls.length, 1)
})
