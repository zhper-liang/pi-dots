import { fork } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActorAuthority } from './workspace-policy.mjs'
import { createWorkspaceService } from './workspace-service.mjs'
import { createWorkspaceScheduler, INTERNAL_SCHEDULE_ACTION } from './workspace-schedule.mjs'
import { normalizeScheduleRule, nextScheduleDue, latestScheduleDue } from './workspace-schedule-rules.mjs'
import { openFoundation } from './fixtures/workspace-foundation.mjs'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'
const actionSpec = { kind: INTERNAL_SCHEDULE_ACTION }
const start = Date.parse('2026-10-19T00:00:00Z')
const create = (requestId = 'one', rule = { type: 'at', at: new Date(start + 60000).toISOString() }) => ({ requestId, command: 'create', title: '内部验收记录', timezone: 'Asia/Shanghai', rule, actionSpec, confirmed: true })
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-05-')), file = join(dir, 'isolated.sqlite')
  const store = await openFoundation(file), authority = createActorAuthority(), actor = authority.user(), service = createWorkspaceService({ repository: store.repo, authority })
  await service.manageLocalGrant(actor, { requestId: 'grant', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
  let time = start, scheduler
  const options = { repository: store.repo, authority, commitLocal: (...args) => service.commitLocal(...args), now: () => time }
  scheduler = createWorkspaceScheduler(options)
  try { await fn({ ...store, file, dir, authority, actor, service, scheduler, options, setTime: t => { time = t }, getTime: () => time }) } finally { await scheduler.close(); await store.close(); await rm(dir, { recursive: true, force: true }) }
}
const history = (s, actor, id) => s.list(actor, { scheduleId: id })
const record = (repo, type, id) => repo.transaction(tx => repo.get(tx, type, 'local-owner', 'local', id))
const mutate = (repo, type, row) => repo.transaction(tx => repo.put(tx, type, row))

test('05 rules reject cron/code/short interval and validate IANA/offset', () => {
  for (const [rule, zone] of [[{ type: 'cron', expression: '*' }, 'UTC'], [{ type: 'interval', seconds: 59, anchor: '2026-10-20T00:00:00Z' }, 'UTC'], [{ type: 'daily', time: '24:00' }, 'UTC'], [{ type: 'at', at: '2026-10-20T00:00' }, 'UTC'], [{ type: 'daily', time: '09:00', shell: 'anything' }, 'UTC'], [{ type: 'daily', time: '09:00' }, 'No/Zone'], [{ type: 'at', at: '2026-02-30T00:00:00Z' }, 'UTC']]) assert.throws(() => normalizeScheduleRule(rule, zone))
  assert.equal(normalizeScheduleRule({ type: 'interval', seconds: 60, anchor: '2026-10-20T08:00:00+08:00' }, 'Asia/Shanghai').anchor, '2026-10-20T00:00:00.000Z')
})
test('05 daily skips DST gap, chooses first overlap including clock rewind and crosses civil date', () => {
  const next = (time, at, zone = 'America/New_York') => new Date(nextScheduleDue({ type: 'daily', time }, zone, Date.parse(at))).toISOString()
  assert.equal(next('02:30', '2026-03-08T05:00:00Z'), '2026-03-09T06:30:00.000Z')
  assert.equal(next('01:30', '2026-11-01T04:00:00Z'), '2026-11-01T05:30:00.000Z')
  assert.equal(next('01:30', '2026-11-01T05:31:00Z'), '2026-11-02T06:30:00.000Z')
  assert.equal(next('00:05', '2026-10-19T16:00:00Z', 'Asia/Shanghai'), '2026-10-19T16:05:00.000Z')
  assert.equal(new Date(latestScheduleDue({ type: 'daily', time: '01:30' }, 'America/New_York', Date.parse('2026-10-31T05:30:00Z'), Date.parse('2026-11-01T06:31:00Z'))).toISOString(), '2026-11-01T05:30:00.000Z')
})
test('05 explicit confirmation, trusted user, action whitelist, idempotency and immutable audited cancellation', () => fixture(async ({ scheduler, actor, authority }) => {
  await assert.rejects(scheduler.manage(actor, { ...create(), confirmed: false }), { code: 'WORKSPACE_SCHEDULE_CONFIRM' })
  await assert.rejects(scheduler.manage({ ...actor }, create()), { code: 'WORKSPACE_ACTOR' })
  for (const kind of ['deliver_notification', 'refresh_source', 'agent_readonly_workflow', 'shell', 'url']) await assert.rejects(scheduler.manage(actor, { ...create(), actionSpec: { kind } }), { code: 'WORKSPACE_SCHEDULE_ACTION' })
  const first = await scheduler.manage(actor, create()), s = first.receipt.schedule
  assert.deepEqual(await scheduler.manage(actor, create()), first)
  await assert.rejects(scheduler.manage(actor, { ...create(), title: 'different' }), { code: 'WORKSPACE_REQUEST_CONFLICT' })
  assert.deepEqual(s.callLimits, { modelCalls: 0, toolCalls: 0 }); assert.equal(s.authorizationSnapshot.userEpoch, 1)
  await assert.rejects(scheduler.manage(actor, { ...create('spoof'), executionPrincipal: { kind: 'user' } }), { code: 'WORKSPACE_SCHEDULE_INPUT' })
  await assert.rejects(scheduler.manage(authority.user(), { command: 'pause', requestId: 'old', id: s.id, expectedRevision: 10 }), { code: 'WORKSPACE_SCHEDULE_REVISION' })
  await scheduler.manage(actor, { command: 'cancel', requestId: 'cancel', id: s.id, expectedRevision: 1 })
  await assert.rejects(scheduler.manage(actor, { command: 'resume', requestId: 'revive', id: s.id, expectedRevision: 2, confirmed: true }), { code: 'WORKSPACE_SCHEDULE_REVISION' })
  assert.equal((await scheduler.list(actor)).items[0].status, 'cancelled')
}))
test('05 duplicate ticks and competing hosts create one stable occurrence/operation only', () => fixture(async ({ scheduler, actor, options, setTime, repo }) => {
  const s = (await scheduler.manage(actor, create())).receipt.schedule, second = createWorkspaceScheduler(options)
  setTime(start + 60000)
  try { await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? second : scheduler).tick())) } finally { await second.close() }
  const rows = (await history(scheduler, actor, s.id)).items
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'succeeded'); assert.equal(rows[0].attempts, 1)
  assert.equal(rows[0].result.notificationDelivered, false)
  const op = await repo.transaction(tx => repo.get(tx, 'Operation', 'local-owner', 'operations', rows[0].operationId)); assert.equal(op.receipt.occurrenceId, rows[0].id)
  await scheduler.tick(); assert.equal((await history(scheduler, actor, s.id)).items.length, 1)
}))
test('05 pause/resume starts next instant, cancels claimed revision; edits invalidate old due', () => fixture(async ({ scheduler, actor, setTime, repo }) => {
  let s = (await scheduler.manage(actor, create('interval', { type: 'interval', seconds: 60, anchor: new Date(start + 60000).toISOString() }))).receipt.schedule
  s = (await scheduler.manage(actor, { command: 'pause', requestId: 'pause', id: s.id, expectedRevision: 1 })).receipt.schedule
  setTime(start + 600000); await scheduler.tick(); assert.equal((await history(scheduler, actor, s.id)).items.length, 0)
  s = (await scheduler.manage(actor, { command: 'resume', requestId: 'resume', id: s.id, expectedRevision: 2, confirmed: true })).receipt.schedule
  assert.equal(s.nextDueAt, new Date(start + 660000).toISOString())
  s = (await scheduler.manage(actor, { ...create('edit', { type: 'at', at: new Date(start + 900000).toISOString() }), command: 'update', id: s.id, expectedRevision: 3 })).receipt.schedule
  setTime(start + 660000); await scheduler.tick(); assert.equal((await history(scheduler, actor, s.id)).items.length, 0)
  setTime(start + 900000); await scheduler.tick(); assert.equal((await history(scheduler, actor, s.id)).items[0].revision, 4)
  assert.equal((await record(repo, 'Schedule', s.id)).status, 'completed')
}))
test('05 persisted grace skips late at; interval/daily coalesce a year of downtime without unbounded rows', () => fixture(async ({ scheduler, actor, setTime, repo }) => {
  const a = (await scheduler.manage(actor, create('late'))).receipt.schedule
  const i = (await scheduler.manage(actor, create('many', { type: 'interval', seconds: 60, anchor: new Date(start + 60000).toISOString() }))).receipt.schedule
  const d = (await scheduler.manage(actor, create('daily', { type: 'daily', time: '09:00' }))).receipt.schedule
  setTime(start + 365 * 86400000 + 123000); await scheduler.tick()
  assert.equal((await history(scheduler, actor, a.id)).items[0].reason, 'grace_expired')
  for (const s of [i, d]) { const rows = (await history(scheduler, actor, s.id)).items; assert.equal(rows.length, 2); assert.equal(rows[0].state, 'coalesced'); assert.equal(rows[1].state, 'succeeded'); assert(Date.parse((await record(repo, 'Schedule', s.id)).nextDueAt) > start + 365 * 86400000) }
}))
test('05 cancellation and live revocation at dispatch boundary beat claimed work', () => fixture(async ({ options, actor, service, setTime, repo }) => {
  for (const mode of ['pause', 'cancel', 'revoke']) {
    const sch = createWorkspaceScheduler({ ...options, boundary: async phase => { if (phase === 'before_dispatch') { const s = (await sch.list(actor)).items.find(x => x.title === mode); if (mode === 'revoke') await service.manageLocalGrant(actor, { requestId: 'revoke', sourceId: 'local', enabled: true, expectedEpoch: 1, confirmed: true }); else await sch.manage(actor, { command: mode, requestId: mode, id: s.id, expectedRevision: s.revision }) } } })
    try {
      setTime(start); const s = (await sch.manage(actor, { ...create(`create-${mode}`), title: mode })).receipt.schedule; setTime(start + 60000); await sch.tick()
      const rows = await repo.transaction(tx => repo.list(tx, 'Occurrence', 'local-owner', 'local')); const o = rows.items.find(o => o.scheduleId === s.id); assert.equal(o.state, 'cancelled'); assert.equal(o.attempts, 0)
    } finally { await sch.close() }
  }
}))
test('05 retry budget persists with 30/120 second backoff, no side effect on rollback', () => fixture(async ({ options, actor, setTime }) => {
  const s = createWorkspaceScheduler({ ...options, boundary: async phase => { if (phase === 'in_transaction') throw Error('isolated injected failure') } })
  try {
    const plan = (await s.manage(actor, create())).receipt.schedule
    setTime(start + 60000); await s.tick(); let o = (await history(s, actor, plan.id)).items[0]; assert.equal(o.state, 'retry_wait'); assert.equal(o.attempts, 1); assert.equal(o.retryAt, new Date(start + 90000).toISOString())
    await s.tick(); assert.equal((await history(s, actor, plan.id)).items[0].attempts, 1)
    setTime(start + 90000); await s.tick(); o = (await history(s, actor, plan.id)).items[0]; assert.equal(o.attempts, 2); assert.equal(o.retryAt, new Date(start + 210000).toISOString())
    setTime(start + 210000); await s.tick(); o = (await history(s, actor, plan.id)).items[0]; assert.equal(o.state, 'failed'); assert.equal(o.attempts, 3)
  } finally { await s.close() }
}))
test('05 linked unknown Task/delivery never redispatched, overlapping due coalesced on resolution', () => fixture(async ({ options, actor, setTime, repo }) => {
  let sch
  sch = createWorkspaceScheduler({ ...options, boundary: async phase => { if (phase === 'after_claim') throw Error('stop after durable claim') } })
  let plan
  try { plan = (await sch.manage(actor, create('interval', { type: 'interval', seconds: 60, anchor: new Date(start + 60000).toISOString() }))).receipt.schedule; setTime(start + 60000); await assert.rejects(sch.tick()) } finally { await sch.close() }
  const o = (await repo.transaction(tx => repo.list(tx, 'Occurrence', 'local-owner', 'local'))).items[0]
  await mutate(repo, 'Occurrence', { ...o, taskId: 999, deliveryId: 'original-delivery', state: 'unknown' })
  const next = createWorkspaceScheduler(options)
  try { setTime(start + 3600000); await next.tick(); let rows = (await history(next, actor, plan.id)).items; assert.equal(rows.length, 1); assert.equal(rows[0].taskId, 999); assert.equal(rows[0].state, 'unknown'); await assert.rejects(next.manage(actor, { ...create('modify'), command: 'update', id: plan.id, expectedRevision: 1 }), { code: 'WORKSPACE_SCHEDULE_UNRESOLVED' })
    await mutate(repo, 'Occurrence', { ...rows[0], state: 'succeeded' }); await next.tick(); rows = (await history(next, actor, plan.id)).items; assert.equal(rows.length, 3); assert.equal(rows.at(-1).state, 'succeeded')
  } finally { await next.close() }
}))
test('05 global recovery limits ten per tick and backward clock does not repeat UTC point', () => fixture(async ({ scheduler, actor, setTime }) => {
  for (let i = 0; i < 13; i++) await scheduler.manage(actor, create(`batch-${i}`))
  setTime(start + 60000); assert.equal(await scheduler.tick(), 10); assert.equal(await scheduler.tick(), 3)
  setTime(start); assert.equal(await scheduler.tick(), 0); setTime(start + 60000); assert.equal(await scheduler.tick(), 0)
}))
test('05 authenticated API: no token/forged actor denied; no chat/model needed; normal chat still runs during scheduler sleep', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-05-http-')), store = await openTaskStore({ file: join(dir, 'isolated.sqlite') }), server = createApiServer({ token: 'isolated-schedule', tasks: store })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}/api/workspace/`
  const api = async (path, data, token = 'isolated-schedule') => { const r = await fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return { status: r.status, body: await r.json() } }
  try {
    assert.equal((await api('schedule-list', {}, 'wrong')).status, 401)
    assert.equal((await api('schedule-list', {})).status, 200) // ADR-011 owner implicit local access
    assert.equal((await api('grant', { requestId: 'grant', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })).status, 200)
    const input = { ...create(), rule: { type: 'at', at: new Date(Date.now() + 60000).toISOString() } }
    assert.equal((await api('schedule-manage', { ...input, ownerId: 'spoof' })).status, 400)
    assert.equal((await api('schedule-manage', input)).status, 200)
    assert.equal((await api('schedule-list', {})).body.data.items.length, 1)
    const task = await store.create({ botId: 'chief', title: 'sleep does not block chat' }); await store.send(task.taskId, '你好')
    for (let i = 0; i < 200; i++) { const state = await store.get(task.taskId); if (state.messages.some(m => m.role === 'assistant')) break; if (i === 199) assert.fail('chat blocked by scheduler'); await new Promise(r => setTimeout(r, 10)) }
  } finally { await new Promise(r => server.close(r)); await store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('05 actual SIGKILL before due scan, after claim, in transaction and after receipt recovers same database once', async () => {
  for (const phase of ['before_due', 'before_claim', 'after_claim', 'before_dispatch', 'in_transaction', 'after_dispatch']) {
    const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-05-kill-')), file = join(dir, 'isolated.sqlite')
    const launch = mode => fork(new URL('./fixtures/workspace-schedule-crash.mjs', import.meta.url), [file, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const message = child => new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('crash fixture timeout')) }, 15000); child.once('message', value => { clearTimeout(timer); resolve(value) }); child.once('error', reject) })
    let child
    try {
      child = launch('seed'); const seeded = await message(child); await once(child, 'exit')
      child = launch(phase); const m = await message(child); assert.equal(m.point, phase); const exited = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL')
      child = launch('recover'); const result = await message(child); await once(child, 'exit'); assert(result.completed)
      const store = await openTaskStore({ file, workspaceScheduleOptions: { autoStart: false, now: () => start + 120001 } })
      try { await store.workspaceScheduler.tick(); const rows = (await store.workspaceSchedules.list({ scheduleId: seeded.seeded.id })).items; assert.equal(rows.length, 1, phase); assert.equal(rows[0].state, 'succeeded', phase); assert.equal(rows[0].attempts, 1, phase); assert(rows[0].operationId); assert.equal(rows[0].result.occurrenceId, rows[0].id) } finally { await store.close() }
    } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }) }
  }
})

