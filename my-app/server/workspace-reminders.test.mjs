import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openFoundation } from './fixtures/workspace-foundation.mjs'
import { createActorAuthority } from './workspace-policy.mjs'
import { createWorkspaceService } from './workspace-service.mjs'
import { createWorkspaceReminders } from './workspace-reminders.mjs'
import { createWorkspaceScheduler } from './workspace-schedule.mjs'
const start = Date.parse('2026-10-19T00:00:00Z')
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-07-')), file = join(dir, 'isolated.sqlite'); let store = await openFoundation(file), time = start, scheduler
  const authority = createActorAuthority(), actor = authority.user(); let service = createWorkspaceService({ repository: store.repo, authority }), reminders
  const setup = () => { reminders = createWorkspaceReminders({ repository: store.repo, authority, service, now: () => time }); scheduler = createWorkspaceScheduler({ repository: store.repo, authority, reminders, commitLocal: (...args) => service.commitLocal(...args), now: () => time }) }; setup()
  await service.manageLocalGrant(actor, { requestId: 'grant', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
  const get = (type, id, source = 'local') => store.repo.transaction(tx => store.repo.get(tx, type, 'local-owner', source, id))
  const rows = type => store.repo.transaction(async tx => (await store.repo.list(tx, type, 'local-owner', 'local', { limit: 100 })).items)
  const add = async (type = 'Todo', data = { title: 'secret-title', status: 'open', due: new Date(start + 60000).toISOString(), timezone: 'UTC' }) => (await service.executeLocal(actor, { requestId: crypto.randomUUID(), sourceId: 'local', type, action: 'create', data })).receipt.target
  const remind = async (ref, extra = {}) => (await reminders.manage(actor, { requestId: crypto.randomUUID(), command: 'create', targetRef: ref, targetVersion: 1, channel: 'inbox', offset: 0, confirmed: true, ...extra })).receipt.reminder
  const env = { actor, authority, get, rows, add, remind, get service() { return service }, get reminders() { return reminders }, get scheduler() { return scheduler }, get repo() { return store.repo }, time: t => { time = t }, restart: async () => { await scheduler.close(); await store.close(); store = await openFoundation(file); service = createWorkspaceService({ repository: store.repo, authority }); setup() } }
  try { await fn(env) } finally { await scheduler.close(); await store.close(); await rm(dir, { recursive: true, force: true }) }
}
test('07 local reminder persists one delivery/inbox/operation across duplicate tick and restart; read is separate', () => fixture(async f => {
  const r = await f.remind(await f.add()); f.time(start + 60001); await f.scheduler.tick(); await f.scheduler.tick()
  const n = await f.rows('Notification'), d = await f.rows('Delivery'), o = await f.rows('Occurrence'); assert.equal(n.length, 1); assert.equal(d.length, 1); assert.equal(o.length, 1); assert.equal(d[0].status, 'recorded'); assert.equal(n[0].status, 'unread'); assert.equal(d[0].readAt, null); assert.equal(o[0].deliveryId, d[0].id); assert.equal(o[0].result.modelCalls, 0); assert.equal(o[0].result.notificationDelivered, false)
  await f.restart(); await f.scheduler.tick(); assert.equal((await f.rows('Notification')).length, 1)
  const list = await f.reminders.list(f.actor); assert.equal(list.items[0].title, 'secret-title'); assert.equal(list.reminders[0].id, r.id)
  const read = await f.reminders.read(f.actor, { id: n[0].id }); assert.equal((await f.get('Delivery', d[0].id)).readAt, read.readAt); assert.equal((await f.reminders.read(f.actor, { id: n[0].id })).readAt, read.readAt)
}))
test('07 local edit immediately revises schedule; delete/completed suppress; no stale send', () => fixture(async f => {
  const ref = await f.add(), r = await f.remind(ref)
  await f.service.executeLocal(f.actor, { requestId: 'edit', sourceId: 'local', type: 'Todo', action: 'update', id: ref.id, expectedVersion: 1, data: { due: new Date(start + 120000).toISOString() } })
  const updated = await f.get('Reminder', r.id), s = await f.get('Schedule', r.scheduleId); assert.equal(updated.targetVersion, 2); assert.equal(updated.version, 2); assert.equal(s.revision, 2); assert.equal(s.nextDueAt, new Date(start + 120000).toISOString())
  f.time(start + 60001); await f.scheduler.tick(); assert.equal((await f.rows('Notification')).length, 0)
  await f.service.executeLocal(f.actor, { requestId: 'delete', sourceId: 'local', type: 'Todo', action: 'delete', id: ref.id, expectedVersion: 2, confirmedDelete: true })
  assert.equal((await f.get('Reminder', r.id)).reason, 'target_deleted'); f.time(start + 120001); await f.scheduler.tick(); assert.equal((await f.rows('Notification')).length, 0)
}))
test('07 no deadline/date-only/invalid confirmation/version/channel/forged actor rejected', () => fixture(async f => {
  const noDue = await f.add('Todo', { title: 'no due', status: 'open' })
  await assert.rejects(f.remind(noDue), { code: 'WORKSPACE_REMINDER_BASE' })
  await assert.rejects(f.remind(noDue, { offset: undefined, at: new Date(start + 60000).toISOString() }), { code: 'WORKSPACE_REMINDER_BASE' })
  const date = await f.add('Todo', { title: 'date', status: 'open', due: '2026-10-20', timezone: 'UTC' }); await assert.rejects(f.remind(date), { code: 'WORKSPACE_REMINDER_BASE' })
  await f.remind(date, { offset: undefined, at: new Date(start + 60000).toISOString() })
  const ref = await f.add()
  for (const extra of [{ targetVersion: 2 }, { channel: 'push' }, { confirmed: false }, { offset: 1.2 }, { offset: undefined, at: '2026-02-30T00:00:00Z' }]) await assert.rejects(f.remind(ref, extra))
  await assert.rejects(f.reminders.list({ principalKind: 'user', ownerId: 'local-owner' }), { code: 'WORKSPACE_ACTOR' })
}))
test('07 epoch rotation blocks stale dispatch; owner cannot revoke local (ADR-011)', () => fixture(async f => {
  const ref = await f.add(); await f.remind(ref); f.time(start + 60001); await f.scheduler.tick(); assert.equal((await f.rows('Notification')).length, 1)
  const ref2 = await f.add('Todo', { title: 'later', status: 'open', due: new Date(start + 180000).toISOString(), timezone: 'UTC' }); await f.remind(ref2)
  // ADR-011: owner cannot revoke local access; an explicit re-enable still rotates the epoch,
  // so reminders pinned to the old epoch must not revive (snapshot invariant kept).
  await assert.rejects(f.service.manageLocalGrant(f.actor, { requestId: 'revoke', sourceId: 'local', enabled: false, expectedEpoch: 1, confirmed: true }), { code: 'WORKSPACE_OWNER_IMPLICIT' })
  await f.service.manageLocalGrant(f.actor, { requestId: 'regrant', sourceId: 'local', enabled: true, expectedEpoch: 1, confirmed: true })
  const list = await f.reminders.list(f.actor); assert(!list.items[0].redacted) // owner always sees own data
  f.time(start + 180001); await f.scheduler.tick(); assert.equal((await f.rows('Notification')).length, 1)
}))
test('07 disable confirmed/version-bound, schedule route cannot bypass and expired misfire skips', () => fixture(async f => {
  const r = await f.remind(await f.add()); await assert.rejects(f.scheduler.manage(f.actor, { requestId: 'bypass', command: 'resume', id: r.scheduleId, expectedRevision: 1, confirmed: true }), { code: 'WORKSPACE_REMINDER_MANAGEMENT' })
  await f.reminders.manage(f.actor, { requestId: 'off', command: 'disable', sourceId: 'local', id: r.id, expectedVersion: 1, confirmed: true }); f.time(start + 60001); await f.scheduler.tick(); assert.equal((await f.rows('Notification')).length, 0)
  const r2 = await f.remind(await f.add('Todo', { title: 'old', status: 'open', due: new Date(start + 120000).toISOString(), timezone: 'UTC' })); f.time(start + 120000 + 900001); await f.scheduler.tick(); const rows = (await f.rows('Occurrence')).filter(o => o.scheduleId === r2.scheduleId); assert.equal(rows[0].reason, 'grace_expired'); assert.equal(rows[0].state, 'skipped'); assert.equal((await f.rows('Notification')).length, 0)
}))

import { externalFixture } from './fixtures/workspace-external.mjs'
const extTime = start + 3600000
const extEvent = (time = extTime) => ({ event_id: 'reminder-ext', summary: 'external-secret', description: 'external-body', start_time: { timestamp: String(time / 1000), timezone: 'UTC' }, end_time: { timestamp: String(time / 1000 + 3600), timezone: 'UTC' }, status: 'confirmed', organizer_calendar_id: 'isolated-calendar' })
const enableLocal = store => store.workspace.manageLocalGrant({ requestId: 'local', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
async function extReminder(f) {
  const q = await f.store.workspace.getExternal({ sourceId: f.sourceId, eventId: 'reminder-ext' }), t = q.items[0]
  return (await f.store.workspaceReminders.manage({ requestId: 'ext-reminder', command: 'create', targetRef: { sourceId: f.sourceId, type: 'Event', id: t.id }, targetVersion: t.version, offset: 0, channel: 'inbox', confirmed: true })).receipt.reminder
}
const extOptions = clock => ({ storeOptions: { workspaceScheduleOptions: { autoStart: false, now: clock }, workspaceReminderOptions: { now: clock }, workspaceSyncOptions: { now: clock } } })
test('07 external send freshly verifies target; changed/deleted races suppress old occurrence and replan', async () => {
  let time = start
  await externalFixture(async f => {
    await enableLocal(f.store); f.events.set('reminder-ext', extEvent()); const r = await extReminder(f)
    f.events.set('reminder-ext', extEvent(extTime + 60000)); time = extTime + 1; await f.store.workspaceScheduler.tick()
    let list = await f.store.workspaceReminders.list({}); assert.equal(list.items.length, 0); assert.equal(list.reminders[0].targetVersion, 2); assert.equal(list.reminders[0].schedule.revision, 2); assert.equal(list.reminders[0].schedule.id, r.scheduleId)
    time = extTime + 60001; await f.store.workspaceScheduler.tick(); list = await f.store.workspaceReminders.list({}); assert.equal(list.items.length, 1); assert.equal(list.items[0].title, 'external-secret'); assert.equal(list.reminders[0].runs.filter(o => o.state === 'succeeded').length, 1)
    assert.equal(f.modelCalls(), 0); assert.equal(f.writes.length, 0)
    const source = (await f.store.workspace.externalSources({})).sources[0]; await f.store.workspace.grantExternal({ sourceId: f.sourceId, expectedEpoch: source.epoch, enabled: true, readScope: 'busy', confirmed: true })
    list = await f.store.workspaceReminders.list({}); assert.equal(list.items[0].redacted, true); assert(!JSON.stringify(list).includes('external-secret')); assert(!list.reminders[0].targetRef)
  }, extOptions(() => time))
})
test('07 external unavailable safely retries 30/120 seconds across restart, max three; no false inbox', async () => {
  let time = start
  await externalFixture(async f => {
    await enableLocal(f.store); f.events.set('reminder-ext', extEvent()); await extReminder(f); f.events.delete('reminder-ext'); time = extTime + 1
    await f.store.workspaceScheduler.tick(); let r = (await f.store.workspaceReminders.list({})).reminders[0]; assert.equal(r.runs[0].state, 'retry_wait'); assert.equal(r.runs[0].attempts, 1); assert.equal(Date.parse(r.runs[0].retryAt), time + 30000)
    await f.restart(); time += 30000; await f.store.workspaceScheduler.tick(); r = (await f.store.workspaceReminders.list({})).reminders[0]; assert.equal(r.runs[0].attempts, 2); assert.equal(Date.parse(r.runs[0].retryAt), time + 120000)
    time += 120000; await f.store.workspaceScheduler.tick(); r = (await f.store.workspaceReminders.list({})).reminders[0]; assert.equal(r.runs[0].attempts, 3); assert.equal(r.runs[0].state, 'failed'); await f.store.workspaceScheduler.tick(); assert.equal((await f.store.workspaceReminders.list({})).items.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.modelCalls(), 0)
  }, extOptions(() => time))
})
test('07 external sync atomically revises reminder; exact cancelled suppresses without delivery', async () => {
  let time = start
  await externalFixture(async f => {
    await enableLocal(f.store); f.events.set('reminder-ext', extEvent()); await extReminder(f)
    await f.store.workspace.configureSync({ sourceId: f.sourceId, enabled: true, expectedRevision: 0, confirmed: true })
    f.events.set('reminder-ext', extEvent(extTime + 120000)); await f.store.workspace.refreshSync({ sourceId: f.sourceId, confirmed: true })
    let r = (await f.store.workspaceReminders.list({})).reminders[0]; assert.equal(r.targetVersion, 2); assert.equal(r.schedule.nextDueAt, new Date(extTime + 120000).toISOString())
    f.events.get('reminder-ext').status = 'cancelled'; time = extTime + 120001; await f.store.workspaceScheduler.tick(); r = (await f.store.workspaceReminders.list({})).reminders[0]; assert.equal(r.reason, 'target_deleted'); assert.equal((await f.store.workspaceReminders.list({})).items.length, 0)
  }, extOptions(() => time))
})
test('07 rollback within delivery records no inbox; same occurrence safely retries exactly once', () => fixture(async f => {
  const r = await f.remind(await f.add()); let crash = true
  const reminders = createWorkspaceReminders({ repository: f.repo, authority: f.authority, service: f.service, now: () => start + 60001, boundary: async point => { if (crash && point === 'in_delivery') throw Error('isolated rollback') } })
  const scheduler = createWorkspaceScheduler({ repository: f.repo, authority: f.authority, reminders, now: () => start + 60001, commitLocal: (...args) => f.service.commitLocal(...args) })
  try { await scheduler.tick(); assert.equal((await f.rows('Notification')).length, 0); assert.equal((await f.rows('Delivery')).length, 0); assert.equal((await f.rows('Occurrence'))[0].attempts, 1) } finally { await scheduler.close() }
  crash = false; f.time(start + 90002); await f.scheduler.tick(); assert.equal((await f.rows('Notification')).length, 1); const o = (await f.rows('Occurrence'))[0]; assert.equal(o.attempts, 2); assert.equal(o.scheduleId, r.scheduleId)
}))

import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createApiServer } from './app.mjs'
import { openTaskStore } from './tasks.mjs'
test('07 actual SIGKILL before claim/after claim/in delivery/after commit recovers same logical inbox', async () => {
  for (const phase of ['before_claim', 'after_claim', 'in_delivery', 'after_dispatch']) {
    const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-07-kill-')), file = join(dir, 'isolated.sqlite')
    const spawn = mode => fork(new URL('./fixtures/workspace-reminder-crash.mjs', import.meta.url), [file, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const receive = child => Promise.race([once(child, 'message').then(([m]) => m), once(child, 'exit').then(([code]) => { throw Error(`child exited ${code}`) })])
    try {
      const seed = spawn('seed'); const seeded = await receive(seed); await once(seed, 'exit'); assert(seeded.seeded)
      const crashing = spawn(phase); const point = await receive(crashing); assert.equal(point.point, phase); const exit = once(crashing, 'exit'); crashing.kill('SIGKILL'); await exit
      const restarted = spawn('recover'); const result = await receive(restarted); await once(restarted, 'exit'); const inbox = result.completed
      assert.equal(inbox.items.length, 1, phase); assert.equal(inbox.reminders[0].runs.length, 1); assert.equal(inbox.reminders[0].runs[0].attempts, 1); assert.equal(inbox.reminders[0].runs[0].deliveryId, inbox.items[0].deliveryId)
      const again = spawn('recover'); const repeated = await receive(again); await once(again, 'exit'); assert.equal(repeated.completed.items[0].id, inbox.items[0].id)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})
test('07 authenticated HTTP closed-page delivery/read, strict token/actor and legacy blocker unaffected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-07-http-')); let models = 0, time = start
  const store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), modelReply: async () => { models++; throw Error('no model') }, workspaceScheduleOptions: { autoStart: false, now: () => time }, workspaceReminderOptions: { now: () => time } })
  const server = createApiServer({ tasks: store, token: 'isolated07-only' }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const call = async (path, input, token = 'isolated07-only') => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/workspace/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); return { status: r.status, body: await r.json() } }
  try {
    await enableLocal(store); assert.equal((await call('reminder-list', {}, 'wrong')).status, 401); assert.equal((await call('reminder-list', { actor: { principalKind: 'user' } })).status, 400)
    const target = (await store.workspace.executeLocal({ requestId: 'todo', sourceId: 'local', type: 'Todo', action: 'create', data: { title: 'http-closed-page', due: new Date(start + 60000).toISOString(), timezone: 'UTC' } })).receipt.target
    const input = { requestId: 'http-remind', command: 'create', targetRef: target, targetVersion: 1, offset: 0, channel: 'inbox', confirmed: true }
    const a = await call('reminder-manage', input), b = await call('reminder-manage', input); assert.equal(a.status, 200); assert.equal(a.body.data.id, b.body.data.id)
    // No browser or subscription exists. Only persisted due + backend tick.
    time += 60001; await store.workspaceScheduler.tick(); const list = await call('reminder-list', {}); assert.equal(list.body.data.items.length, 1)
    assert.equal((await call('notification-read', { id: list.body.data.items[0].id })).body.data.status, 'read'); assert.equal(models, 0)
  } finally { await new Promise(resolve => server.close(resolve)); await store.close(); await rm(dir, { recursive: true, force: true }) }
})
test('07 local target edited between claim and send cancels old occurrence; no raced delivery', () => fixture(async f => {
  const ref = await f.add(), r = await f.remind(ref)
  const reminders = createWorkspaceReminders({ repository: f.repo, authority: f.authority, service: f.service, now: () => start + 60001 })
  const scheduler = createWorkspaceScheduler({ repository: f.repo, authority: f.authority, reminders, now: () => start + 60001, commitLocal: (...a) => f.service.commitLocal(...a), boundary: async point => { if (point === 'before_dispatch') await f.service.executeLocal(f.actor, { requestId: 'race', sourceId: 'local', type: 'Todo', action: 'update', id: ref.id, expectedVersion: 1, data: { due: new Date(start + 120000).toISOString() } }) } })
  try { await scheduler.tick(); assert.equal((await f.rows('Notification')).length, 0); assert.equal((await f.rows('Occurrence'))[0].state, 'cancelled'); assert.equal((await f.get('Schedule', r.scheduleId)).revision, 2) } finally { await scheduler.close() }
}))
test('07 unknown linked execution preserved; completed Todo and deleted Event stop future reminders', () => fixture(async f => {
  const ref = await f.add(); await f.remind(ref)
  const reminders = createWorkspaceReminders({ repository: f.repo, authority: f.authority, service: f.service, now: () => start + 60001 })
  const scheduler = createWorkspaceScheduler({ repository: f.repo, authority: f.authority, reminders, now: () => start + 60001, commitLocal: (...a) => f.service.commitLocal(...a), boundary: async (point, rows) => { if (point === 'after_claim') await f.repo.transaction(tx => f.repo.put(tx, 'Occurrence', { ...rows[0], state: 'unknown', deliveryId: 'unknown-preserved' })) } })
  try { await scheduler.tick() } finally { await scheduler.close() }
  f.time(start + 90001); await f.scheduler.tick(); assert.equal((await f.rows('Occurrence'))[0].state, 'unknown'); assert.equal((await f.rows('Notification')).length, 0)
  const t = await f.add('Todo', { title: 'complete', due: new Date(start + 180000).toISOString(), timezone: 'UTC' }), rt = await f.remind(t)
  await f.service.executeLocal(f.actor, { requestId: 'complete', sourceId: 'local', type: 'Todo', action: 'update', id: t.id, expectedVersion: 1, data: { status: 'completed' } }); assert.equal((await f.get('Reminder', rt.id)).reason, 'target_completed')
  const e = await f.add('Event', { title: 'event', start: new Date(start + 180000).toISOString(), end: new Date(start + 240000).toISOString(), timezone: 'UTC' }), re = await f.remind(e)
  await f.service.executeLocal(f.actor, { requestId: 'delete-event', sourceId: 'local', type: 'Event', action: 'delete', id: e.id, expectedVersion: 1, confirmedDelete: true }); assert.equal((await f.get('Reminder', re.id)).reason, 'target_deleted')
}))

