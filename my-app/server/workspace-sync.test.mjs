import { test } from 'node:test'
import assert from 'node:assert/strict'
import { externalFixture } from './fixtures/workspace-external.mjs'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const event = (id = 'one', title = 'sync-secret', start = NOW + 3600000) => ({ event_id: id, summary: title, description: 'body-secret', start_time: { timestamp: String(start / 1000), timezone: 'Asia/Shanghai' }, end_time: { timestamp: String(start / 1000 + 3600), timezone: 'Asia/Shanghai' }, status: 'confirmed', organizer_calendar_id: 'isolated-calendar' })
const window = sourceId => ({ sourceId, start: '2026-10-19T12:00:00Z', end: '2026-10-20T12:00:00Z', timezone: 'Asia/Shanghai' })
const enable = f => f.store.workspace.configureSync({ sourceId: f.sourceId, enabled: true, confirmed: true, expectedRevision: 0 })
const refresh = f => f.store.workspace.refreshSync({ sourceId: f.sourceId, confirmed: true })
const query = f => f.store.workspace.queryExternal(window(f.sourceId))
const options = (extra = {}) => ({ storeOptions: { workspaceScheduleOptions: { autoStart: false }, workspaceSyncOptions: { now: () => NOW, ...extra } } })

test('06 complete windows publish same cached UI/Agent query; changes and missing are scoped, repeat is idempotent', async () => externalFixture(async f => {
  f.events.set('one', event()); await enable(f)
  let s = await refresh(f); assert.equal(s.runState, 'idle'); assert.equal(s.windows.length, 2); assert.equal(s.futureDays, 31); assert.equal(s.pastDays, 7); assert.equal(s.refreshSeconds, 300)
  let q = await query(f); assert.equal(q.cached, true); assert.equal(q.stale, false); assert.equal(q.items[0].title, 'sync-secret'); const id = q.items[0].id
  const version = q.items[0].version; await refresh(f); assert.equal((await query(f)).items[0].version, version)
  f.events.set('one', event('one', 'updated')); await refresh(f); q = await query(f); assert.equal(q.items[0].title, 'updated'); assert.equal(q.items[0].id, id)
  f.events.delete('one'); await refresh(f); assert.equal((await query(f)).items.length, 0)
  assert.equal(f.writes.length, 0); assert.equal(f.modelCalls(), 0)
}, options()))

test('06 partial paging/duplicate token and failures retain old coverage/cache and exhaust persisted read retries', async () => {
  let mode = 'ok', time = NOW
  await externalFixture(async f => {
    f.events.set('one', event()); await enable(f); await refresh(f)
    const before = (await f.store.workspace.syncStatus({ sourceId: f.sourceId })).windows.map(w => w.generation)
    mode = 'paging'; let s = await refresh(f); assert.equal(s.runState, 'retry_wait'); assert.equal(s.attempts, 1); assert.equal(Date.parse(s.retryAt), time + 30000)
    assert.deepEqual(s.windows.map(w => w.generation), before); assert.equal((await query(f)).stale, true); assert.equal((await query(f)).items[0].title, 'sync-secret')
    time += 30000; await f.store.workspaceScheduler.tick(); s = await f.store.workspace.syncStatus({ sourceId: f.sourceId }); assert.equal(s.attempts, 2); assert.equal(Date.parse(s.retryAt), time + 120000)
    await f.restart(); time += 120000; await f.store.workspaceScheduler.tick(); s = await f.store.workspace.syncStatus({ sourceId: f.sourceId }); assert.equal(s.runState, 'failed'); assert.equal(s.attempts, 3)
    await f.store.workspaceScheduler.tick(); assert.equal((await f.store.workspace.syncStatus({ sourceId: f.sourceId })).attempts, 3)
    mode = 'ok'; assert.equal((await refresh(f)).runState, 'idle')
  }, { ...options(), storeOptions: { workspaceScheduleOptions: { autoStart: false }, workspaceSyncOptions: { now: () => time } }, readWindow: ({ events }) => mode === 'paging' ? { items: [], has_more: true, page_token: 'repeated' } : { items: [...events.values()] } })
})

