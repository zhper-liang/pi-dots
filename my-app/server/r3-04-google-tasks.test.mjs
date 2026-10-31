import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { openGoogleConnection } from './google-connection.mjs'
import { GoogleAccount } from './google-account.mjs'
import { addRule } from './policy.mjs'
import { ToolAccess } from './tools.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { createWorkspaceRepository } from './workspace-repository.mjs'
import { workspaceSourceReadable } from './workspace-grants.mjs'
import { LOCAL_OWNER, payloadHash } from './workspace-schema.mjs'
import { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT, FAKE_GOOGLE_SECRET_PREFIXES } from './fixtures/fake-google.mjs'

// R3-04 Google Tasks source. Only the loopback fake-google is reachable; every test ends with a
// real-host guard check and a secret scan of the data directory (CONTRACTS §3).
const DAY = 86400000
const day = n => new Date(Date.now() + n * DAY).toISOString().slice(0, 10)
const at = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const windowOf = (from, to) => ({ start: at(Date.parse(`${day(from)}T00:00:00Z`)), end: at(Date.parse(`${day(to)}T00:00:00Z`)), timezone: 'UTC' })
async function files(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name))
  return out
}

async function tasksStore(fn, { fake: fakeOptions = {}, services = ['tasks'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r3-04-')), fake = await createFakeGoogle(fakeOptions), guard = guardGoogleNetwork()
  let offset = 0
  const clock = () => Date.now() + offset
  const google = await openGoogleConnection({ dataDirectory: join(dir, 'google'), env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch, sleep: async () => {} })
  const options = { file: join(dir, 'isolated.sqlite'), google, workspaceScheduleOptions: { autoStart: false, now: clock }, workspaceReminderOptions: { now: clock }, workspaceSyncOptions: { now: clock } }
  let store = await openTaskStore(options), closed = false
  const connect = async (list = services) => { const started = await store.googleConnect({ services: list }); return store.googlePaste({ redirectUrl: await fake.approve(started.attempt.authorizeUrl) }) }
  try {
    await store.googleSaveClient({ requestId: 'r3-04-client-0001', ...FAKE_GOOGLE_CLIENT })
    await connect()
    const repo = () => createWorkspaceRepository({ harness: store.harness, context })
    const sources = async () => (await store.workspace.externalSources({})).sources.filter(s => s.provider === 'google-tasks')
    const todo = (sourceId, remoteId) => store.harness.commit(tx => repo().get(tx, 'Todo', LOCAL_OWNER, sourceId, payloadHash([sourceId, remoteId])), context)
    await fn({ get store() { return store }, google, fake, connect, clock, advance: ms => { offset += ms }, sources, todo, repo,
      restart: async () => { await store.close(); store = await openTaskStore(options); return store } })
    await store.close(); closed = true
    const leaks = []
    for (const file of await files(dir)) {
      if (file.endsWith(join('google', 'credentials.json'))) continue
      const bytes = (await readFile(file)).toString('latin1')
      for (const prefix of FAKE_GOOGLE_SECRET_PREFIXES) if (bytes.includes(prefix)) leaks.push(`${file.slice(dir.length)}:${prefix}`)
    }
    assert.deepEqual(leaks, [], 'no Google secret in SQLite or any other data file')
    assert.deepEqual(guard.blocked, [], 'no request to a real Google host')
  } finally { if (!closed) await store.close().catch(() => {}); await google.close(); await fake.close(); await rm(dir, { recursive: true, force: true }) }
}
test('R3-04 discovery and mapping: each list is a Source on connect; date-only due, status, etag, read-only subtasks', () => tasksStore(async ({ store, fake, sources }) => {
  fake.addTaskList({ id: 'work', title: '工作' }).addTaskList({ id: 'home', title: '家里' })
  const report = fake.addTask('work', { title: '交周报', due: `${day(2)}T15:30:00.000Z`, notes: '外部备注' })
  fake.addTask('work', { title: '周报附件', parent: report.id, due: day(2) })
  fake.addTask('work', { title: '已完成', status: 'completed', due: day(1) })
  fake.addTask('work', { title: '无截止' })
  fake.addTask('work', { title: '早已逾期', due: day(-20) })
  fake.addTask('work', { title: '远期', due: day(40) })
  fake.addTask('work', { title: '无截止已完成', status: 'completed' })
  const listed = await sources()
  assert.deepEqual(listed.map(s => s.title).sort(), ['家里', '工作'].sort())
  for (const s of listed) assert.deepEqual([s.itemType, s.authority, s.authorized, s.readScope, s.readOnly], ['Todo', 'external', true, 'full', false], 'usable on connect, no per-source grant step')
  const work = listed.find(s => s.title === '工作').id
  const result = await store.workspace.queryExternal({ sourceId: work, ...windowOf(-1, 7) })
  assert.equal(result.complete, true); assert.equal(result.provider, 'google-tasks')
  assert.deepEqual(result.items.map(i => i.title).sort(), ['交周报', '周报附件', '已完成', '无截止', '早已逾期'].sort(), 'window, overdue open and undated open tasks')
  const item = result.items.find(i => i.title === '交周报')
  assert.equal(item.due, day(2), 'Google drops the time of day: due is a date'); assert.equal(item.start, undefined); assert.equal(item.end, undefined)
  assert.deepEqual([item.status, item.authority, item.remoteId, item.remoteVersion, item.readOnly, item.version], ['open', 'external', report.id, fake.state.tasks.get('work').get(report.id).etag, false, 1])
  assert.equal(item.providerTask.notes, '外部备注'); assert.ok(Number.isFinite(Date.parse(item.observedAt)))
  assert.equal(result.items.find(i => i.title === '周报附件').readOnly, true, 'subtasks are flat and read-only')
  assert.equal(result.items.find(i => i.title === '已完成').status, 'completed')
  const again = await store.workspace.queryExternal({ sourceId: work, ...windowOf(-1, 7) })
  assert.equal(again.items.find(i => i.title === '交周报').version, 1, 'an unchanged etag does not bump the version')
  const view = await store.getBotConfiguration('calendar')
  assert.deepEqual(view.resourceLabels[`workspace:${work}`], { title: '工作', note: 'Google 任务' }, 'assignable on the Bot page right after connect')
  await assert.rejects(store.workspace.queryExternal({ sourceId: work, ...windowOf(-1, 7), start: '2026-11-01' }), e => e.code === 'WORKSPACE_EXTERNAL_INPUT')
}))

test('R3-04 paging: tasks and lists over several pages are complete', () => tasksStore(async ({ store, sources, fake }) => {
  fake.addTaskList({ id: 'a' }).addTaskList({ id: 'b' }).addTaskList({ id: 'c' })
  for (let i = 0; i < 7; i++) fake.addTask('a', { title: `任务${i}`, due: day(1) })
  const listed = await sources()
  assert.equal(listed.length, 3)
  const result = await store.workspace.queryExternal({ sourceId: listed.find(s => s.title === 'a').id, ...windowOf(0, 3) })
  assert.equal(result.complete, true); assert.equal(result.items.length, 7)
  assert.ok(fake.requests.some(r => r.path === '/tasks/v1/lists/a/tasks' && r.query.pageToken), 'followed nextPageToken')
}, { fake: { pageSize: { tasks: 2 } } }))

async function approved(store, input) {
  const op = await store.workspace.prepareExternal(input)
  assert.equal(op.state, 'awaiting_confirmation', 'the manual HTTP path previews first, like Feishu')
  await store.workspace.confirmExternal({ requestId: input.requestId, payloadHash: op.payloadHash, confirmed: true })
  return store.workspace.executeExternal({ requestId: input.requestId })
}
test('R3-04 writes: create/complete/reopen/update/delete; status maps both ways; due stays a date; read back after write', () => tasksStore(async ({ store, fake, sources, todo }) => {
  fake.addTaskList({ id: 'work', title: '工作' })
  const [{ id: sourceId }] = await sources(), list = fake.state.tasks.get('work')
  const created = await approved(store, { sourceId, requestId: 'w-create', action: 'create', arguments: { title: '订机票', due: day(3), notes: '靠窗' } })
  assert.equal(created.state, 'succeeded'); assert.equal(created.receipt.result.verified, true)
  const taskId = created.receipt.result.taskId, remote = list.get(taskId)
  assert.deepEqual([remote.title, remote.due, remote.status, remote.notes], ['订机票', `${day(3)}T00:00:00.000Z`, 'needsAction', '靠窗'], 'date-only due is sent as UTC midnight')
  let local = await todo(sourceId, taskId)
  assert.deepEqual([local.status, local.due, local.version, local.remoteVersion], ['open', day(3), 1, remote.etag])
  // Pidot → Google: open → completed, with If-Match of the etag that was read, then a read-back GET.
  const before = fake.requests.length
  const done = await approved(store, { sourceId, requestId: 'w-complete', action: 'update', arguments: { taskId, status: 'completed' }, expectedVersion: 1 })
  assert.equal(done.state, 'succeeded')
  const sent = fake.requests.slice(before)
  assert.deepEqual(sent.map(r => r.method), ['GET', 'PATCH', 'GET'], 'etag compare, write, read back')
  assert.equal(sent[1].ifMatch, remote.etag)
  assert.equal(list.get(taskId).status, 'completed')
  local = await todo(sourceId, taskId); assert.deepEqual([local.status, local.version], ['completed', 2])
  // Google → Pidot: reopened in Google maps back to open.
  Object.assign(list.get(taskId), { status: 'needsAction', completed: undefined, etag: '"reopened-in-google"' })
  const read = (await store.workspace.getExternal({ sourceId, taskId })).items[0]
  assert.deepEqual([read.status, read.version, read.remoteVersion], ['open', 3, '"reopened-in-google"'])
  // Completed in Google maps to completed.
  Object.assign(list.get(taskId), { status: 'completed', etag: '"completed-in-google"' })
  assert.equal((await store.workspace.getExternal({ sourceId, taskId })).items[0].status, 'completed')
  // Pidot → Google: completed → open clears Google's completion.
  const reopened = await approved(store, { sourceId, requestId: 'w-reopen', action: 'update', arguments: { taskId, status: 'open', due: day(5) }, expectedVersion: 4 })
  assert.equal(reopened.state, 'succeeded')
  assert.deepEqual([list.get(taskId).status, list.get(taskId).completed, list.get(taskId).due], ['needsAction', undefined, `${day(5)}T00:00:00.000Z`])
  local = await todo(sourceId, taskId); assert.deepEqual([local.status, local.due], ['open', day(5)])
  // A time of day is refused instead of being silently dropped; subtasks are read-only; stale versions conflict.
  await assert.rejects(store.workspace.prepareExternal({ sourceId, requestId: 'w-time', action: 'create', arguments: { title: '带时刻', due: `${day(3)}T09:00:00+08:00` } }), e => e.code === 'WORKSPACE_EXTERNAL_INPUT')
  await assert.rejects(store.workspace.prepareExternal({ sourceId, requestId: 'w-stale', action: 'update', arguments: { taskId, title: 'x' }, expectedVersion: 1 }), e => e.code === 'WORKSPACE_VERSION_CONFLICT')
  const sub = fake.addTask('work', { title: '子任务', parent: taskId })
  await store.workspace.getExternal({ sourceId, taskId: sub.id })
  await assert.rejects(store.workspace.prepareExternal({ sourceId, requestId: 'w-sub', action: 'delete', arguments: { taskId: sub.id }, expectedVersion: 1 }), e => e.code === 'WORKSPACE_EXTERNAL_READ_ONLY')
  // Delete, then the Todo is a tombstone and leaves the window.
  const removed = await approved(store, { sourceId, requestId: 'w-delete', action: 'delete', arguments: { taskId }, expectedVersion: 5 })
  assert.equal(removed.state, 'succeeded'); assert.equal(removed.receipt.result.verified, true)
  assert.equal(list.get(taskId).deleted, true); assert.ok((await todo(sourceId, taskId)).deletedAt)
  assert.ok(!(await store.workspace.queryExternal({ sourceId, ...windowOf(-1, 7) })).items.some(i => i.remoteId === taskId))
  // Same requestId is idempotent and never re-sent.
  const posts = fake.count('/lists/work/tasks', 'POST')
  assert.equal((await store.workspace.executeExternal({ requestId: 'w-create' })).state, 'succeeded'); assert.equal(fake.count('/lists/work/tasks', 'POST'), posts)
}))

test('R3-04 etag change is a conflict: compared before the write, nothing overwritten, cache refreshed', () => tasksStore(async ({ store, fake, sources, todo }) => {
  fake.addTaskList({ id: 'work' })
  const [{ id: sourceId }] = await sources(), task = fake.addTask('work', { title: '原标题', due: day(1) })
  await store.workspace.getExternal({ sourceId, taskId: task.id })
  Object.assign(fake.state.tasks.get('work').get(task.id), { title: '别人改过', etag: '"edited-elsewhere"' })
  const op = await approved(store, { sourceId, requestId: 'c-update', action: 'update', arguments: { taskId: task.id, title: '我的改动' }, expectedVersion: 1 })
  assert.equal(op.state, 'conflict'); assert.equal(op.error.code, 'WORKSPACE_VERSION_CONFLICT'); assert.match(op.error.message, /已被修改/)
  const local = await todo(sourceId, task.id)
  assert.deepEqual([local.title, local.version, local.remoteVersion], ['别人改过', 2, '"edited-elsewhere"'], 'the conflict refreshes the cache to the remote version')
  // The old version is now rejected up front; a delete prepared on v2 conflicts at dispatch after another edit.
  await assert.rejects(store.workspace.prepareExternal({ sourceId, requestId: 'c-old', action: 'delete', arguments: { taskId: task.id }, expectedVersion: 1 }), e => e.code === 'WORKSPACE_VERSION_CONFLICT')
  const pending = await store.workspace.prepareExternal({ sourceId, requestId: 'c-delete', action: 'delete', arguments: { taskId: task.id }, expectedVersion: 2 })
  await store.workspace.confirmExternal({ requestId: 'c-delete', payloadHash: pending.payloadHash, confirmed: true })
  fake.state.tasks.get('work').get(task.id).etag = '"edited-again"'
  assert.equal((await store.workspace.executeExternal({ requestId: 'c-delete' })).state, 'conflict')
  assert.equal(fake.count(`/lists/work/tasks/${task.id}`, 'PATCH') + fake.count(`/lists/work/tasks/${task.id}`, 'DELETE'), 0, 'no write was sent')
  assert.equal(fake.state.tasks.get('work').get(task.id).title, '别人改过'); assert.notEqual(fake.state.tasks.get('work').get(task.id).deleted, true)
}))

// The Tasks API's If-Match support is unverified (README §10). The fake models both: by default it
// ignores If-Match (so only the pre-write compare protects), with tasksIfMatch it answers 412.
for (const honoured of [false, true]) test(`R3-04 race between compare and write: If-Match ${honoured ? 'honoured → 412 conflict, not overwritten' : 'ignored → overwrite (no server CAS; documented)'}`, () => {
  let race = false
  const routes = [{ method: 'GET', path: /^\/tasks\/v1\/lists\/work\/tasks\/[^/]+$/, handler(_req, res, ctx) {
    const id = decodeURIComponent(ctx.url.pathname.split('/').at(-1)), task = ctx.state.tasks.get('work').get(id)
    if (!task || task.deleted) { ctx.json(res, 404, ctx.error(404, 'notFound')); return }
    ctx.json(res, 200, task)
    if (race) { race = false; Object.assign(task, { title: '并发修改', etag: '"raced"' }) } // another writer lands right after our compare
  } }]
  return tasksStore(async ({ store, fake, sources, todo }) => {
    fake.addTaskList({ id: 'work' })
    const [{ id: sourceId }] = await sources(), task = fake.addTask('work', { title: '原标题' })
    await store.workspace.getExternal({ sourceId, taskId: task.id })
    const readEtag = task.etag
    race = true
    const op = await approved(store, { sourceId, requestId: 'race-update', action: 'update', arguments: { taskId: task.id, title: '我的改动' }, expectedVersion: 1 })
    const patch = fake.requests.find(r => r.method === 'PATCH')
    assert.equal(patch.ifMatch, readEtag, 'If-Match carries the etag that was read')
    if (honoured) {
      assert.equal(op.state, 'conflict'); assert.equal(op.error.code, 'GOOGLE_PRECONDITION')
      assert.equal(fake.state.tasks.get('work').get(task.id).title, '并发修改', 'the other writer is not overwritten')
      assert.equal((await todo(sourceId, task.id)).remoteVersion, '"raced"')
    } else {
      assert.equal(op.state, 'succeeded'); assert.equal(fake.state.tasks.get('work').get(task.id).title, '我的改动')
    }
  }, { fake: { tasksIfMatch: honoured, routes } })
})

test('R3-04 unknown create: response lost → found by title + creation window; not applied → unknown, never recreated', () => tasksStore(async ({ store, fake, sources, advance }) => {
  fake.addTaskList({ id: 'work' })
  const [{ id: sourceId }] = await sources(), list = fake.state.tasks.get('work'), posts = () => fake.count('/lists/work/tasks', 'POST')
  fake.addTask('work', { title: '买牛奶' }) // a same-title task that already existed and was read
  await store.workspace.queryExternal({ sourceId, ...windowOf(0, 1) })
  // A. Google created it, then the connection dropped before the response arrived.
  fake.fail({ method: 'POST', path: '/lists/work/tasks', after: true, disconnect: true })
  const lost = await approved(store, { sourceId, requestId: 'u-lost', action: 'create', arguments: { title: '买牛奶' } })
  assert.equal(lost.state, 'succeeded'); assert.equal(lost.receipt.result.resolvedBy, 'lookup')
  assert.equal([...list.values()].filter(t => t.title === '买牛奶').length, 2, 'the pre-existing task is not mistaken for ours; no third copy')
  assert.equal(posts(), 1)
  // B. The request never took effect: no candidate → unknown, and nothing is re-sent.
  fake.fail({ method: 'POST', path: '/lists/work/tasks', disconnect: true })
  const unknown = await approved(store, { sourceId, requestId: 'u-none', action: 'create', arguments: { title: '交水费', due: day(2) } })
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.error.code, 'WORKSPACE_EXTERNAL_UNKNOWN'); assert.equal(unknown.receipt.result.candidates, 0)
  assert.equal(posts(), 2)
  assert.equal((await store.workspace.executeExternal({ requestId: 'u-none' })).state, 'unknown'); assert.equal(posts(), 2, 'same requestId: no re-dispatch')
  await assert.rejects(store.workspace.prepareExternal({ sourceId, requestId: 'u-retry', action: 'create', arguments: { title: '交水费', due: day(2) } }), e => e.code === 'WORKSPACE_EXTERNAL_LOCKED', 'a new requestId for the same title is locked')
  assert.equal((await approved(store, { sourceId, requestId: 'u-other', action: 'create', arguments: { title: '别的事' } })).state, 'succeeded', 'other titles are not blocked')
  assert.equal([...list.values()].filter(t => t.title === '交水费').length, 0)
  // The lock lapses after the window; the unknown Operation itself stays unknown.
  advance(11 * 60000)
  assert.equal((await store.workspace.prepareExternal({ sourceId, requestId: 'u-later', action: 'create', arguments: { title: '交水费', due: day(2) } })).state, 'awaiting_confirmation')
  assert.equal((await store.workspace.getExternalOperation({ requestId: 'u-none' })).state, 'unknown')
}))

test('R3-04 unknown create settled by a later complete scan, without re-sending', () => tasksStore(async ({ store, fake, sources }) => {
  fake.addTaskList({ id: 'work' })
  const [{ id: sourceId }] = await sources()
  fake.fail({ method: 'POST', path: '/lists/work/tasks', after: true, status: 503 })
  fake.fail({ method: 'GET', path: /\/lists\/work\/tasks$/, times: 2, status: 503 }) // the immediate lookup fails too
  const op = await approved(store, { sourceId, requestId: 's-create', action: 'create', arguments: { title: '续签合同' } })
  assert.equal(op.state, 'unknown')
  await store.workspace.queryExternal({ sourceId, ...windowOf(0, 1) })
  const settled = await store.workspace.getExternalOperation({ requestId: 's-create' })
  assert.equal(settled.state, 'succeeded'); assert.equal(settled.receipt.result.resolvedBy, 'later-scan'); assert.equal(settled.error, undefined)
  assert.equal(fake.count('/lists/work/tasks', 'POST'), 1)
  assert.equal([...fake.state.tasks.get('work').values()].filter(t => t.title === '续签合同').length, 1)
}))

async function assign(store, botId, resources) {
  const { bot } = await store.getBotConfiguration(botId)
  await store.updateBotConfiguration(botId, { requestId: `r3-04-${Math.random().toString(36).slice(2, 10)}`, expectedVersion: bot.configRef.version, description: 'R3-04', tools: WORKSPACE_TOOLS, resources })
}
const readable = (store, sourceId) => store.harness.commit(tx => workspaceSourceReadable(tx, 'calendar', sourceId), context)
const resourcesOf = async store => Object.values((await store.harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(ToolAccess))), context)).assignments).flatMap(a => a.resources)
test('R3-04 revoked access makes the source invisible: disconnect, invalid_grant, lost scope, deleted list', () => tasksStore(async ({ store, fake, sources, connect, google, advance }) => {
  fake.addTaskList({ id: 'work', title: '工作' }).addTaskList({ id: 'home', title: '家里' })
  const task = fake.addTask('work', { title: '机密任务', due: day(1) })
  const listed = await sources(), sourceId = listed.find(s => s.title === '工作').id, home = listed.find(s => s.title === '家里').id
  await assign(store, 'calendar', ['workspace:local', `workspace:${sourceId}`, `workspace:${home}`])
  await store.workspace.queryExternal({ sourceId, ...windowOf(0, 2) })
  assert.equal(await readable(store, sourceId), true)
  await assert.rejects(store.workspace.query({ sourceId, type: 'Todo' }), e => e.code === 'WORKSPACE_LOCAL_ONLY', 'the local entry never serves the external cache')
  // 1. Disconnect: no source, no cache, no Bot resource.
  await store.googleDisconnect({})
  assert.deepEqual(await sources(), [])
  for (const call of [store.workspace.queryExternal({ sourceId, ...windowOf(0, 2) }), store.workspace.getExternal({ sourceId, taskId: task.id }), store.workspace.prepareExternal({ sourceId, requestId: 'r-after', action: 'create', arguments: { title: 'x' } })])
    await assert.rejects(call, e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
  assert.equal(await readable(store, sourceId), false)
  assert.ok(!(await resourcesOf(store)).some(r => r.startsWith('workspace:google-tasks:')), 'removed from every Bot')
  // Reconnecting the same account: same source id, new authEpoch; schedule-enabled Bots regain sources unless narrowed.
  await connect()
  assert.equal((await sources()).find(s => s.title === '工作').id, sourceId)
  assert.equal((await store.workspace.queryExternal({ sourceId, ...windowOf(0, 2) })).items[0].title, '机密任务')
  assert.equal(await readable(store, sourceId), true, 'reconnect restores sources for schedule-enabled Bots')
  // 2. invalid_grant: the mirror goes needs_auth and the source disappears.
  fake.revokeAll(); google.rejectToken(await google.accessToken())
  await assert.rejects(store.workspace.queryExternal({ sourceId, ...windowOf(0, 2) }), e => ['GOOGLE_NEEDS_AUTH', 'WORKSPACE_EXTERNAL_REVOKED'].includes(e.code))
  for (let i = 0; i < 50 && (await store.harness.commit(async tx => (await tx.doc(GoogleAccount)).status, context)) !== 'needs_auth'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(await sources(), [])
  await assert.rejects(store.workspace.getExternal({ sourceId, taskId: task.id }), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
  // 3. Reconnect granting Calendar only: Tasks sources stay invisible.
  fake.setGrant({ scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'] })
  await connect(['calendar', 'tasks'])
  assert.deepEqual(await sources(), [])
  await assert.rejects(store.workspace.queryExternal({ sourceId, ...windowOf(0, 2) }), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
  // 4. A list deleted in Google retires its Source on the next discovery.
  fake.setGrant({ scopes: null }); await connect()
  assert.equal((await sources()).length, 2)
  await assign(store, 'calendar', ['workspace:local', `workspace:${sourceId}`, `workspace:${home}`])
  fake.state.taskLists.delete('home'); advance(6 * 60000)
  assert.deepEqual((await sources()).map(s => s.title), ['工作'])
  await assert.rejects(store.workspace.queryExternal({ sourceId: home, ...windowOf(0, 2) }), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
  assert.deepEqual((await resourcesOf(store)).filter(r => r.startsWith('workspace:google-tasks:')), [`workspace:${sourceId}`], 'only the deleted list left the Bot')
}))

test('R3-04 reminders on external Todo: explicit time only, fresh Google read before delivery, completed/deleted suppress', () => tasksStore(async ({ store, fake, sources, clock, advance }) => {
  fake.addTaskList({ id: 'work' })
  const [{ id: sourceId }] = await sources(), list = fake.state.tasks.get('work')
  const tasks = Object.fromEntries(['提交材料', '已在Google完成', '已在Google删除'].map(title => [title, fake.addTask('work', { title, due: day(2) })]))
  fake.addTask('work', { title: '没有截止' })
  const items = (await store.workspace.queryExternal({ sourceId, ...windowOf(0, 3) })).items, of = title => items.find(i => i.title === title)
  const remind = (title, extra) => store.workspaceReminders.manage({ requestId: `rem-${payloadHash(title).slice(0, 12)}-${Object.keys(extra)[0]}`, command: 'create', targetRef: { type: 'Todo', sourceId, id: of(title).id }, targetVersion: of(title).version, channel: 'inbox', confirmed: true, ...extra })
  const when = new Date(clock() + 3600000).toISOString()
  await assert.rejects(remind('提交材料', { offset: -600 }), e => e.code === 'WORKSPACE_REMINDER_BASE', 'a date-only due has no instant; no invented midnight')
  await assert.rejects(remind('没有截止', { at: when }), e => e.code === 'WORKSPACE_REMINDER_BASE')
  await assert.rejects(store.workspaceReminders.manage({ requestId: 'rem-wrong-type', command: 'create', targetRef: { type: 'Event', sourceId, id: of('提交材料').id }, targetVersion: 1, at: when, channel: 'inbox', confirmed: true }), e => e.code === 'WORKSPACE_REMINDER_TARGET')
  for (const title of Object.keys(tasks)) assert.equal((await remind(title, { at: when })).state, 'succeeded')
  Object.assign(list.get(tasks['已在Google完成'].id), { status: 'completed', etag: '"done-in-google"' })
  list.get(tasks['已在Google删除'].id).deleted = true
  advance(3600000 + 1000)
  const gets = fake.requests.length
  await store.workspaceScheduler.tick()
  assert.equal(fake.requests.slice(gets).filter(r => r.method === 'GET' && /\/lists\/work\/tasks\/[^/]+$/.test(r.path)).length, 3, 'each delivery is preceded by an exact Google read')
  const listed = await store.workspaceReminders.list({})
  assert.deepEqual(listed.items.map(n => n.title), ['提交材料'], 'only the live open task is delivered to the inbox')
  const reasonOf = title => listed.reminders.find(r => r.targetRef.id === of(title).id).reason
  assert.equal(reasonOf('已在Google完成'), 'target_completed'); assert.equal(reasonOf('已在Google删除'), 'target_deleted')
  assert.equal(fake.count('/lists/work/tasks', 'POST'), 0); assert.equal(fake.requests.filter(r => ['PATCH', 'DELETE'].includes(r.method)).length, 0, 'reminders never write to Google')
  // After disconnect the reminder history is redacted.
  await store.googleDisconnect({})
  const redacted = await store.workspaceReminders.list({})
  assert.ok(redacted.items.every(n => n.redacted)); assert.ok(!JSON.stringify(redacted).includes('提交材料'))
}))

test('R3-04 background sync: rescans, records changes and deletions, stops on revoke', () => tasksStore(async ({ store, fake, sources, todo, repo }) => {
  fake.addTaskList({ id: 'work' })
  const [{ id: sourceId }] = await sources(), a = fake.addTask('work', { title: '甲', due: day(3) }), b = fake.addTask('work', { title: '乙' })
  await store.workspace.configureSync({ sourceId, enabled: true, expectedRevision: 0, confirmed: true })
  let status = await store.workspace.refreshSync({ sourceId, confirmed: true })
  assert.equal(status.runState, 'idle'); assert.equal(status.windows.length, 2); assert.ok(status.windows.every(w => w.coverage.complete))
  assert.equal((await todo(sourceId, a.id)).version, 1); assert.equal((await todo(sourceId, b.id)).version, 1)
  Object.assign(fake.state.tasks.get('work').get(a.id), { title: '甲（已改）', etag: '"edited"' })
  fake.state.tasks.get('work').get(b.id).deleted = true
  status = await store.workspace.refreshSync({ sourceId, confirmed: true })
  assert.equal(status.runState, 'idle')
  assert.deepEqual([(await todo(sourceId, a.id)).title, (await todo(sourceId, a.id)).version], ['甲（已改）', 2])
  assert.ok((await todo(sourceId, b.id)).deletedAt, 'a task gone from a complete scan becomes a tombstone')
  const outbox = await store.harness.commit(async tx => (await repo().list(tx, 'Outbox', LOCAL_OWNER, sourceId)).items.map(o => o.targetRef.kind).sort(), context)
  assert.deepEqual(outbox, ['appeared', 'appeared', 'deleted', 'updated'])
  assert.equal(fake.requests.filter(r => r.method !== 'GET' && r.path.startsWith('/tasks/')).length, 0, 'sync is read-only')
  await store.googleDisconnect({})
  await assert.rejects(store.workspace.syncStatus({ sourceId }), e => e.code === 'WORKSPACE_EXTERNAL_REVOKED')
}))

async function mcpClient(store, token) {
  const { MCP_VERSION } = await import('./workspace-mcp-protocol.mjs')
  let sessionId, id = 1
  const send = async message => { const data = await store.workspaceMcpMessage(token, sessionId, message); sessionId = data.sessionId; return data.message }
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_VERSION, clientInfo: { name: 'r3-04', version: '1' }, capabilities: {} } })
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return async (name, args) => { const r = await send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }); return r.result.isError ? { error: JSON.parse(r.result.content[0].text).error } : r.result.structuredContent.data }
}
test('R3-04 Agent path: list/get/complete run directly with the group on (D4); a Todo ask rule waits; Event rules do not apply', () => tasksStore(async ({ store, fake, sources }) => {
  fake.addTaskList({ id: 'work', title: '工作' })
  const task = fake.addTask('work', { title: '回电话', due: day(1) })
  const [{ id: sourceId }] = await sources()
  await assign(store, 'calendar', [`workspace:${sourceId}`])
  const credential = await store.workspaceAgent.issueClient({ sourceId, botId: 'calendar', actions: ['read', 'create', 'update', 'delete'], readScope: 'full', ttlSeconds: 600, confirmed: true })
  const call = await mcpClient(store, credential.token)
  const listed = await call('workspace.list', { sourceId, type: 'Todo', ...windowOf(0, 2) })
  assert.deepEqual(listed.items.map(i => [i.title, i.due, i.status]), [['回电话', day(1), 'open']])
  assert.equal((await call('workspace.list', { sourceId, type: 'Event', ...windowOf(0, 2) })).error.code, 'WORKSPACE_INPUT')
  const got = (await call('workspace.get', { sourceId, type: 'Todo', taskId: task.id })).items[0]
  const done = await call('workspace.prepare_change', { sourceId, requestId: 'agent-complete', action: 'update', change: { arguments: { taskId: task.id, status: 'completed' }, expectedVersion: got.version } })
  assert.equal(done.state, 'succeeded'); assert.equal(done.external.autoApproved, true, 'no confirmation step with the group on')
  assert.equal(fake.state.tasks.get('work').get(task.id).status, 'completed')
  assert.equal((await call('workspace.operation_status', { sourceId, requestId: 'agent-complete' })).state, 'succeeded')
  await store.harness.commit(tx => addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', type: 'Event' }, effect: 'ask' }), context)
  assert.equal((await call('workspace.prepare_change', { sourceId, requestId: 'agent-event-rule', action: 'create', change: { arguments: { title: '不受日程规则影响' } } })).state, 'succeeded')
  await store.harness.commit(tx => addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', type: 'Todo' }, effect: 'ask' }), context)
  const asked = await call('workspace.prepare_change', { sourceId, requestId: 'agent-ask', action: 'create', change: { arguments: { title: '先问我' } } })
  assert.equal(asked.state, 'awaiting_confirmation'); assert.ok(![...fake.state.tasks.get('work').values()].some(t => t.title === '先问我'))
}))

test('R3-04 restart: an interrupted dispatch becomes unknown and is never re-sent', () => tasksStore(async ({ store, fake, sources, repo, restart }) => {
  fake.addTaskList({ id: 'work' })
  const [{ id: sourceId }] = await sources()
  const op = await store.workspace.prepareExternal({ sourceId, requestId: 'crash-create', action: 'create', arguments: { title: '断电前' } })
  await store.workspace.confirmExternal({ requestId: 'crash-create', payloadHash: op.payloadHash, confirmed: true })
  // Simulate a crash right after the dispatching commit (the request may or may not have reached Google).
  await store.harness.commit(async tx => { const r = repo(), o = await r.get(tx, 'Operation', LOCAL_OWNER, 'operations', op.id); await r.put(tx, 'Operation', { ...o, state: 'dispatching', external: { ...o.external, invocation: 'lost', dispatchedAt: new Date().toISOString() } }) }, context)
  const reopened = await restart()
  const after = await reopened.workspace.getExternalOperation({ requestId: 'crash-create' })
  assert.equal(after.state, 'unknown')
  assert.equal((await reopened.workspace.executeExternal({ requestId: 'crash-create' })).state, 'unknown')
  assert.equal(fake.count('/lists/work/tasks', 'POST'), 0)
}))