test('07 completed occurrence never revived by target version change; cancelled plans stay cancelled', () => fixture(async f => {
 const ref = await f.add(), r = await f.remind(ref); f.time(start + 60001); await f.scheduler.tick()
 await f.service.executeLocal(f.actor,{requestId:'post-record-edit',sourceId:'local',type:'Todo',action:'update',id:ref.id,expectedVersion:1,data:{due:new Date(start+120000).toISOString()}})
 assert.equal((await f.get('Schedule',r.scheduleId)).status,'completed');assert.equal((await f.get('Schedule',r.scheduleId)).revision,1)
 f.time(start+120001);await f.scheduler.tick();assert.equal((await f.rows('Notification')).length,1);assert.equal((await f.rows('Occurrence')).length,1)
}))
test('07 unknown associated delivery blocks target replan, not just duplicate dispatch', () => fixture(async f => {
 const ref=await f.add(),r=await f.remind(ref)
 await f.repo.transaction(async tx=>{const s=await f.repo.get(tx,'Schedule','local-owner','local',r.scheduleId);const o={schemaVersion:1,ownerId:'local-owner',sourceId:'local',id:'unknown-one',scheduleId:s.id,revision:1,scheduledFor:s.nextDueAt,attempts:1,state:'unknown',deliveryId:'keep-original'};await f.repo.put(tx,'Occurrence',o);await f.repo.put(tx,'Schedule',{...s,activeOccurrenceId:o.id,status:'finishing'})})
 await f.service.executeLocal(f.actor,{requestId:'unknown-edit',sourceId:'local',type:'Todo',action:'update',id:ref.id,expectedVersion:1,data:{due:new Date(start+120000).toISOString()}})
 assert.equal((await f.get('Schedule',r.scheduleId)).revision,1);assert.equal((await f.get('Reminder',r.id)).state,'unknown');assert.equal((await f.get('Occurrence','unknown-one')).deliveryId,'keep-original')
 f.time(start+120001);await f.scheduler.tick();assert.equal((await f.rows('Notification')).length,0)
}))
test('07 external grant revocation denies old local operation receipt and idempotent replay', async ()=>{
 let time=start
 await externalFixture(async f=>{
  await enableLocal(f.store);f.events.set('reminder-ext',extEvent());await extReminder(f)
  assert((await f.store.workspace.getLocalOperation({requestId:'ext-reminder',sourceId:'local'})).receipt.reminder)
  const src=(await f.store.workspace.externalSources({})).sources[0];await f.store.workspace.grantExternal({sourceId:f.sourceId,expectedEpoch:src.epoch,enabled:false,readScope:'full',confirmed:true})
  await assert.rejects(f.store.workspace.getLocalOperation({requestId:'ext-reminder',sourceId:'local'}),{code:'WORKSPACE_FORBIDDEN'})
  await assert.rejects(f.store.workspaceReminders.manage({requestId:'ext-reminder',command:'create',targetRef:{sourceId:f.sourceId,type:'Event',id:'known-target'},targetVersion:1,offset:0,channel:'inbox',confirmed:true}),{code:'WORKSPACE_FORBIDDEN'})
  assert(!JSON.stringify(await f.store.workspaceReminders.list({})).includes('external-secret'))
 },extOptions(()=>time))
})
