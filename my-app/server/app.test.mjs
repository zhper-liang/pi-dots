import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiServer, MAX_BODY_BYTES } from './app.mjs'
import { readConfig } from './config.mjs'

// Ephemeral test-only token. No user credentials are loaded by the test suite.
const token = 'pidot-test-only-token-not-for-deployment'

async function withServer(run, options = {}) {
  const server = createApiServer({ token, ...options })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { address, port } = server.address()
  assert.equal(address, '127.0.0.1')
  const request = (body, init = {}) => fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  })
  try {
    await run(request, `http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
  }
}

async function expectError(response, status, code) {
  assert.equal(response.status, status)
  const body = await response.json()
  assert.equal(body.error.code, code)
  assert.equal(typeof body.error.message, 'string')
  assert.equal('reply' in body, false)
  return body
}

test('valid message returns an explicitly marked deterministic test reply', async () => {
  await withServer(async (request) => {
    const first = await request({ message: '你好，Pidot' })
    assert.equal(first.status, 200)
    assert.match(first.headers.get('content-type'), /application\/json/)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.equal(first.headers.get('access-control-allow-origin'), null)
    const body = await first.json()
    assert.deepEqual(body, {
      mode: 'test',
      reply: { role: 'assistant', content: '[测试回复，非模型输出] 收到：你好，Pidot' },
    })
    assert.deepEqual(await (await request({ message: '你好，Pidot' })).json(), body)
    assert.match((await (await request({ message: '另一条消息' })).json()).reply.content, /另一条消息$/)
  })
})

test('missing, incorrect and malformed tokens are denied before body parsing', async () => {
  await withServer(async (request) => {
    for (const auth of [undefined, 'Bearer wrong', `Basic ${token}`, `Bearer ${token}extra`]) {
      const headers = { 'Content-Type': 'application/json' }
      if (auth) headers.Authorization = auth
      const response = await request('{bad json', { headers })
      assert.equal(response.headers.get('www-authenticate'), 'Bearer')
      await expectError(response, 401, 'UNAUTHORIZED')
    }
  })
})

test('invalid JSON, schema and whitespace-only messages are rejected', async () => {
  await withServer(async (request) => {
    for (const body of ['', '{broken']) await expectError(await request(body), 400, 'INVALID_JSON')
    for (const body of [null, [], {}, { message: '' }, { message: ' \n ' }, { message: 1 },
      { message: 'a'.repeat(4001) }, { message: 'ok', model: 'not-allowed' }]) {
      await expectError(await request(body), 400, 'INVALID_MESSAGE')
    }
    assert.equal((await request({ message: 'a'.repeat(4000) })).status, 200)
  })
})

test('body size and content type limits return structured errors', async () => {
  await withServer(async (request) => {
    await expectError(await request({ message: 'a'.repeat(MAX_BODY_BYTES) }), 413, 'PAYLOAD_TOO_LARGE')
    await expectError(await request({ message: 'hello' }, { headers: { Authorization: `Bearer ${token}` } }), 415, 'UNSUPPORTED_MEDIA_TYPE')
    assert.equal((await request({ message: 'still alive' })).status, 200)
  })
})

test('authenticated unknown routes and unsupported methods are explicit', async () => {
  await withServer(async (request, base) => {
    const response = await request(undefined, { method: 'GET' })
    assert.equal(response.headers.get('allow'), 'POST')
    await expectError(response, 405, 'METHOD_NOT_ALLOWED')
    await expectError(await fetch(`${base}/missing`, { headers: { Authorization: `Bearer ${token}` } }), 404, 'NOT_FOUND')
    await expectError(await fetch(`${base}/api/chat?token=${token}`), 401, 'UNAUTHORIZED')
    await expectError(await fetch(`${base}/api/chat`, { method: 'OPTIONS' }), 401, 'UNAUTHORIZED')
  })
})

test('service exceptions return 500, never a fabricated reply or sensitive details', async () => {
  const logs = []
  await withServer(async (request) => {
    const error = await expectError(await request({ message: 'hello' }), 500, 'INTERNAL_ERROR')
    assert.equal(JSON.stringify(error).includes(token), false)
    assert.deepEqual(logs, ['API request failed'])
  }, { reply: async () => { throw new Error(`sensitive ${token}`) }, onError: (entry) => logs.push(entry) })
})

test('configuration fails closed and always binds loopback', () => {
  for (const value of [undefined, '', 'short', ' '.repeat(32), 'a'.repeat(31), 'a'.repeat(257), 'a'.repeat(32) + '\n']) {
    assert.throws(() => readConfig({ PIDOT_API_TOKEN: value }), /PIDOT_API_TOKEN/)
  }
  for (const port of ['', '0', '-1', '65536', '1.5', '3e3', ' 3001']) {
    assert.throws(() => readConfig({ PIDOT_API_TOKEN: token, PIDOT_API_PORT: port }), /PIDOT_API_PORT/)
  }
  assert.deepEqual(readConfig({ PIDOT_API_TOKEN: token, HOST: '0.0.0.0' }), { host: '127.0.0.1', port: 3001, token })
  assert.equal(readConfig({ PIDOT_API_TOKEN: token, PIDOT_API_PORT: '4001' }).port, 4001)
})

test('CLI refuses missing configuration without printing secrets', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PIDOT_REPLY_MODE: 'test', PIDOT_API_TOKEN: '' },
  })
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += data })
  const [code] = await once(child, 'close')
  assert.equal(code, 1)
  assert.match(stderr, /配置错误.*PIDOT_API_TOKEN/)
})

test('CLI starts, serves requests, rejects occupied port and stops on SIGTERM', { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const database = join(dir, 'test.sqlite')
  // Reserve an ephemeral port to avoid assuming a specific local port is free.
  await withServer(async (_request, base) => {
    const port = new URL(base).port
    const env = { ...process.env, PIDOT_REPLY_MODE: 'test', PIDOT_API_TOKEN: token, PIDOT_API_PORT: port, PIDOT_DB_PATH: database }
    const occupied = spawn(process.execPath, ['server/index.mjs'], { cwd: new URL('..', import.meta.url), env })
    let stderr = ''
    occupied.stderr.on('data', (data) => { stderr += data })
    const [code] = await once(occupied, 'close')
    assert.equal(code, 1)
    assert.match(stderr, /已被占用/)
    assert.equal(stderr.includes(token), false)
  })
  const probe = createApiServer({ token })
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PIDOT_REPLY_MODE: 'test', PIDOT_API_TOKEN: token, PIDOT_API_PORT: String(port), PIDOT_DB_PATH: database },
  })
  const closed = once(child, 'close')
  try {
    await once(child.stdout, 'data')
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'CLI smoke test' }),
    })
    assert.equal(response.status, 200)
    child.kill('SIGTERM')
    const [code, signal] = await closed
    assert.equal(code, 0)
    assert.equal(signal, null)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/chat`))
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('06 response serialization failure returns JSON 500 before headers and server stays available', async () => {
  let calls = 0
  await withServer(async request => {
    const failure = await request({ message: 'unserializable result' })
    await expectError(failure, 500, 'INTERNAL_ERROR')
    const next = await request({ message: 'still available' })
    assert.equal(next.status, 200)
    assert.equal((await next.json()).ok, true)
  }, { reply: async () => ++calls === 1 ? { unsupported: 1n } : { ok: true } })
})