test('06 revoked/busy authorization never loads full cache; explicit disable stops future fetch', async () => externalFixture(async f => {
  f.events.set('one', event()); await enable(f); await refresh(f)
  let source = (await f.store.workspace.externalSources({})).sources[0]
  await f.store.workspace.grantExternal({ sourceId: f.sourceId, expectedEpoch: source.epoch, enabled: true, confirmed: true, readScope: 'busy' })
  await assert.rejects(f.store.workspace.syncStatus({ sourceId: f.sourceId }), e => e.code === 'WORKSPACE_SYNC_SCOPE')
  const busy = await query(f); assert.equal(JSON.stringify(busy).includes('secret'), false); assert.deepEqual(Object.keys(busy.items[0]), ['start','end','timezone'])
  await f.store.workspaceScheduler.tick()
  source = (await f.store.workspace.externalSources({})).sources[0]
  await f.store.workspace.grantExternal({ sourceId: f.sourceId, expectedEpoch: source.epoch, enabled: true, confirmed: true, readScope: 'full' })
  const s = await f.store.workspace.syncStatus({ sourceId: f.sourceId }); assert.equal(s.runState, 'revoked'); assert.equal(s.windows.length, 0)
  await f.store.workspace.configureSync({ sourceId: f.sourceId, enabled: false, expectedRevision: s.revision, confirmed: true })
  await assert.rejects(refresh(f), e => e.code === 'WORKSPACE_SYNC_REVOKED')
}, options()))

test('06 stale generation cannot overwrite newer exact read receipt', async () => {
  let fref, race = false
  await externalFixture(async f => {
    fref = f; f.events.set('one', event()); await enable(f); await refresh(f)
    race = true; const s = await refresh(f); assert.equal(s.runState, 'retry_wait'); assert.equal(s.error.code, 'WORKSPACE_SYNC_SUPERSEDED')
    const q = await query(f); assert.equal(q.items[0].title, 'newer-exact'); assert.equal(q.stale, true)
  }, options({ boundary: async name => { if (race && name === 'before_publish') { race = false; fref.events.set('one', event('one', 'newer-exact')); await fref.store.workspace.getExternal({ sourceId: fref.sourceId, eventId: 'one' }) } } }))
})

test('06 strict configuration rejects zero windows, invalid timezone, hidden principal and stale revision', async () => externalFixture(async f => {
  for (const patch of [{ pastDays: 0 }, { futureDays: 32 }, { refreshSeconds: 59 }, { timezone: 'bad' }, { actor: 'admin' }]) await assert.rejects(f.store.workspace.configureSync({ sourceId: f.sourceId, enabled: true, confirmed: true, expectedRevision: 0, ...patch }), e => e.code === 'WORKSPACE_SYNC_INPUT')
  await enable(f); await assert.rejects(enable(f), e => e.code === 'WORKSPACE_SYNC_REVISION')
}, options()))

