import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openGoogleConnection } from './google-connection.mjs'
import { createGoogleClient, googleEndpoints, GOOGLE_ENDPOINTS } from './google-client.mjs'
import { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT, FAKE_GOOGLE_SECRET_PREFIXES } from './fixtures/fake-google.mjs'

const code = c => e => e.code === c
async function connected(fn, { fake: fakeOptions, connection = {}, services = ['calendar', 'tasks'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-client-')), fake = await createFakeGoogle(fakeOptions), guard = guardGoogleNetwork(), sleeps = []
  const google = await openGoogleConnection({ dataDirectory: join(dir, 'google'), env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch, sleep: async ms => { sleeps.push(ms) }, ...connection })
  try {
    await google.saveClient({ requestId: 'client-for-client-tests', ...FAKE_GOOGLE_CLIENT })
    const started = await google.start({ services })
    await google.paste({ redirectUrl: await fake.approve(started.attempt.authorizeUrl) })
    fake.addCalendar({ id: 'primary@example.test', summary: '我的日历', primary: true }).addTaskList({ id: 'list-1', title: '清单' })
    await fn({ google, fake, sleeps, calls: path => fake.requests.filter(r => r.path.endsWith(path)).length })
    assert.deepEqual(guard.blocked, [])
  } finally { await google.close(); await fake.close(); await rm(dir, { recursive: true, force: true }) }
}
const event = { summary: 'R3 测试', start: { dateTime: '2026-11-02T09:00:00+08:00' }, end: { dateTime: '2026-11-02T10:00:00+08:00' } }
const eventsPath = '/calendars/primary%40example.test/events'

test('R3-01 production hosts are fixed; only loopback fixtures may replace them', async () => {
  const seen = []
  const client = createGoogleClient({ token: async () => 'test-token', fetchImpl: async url => { seen.push(new URL(url).origin); return Response.json({ items: [] }) } })
  await client.api('calendar', '/users/me/calendarList'); await client.api('tasks', '/users/@me/lists')
  assert.deepEqual(seen, ['https://www.googleapis.com', 'https://tasks.googleapis.com'])
  assert.equal(googleEndpoints(), GOOGLE_ENDPOINTS)
  for (const bad of [{ calendar: 'https://evil.example/calendar/v3' }, { token: 'http://10.0.0.1/token' }, { token: 'http://user:pw@127.0.0.1/token' }, { nope: 'http://127.0.0.1/x' }]) assert.throws(() => googleEndpoints(bad))
  await assert.rejects(openGoogleConnection({ dataDirectory: '/nonexistent-never-created', env: {}, envFiles: [], endpoints: { token: 'https://oauth2.example.com/token' } }))
})

test('R3-02 reads: at most one backoff retry for 5xx, 429 (Retry-After), transport loss', async () => connected(async ({ google, fake, sleeps, calls }) => {
  fake.fail({ method: 'GET', path: '/users/me/calendarList', status: 503 })
  assert.equal((await google.api('calendar', '/users/me/calendarList')).data.items.length, 1)
  assert.equal(calls('/users/me/calendarList'), 2)
  fake.fail({ method: 'GET', path: '/users/me/calendarList', status: 500, times: 2 })
  await assert.rejects(google.api('calendar', '/users/me/calendarList'), e => e.code === 'GOOGLE_PROVIDER_ERROR' && !e.outcomeUnknown)
  assert.equal(calls('/users/me/calendarList'), 4, 'never a third attempt')
  fake.fail({ method: 'GET', path: '/users/@me/lists', status: 429, headers: { 'Retry-After': '1' } })
  await google.api('tasks', '/users/@me/lists')
  assert.equal(sleeps.at(-1), 1000)
  fake.fail({ method: 'GET', path: '/users/@me/lists', status: 403, reason: 'rateLimitExceeded' })
  await google.api('tasks', '/users/@me/lists')
  fake.fail({ method: 'GET', path: '/users/me/calendarList', disconnect: true })
  assert.equal((await google.api('calendar', '/users/me/calendarList')).status, 200)
}))

test('R3-02 writes are never resent; 5xx, timeouts and lost responses are outcome-unknown', async () => connected(async ({ google, fake, calls }) => {
  fake.fail({ method: 'POST', path: eventsPath, status: 503 })
  await assert.rejects(google.api('calendar', eventsPath, { method: 'POST', body: event }), e => e.code === 'GOOGLE_PROVIDER_ERROR' && e.outcomeUnknown && /结果未知/.test(e.message))
  assert.equal(calls(eventsPath), 1)
  fake.fail({ method: 'POST', path: eventsPath, status: 429 })
  await assert.rejects(google.api('calendar', eventsPath, { method: 'POST', body: event }), e => e.code === 'GOOGLE_RATE_LIMIT' && !e.outcomeUnknown)
  assert.equal(calls(eventsPath), 2)
  // The insert lands, then the connection drops before the response: unknown, and exactly one event.
  fake.fail({ method: 'POST', path: eventsPath, after: true, disconnect: true })
  await assert.rejects(google.api('calendar', eventsPath, { method: 'POST', body: { ...event, id: 'deterministicid0001' } }), e => e.code === 'GOOGLE_TRANSPORT' && e.outcomeUnknown)
  assert.equal(calls(eventsPath), 3)
  assert.ok(fake.state.events.get('primary@example.test').has('deterministicid0001'))
  await assert.rejects(google.api('calendar', eventsPath, { method: 'POST', body: { ...event, id: 'deterministicid0001' } }), code('GOOGLE_CONFLICT'))
}))

test('R3-02 timeouts: a read retries once, a write is unknown and not resent', async () => connected(async ({ google, fake, calls }) => {
  fake.fail({ method: 'GET', path: '/users/me/calendarList', hang: true, times: 2 })
  await assert.rejects(google.api('calendar', '/users/me/calendarList'), code('GOOGLE_TIMEOUT'))
  assert.equal(calls('/users/me/calendarList'), 2)
  fake.fail({ method: 'POST', path: eventsPath, hang: true })
  await assert.rejects(google.api('calendar', eventsPath, { method: 'POST', body: event }), e => e.code === 'GOOGLE_TIMEOUT' && e.outcomeUnknown)
  assert.equal(calls(eventsPath), 1)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(google.api('calendar', '/users/me/calendarList', { signal: controller.signal }), code('GOOGLE_CANCELLED'))
}, { connection: { timeoutMs: 150 } }))

test('R3-02 401: one forced refresh and resend, then needs_auth', async () => connected(async ({ google, fake, calls }) => {
  fake.fail({ method: 'GET', path: '/users/me/calendarList', status: 401, reason: 'authError' })
  assert.equal((await google.api('calendar', '/users/me/calendarList')).status, 200)
  assert.equal(calls('/token'), 2, 'exchange + one refresh')
  fake.fail({ method: 'POST', path: eventsPath, status: 401, reason: 'authError' })
  assert.equal((await google.api('calendar', eventsPath, { method: 'POST', body: event })).status, 200)
  assert.equal([...fake.state.events.get('primary@example.test').values()].length, 1, 'a 401-rejected write is resent once and lands once')
  fake.fail({ method: 'GET', path: '/users/me/calendarList', status: 401, times: 2 })
  await assert.rejects(google.api('calendar', '/users/me/calendarList'), e => e.code === 'GOOGLE_NEEDS_AUTH' && e.kind === 'needs_auth')
}))

test('R3-02 412 conflict, 404/410, redirect refusal, oversized body, provider text never surfaces', async () => connected(async ({ google, fake }) => {
  const created = (await google.api('calendar', eventsPath, { method: 'POST', body: event })).data
  await google.api('calendar', `${eventsPath}/${created.id}`, { method: 'PATCH', body: { summary: '改' }, headers: { 'If-Match': created.etag } })
  await assert.rejects(google.api('calendar', `${eventsPath}/${created.id}`, { method: 'PATCH', body: { summary: '旧版本' }, headers: { 'If-Match': created.etag } }), e => e.code === 'GOOGLE_PRECONDITION' && !e.outcomeUnknown)
  await assert.rejects(google.api('calendar', `${eventsPath}/missing`), code('GOOGLE_NOT_FOUND'))
  await google.api('calendar', `${eventsPath}/${created.id}`, { method: 'DELETE' })
  await assert.rejects(google.api('calendar', `${eventsPath}/${created.id}`, { method: 'DELETE' }), code('GOOGLE_GONE'))
  fake.fail({ method: 'GET', path: '/users/me/calendarList', status: 302, headers: { Location: 'https://evil.example/' } })
  await assert.rejects(google.api('calendar', '/users/me/calendarList'), code('GOOGLE_REDIRECT_REFUSED'))
  fake.fail({ method: 'GET', path: '/users/me/calendarList', huge: 2 * 1024 * 1024 })
  await assert.rejects(google.api('calendar', '/users/me/calendarList'), code('GOOGLE_RESPONSE_TOO_LARGE'))
  fake.fail({ method: 'GET', path: '/users/@me/lists', status: 400, body: { error: { message: 'provider says SECRET-PROVIDER-TEXT' } } })
  await assert.rejects(google.api('tasks', '/users/@me/lists'), e => e.code === 'GOOGLE_BAD_REQUEST' && !e.message.includes('SECRET-PROVIDER-TEXT'))
}))

test('R3-02 request shape is validated before any network call', async () => connected(async ({ google, fake }) => {
  const before = fake.requests.length
  for (const [service, path, options] of [['gmail', '/x'], ['calendar', '/../token'], ['calendar', '//evil.example/x'], ['calendar', 'relative'], ['calendar', '/x', { headers: { Authorization: 'Bearer other' } }], ['calendar', '/x', { headers: { 'If-Match': 'a\r\nX: y' } }], ['calendar', '/x', { method: 'TRACE' }]]) {
    await assert.rejects(google.api(service, path, options), code('GOOGLE_INPUT'))
  }
  assert.equal(fake.requests.length, before)
}))

test('R3-01 fake-google: pagination, Tasks date-only due, userinfo, scope enforcement, secret prefixes', async () => connected(async ({ google, fake }) => {
  for (let i = 0; i < 4; i++) fake.addCalendar({ id: `cal-${i}@example.test`, accessRole: i % 2 ? 'reader' : 'owner' })
  const first = (await google.api('calendar', '/users/me/calendarList', { query: { maxResults: 2 } })).data
  assert.equal(first.items.length, 2); assert.ok(first.nextPageToken)
  const second = (await google.api('calendar', '/users/me/calendarList', { query: { maxResults: 2, pageToken: first.nextPageToken } })).data
  assert.equal(second.items.length, 2); assert.ok(second.nextPageToken)
  const task = (await google.api('tasks', '/lists/list-1/tasks', { method: 'POST', body: { title: '交报告', due: '2026-11-03T15:30:00+08:00' } })).data
  assert.equal(task.due, '2026-11-03T00:00:00.000Z'); assert.equal(task.status, 'needsAction')
  const token = await google.accessToken()
  assert.ok(FAKE_GOOGLE_SECRET_PREFIXES.some(prefix => token.startsWith(prefix)))
  const info = await (await fetch(fake.userinfoUrl, { headers: { Authorization: `Bearer ${token}` } })).json()
  assert.deepEqual(info, { sub: 'fake-sub-0001', email: 'owner@example.test', email_verified: true })
  assert.equal((await fetch(fake.userinfoUrl, { headers: { Authorization: 'Bearer ya29.unknown' } })).status, 401)
  assert.equal((await fetch(`${fake.endpoints.calendar}/users/me/calendarList`)).status, 401)
}))

test('R3-01 fake-google: a token without the Calendar scope gets 403 insufficientPermissions', async () => connected(async ({ google, fake }) => {
  const token = await google.accessToken()
  const response = await fetch(`${fake.endpoints.calendar}/users/me/calendarList`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.errors[0].reason, 'insufficientPermissions')
}, { services: ['tasks'] }))

test('R3-01 fake-google: tickets add endpoints from their own tests via options.routes (still bearer-checked)', async () => connected(async ({ google }) => {
  const result = await google.api('calendar', '/freeBusy', { method: 'POST', body: { items: [] } })
  assert.deepEqual(result.data, { kind: 'calendar#freeBusy', sub: 'fake-sub-0001' })
}, { fake: { routes: [{ method: 'POST', path: /\/calendar\/v3\/freeBusy$/, handler: (_req, res, ctx) => ctx.json(res, 200, { kind: 'calendar#freeBusy', sub: ctx.token.sub }) }] } }))
