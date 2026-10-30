import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { openGoogleConnection } from './google-connection.mjs'
import { GoogleAccount } from './google-account.mjs'
import { listBots } from './bots.mjs'
import { MCP_VERSION } from './workspace-mcp-protocol.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { createWorkspaceRepository } from './workspace-repository.mjs'
import { payloadHash } from './workspace-schema.mjs'
import { googleEventIdOf } from './workspace-google-calendar.mjs'
import { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT, FAKE_GOOGLE_SECRET_PREFIXES } from './fixtures/fake-google.mjs'

// R3-03 Google Calendar source. Every network call goes to the loopback fake; guard.blocked must stay empty.
const T0 = Date.parse('2026-10-31T00:00:00Z')
const write = (fake, method) => fake.requests.filter(r => r.method === method && /\/events(\/|$)/.test(r.path))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function files(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name))
  return out
}

/** Isolated store + fake Google with four calendars: owner (primary), writer, reader, freeBusyReader. */
async function calendarStore(fn, { timeoutMs = 10000, storeOptions = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-03-')), fake = await createFakeGoogle(), guard = guardGoogleNetwork()
  fake.addCalendar({ id: 'me@example.test', summary: '我的日历', accessRole: 'owner', timeZone: 'Asia/Shanghai', primary: true })
    .addCalendar({ id: 'team#ny@group.calendar.google.com', summary: '纽约团队', accessRole: 'writer', timeZone: 'America/New_York' })
    .addCalendar({ id: 'zh.china#holiday@group.v.calendar.google.com', summary: '中国节假日', accessRole: 'reader', timeZone: 'Asia/Shanghai' })
    .addCalendar({ id: 'boss@example.test', summary: '老板', accessRole: 'freeBusyReader', timeZone: 'Asia/Shanghai' })
  let time = T0, store
  const results = [], record = value => { results.push(JSON.stringify(value ?? null)); return value }
  const google = await openGoogleConnection({ dataDirectory: join(dir, 'google'), env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch, timeoutMs, sleep: async () => {} })
  const open = () => openTaskStore({ file: join(dir, 'isolated.sqlite'), google, workspaceScheduleOptions: { autoStart: false }, workspaceSyncOptions: { now: () => time }, detectorOptions: { autoStart: false }, memoryOptions: { enabled: false }, ...storeOptions })
  try {
    store = await open()
    await store.googleSaveClient({ requestId: 'r3-03-client-01', ...FAKE_GOOGLE_CLIENT })
    const started = await store.googleConnect({ services: ['calendar'] })
    await store.googlePaste({ redirectUrl: await fake.approve(started.attempt.authorizeUrl) })
    const sources = record(await store.workspace.externalSources({})).sources
    const id = title => sources.find(s => s.title === title).id
    await fn({ get store() { return store }, google, fake, dir, sources, record, id, primary: id('我的日历'), team: id('纽约团队'), holiday: id('中国节假日'), boss: id('老板'),
      advance: ms => { time += ms }, now: () => time,
      restart: async () => { await store.close(); store = await open(); return store }, closeOnly: () => store.close(), reopen: async () => { store = await open(); return store } })
    assert.deepEqual(guard.blocked, [], 'no request ever reached a real Google host')
    await store.close(); store = null
    // Secret scan (§7): fake tokens/codes/client secret never reach SQLite, results or Task history.
    const leaks = []
    for (const file of await files(dir)) {
      if (file.endsWith(join('google', 'credentials.json'))) continue
      const bytes = (await readFile(file)).toString('latin1')
      for (const prefix of FAKE_GOOGLE_SECRET_PREFIXES) if (bytes.includes(prefix)) leaks.push(`${file.slice(dir.length)}:${prefix}`)
    }
    for (const text of results) for (const prefix of FAKE_GOOGLE_SECRET_PREFIXES) if (text.includes(prefix)) leaks.push(`result:${prefix}`)
    assert.deepEqual(leaks, [])
  } finally { await store?.close().catch(() => {}); await google.close(); await fake.close(); await rm(dir, { recursive: true, force: true }) }
}
const window = (sourceId, start, end) => ({ sourceId, start, end, timezone: 'Asia/Shanghai' })
const account = s => s.harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(GoogleAccount))), context)
async function assign(s, resources) {
  const { bot } = await s.getBotConfiguration('calendar')
  await s.updateBotConfiguration('calendar', { requestId: `r3-03-cfg-${Math.random().toString(36).slice(2, 10)}`, expectedVersion: bot.configRef.version, description: 'R3-03 Google 日历', tools: WORKSPACE_TOOLS, resources })
}
async function mcpClient(s, sourceId, actions = ['read', 'create', 'update', 'delete']) {
  const credential = await s.workspaceAgent.issueClient({ sourceId, botId: 'calendar', actions, readScope: 'full', ttlSeconds: 600, confirmed: true })
  let sessionId, id = 1
  const send = async message => { const data = await s.workspaceMcpMessage(credential.token, sessionId, message); sessionId = data.sessionId; return data.message }
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_VERSION, clientInfo: { name: 'r3-03', version: '1' }, capabilities: {} } })
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return async (name, args) => { const r = await send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }); return r.result.isError ? { error: JSON.parse(r.result.content[0].text).error } : r.result.structuredContent.data }
}
const create = { title: 'R3-03 评审', description: '外部说明', start: '2026-11-04T09:00:00+08:00', end: '2026-11-04T10:00:00+08:00', timezone: 'Asia/Shanghai' }
test('R3-03 discovery: every calendar is a source; reader/freeBusyReader read-only; usable with no per-source grant (D7, D14)', async () => calendarStore(async ({ store, fake, sources, primary, holiday, boss, record }) => {
  assert.equal(sources.length, 4); assert.equal(sources[0].id, primary, 'primary calendar first')
  const byTitle = Object.fromEntries(sources.map(s => [s.title, s]))
  assert.deepEqual(Object.keys(byTitle).sort(), ['中国节假日', '我的日历', '纽约团队', '老板'].sort())
  for (const title of ['我的日历', '纽约团队']) assert.deepEqual([byTitle[title].readOnly, byTitle[title].capabilities], [false, ['read', 'create', 'update', 'delete']])
  for (const title of ['中国节假日', '老板']) assert.deepEqual([byTitle[title].readOnly, byTitle[title].capabilities], [true, ['read']])
  for (const s of sources) {
    assert.match(s.id, /^google-calendar:[a-f0-9]{64}$/)
    assert.deepEqual([s.provider, s.authority, s.itemType, s.authorized, s.readScope], ['google-calendar', 'external', 'Event', true, 'full'], 'connected = usable, no grant step')
    assert.equal(Object.hasOwn(s, 'calendarId'), false, 'calendar ids (often e-mail addresses) stay server side')
  }
  const view = record(await store.getBotConfiguration('calendar'))
  for (const s of sources) assert.ok(view.resources.includes(`workspace:${s.id}`))
  assert.deepEqual(view.resourceLabels[`workspace:${holiday}`], { title: '中国节假日', note: 'Google 日历 · 只读' })
  assert.deepEqual(view.resourceLabels[`workspace:${boss}`], { title: '老板', note: 'Google 日历 · 只读' })
  assert.deepEqual(view.resourceLabels[`workspace:${primary}`], { title: '我的日历', note: 'Google 日历' })
  // Rediscovery inside the TTL is served from the stored catalog, with the same ids.
  const lists = fake.count('/users/me/calendarList', 'GET')
  assert.deepEqual((await store.workspace.externalSources({})).sources.map(s => s.id), sources.map(s => s.id))
  assert.equal(fake.count('/users/me/calendarList', 'GET'), lists)
  const repo = createWorkspaceRepository({ harness: store.harness, context })
  const connection = await repo.transaction(async tx => { const source = await repo.get(tx, 'Source', 'local-owner', primary, primary); return { source, connection: await repo.get(tx, 'Connection', 'local-owner', primary, source.connectionId) } })
  assert.equal(connection.source.providerContainerId, 'me@example.test')
  assert.deepEqual(Object.keys(connection.connection).sort(), ['accountKey', 'authEpoch', 'credentialRef', 'id', 'ownerId', 'provider', 'schemaVersion', 'sourceId', 'status'])
  assert.deepEqual([connection.connection.provider, connection.connection.credentialRef, connection.connection.status], ['google', 'google', 'active'])
}))

