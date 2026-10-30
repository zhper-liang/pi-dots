import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openGoogleConnection } from './google-connection.mjs'
import { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT, FAKE_GOOGLE_SECRET_PREFIXES } from './fixtures/fake-google.mjs'
import { GOOGLE_SERVICE_SCOPES, GOOGLE_IDENTITY_SCOPES } from './google-oauth.mjs'

const code = c => e => e.code === c
const leaks = text => FAKE_GOOGLE_SECRET_PREFIXES.filter(prefix => String(text).includes(prefix))
async function setup(fn, { fake: fakeOptions, connection: connectionOptions = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-google-')), fake = await createFakeGoogle(fakeOptions), guard = guardGoogleNetwork()
  const clock = { t: Date.parse('2026-10-31T00:00:00Z') }, notified = []
  const open = (extra = {}) => openGoogleConnection({ dataDirectory: join(dir, 'google'), env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch, now: () => clock.t, ...connectionOptions, ...extra })
  let google = await open()
  google.subscribe(() => { notified.push('change') })
  try {
    await fn({ dir, fake, clock, notified, get google() { return google }, reopen: async extra => { await google.close(); google = await open(extra); return google } })
    assert.deepEqual(guard.blocked, [], 'no request may reach a real Google host')
  } finally { await google.close(); await fake.close(); await rm(dir, { recursive: true, force: true }) }
}
async function saveClient(google, extra = {}) { return google.saveClient({ requestId: `client-${Math.random().toString(36).slice(2, 10)}`, ...FAKE_GOOGLE_CLIENT, ...extra }) }
async function startAndApprove(google, fake, services = ['calendar', 'tasks', 'workspace']) {
  const started = await google.start({ services })
  return { started, location: await fake.approve(started.attempt.authorizeUrl) }
}

test('R3-02 callback connect: PKCE S256, state, scope union, one-time 127.0.0.1 page, 0600 file', async () => setup(async ({ google, fake, dir }) => {
  await saveClient(google)
  const { started, location } = await startAndApprove(google, fake)
  const authorize = new URL(started.attempt.authorizeUrl)
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorize.searchParams.get('access_type'), 'offline'); assert.equal(authorize.searchParams.get('prompt'), 'consent')
  assert.match(authorize.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(authorize.searchParams.get('state').length >= 43)
  assert.deepEqual(authorize.searchParams.get('scope').split(' ').sort(), [...new Set([...GOOGLE_IDENTITY_SCOPES, ...Object.values(GOOGLE_SERVICE_SCOPES).flat()])].sort())
  const page = await fetch(location)
  const html = await page.text()
  assert.equal(page.status, 200); assert.match(html, /已连接/); assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.deepEqual(leaks(html), []); assert.ok(!html.includes(new URL(location).searchParams.get('state')))
  const status = await google.status()
  assert.equal(status.connected, true); assert.equal(status.email, 'owner@example.test')
  assert.deepEqual(status.services, ['calendar', 'tasks', 'gmail', 'drive', 'docs', 'sheets'])
  assert.deepEqual(leaks(JSON.stringify(status)), [])
  assert.match(await google.accessToken({ services: ['calendar'] }), /^ya29\.fake-access-/)
  assert.equal((await stat(join(dir, 'google'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(dir, 'google', 'credentials.json'))).mode & 0o777, 0o600)
  // The listener is one-time: a second visit cannot reach it.
  await assert.rejects(fetch(location))
}))

test('R3-02 paste fallback: unreachable callback, pasted redirect completes the same exchange once', async () => setup(async ({ google, fake }) => {
  await saveClient(google)
  const { location } = await startAndApprove(google, fake, ['calendar'])
  // Browser on another machine: the redirect never reaches this host's listener.
  await assert.rejects(google.paste({ redirectUrl: location.replace(/state=[^&]+/, 'state=forged') }), code('GOOGLE_STATE_MISMATCH'))
  await assert.rejects(google.paste({ redirectUrl: location.replace('127.0.0.1', 'evil.example') }), code('GOOGLE_REDIRECT_INVALID'))
  await assert.rejects(google.paste({ redirectUrl: 'not a url' }), code('GOOGLE_REDIRECT_INVALID'))
  const status = await google.paste({ redirectUrl: `  ${location}  ` })
  assert.equal(status.connected, true); assert.deepEqual(status.services, ['calendar'])
  assert.equal(fake.count('/token', 'POST'), 1)
  await assert.rejects(google.paste({ redirectUrl: location }), code('GOOGLE_ATTEMPT_USED'))
  assert.equal(fake.count('/token', 'POST'), 1, 'a replayed redirect never reaches the token endpoint')
}))

test('R3-02 state mismatch at the callback keeps the attempt; replay after use is refused', async () => setup(async ({ google, fake }) => {
  await saveClient(google)
  const { location } = await startAndApprove(google, fake, ['tasks'])
  const forged = await fetch(location.replace(/state=[^&]+/, 'state=forged'))
  assert.equal(forged.status, 400); assert.match(await forged.text(), /链接无效/)
  assert.equal((await google.status()).connected, false)
  assert.equal((await fetch(location)).status, 200)
  assert.equal((await google.status()).connected, true)
  await assert.rejects(google.paste({ redirectUrl: location }), code('GOOGLE_ATTEMPT_USED'))
}))

test('R3-02 five-minute limit, user denial and missing attempt', async () => setup(async ({ google, fake, clock }) => {
  await saveClient(google)
  await assert.rejects(google.paste({ redirectUrl: 'http://127.0.0.1:1/?state=x&code=y' }), code('GOOGLE_ATTEMPT_MISSING'))
  const { location } = await startAndApprove(google, fake, ['calendar'])
  clock.t += 5 * 60 * 1000
  await assert.rejects(google.paste({ redirectUrl: location }), code('GOOGLE_ATTEMPT_EXPIRED'))
  assert.equal(fake.count('/token', 'POST'), 0)
  fake.setGrant({ deny: true })
  const denied = await startAndApprove(google, fake, ['calendar'])
  assert.match(denied.location, /error=access_denied/)
  await assert.rejects(google.paste({ redirectUrl: denied.location }), code('GOOGLE_ACCESS_DENIED'))
  const status = await google.status()
  assert.equal(status.connected, false); assert.equal(status.lastResult.result, 'denied')
}))

test('R3-02 the real timer closes the listener after the limit', async () => setup(async ({ google, fake }) => {
  await saveClient(google)
  const { location } = await startAndApprove(google, fake, ['calendar'])
  await new Promise(resolve => setTimeout(resolve, 120))
  await assert.rejects(fetch(location))
  assert.equal((await google.status()).lastResult.result, 'expired')
}, { connection: { attemptMs: 50 } }))

test('R3-02 partial scopes: services follow what Google actually granted', async () => setup(async ({ google, fake }) => {
  await saveClient(google)
  fake.setGrant({ scopes: [...GOOGLE_IDENTITY_SCOPES, ...GOOGLE_SERVICE_SCOPES.calendar, GOOGLE_SERVICE_SCOPES.gmail[0]] })
  const { location } = await startAndApprove(google, fake)
  const status = await google.paste({ redirectUrl: location })
  assert.deepEqual(status.services, ['calendar']); assert.deepEqual(status.requested, ['calendar', 'tasks', 'gmail', 'drive', 'docs', 'sheets'])
  await google.accessToken({ services: ['calendar'] })
  await assert.rejects(google.accessToken({ services: ['tasks'] }), code('GOOGLE_SCOPE_MISSING'))
  await assert.rejects(google.accessToken({ services: ['gmail'] }), code('GOOGLE_SCOPE_MISSING'))
}))

test('R3-02 token API: refresh ~60 s early, one refresh for concurrent callers, cached otherwise', async () => setup(async ({ google, fake, clock }) => {
  await saveClient(google)
  await google.paste({ redirectUrl: (await startAndApprove(google, fake, ['calendar'])).location })
  const first = await google.accessToken()
  clock.t += 3500 * 1000
  assert.equal(await google.accessToken(), first)
  assert.equal(fake.count('/token', 'POST'), 1)
  clock.t += 45 * 1000 // 55 s left: inside the early-refresh margin
  fake.fail({ method: 'POST', path: '/token', delayMs: 40, after: true })
  const tokens = await Promise.all(Array.from({ length: 6 }, () => google.accessToken({ services: ['calendar'] })))
  assert.equal(new Set(tokens).size, 1); assert.notEqual(tokens[0], first)
  assert.equal(fake.count('/token', 'POST'), 2, 'six concurrent callers share one refresh')
}))

test('R3-02 invalid_grant: needs_auth, refresh token dropped, listeners told, no further network', async () => setup(async ({ google, fake, clock, dir, notified }) => {
  await saveClient(google)
  await google.paste({ redirectUrl: (await startAndApprove(google, fake, ['calendar'])).location })
  const before = notified.length
  fake.revokeAll(); clock.t += 3600 * 1000
  await assert.rejects(google.accessToken(), e => e.code === 'GOOGLE_NEEDS_AUTH' && e.kind === 'needs_auth')
  assert.equal((await google.status()).status, 'needs_auth')
  assert.ok(notified.length > before)
  const file = JSON.parse(await readFile(join(dir, 'google', 'credentials.json'), 'utf8'))
  assert.equal(file.account.refreshToken, null); assert.equal(file.account.status, 'needs_auth')
  const calls = fake.count('/token', 'POST')
  await assert.rejects(google.accessToken(), code('GOOGLE_NEEDS_AUTH'))
  assert.equal(fake.count('/token', 'POST'), calls)
}))

test('R3-02 disconnect revokes, deletes the account, keeps the client; revoke failure is reported', async () => setup(async ({ google, fake, dir }) => {
  await saveClient(google)
  await google.paste({ redirectUrl: (await startAndApprove(google, fake, ['calendar'])).location })
  const result = await google.disconnect({})
  assert.deepEqual(result, { disconnected: true, revoked: true })
  assert.equal(fake.count('/revoke', 'POST'), 1)
  const file = JSON.parse(await readFile(join(dir, 'google', 'credentials.json'), 'utf8'))
  assert.equal(file.account, null); assert.equal(file.client.clientId, FAKE_GOOGLE_CLIENT.clientId)
  await assert.rejects(google.accessToken(), code('GOOGLE_NOT_CONNECTED'))
  await google.paste({ redirectUrl: (await startAndApprove(google, fake, ['calendar'])).location })
  fake.fail({ method: 'POST', path: '/revoke', status: 503 })
  assert.deepEqual(await google.disconnect({}), { disconnected: true, revoked: false })
  assert.equal((await google.status()).connected, false)
}))

test('R3-02 restart keeps the connection and refreshes from the stored refresh token', async () => setup(async ({ google, fake, reopen }) => {
  await saveClient(google)
  await google.paste({ redirectUrl: (await startAndApprove(google, fake, ['tasks'])).location })
  const reopened = await reopen()
  assert.equal((await reopened.status()).connected, true)
  assert.match(await reopened.accessToken({ services: ['tasks'] }), /^ya29\.fake-access-/)
  assert.equal(fake.count('/token', 'POST'), 2)
}))

test('R3-02 no refresh token returned: not connected, clear error', async () => setup(async ({ google, fake }) => {
  await saveClient(google)
  fake.setGrant({ refreshToken: false })
  await assert.rejects(google.paste({ redirectUrl: (await startAndApprove(google, fake, ['calendar'])).location }), code('GOOGLE_NO_REFRESH_TOKEN'))
  assert.equal((await google.status()).connected, false)
}))

test('R3-02 changing the client id invalidates the old refresh token', async () => setup(async ({ google, fake }) => {
  await saveClient(google)
  await google.paste({ redirectUrl: (await startAndApprove(google, fake, ['calendar'])).location })
  await saveClient(google, { clientId: 'other-client.apps.googleusercontent.com' })
  assert.equal((await google.status()).status, 'needs_auth')
  await assert.rejects(google.accessToken(), code('GOOGLE_NEEDS_AUTH'))
}))

test('R3-02 client config: env wins and locks the UI; partial env fails closed; secret never echoed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-google-env-'))
  try {
    const envFile = join(dir, 'app.env')
    await writeFile(envFile, `GOOGLE_OAUTH_CLIENT_ID=${FAKE_GOOGLE_CLIENT.clientId}\nGOOGLE_OAUTH_CLIENT_SECRET=${FAKE_GOOGLE_CLIENT.clientSecret}\n`)
    const fromFile = await openGoogleConnection({ dataDirectory: join(dir, 'a'), env: {}, envFiles: [envFile] })
    const status = await fromFile.status()
    assert.deepEqual(status.client, { configured: true, source: 'env', invalid: false, editable: false })
    await assert.rejects(fromFile.saveClient({ requestId: 'client-env-locked', ...FAKE_GOOGLE_CLIENT }), code('GOOGLE_CLIENT_ENV_LOCKED'))
    assert.deepEqual(leaks(JSON.stringify(status)), [])
    await fromFile.close()
    const partial = await openGoogleConnection({ dataDirectory: join(dir, 'b'), env: { GOOGLE_OAUTH_CLIENT_ID: FAKE_GOOGLE_CLIENT.clientId }, envFiles: [] })
    assert.equal((await partial.status()).client.invalid, true)
    await assert.rejects(partial.start({ services: ['calendar'] }), code('GOOGLE_CLIENT_INVALID'))
    await partial.close()
    const local = await openGoogleConnection({ dataDirectory: join(dir, 'c'), env: {}, envFiles: [] })
    const saved = await local.saveClient({ requestId: 'client-first-save', ...FAKE_GOOGLE_CLIENT })
    assert.deepEqual(saved.client, { configured: true, source: 'file', invalid: false, editable: true })
    // Blank secret keeps the stored one; same requestId with other values conflicts.
    await local.saveClient({ requestId: 'client-keep-secret', clientId: FAKE_GOOGLE_CLIENT.clientId, clientSecret: '' })
    await assert.rejects(local.saveClient({ requestId: 'client-first-save', clientId: 'x.apps.googleusercontent.com', clientSecret: 'y' }), code('GOOGLE_CLIENT_REQUEST_CONFLICT'))
    await assert.rejects(local.saveClient({ requestId: 'client-bad', clientId: 'bad id', clientSecret: 'y' }), code('GOOGLE_CLIENT_INPUT'))
    await assert.rejects(local.start({ services: [] }), code('GOOGLE_CONNECT_INPUT'))
    await assert.rejects(local.start({ services: ['gmail'] }), code('GOOGLE_CONNECT_INPUT'))
    await local.close()
    assert.equal(JSON.parse(await readFile(join(dir, 'c', 'credentials.json'), 'utf8')).client.clientSecret, FAKE_GOOGLE_CLIENT.clientSecret)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('R3-02 credential file guards: symlinked file or directory and loose permissions are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-google-fs-'))
  try {
    const valid = JSON.stringify({ version: 1, client: FAKE_GOOGLE_CLIENT, account: null })
    await mkdir(join(dir, 'link-file'), { mode: 0o700 }); await writeFile(join(dir, 'outside.json'), valid, { mode: 0o600 })
    await symlink(join(dir, 'outside.json'), join(dir, 'link-file', 'credentials.json'))
    await assert.rejects(openGoogleConnection({ dataDirectory: join(dir, 'link-file'), env: {}, envFiles: [] }), code('GOOGLE_STORAGE_FAILED'))
    await mkdir(join(dir, 'real'), { mode: 0o700 }); await symlink(join(dir, 'real'), join(dir, 'link-dir'))
    await assert.rejects(openGoogleConnection({ dataDirectory: join(dir, 'link-dir'), env: {}, envFiles: [] }), code('GOOGLE_STORAGE_FAILED'))
    await mkdir(join(dir, 'loose'), { mode: 0o700 }); await writeFile(join(dir, 'loose', 'credentials.json'), valid, { mode: 0o644 })
    await assert.rejects(openGoogleConnection({ dataDirectory: join(dir, 'loose'), env: {}, envFiles: [] }), code('GOOGLE_STORAGE_FAILED'))
    await mkdir(join(dir, 'corrupt'), { mode: 0o700 }); await writeFile(join(dir, 'corrupt', 'credentials.json'), '{"version":1,"client":{"clientId":"x"}}', { mode: 0o600 })
    await assert.rejects(openGoogleConnection({ dataDirectory: join(dir, 'corrupt'), env: {}, envFiles: [] }), e => e.code === 'GOOGLE_STORAGE_FAILED' && !e.message.includes(dir))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('R3-02 redact replaces every known secret', async () => setup(async ({ google, fake }) => {
  await saveClient(google)
  await google.paste({ redirectUrl: (await startAndApprove(google, fake, ['calendar'])).location })
  const token = await google.accessToken()
  const text = google.redact(`a ${token} b ${FAKE_GOOGLE_CLIENT.clientSecret} c`)
  assert.deepEqual(leaks(text), []); assert.match(text, /\[已隐藏凭证\]/)
}))

test('R3-02 a disconnect during the code exchange wins; concurrent starts leave one listener', async () => setup(async ({ google, fake }) => {
  await saveClient(google)
  const [a, b] = await Promise.all([google.start({ services: ['calendar'] }), google.start({ services: ['calendar'] })])
  assert.notEqual(a.attempt.authorizeUrl, b.attempt.authorizeUrl)
  await assert.rejects(fetch(new URL(a.attempt.authorizeUrl).searchParams.get('redirect_uri')), 'the first listener was closed by the second start')
  const location = await fake.approve(b.attempt.authorizeUrl)
  fake.fail({ method: 'POST', path: '/token', delayMs: 80, after: true })
  const pasting = google.paste({ redirectUrl: location })
  await new Promise(resolve => setTimeout(resolve, 20))
  await google.disconnect({})
  await assert.rejects(pasting, code('GOOGLE_BUSY'))
  const status = await google.status()
  assert.equal(status.connected, false); assert.equal(status.status, 'disconnected')
  assert.ok(fake.count('/revoke', 'POST') >= 1, 'the grant obtained after disconnect is revoked')
}))
