import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApiServer } from './app.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'

const token = 'pidot-iss2-test-only-token-not-for-deployment'
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-task-api-'))
  const tasks = await openTaskStore({ file: join(dir, 'test.sqlite'), ...options })
  const staticDir = join(dir, 'dist')
  await mkdir(join(staticDir, 'assets'), { recursive: true })
  await writeFile(join(staticDir, 'index.html'), '<html>Pidot</html>')
  await writeFile(join(staticDir, 'assets/app-123.js'), 'console.log("public artifact")')
  await writeFile(join(dir, '.env'), 'never serve secrets')
  const server = createApiServer({ token, tasks, staticDir })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections() })
    await tasks.close(); await rm(dir, { recursive: true, force: true })
  })
  const request = (path, options = {}) => fetch(base + path, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } })
  return { request, base, tasks }
}

test('authenticated API lists presets, creates, lists and reopens native Task with frozen config', async (t) => {
  const { request } = await fixture(t)
  const bots = await (await request('/api/bots')).json()
  assert.equal(bots.bots.length, 3)
  assert.ok(bots.bots.every((bot) => bot.name && bot.description && bot.configRef.version))
  assert.deepEqual(await (await request('/api/tasks')).json(), { tasks: [] })
  const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ botId: 'chief', title: 'API 会话' }) })
  assert.equal(created.status, 201)
  const { task } = await created.json()
  assert.equal(created.headers.get('location'), `/api/tasks/${task.taskId}`)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await (await request(`/api/tasks/${task.taskId}`)).json(), { task })
  assert.deepEqual(await (await request('/api/tasks')).json(), { tasks: [{ ...task, taskStateHistory: [] }] })
  assert.equal(task.titleSource, 'user-request')
  assert.equal(task.parameters.model, null)
  assert.ok(task.parameterSources.model.configRef.version)
})

test('all Task/Bot reads and writes require Bearer auth before validation', async (t) => {
  const { request, base, tasks } = await fixture(t)
  for (const path of ['/api/bots', '/api/tasks', '/api/tasks/7', '/api/tasks/7/messages', '/api/tasks?token=' + token]) {
    assert.equal((await fetch(base + path)).status, 401)
    assert.equal((await request(path, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  }
  const response = await fetch(base + '/api/tasks', { method: 'POST', body: '{invalid' })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.deepEqual(await tasks.list(), [])
})

test('Task API enforces JSON, size, schema, methods and safe ids', async (t) => {
  const { request, tasks } = await fixture(t)
  for (const [body, code] of [['{', 'INVALID_JSON'], [JSON.stringify({ botId: 'missing' }), 'BOT_NOT_FOUND'], [JSON.stringify({ botId: 'chief', parameters: {} }), 'INVALID_TASK']]) {
    const response = await request('/api/tasks', { method: 'POST', body })
    assert.ok(response.status >= 400 && response.status < 500)
    assert.equal((await response.json()).error.code, code)
  }
  assert.equal((await request('/api/tasks', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await request('/api/tasks', { method: 'POST', body: 'a'.repeat(17000) })).status, 413)
  for (const path of ['/api/tasks/7']) {
    const response = await request(path, { method: 'POST', body: '{}' })
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET')
  }
  assert.equal((await request('/api/tasks', { method: 'DELETE' })).status, 405)
  for (const path of ['/api/tasks/0', '/api/tasks/1x', '/api/tasks/999999999999999999', '/api/tasks/999999']) assert.equal((await request(path)).status, 404)
  assert.deepEqual(await tasks.list(), [])
})

test('create failure returns redacted error and leaves no half Task visible', async (t) => {
  const { request } = await fixture(t, { beforeCommit: () => { throw new Error('sensitive data') } })
  const response = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ botId: 'chief' }) })
  assert.equal(response.status, 500)
  const body = await response.text()
  assert.ok(!body.includes('sensitive'))
  assert.ok(!body.includes('taskId'))
  assert.deepEqual(await (await request('/api/tasks')).json(), { tasks: [] })
})