test('R3-03 window reads fill the Event cache: cross-day, DST fall-back, time zones, read-only kinds, versions', async () => calendarStore(async ({ store, fake, primary, team, boss, record }) => {
  fake.addEvent('me@example.test', { id: 'cross', summary: '跨日值班', start: { dateTime: '2026-11-02T23:30:00+08:00', timeZone: 'Asia/Shanghai' }, end: { dateTime: '2026-11-03T01:00:00+08:00', timeZone: 'Asia/Shanghai' } })
  fake.addEvent('me@example.test', { id: 'holiday', summary: '全天', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } })
  fake.addEvent('me@example.test', { id: 'weekly_20261102T020000Z', summary: '周会', recurringEventId: 'weekly', start: { dateTime: '2026-11-02T10:00:00+08:00', timeZone: 'Asia/Shanghai' }, end: { dateTime: '2026-11-02T11:00:00+08:00', timeZone: 'Asia/Shanghai' } })
  // America/New_York falls back on 2026-11-01: 01:30 happens twice, one hour apart.
  fake.addEvent('team#ny@group.calendar.google.com', { id: 'edt', summary: '第一次 01:30', start: { dateTime: '2026-11-01T01:30:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-01T02:00:00-04:00', timeZone: 'America/New_York' } })
  fake.addEvent('team#ny@group.calendar.google.com', { id: 'est', summary: '第二次 01:30', start: { dateTime: '2026-11-01T01:30:00-05:00' }, end: { dateTime: '2026-11-01T02:00:00-05:00' } })
  fake.addEvent('boss@example.test', { id: 'busy1', start: { dateTime: '2026-11-02T14:00:00+08:00' }, end: { dateTime: '2026-11-02T15:00:00+08:00' } })
  const day1 = record(await store.workspace.queryExternal(window(primary, '2026-11-02T00:00:00+08:00', '2026-11-03T00:00:00+08:00')))
  assert.deepEqual([day1.provider, day1.authority, day1.complete, day1.stale], ['google-calendar', 'external', true, false])
  const cross = day1.items.find(e => e.remoteId === 'cross')
  assert.deepEqual([cross.start, cross.end, cross.timezone, cross.readOnly, cross.instanceKey, cross.version, cross.authority], ['2026-11-02T23:30:00+08:00', '2026-11-03T01:00:00+08:00', 'Asia/Shanghai', false, 'cross', 1, 'external'])
  assert.equal(cross.id, payloadHash([primary, 'cross', 'cross'])); assert.match(cross.remoteVersion, /^"fake-etag-\d+"$/)
  const allDay = day1.items.find(e => e.remoteId === 'holiday'), weekly = day1.items.find(e => e.remoteId === 'weekly_20261102T020000Z')
  assert.deepEqual([allDay.start, allDay.end, allDay.readOnly], ['2026-11-02', '2026-11-03', true], 'all-day keeps Google dates (end exclusive), read-only')
  assert.equal(weekly.readOnly, true, 'recurring instances are read-only in round one')
  const day2 = await store.workspace.queryExternal(window(primary, '2026-11-03T00:00:00+08:00', '2026-11-04T00:00:00+08:00'))
  assert.ok(day2.items.some(e => e.remoteId === 'cross'), 'the cross-day event shows on its second day too')
  const day3 = await store.workspace.queryExternal(window(primary, '2026-11-04T00:00:00+08:00', '2026-11-05T00:00:00+08:00'))
  assert.ok(!day3.items.some(e => e.remoteId === 'cross'))
  const ny = await store.workspace.queryExternal({ sourceId: team, start: '2026-11-01T00:00:00-04:00', end: '2026-11-02T00:00:00-05:00' })
  const edt = ny.items.find(e => e.remoteId === 'edt'), est = ny.items.find(e => e.remoteId === 'est')
  assert.equal(Date.parse(est.start) - Date.parse(edt.start), 3600000, 'same wall time, one hour apart across the DST change')
  assert.deepEqual([Date.parse(edt.end) - Date.parse(edt.start), Date.parse(est.end) - Date.parse(est.start)], [1800000, 1800000])
  assert.deepEqual([edt.timezone, est.timezone], ['America/New_York', 'America/New_York'], 'missing event zone falls back to the calendar zone')
  const busy = (await store.workspace.queryExternal(window(boss, '2026-11-02T00:00:00+08:00', '2026-11-03T00:00:00+08:00'))).items[0]
  assert.deepEqual([busy.title, busy.readOnly], ['忙碌', true])
  // version moves only when the etag moves.
  assert.equal((await store.workspace.getExternal({ sourceId: primary, eventId: 'cross' })).items[0].version, 1)
  fake.state.events.get('me@example.test').get('cross').summary = '值班改名'; fake.state.events.get('me@example.test').get('cross').etag = '"fake-etag-external"'
  const changed = (await store.workspace.getExternal({ sourceId: primary, eventId: 'cross' })).items[0]
  assert.deepEqual([changed.version, changed.title, changed.remoteVersion], [2, '值班改名', '"fake-etag-external"'])
  const list = fake.requests.find(r => r.method === 'GET' && r.path.endsWith('/events') && r.query.timeMin === '2026-11-01T16:00:00.000Z')
  assert.deepEqual([list.query.singleEvents, list.query.timeMax], ['true', '2026-11-02T16:00:00.000Z'], 'recurring series are expanded; window sent in UTC')
  for (const bad of [{ start: '2026-11-02T00:00:00', end: '2026-11-03T00:00:00+08:00' }, { start: '2026-11-01T00:00:00Z', end: '2027-01-10T00:00:00Z' }, { start: '2026-11-03T00:00:00Z', end: '2026-11-02T00:00:00Z' }])
    await assert.rejects(store.workspace.queryExternal({ sourceId: primary, ...bad }), e => e.code === 'WORKSPACE_EXTERNAL_INPUT')
  await assert.rejects(store.workspace.getExternal({ sourceId: primary, eventId: 'nope' }), e => e.code === 'WORKSPACE_EXTERNAL_NOT_FOUND')
}))
test('R3-03 end to end: an Agent creates, updates and deletes through workspace.prepare_change, directly with the group on (D4)', async () => calendarStore(async ({ store, fake, primary, holiday, record }) => {
  await assign(store, [`workspace:${primary}`])
  const call = await mcpClient(store, primary)
  const created = record(await call('workspace.prepare_change', { sourceId: primary, requestId: 'r3-03-create', action: 'create', change: { arguments: create } }))
  const eventId = googleEventIdOf('r3-03-create')
  assert.match(eventId, /^[0-9a-v]{5,1024}$/, 'base32hex, 5–1024 chars'); assert.equal(eventId, created.external.eventId)
  assert.deepEqual([created.state, created.external.autoApproved, created.receipt.providerReceipt.eventId, created.receipt.providerReceipt.verifiedBy], ['succeeded', true, eventId, 'response'])
  const posts = write(fake, 'POST')
  assert.equal(posts.length, 1); assert.equal(posts[0].query.sendUpdates, 'none')
  const stored = fake.state.events.get('me@example.test').get(eventId)
  assert.deepEqual([stored.summary, stored.start.timeZone, Date.parse(stored.start.dateTime)], ['R3-03 评审', 'Asia/Shanghai', Date.parse(create.start)])
  const listed = record(await call('workspace.list', { sourceId: primary, type: 'Event', start: '2026-11-04T00:00:00+08:00', end: '2026-11-05T00:00:00+08:00' }))
  const item = listed.items.find(e => e.remoteId === eventId)
  assert.deepEqual([item.title, item.readOnly, item.version], ['R3-03 评审', false, 1])
  // Same requestId replays the stored Operation and never sends a second insert.
  assert.equal((await call('workspace.prepare_change', { sourceId: primary, requestId: 'r3-03-create', action: 'create', change: { arguments: create } })).state, 'succeeded')
  assert.equal(write(fake, 'POST').length, 1)
  assert.equal((await call('workspace.prepare_change', { sourceId: primary, requestId: 'r3-03-create', action: 'create', change: { arguments: { ...create, title: '另一件事' } } })).error.code, 'WORKSPACE_REQUEST_CONFLICT')
  const updated = record(await call('workspace.prepare_change', { sourceId: primary, requestId: 'r3-03-update', action: 'update', change: { arguments: { eventId, title: '改到下午', start: '2026-11-04T14:00:00+08:00', end: '2026-11-04T15:00:00+08:00' }, expectedVersion: item.version } }))
  assert.equal(updated.state, 'succeeded', JSON.stringify(updated.error ?? updated.receipt))
  const patch = write(fake, 'PATCH')
  assert.deepEqual([patch.length, patch[0].ifMatch, patch[0].query.sendUpdates], [1, item.remoteVersion, 'none'], 'update sends If-Match: <etag>')
  assert.equal(fake.state.events.get('me@example.test').get(eventId).summary, '改到下午')
  const fresh = (await call('workspace.get', { sourceId: primary, type: 'Event', eventId })).items[0]
  assert.deepEqual([fresh.title, fresh.version, Date.parse(fresh.start)], ['改到下午', 2, Date.parse('2026-11-04T14:00:00+08:00')])
  const removed = record(await call('workspace.prepare_change', { sourceId: primary, requestId: 'r3-03-delete', action: 'delete', change: { arguments: { eventId }, expectedVersion: fresh.version } }))
  assert.equal(removed.state, 'succeeded')
  const del = write(fake, 'DELETE')
  assert.deepEqual([del.length, del[0].ifMatch, del[0].query.sendUpdates], [1, fresh.remoteVersion, 'none'])
  assert.equal(fake.state.events.get('me@example.test').get(eventId).status, 'cancelled')
  assert.ok(!(await call('workspace.list', { sourceId: primary, type: 'Event', start: '2026-11-04T00:00:00+08:00', end: '2026-11-05T00:00:00+08:00' })).items.some(e => e.remoteId === eventId))
  // Read-only calendars and read-only events refuse writes before anything is sent.
  await assert.rejects(store.workspace.prepareExternal({ sourceId: holiday, requestId: 'r3-03-ro', action: 'create', arguments: create }), e => e.code === 'WORKSPACE_FORBIDDEN')
  fake.addEvent('me@example.test', { id: 'allday', summary: '全天', start: { date: '2026-11-06' }, end: { date: '2026-11-07' } })
  const allDay = (await store.workspace.getExternal({ sourceId: primary, eventId: 'allday' })).items[0]
  await assert.rejects(store.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-allday', action: 'update', arguments: { eventId: 'allday', title: 'x' }, expectedVersion: allDay.version }), e => e.code === 'WORKSPACE_EXTERNAL_READ_ONLY')
  await assert.rejects(store.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-bad', action: 'create', arguments: { ...create, attendees: ['x@example.test'] } }), e => e.code === 'WORKSPACE_EXTERNAL_INPUT')
  // A user-side change without the policy auto-approval still uses the existing confirm/execute pair.
  const manual = await store.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-manual', action: 'create', arguments: { ...create, title: '手动' } })
  assert.equal(manual.state, 'awaiting_confirmation'); assert.equal(write(fake, 'POST').length, 1)
  await store.workspace.confirmExternal({ requestId: manual.requestId, payloadHash: manual.payloadHash, confirmed: true })
  assert.equal((await store.workspace.executeExternal({ requestId: manual.requestId })).state, 'succeeded'); assert.equal(write(fake, 'POST').length, 2)
  assert.equal(fake.requests.filter(r => r.method === 'PUT').length, 0, 'never a full replace')
}))

test('R3-03 conflicts: a 412 never overwrites; a duplicate insert is a conflict, never a second event', async () => calendarStore(async ({ store, fake, primary }) => {
  fake.addEvent('me@example.test', { id: 'shared', summary: '原标题', start: { dateTime: '2026-11-05T09:00:00+08:00', timeZone: 'Asia/Shanghai' }, end: { dateTime: '2026-11-05T10:00:00+08:00', timeZone: 'Asia/Shanghai' } })
  const seen = (await store.workspace.getExternal({ sourceId: primary, eventId: 'shared' })).items[0]
  const remote = fake.state.events.get('me@example.test').get('shared')
  Object.assign(remote, { summary: 'Google 端改过', etag: '"fake-etag-other-writer"' }) // another writer, after our read
  const op = await store.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-412', action: 'update', arguments: { eventId: 'shared', title: '我的修改' }, expectedVersion: seen.version })
  await store.workspace.confirmExternal({ requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true })
  const result = await store.workspace.executeExternal({ requestId: op.requestId })
  assert.deepEqual([result.state, result.error.code], ['conflict', 'GOOGLE_PRECONDITION'])
  assert.deepEqual(write(fake, 'PATCH').map(r => r.ifMatch), [seen.remoteVersion], 'one PATCH with the stale etag, no retry')
  assert.equal(remote.summary, 'Google 端改过', 'the other writer wins; nothing is overwritten')
  const refreshed = (await store.workspace.getExternal({ sourceId: primary, eventId: 'shared' })).items[0]
  assert.deepEqual([refreshed.title, refreshed.remoteVersion, refreshed.version > seen.version], ['Google 端改过', '"fake-etag-other-writer"', true])
  // Delete with the current local version, then the remote changes before dispatch: 412 again, event survives.
  remote.etag = '"fake-etag-moved-again"'
  const del = await store.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-412-del', action: 'delete', arguments: { eventId: 'shared' }, expectedVersion: refreshed.version })
  await store.workspace.confirmExternal({ requestId: del.requestId, payloadHash: del.payloadHash, confirmed: true })
  assert.equal((await store.workspace.executeExternal({ requestId: del.requestId })).state, 'conflict')
  assert.equal(remote.status, 'confirmed')
  await assert.rejects(store.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-stale', action: 'update', arguments: { eventId: 'shared', title: 'x' }, expectedVersion: seen.version }), e => e.code === 'WORKSPACE_VERSION_CONFLICT')
  // The deterministic id is already taken: Google answers 409 and Pidot records a conflict.
  fake.addEvent('me@example.test', { id: googleEventIdOf('r3-03-dup'), summary: '早已存在', start: { dateTime: '2026-11-05T11:00:00+08:00' }, end: { dateTime: '2026-11-05T12:00:00+08:00' } })
  const dup = await store.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-dup', action: 'create', arguments: create })
  await store.workspace.confirmExternal({ requestId: dup.requestId, payloadHash: dup.payloadHash, confirmed: true })
  const duplicate = await store.workspace.executeExternal({ requestId: dup.requestId })
  assert.deepEqual([duplicate.state, duplicate.error.code], ['conflict', 'GOOGLE_CONFLICT'])
  assert.equal(fake.state.events.get('me@example.test').get(googleEventIdOf('r3-03-dup')).summary, '早已存在')
  assert.equal([...fake.state.events.get('me@example.test').values()].filter(e => e.summary === create.title).length, 0, 'no second event')
}))

test('R3-03 unknown create: timeouts and lost responses are read back by id; found = success, never a second insert', async () => calendarStore(async ({ store, fake, primary }) => {
  const run = async requestId => {
    const op = await store.workspace.prepareExternal({ sourceId: primary, requestId, action: 'create', arguments: { ...create, title: requestId } })
    await store.workspace.confirmExternal({ requestId, payloadHash: op.payloadHash, confirmed: true })
    return store.workspace.executeExternal({ requestId })
  }
  const inserts = () => write(fake, 'POST').length, events = fake.state.events.get('me@example.test')
  // A: Google applied the insert but the response arrived after the client timeout.
  fake.fail({ method: 'POST', path: /\/events$/, after: true, delayMs: 1500 })
  const a = await run('r3-03-timeout-applied')
  assert.deepEqual([a.state, a.receipt.providerReceipt.verifiedBy, inserts()], ['succeeded', 'id-lookup', 1])
  assert.equal([...events.values()].filter(e => e.summary === 'r3-03-timeout-applied').length, 1)
  // B: the insert hangs and never lands. Unknown stays unknown; asking again never resends.
  fake.fail({ method: 'POST', path: /\/events$/, hang: true })
  const b = await run('r3-03-timeout-lost')
  assert.equal(b.state, 'unknown'); assert.equal(inserts(), 2)
  assert.equal((await store.workspace.executeExternal({ requestId: 'r3-03-timeout-lost' })).state, 'unknown')
  assert.equal((await store.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-timeout-lost', action: 'create', arguments: { ...create, title: 'r3-03-timeout-lost' } })).state, 'unknown')
  assert.equal((await store.workspace.getExternalOperation({ requestId: 'r3-03-timeout-lost' })).state, 'unknown'); assert.equal(inserts(), 2)
  // The original request lands late: querying the same request finds it, still without a resend.
  fake.addEvent('me@example.test', { id: googleEventIdOf('r3-03-timeout-lost'), summary: 'r3-03-timeout-lost', start: { dateTime: create.start }, end: { dateTime: create.end } })
  const late = await store.workspace.getExternalOperation({ requestId: 'r3-03-timeout-lost' })
  assert.deepEqual([late.state, late.receipt.providerReceipt.verifiedBy, inserts()], ['succeeded', 'id-lookup', 2])
  // C: connection dropped after the insert took effect.
  fake.fail({ method: 'POST', path: /\/events$/, after: true, disconnect: true })
  assert.equal((await run('r3-03-dropped')).state, 'succeeded'); assert.equal(inserts(), 3)
  // D: 5xx on a write is unknown too; the id lookup finds nothing, so it stays unknown with one attempt.
  fake.fail({ method: 'POST', path: /\/events$/, status: 503 })
  assert.equal((await run('r3-03-5xx')).state, 'unknown'); assert.equal(inserts(), 4)
  for (const title of ['r3-03-timeout-applied', 'r3-03-timeout-lost', 'r3-03-dropped']) assert.equal([...events.values()].filter(e => e.summary === title).length, 1, title)
}, { timeoutMs: 400 }))
test('R3-03 revoked access hides the cache; an unsubscribed calendar leaves every Bot; reconnect invalidates old sync', async t => {
  await t.test('invalid_grant', () => calendarStore(async ({ store, google, fake, primary }) => {
    fake.addEvent('me@example.test', { id: 'secret', summary: '机密会议', start: { dateTime: '2026-11-02T09:00:00+08:00' }, end: { dateTime: '2026-11-02T10:00:00+08:00' } })
    await store.workspace.configureSync({ sourceId: primary, enabled: true, confirmed: true, expectedRevision: 0 })
    await store.workspace.refreshSync({ sourceId: primary, confirmed: true })
    assert.equal((await store.workspace.queryExternal(window(primary, '2026-11-02T00:00:00+08:00', '2026-11-03T00:00:00+08:00'))).cached, true)
    fake.revokeAll(); google.rejectToken(await google.accessToken().catch(() => ''))
    await assert.rejects(google.api('calendar', '/users/me/calendarList'), e => e.kind === 'needs_auth')
    for (let i = 0; i < 100 && (await account(store)).status !== 'needs_auth'; i++) await sleep(10)
    assert.equal((await account(store)).status, 'needs_auth')
    await assert.rejects(store.workspace.queryExternal(window(primary, '2026-11-02T00:00:00+08:00', '2026-11-03T00:00:00+08:00')), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
    await assert.rejects(store.workspace.getExternal({ sourceId: primary, eventId: 'secret' }), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
    await assert.rejects(store.workspace.syncStatus({ sourceId: primary }), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
    assert.deepEqual((await store.workspace.externalSources({})).sources, [])
    assert.ok(!(await store.getBotConfiguration('calendar')).resources.some(r => r.startsWith('workspace:google-calendar:')))
  }))
  await t.test('calendar no longer subscribed', () => calendarStore(async ({ store, fake, team, primary, advance }) => {
    await assign(store, [`workspace:${team}`, `workspace:${primary}`])
    fake.state.calendars.delete('team#ny@group.calendar.google.com')
    advance(301000) // past the discovery TTL
    const ids = (await store.workspace.externalSources({})).sources.map(s => s.id)
    assert.ok(!ids.includes(team)); assert.ok(ids.includes(primary))
    await assert.rejects(store.workspace.queryExternal({ sourceId: team, start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z' }), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
    const { assigned } = await store.getBotConfiguration('calendar')
    assert.deepEqual(assigned.resources.filter(r => r.startsWith('workspace:google-calendar:')), [`workspace:${primary}`], 'removed from the Bot, others kept')
  }))
  await t.test('reconnect', () => calendarStore(async ({ store, fake, primary }) => {
    await store.workspace.configureSync({ sourceId: primary, enabled: true, confirmed: true, expectedRevision: 0 })
    const epoch = (await store.workspace.externalSources({})).sources.find(s => s.id === primary).epoch
    await store.googleDisconnect({})
    assert.deepEqual((await store.workspace.externalSources({})).sources, [])
    const started = await store.googleConnect({ services: ['calendar'] })
    await store.googlePaste({ redirectUrl: await fake.approve(started.attempt.authorizeUrl) })
    const again = (await store.workspace.externalSources({})).sources.find(s => s.id === primary)
    assert.ok(again, 'same account → same source id'); assert.equal(again.authorized, true); assert.ok(again.epoch > epoch)
    assert.equal((await store.workspace.syncStatus({ sourceId: primary })).runState, 'revoked', 'old sync configuration does not survive a new authEpoch')
  }))
})

test('R3-03 background sync reuses workspace-sync; state survives a restart; a write interrupted by a restart is recovered by id', async () => calendarStore(async ({ store: first, fake, primary, advance, restart, closeOnly, reopen }) => {
  fake.addEvent('me@example.test', { id: 'sync-a', summary: '同步一', start: { dateTime: '2026-11-01T09:00:00+08:00' }, end: { dateTime: '2026-11-01T10:00:00+08:00' } })
  await first.workspace.configureSync({ sourceId: primary, enabled: true, confirmed: true, expectedRevision: 0, pastDays: 7, futureDays: 31, refreshSeconds: 300 })
  let s = await first.workspace.refreshSync({ sourceId: primary, confirmed: true })
  assert.deepEqual([s.runState, s.windows.length, s.windows.every(w => !w.stale)], ['idle', 2, true])
  const span = window(primary, '2026-10-31T08:00:00+08:00', '2026-11-03T08:00:00+08:00')
  let q = await first.workspace.queryExternal(span)
  assert.deepEqual([q.cached, q.provider, q.items.map(e => e.remoteId)], [true, 'google-calendar', ['sync-a']])
  // The scheduler's tick runs the rescan when due; no model call, no write.
  fake.addEvent('me@example.test', { id: 'sync-b', summary: '同步二', start: { dateTime: '2026-11-02T09:00:00+08:00' }, end: { dateTime: '2026-11-02T10:00:00+08:00' } })
  advance(301000); await first.workspaceScheduler.tick()
  q = await first.workspace.queryExternal(span)
  assert.deepEqual(q.items.map(e => e.remoteId).sort(), ['sync-a', 'sync-b'])
  const repo = createWorkspaceRepository({ harness: first.harness, context })
  const outbox = await repo.transaction(tx => repo.list(tx, 'Outbox', 'local-owner', primary))
  assert.ok(outbox.items.some(o => o.targetRef?.remoteId === 'sync-b' && o.targetRef.kind === 'appeared'))
  assert.equal(fake.requests.filter(r => r.method !== 'GET' && !r.path.startsWith('/token')).length, 0)
  const before = await first.workspace.syncStatus({ sourceId: primary })
  const second = await restart()
  const after = await second.workspace.syncStatus({ sourceId: primary })
  assert.deepEqual([after.revision, after.runState, after.enabled, after.windows.map(w => w.generation)], [before.revision, 'idle', true, before.windows.map(w => w.generation)])
  const lists = fake.requests.filter(r => r.method === 'GET' && r.path.endsWith('/events')).length
  assert.deepEqual((await second.workspace.queryExternal(span)).items.map(e => e.remoteId).sort(), ['sync-a', 'sync-b'], 'served from the restored cache')
  assert.equal(fake.requests.filter(r => r.method === 'GET' && r.path.endsWith('/events')).length, lists)
  // A create is in flight when the process stops. After restart it is unknown, then found by id; never resent.
  fake.fail({ method: 'POST', path: /\/events$/, hang: true })
  const op = await second.workspace.prepareExternal({ sourceId: primary, requestId: 'r3-03-restart', action: 'create', arguments: create })
  await second.workspace.confirmExternal({ requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true })
  const doomed = second.workspace.executeExternal({ requestId: op.requestId }).then(() => 'settled', () => 'interrupted')
  for (let i = 0; i < 200 && !write(fake, 'POST').length; i++) await sleep(10)
  assert.equal(write(fake, 'POST').length, 1)
  await closeOnly()
  await Promise.race([doomed, sleep(3000)])
  const third = await reopen()
  const recovered = await third.workspace.getExternalOperation({ requestId: 'r3-03-restart' })
  assert.equal(recovered.state, 'unknown', 'dispatching at shutdown → unknown, original Operation kept')
  fake.addEvent('me@example.test', { id: googleEventIdOf('r3-03-restart'), summary: create.title, start: { dateTime: create.start }, end: { dateTime: create.end } })
  const found = await third.workspace.getExternalOperation({ requestId: 'r3-03-restart' })
  assert.deepEqual([found.state, found.requestId, write(fake, 'POST').length], ['succeeded', 'r3-03-restart', 1])
}, { timeoutMs: 800 }))

// The chat path resolves a Task's workspace sources in workspace-mcp-host.mjs, which today only admits
// `local` and the bound Feishu calendar. Not an R3-03 file: wiring is listed in the R3-03 report.
test('R3-03 chat: a Bot with only a Google calendar creates an event from a model tool call', { todo: 'needs workspaceTaskResolver to admit live Google sources (workspace-mcp-host.mjs)' }, async () => {
  let sourceId = null
  const bots = listBots({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture' })
  const modelReply = async (_message, options) => {
    if (options.context.messages.some(m => m.role === 'toolResult')) return { mode: 'model', reply: { content: '已添加。' }, execution: { usage: { totalTokens: 1 } } }
    const call = { type: 'toolCall', id: 'g-create', name: 'workspace.prepare_change', arguments: { sourceId, requestId: 'r3-03-chat', action: 'create', change: { arguments: create } } }
    return { mode: 'model', reply: { content: '' }, toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() }, execution: { usage: { totalTokens: 1 } } }
  }
  await calendarStore(async ({ store, fake, primary }) => {
    sourceId = primary
    await assign(store, [`workspace:${primary}`])
    const task = await store.create({ botId: 'calendar' })
    await store.send(task.taskId, '帮我在 Google 日历加个评审')
    let current
    for (let i = 0; i < 150; i++) { current = await store.get(task.taskId); if (current.activeInputId === null && current.messages.some(m => m.role === 'assistant')) break; await sleep(20) }
    assert.ok(current.messages.some(m => m.toolName === 'workspace.prepare_change' && m.result?.ok === true), 'tool result ok')
    assert.equal(write(fake, 'POST').length, 1)
  }, { storeOptions: { bots, modelReply } })
})