test('06 real OS SIGKILL during claim/publish/commit resumes cursor without duplicate publication', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path'), { fork } = await import('node:child_process')
  for (const phase of ['after_claim', 'before_publish', 'in_publish', 'after_publish']) {
    const dir = await mkdtemp(join(tmpdir(), 'pidot-sync-kill-')), file = join(dir, 'isolated.sqlite')
    const run = (mode, kill = false) => new Promise((resolve, reject) => {
      const child = fork(new URL('./fixtures/workspace-sync-crash.mjs', import.meta.url), [file, mode], { silent: true }); let message, err = ''
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`timeout ${mode}: ${err}`)) }, 15000)
      child.stderr.on('data', d => { err += d }); child.on('message', m => { message = m; if (kill && m.point) child.kill('SIGKILL') }); child.on('error', reject)
      child.on('exit', (code, signal) => { clearTimeout(timeout); if (kill ? signal !== 'SIGKILL' : code !== 0) reject(Error(`${mode} exit ${code}/${signal}: ${err}`)); else resolve(message) })
    })
    try {
      await run('seed'); await run(phase, true); const result = await run('recover')
      assert.equal(result.completed.runState, 'idle', phase); assert.equal(result.completed.windows.length, 2)
      assert(result.completed.windows.every(w => w.coverage.complete)); assert.equal(result.completed.cursor, null)
      if (phase === 'after_publish') assert(result.completed.windows[0].generation < result.completed.windows[1].generation)
      const repeated = await run('recover'); assert.deepEqual(repeated.completed.windows.map(w => w.generation), result.completed.windows.map(w => w.generation))
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test('06 read transport/rate errors keep old complete cache for offline read, never invoke writes', async () => {
  for (const kind of ['timeout', 'rate']) {
    let fail = false
    await externalFixture(async f => {
      f.events.set('one', event()); await enable(f); await refresh(f); fail = true
      const state = await refresh(f); assert.equal(state.runState, 'retry_wait'); assert(state.windows.every(w => w.stale))
      assert.equal((await query(f)).items[0].title, 'sync-secret'); assert.equal(f.writes.length, 0)
    }, { ...options(), readWindow: ({ events }) => { if (fail) { const e = Error(kind); e.code = kind === 'rate' ? 'FEISHU_RATE_LIMIT' : 'FEISHU_TRANSPORT'; throw e }; return { items: [...events.values()] } } })
  }
})

test('06 pending background scan works without UI and survives restart with original configuration', async () => externalFixture(async f => {
  f.events.set('one', event()); await enable(f); await f.store.workspaceScheduler.tick()
  assert.equal((await query(f)).cached, true); await f.restart()
  const s = await f.store.workspace.syncStatus({ sourceId: f.sourceId }); assert.equal(s.runState, 'idle'); assert.equal(s.revision, 1)
  assert.equal((await query(f)).items[0].title, 'sync-secret')
}, options()))

test('06 cache, window coverage, reminder invalidation and outbox roll back together; ABA changes are consumable exactly once per transition', async () => {
  const { openFoundation } = await import('./fixtures/workspace-foundation.mjs'), { createWorkspaceSync } = await import('./workspace-sync.mjs'), { createActorAuthority } = await import('./workspace-policy.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-sync-atomic-')), s = await openFoundation(join(dir, 'isolated.sqlite'))
  const authority = createActorAuthority(), actor = authority.user(), sourceId = 'external-test', base = { schemaVersion: 1, ownerId: 'local-owner', sourceId }
  let version = 'A', crash = true
  const row = () => ({ ...base, id: 'event', remoteId: 'remote', instanceKey: 'instance', title: version, start: '2026-10-19T13:00:00Z', end: '2026-10-19T14:00:00Z', timezone: 'UTC', version: 1, remoteVersion: version, authority: 'external' })
  const sync = createWorkspaceSync({ repository: s.repo, authority, now: () => NOW,
    permission: async (tx, a) => ({ ...await authority.authorize(s.repo, tx, a, sourceId, 'read'), binding: { resource: 'fixture' } }),
    readWindow: async () => ({ complete: true, events: [row()] }),
    cache: async (tx, a, id, e) => s.repo.put(tx, 'Event', e), boundary: async name => { if (name === 'in_publish' && crash) throw Error('rollback') } })
  try {
    await s.repo.transaction(async tx => {
      await s.repo.put(tx, 'Connection', { ...base, id: 'connection', provider: 'feishu', accountKey: 'fixture', authEpoch: 1, status: 'active' })
      await s.repo.put(tx, 'Source', { ...base, id: sourceId, connectionId: 'connection', authority: 'external', capabilities: ['read'] })
      await s.repo.put(tx, 'Grant', { ...base, id: 'user:authenticated-user', principalKind: 'user', subjectId: 'authenticated-user', actions: ['read'], readScope: 'full', epoch: 1 })
      await s.repo.put(tx, 'Reminder', { ...base, id: 'reminder', targetRef: { type: 'Event', id: 'event' }, channel: 'inbox', enabled: true, version: 1, targetVersion: 1 })
    })
    await sync.configure(actor, { sourceId, expectedRevision: 0, enabled: true, confirmed: true }); await sync.refresh(actor, { sourceId, confirmed: true })
    await s.repo.transaction(async tx => {
      assert.equal(await s.repo.get(tx, 'Event', base.ownerId, sourceId, 'event'), null)
      assert.equal((await s.repo.list(tx, 'Outbox', base.ownerId, sourceId)).items.length, 0)
      assert.equal((await s.repo.get(tx, 'Reminder', base.ownerId, sourceId, 'reminder')).invalidated, undefined)
    })
    crash = false; await sync.refresh(actor, { sourceId, confirmed: true })
    const count = () => s.repo.transaction(async tx => (await s.repo.list(tx, 'Outbox', base.ownerId, sourceId)).items.length)
    assert.equal(await count(), 1) // out-of-window rows never acquire presence
    await s.repo.transaction(async tx => assert.equal((await s.repo.get(tx, 'Reminder', base.ownerId, sourceId, 'reminder')).invalidated, true))
    await sync.refresh(actor, { sourceId, confirmed: true }); assert.equal(await count(), 1)
    version = 'B'; await sync.refresh(actor, { sourceId, confirmed: true }); const b = await count(); assert(b > 1)
    version = 'A'; await sync.refresh(actor, { sourceId, confirmed: true }); assert((await count()) > b)
    const a = await count(); await sync.refresh(actor, { sourceId, confirmed: true }); assert.equal(await count(), a)
  } finally { await sync.close(); await s.close(); await rm(dir, { recursive: true, force: true }) }
})