test('public UI only serves allowlisted build artifacts, not storage or credentials', async (t) => {
  const { base, request } = await fixture(t)
  const response = await fetch(base + '/')
  assert.equal(response.status, 200)
  assert.match(await response.text(), /Pidot/)
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal((await fetch(base + '/assets/app-123.js')).status, 200)
  assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200)
  for (const path of ['/.env', '/data/pidot.sqlite', '/server/index.mjs', '/assets/%2e%2e/.env']) {
    assert.equal((await fetch(base + path)).status, 401)
    assert.equal((await request(path)).status, 404)
  }
})

test('real API process restart serves the same native Task and configuration from SQLite', { timeout: 10000 }, async (t) => {
  const { spawn } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-process-restart-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const probe = createApiServer({ token })
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  async function launch() {
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PIDOT_REPLY_MODE: 'test', PIDOT_API_TOKEN: token, PIDOT_API_PORT: String(port), PIDOT_DB_PATH: join(dir, 'persist.sqlite') },
    })
    const closed = once(child, 'close')
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('API exited before ready') })])
    return async () => {
      child.kill('SIGTERM')
      const [code, signal] = await closed
      assert.equal(code, 0); assert.equal(signal, null)
    }
  }
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
  let stop = await launch()
  const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ botId: 'calendar' }) })
  assert.equal(created.status, 201)
  const { task } = await created.json()
  async function sendAndWait(text) {
    const accepted = await request(`/api/tasks/${task.taskId}/messages`, { method: 'POST', body: JSON.stringify({ message: text }) })
    assert.equal(accepted.status, 202)
    for (let n = 0; n < 100; n++) {
      const { task: current } = await (await request(`/api/tasks/${task.taskId}`)).json()
      if (!current.activeInputId) return current
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('Message did not complete')
  }
  const first = await sendAndWait('重启前')
  assert.equal(first.messages.length, 2)
  await stop()
  stop = await launch()
  const reopened = (await (await request(`/api/tasks/${task.taskId}`)).json()).task
  assert.deepEqual(reopened.messages, first.messages)
  const second = await sendAndWait('重启后')
  assert.equal(second.messages.length, 4)
  assert.equal(second.taskId, task.taskId)
  assert.equal(second.conversationId, task.conversationId)
  assert.deepEqual(second.configRef, task.configRef)
  await stop()
})

test('message endpoint authenticates, validates, queues busy and reads back persistent failures', async (t) => {
  let release
  let attempts = 0
  const { request, base, tasks } = await fixture(t, { reply: async () => { if (++attempts === 1) await new Promise((resolve) => { release = resolve }); throw new Error('private-error') } })
  const task = await tasks.create({ botId: 'chief' })
  const path = `/api/tasks/${task.taskId}/messages`
  const post = (body, extra = {}) => request(path, { method: 'POST', body: JSON.stringify(body), ...extra })
  assert.equal((await fetch(base + path, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await request(path)).status, 405)
  for (const body of [{ message: '' }, { message: ' ' }, { message: 'x'.repeat(4001) }, { message: 'ok', taskId: 5 }, null]) assert.equal((await post(body)).status, 400)
  assert.equal((await post({ message: 'ok' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await post({ message: 'x'.repeat(18000) })).status, 413)
  assert.equal((await request('/api/tasks/999999/messages', { method: 'POST', body: '{"message":"test"}' })).status, 404)
  assert.equal((await post({ message: 'fail' })).status, 202)
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5))
  try {
    const queued = await post({ message: 'busy' })
    assert.equal(queued.status, 202)
    assert.equal((await queued.json()).status, 'queued')
  } finally { release() }
  for (let n = 0; n < 100; n++) {
    const current = (await (await request(`/api/tasks/${task.taskId}`)).json()).task
    if (!current.activeInputId) {
      assert.equal(current.messages.length, 4)
      assert.equal(current.messages.filter((m) => m.role === 'error').length, 2)
      assert.ok(current.messages.filter((m) => m.role === 'user').every((m) => m.deliveryStatus === 'failed'))
      assert.ok(!JSON.stringify(current).includes('private-error'))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Failure did not persist')
})