test('05 grace boundary inclusive and new host resumes original retry record and operation ID', () => fixture(async ({ options, actor, setTime }) => {
  let original
  const first = createWorkspaceScheduler({ ...options, boundary: async p => { if (p === 'in_transaction') throw Error('safe rollback') } })
  try { original = (await first.manage(actor, create())).receipt.schedule; setTime(start + 960000); await first.tick(); const o = (await history(first, actor, original.id)).items[0]; assert.equal(o.state, 'retry_wait'); assert.equal(o.attempts, 1) } finally { await first.close() }
  const recovered = createWorkspaceScheduler(options)
  try { const prior = (await history(recovered, actor, original.id)).items[0]; setTime(start + 990000); await recovered.tick(); const after = (await history(recovered, actor, original.id)).items[0]; assert.equal(after.id, prior.id); assert.equal(after.operationId, prior.operationId); assert.equal(after.attempts, 2); assert.equal(after.state, 'succeeded') } finally { await recovered.close() }
}))
test('05 occurrence pagination preserves historical rows and owner local access cannot be revoked (ADR-011)', () => fixture(async ({ scheduler, actor, service, repo }) => {
  const s = (await scheduler.manage(actor, create())).receipt.schedule
  for (let i = 0; i < 105; i++) await mutate(repo, 'Occurrence', { schemaVersion: 1, ownerId: 'local-owner', sourceId: 'local', id: `historical-${i}`, scheduleId: s.id, revision: 1, scheduledFor: new Date(start - i * 60000).toISOString(), attempts: 0, state: 'skipped', reason: 'historical-isolated-fixture' })
  const a = await scheduler.list(actor, { scheduleId: s.id, limit: 100 }), b = await scheduler.list(actor, { scheduleId: s.id, cursor: a.next, limit: 100 }); assert.equal(a.items.length, 100); assert.equal(b.items.length, 5)
  // ADR-011: owner local access cannot be revoked; listing and receipts stay readable.
  await assert.rejects(service.manageLocalGrant(actor, { requestId: 'revoke-list', sourceId: 'local', enabled: false, expectedEpoch: 1, confirmed: true }), { code: 'WORKSPACE_OWNER_IMPLICIT' })
  assert.equal((await scheduler.list(actor, { scheduleId: s.id, limit: 100 })).items.length, 100)
}))