test('06 recurring instances and window moves do not globally delete provider objects; empty success has explicit complete coverage', async () => externalFixture(async f => {
  f.events.set('one', { ...event('recurring'), recurrence: 'FREQ=DAILY' })
  f.events.set('two', { ...event('recurring', 'second-instance', NOW + 86400000 + 3600000), recurrence: 'FREQ=DAILY' })
  await enable(f); await refresh(f)
  const q = await f.store.workspace.queryExternal({ ...window(f.sourceId), end: '2026-10-22T12:00:00Z' }); assert.equal(q.items.length, 2); assert.notEqual(q.items[0].id, q.items[1].id)
  f.events.set('one', { ...event('recurring', 'moved-out', NOW + 60 * 86400000), recurrence: 'FREQ=DAILY' }); f.events.delete('two')
  await refresh(f); assert.equal((await query(f)).items.length, 0)
  f.events.clear(); const state = await refresh(f); assert(state.windows.every(w => w.coverage.complete && w.coverage.count === 0))
}, options()))

test('06 authenticated sync API rejects token/actor forgery and shares durable manual/background status', async () => externalFixture(async f => {
  const { createApiServer } = await import('./app.mjs'), server = createApiServer({ tasks: f.store, token: 'sync-isolated' })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const call = async (path, body, token = 'sync-isolated') => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/workspace/external-sync-${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  try {
    assert.equal((await call('status', { sourceId: f.sourceId }, 'wrong')).status, 401)
    assert.equal((await call('configure', { sourceId: f.sourceId, actor: 'admin', enabled: true, confirmed: true, expectedRevision: 0 })).status, 400)
    assert.equal((await call('configure', { sourceId: f.sourceId, enabled: true, confirmed: true, expectedRevision: 0 })).status, 200)
    assert.equal((await call('refresh', { sourceId: f.sourceId, confirmed: true })).body.data.runState, 'idle')
    assert.equal((await call('status', { sourceId: f.sourceId })).body.data.windows.length, 2)
  } finally { await new Promise(r => server.close(r)) }
}, options()))
