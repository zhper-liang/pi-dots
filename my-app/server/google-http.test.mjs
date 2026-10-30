import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createApiServer } from './app.mjs'
import { openTaskStore } from './tasks.mjs'
import { openGoogleConnection } from './google-connection.mjs'
import { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT, FAKE_GOOGLE_SECRET_PREFIXES } from './fixtures/fake-google.mjs'

const TOKEN = 'r3-google-http-token-0123456789abcdef'
async function files(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name))
  return out
}

test('R3-02 HTTP: status/client/connect/paste/disconnect, auth and methods, zero secret hits anywhere', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-http-')), fake = await createFakeGoogle(), guard = guardGoogleNetwork()
  const captured = [], original = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  for (const name of Object.keys(original)) console[name] = (...args) => { captured.push(args.map(String).join(' ')); }
  const google = await openGoogleConnection({ dataDirectory: join(dir, 'google'), env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch })
  const store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), google, workspaceScheduleOptions: { autoStart: false } })
  const server = createApiServer({ token: TOKEN, tasks: store, onError: message => captured.push(String(message)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`, bodies = []
  let closed = false
  const call = async (path, body, { auth = true, method } = {}) => {
    const response = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text(); bodies.push(text)
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  try {
    assert.equal((await call('/api/google/status', undefined, { auth: false })).status, 401)
    assert.equal((await call('/api/google/status', {}, { method: 'POST' })).status, 405)
    assert.equal((await call('/api/google/connect', undefined, { method: 'GET' })).status, 405)
    assert.equal((await call('/api/google/tokens')).status, 404, 'no route ever returns a token')
    const initial = await call('/api/google/status')
    assert.equal(initial.status, 200)
    assert.deepEqual(Object.keys(initial.body.data).sort(), ['attempt', 'client', 'connected', 'email', 'lastResult', 'requested', 'services', 'status'])
    assert.equal((await call('/api/google/connect', { services: ['calendar'] })).body.error.code, 'GOOGLE_NOT_CONFIGURED')
    const saved = await call('/api/google/client', { requestId: 'http-client-0001', ...FAKE_GOOGLE_CLIENT })
    assert.equal(saved.status, 200); assert.equal(saved.body.data.client.configured, true)
    assert.equal((await call('/api/google/client', { requestId: 'http-client-0002', clientId: 'x y', clientSecret: 'z' })).body.error.code, 'GOOGLE_CLIENT_INPUT')
    const started = await call('/api/google/connect', { services: ['calendar', 'tasks', 'workspace'] })
    assert.equal(started.status, 200); assert.ok(started.body.data.attempt.authorizeUrl.startsWith(fake.endpoints.authorize))
    const location = await fake.approve(started.body.data.attempt.authorizeUrl)
    // Pasted text is a secret: a malformed paste is refused without echoing any of it.
    const bad = await call('/api/google/paste', { redirectUrl: `${location.replace(/:\d+\//, ':1/')}` })
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'GOOGLE_REDIRECT_INVALID')
    assert.equal((await call('/api/google/paste', { redirectUrl: location, extra: 1 })).status, 400)
    const pasted = await call('/api/google/paste', { redirectUrl: location })
    assert.equal(pasted.status, 200); assert.equal(pasted.body.data.connected, true); assert.equal(pasted.body.data.email, 'owner@example.test')
    assert.equal((await call('/api/google/paste', { redirectUrl: location })).body.error.code, 'GOOGLE_ATTEMPT_USED')
    const status = await call('/api/google/status')
    assert.deepEqual(status.body.data.services, ['calendar', 'tasks', 'gmail', 'drive', 'docs', 'sheets'])
    // A Task runs and its history is scanned too.
    const task = await call('/api/tasks', { botId: 'chief' })
    await call(`/api/tasks/${task.body.task.taskId}/messages`, { message: '连接我的 Google' })
    for (let i = 0; i < 100; i++) { const t = await call(`/api/tasks/${task.body.task.taskId}`); if (t.body.task.activeInputId === null) break; await new Promise(r => setTimeout(r, 10)) }
    // Sanity: the scan prefixes are real — the credentials file holds the refresh token.
    const credentials = await readFile(join(dir, 'google', 'credentials.json'), 'utf8')
    assert.ok(credentials.includes('1//fake-refresh-') && credentials.includes(FAKE_GOOGLE_CLIENT.clientSecret))
    const disconnected = await call('/api/google/disconnect', {})
    assert.deepEqual(disconnected.body.data, { disconnected: true, revoked: true })
    assert.equal((await call('/api/google/status')).body.data.connected, false)
    await store.close(); closed = true
    const leaks = []
    for (const file of await files(dir)) {
      if (file.endsWith(join('google', 'credentials.json'))) continue
      const bytes = (await readFile(file)).toString('latin1')
      for (const prefix of FAKE_GOOGLE_SECRET_PREFIXES) if (bytes.includes(prefix)) leaks.push(`${file.slice(dir.length)}:${prefix}`)
    }
    for (const text of [...bodies, ...captured]) for (const prefix of FAKE_GOOGLE_SECRET_PREFIXES) if (text.includes(prefix)) leaks.push(`text:${prefix}`)
    assert.deepEqual(leaks, [], 'no token, code, client secret or pasted URL in SQLite, HTTP responses, logs or Task history')
    assert.ok(!bodies.some(text => text.includes(location)), 'the pasted redirect URL never comes back')
    assert.deepEqual(guard.blocked, [])
  } finally {
    Object.assign(console, original)
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (!closed) await store.close().catch(() => {}); await google.close(); await fake.close(); await rm(dir, { recursive: true, force: true })
  }
})
