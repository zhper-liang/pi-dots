import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'
import { listBots } from './bots.mjs'
import { detect, applyDetection, Findings } from './detectors.mjs'
import { DetectorDirty } from './detector-state.mjs'

// PLAN §8.2 detectors (phase 2). IDs follow T2-01..T2-10; D-06..D-08 per PLAN §11.
const H = 3600000, D = 24 * H, now = Date.parse('2026-10-23T02:00:00Z') // 10:00 Asia/Shanghai
const iso = t => new Date(t).toISOString()
const ev = (id, start, end, extra = {}) => ({ sourceId: 'local', id, version: 1, title: id, start: iso(start), end: iso(end), ...extra })
const todo = (id, due, extra = {}) => ({ sourceId: 'local', id, version: 1, title: id, status: 'open', due, deletedAt: null, ...extra })
const empty = { events: [], todos: [], links: [], pending: [], incomplete: [] }
const ids = (r, detector) => r.findings.filter(f => f.detector === detector).map(f => f.refs.map(x => x.id).join('+'))
const fakeTx = () => { const docs = new Map(); return { async doc(token) { const k = token.definition.kind; if (!docs.has(k)) docs.set(k, token.definition.initial()); return docs.get(k) } } }
const modelConfig = { baseUrl: 'https://fixture.invalid/v1', model: 'detector-fixture', apiKey: 'fixture-only' }
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-detect-')), file = join(dir, 'isolated.sqlite'), clock = { time: now }, calls = { n: 0 }
  let s
  const open = () => openTaskStore({ file, bots: listBots(modelConfig), modelReply: async () => { calls.n++; return { mode: 'model', reply: { content: '好的' }, execution: { usage: { totalTokens: 1 } } } }, detectorOptions: { now: () => clock.time } })
  try {
    s = await open()
    await fn({ s, clock, calls, file, reopen: async () => { await s.close(); s = await open(); return s } })
  } finally { await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
let seq = 0
const addTodo = (s, title, due) => s.workspace.executeLocal({ requestId: `detect-todo-${++seq}`, sourceId: 'local', type: 'Todo', action: 'create', data: { title, due } })
const chiefCards = async s => (await s.get((await s.mainSessions()).chief)).messages.filter(m => m.systemKind === 'finding')

test('T2-01 the change marker is written in the same transaction as the local write; a rolled-back write leaves none', () => fixture(async ({ s, file, reopen }) => {
  const before = (await s.harness.snapshot(DetectorDirty, undefined, context))?.revision ?? 0 // created by the first write
  const made = await addTodo(s, '标记', null)
  const dirty = await s.harness.snapshot(DetectorDirty, undefined, context)
  assert.equal(dirty.revision, before + 1); assert.deepEqual([dirty.items.at(-1).type, dirty.items.at(-1).id], ['Todo', made.receipt.target.id])
  const db = new DatabaseSync(file)
  db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON documents WHEN json_extract(NEW.record, '$.kind') = 'pidot.workspace.Outbox' BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END")
  await assert.rejects(addTodo(s, '回滚', null))
  await s.close(); db.exec('DROP TRIGGER fail_outbox'); db.close() // same pattern as tasks.test.mjs SQLite failure test
  const reopened = await reopen()
  assert.equal((await reopened.harness.snapshot(DetectorDirty, undefined, context)).revision, before + 1)
  assert.equal((await reopened.workspace.query({ sourceId: 'local', type: 'Todo' })).items.length, 1) // the failed Todo is absent too
}))
test('T2-02 conflict: overlap, touching ends, 7-day boundary, busy-only source, all-day excluded, incomplete source noted', () => {
  const events = [ev('A', now + H, now + 2 * H), ev('B', now + 1.5 * H, now + 3 * H), ev('C', now + 3 * H, now + 4 * H), ev('F', now + 3.5 * H, now + 3.75 * H, { sourceId: 'feishu:x', busyOnly: true }),
    ev('J', now - 2 * H, now + 22 * H), ev('Hh', now + 7 * D - H, now + 7 * D + H), ev('I', now + 7 * D - 0.5 * H, now + 7 * D + 2 * H), ev('G', now + 7 * D + H, now + 7 * D + 2 * H), ev('K', now + 8 * D, now + 8 * D + H)]
  const r = detect({ ...empty, events: [...events, ev('L', now + 7 * D + 1.5 * H, now + 7 * D + 3 * H)], incomplete: ['飞书日历'] }, now)
  assert.deepEqual(ids(r, 'conflict').sort(), ['A+B', 'C+F', 'Hh+I'])
  assert.match(r.findings.find(f => f.refs[1].id === 'F').summary, /「C」与「忙碌」/); assert.match(r.findings[0].summary, /飞书日历 数据不全，未参与/)
  assert.equal(r.wakeAt, Date.parse(events[7].start) - 7 * D) // G enters the 7-day window
})
test('T2-03 overdue: past date or instant, or due today with under 30 minutes of free time left', () => {
  const todos = [todo('past-date', '2026-10-22'), todo('past-instant', iso(now - H)), todo('later-today', '2026-10-23'), todo('soon', iso(now + 20 * 60000)), todo('busy-due', iso(now + 2 * H)), todo('done', '2026-10-01', { status: 'completed' })]
  const r = detect({ ...empty, todos, events: [ev('block', now, now + 105 * 60000)] }, now)
  assert.deepEqual(ids(r, 'overdue').sort(), ['busy-due', 'past-date', 'past-instant', 'soon'])
})
test('T2-04 unprepared only counts explicit ItemLink links within 12 hours', () => {
  const link = (t, e) => ({ todoRef: { sourceId: 'local', id: t }, eventRef: { sourceId: 'local', id: e } })
  const r = detect({ ...empty, events: [ev('E', now + 3 * H, now + 4 * H), ev('E2', now + 3 * H, now + 4 * H), ev('E3', now + 5 * H, now + 6 * H), ev('E4', now + 13 * H, now + 14 * H)],
    todos: [todo('T1', null), todo('E2', null), todo('T3', null, { status: 'completed' }), todo('T4', null)], links: [link('T1', 'E'), link('T3', 'E3'), link('T4', 'E4')] }, now)
  assert.deepEqual(ids(r, 'unprepared'), ['E+T1'])
  assert.equal(r.wakeAt, now + H) // E4 enters the 12-hour window
})
test('T2-05 one notice per object version; a version change silently resolves the old finding and re-judges', async () => {
  const tx = fakeTx(), v1 = detect({ ...empty, todos: [todo('t', '2026-10-01')] }, now), v2 = detect({ ...empty, todos: [todo('t', '2026-10-01', { version: 2 })] }, now)
  assert.equal((await applyDetection(tx, v1, now)).length, 1); assert.equal((await applyDetection(tx, v1, now + 1000)).length, 0)
  assert.equal((await applyDetection(tx, v2, now + 2000)).length, 1)
  assert.deepEqual((await tx.doc(Findings)).items.map(f => f.state), ['resolved', 'open'])
})
test('T2-06 night goes to the inbox only; from the 11th a day it is deferred into the next summary; the summary runs once a day', async () => {
  const tx = fakeTx(), many = n => detect({ ...empty, todos: Array.from({ length: n }, (_, i) => todo(`t${i}`, '2026-10-01')) }, now)
  const day1 = await applyDetection(tx, many(11), now)
  assert.equal(day1.length, 10); assert.equal((await tx.doc(Findings)).items.filter(f => f.state === 'deferred').length, 1)
  assert.equal((await applyDetection(tx, many(11), now + H)).length, 0)
  const day2 = await applyDetection(tx, many(11), now + D)
  assert.deepEqual(day2.map(f => f.detector), ['summary']); assert.match(day2[0].lines.join(), /t10/)
  assert.equal((await applyDetection(tx, many(11), now + D + H)).length, 0)
  assert.equal((await tx.doc(Findings)).daily['2026-10-24'] ?? 0, 0) // the summary card is not counted
  const night = now + D + 13 * H // 23:00
  assert.equal((await applyDetection(tx, many(12), night)).length, 0)
  assert.equal((await tx.doc(Findings)).items.find(f => f.refs[0]?.id === 't11').delivery, 'inbox')
})
test('T2-07 follow-up: a user-pending item after 4 hours, once per object version', async () => {
  const p = { kind: 'Blocker', taskId: 7, id: 3, version: 1, createdAt: iso(now - 4 * H + 60000), summary: '在等你补充' }
  const early = detect({ ...empty, pending: [p] }, now)
  assert.equal(ids(early, 'followup').length, 0); assert.equal(early.wakeAt, Date.parse(p.createdAt) + 4 * H)
  const tx = fakeTx(), late = detect({ ...empty, pending: [p] }, now + 60000)
  assert.deepEqual(ids(late, 'followup'), ['3']); assert.equal(late.findings[0].taskId, 7)
  assert.equal((await applyDetection(tx, late, now + 60000)).length, 1); assert.equal((await applyDetection(tx, late, now + 2 * H)).length, 0)
})
test('T2-08 with no data change, the wake time still delivers overdue reminders to Chief\'s main session', () => fixture(async ({ s, clock }) => {
  const T = Date.parse('2026-10-23T04:00:00Z')
  await addTodo(s, '交周报', iso(T))
  clock.time = T - H
  const first = await s.detectorWorker.tick()
  assert.equal(first.delivered, 0); assert.ok(first.wakeAt > clock.time && first.wakeAt <= T)
  clock.time = T + 1000
  assert.equal((await s.detectorWorker.tick()).delivered, 1)
  assert.match((await chiefCards(s)).at(-1).content, /交周报/)
  assert.equal((await s.inbox()).items.filter(i => i.kind === 'finding').length, 1)
}))
test('T2-09 detection never calls a model or reads conversation text', () => fixture(async ({ s, calls }) => {
  await addTodo(s, '过期待办', '2026-10-01'); await s.detectorWorker.tick()
  assert.ok((await chiefCards(s)).length >= 1); assert.equal(calls.n, 0)
  for (const f of ['detectors.mjs', 'detector-state.mjs']) { const src = await readFile(new URL(f, import.meta.url), 'utf8'); for (const banned of ['scanEntries', 'tx.entry(', 'modelReply', 'conversation']) assert.ok(!src.includes(banned), `${f}: ${banned}`) }
}))
test('T2-10 handle derives a Task in Chief\'s main session; dismiss and mute stop reminders; mute is restorable', () => fixture(async ({ s }) => {
  await addTodo(s, '甲', '2026-10-01'); await addTodo(s, '乙', '2026-10-01')
  assert.equal((await s.detectorWorker.tick()).delivered, 3) // two findings + the day's summary
  const [a, b] = (await s.findings.list()).items.filter(f => f.detector === 'overdue')
  const handled = await s.findings.act({ id: a.id, action: 'handle' })
  const child = await s.get(handled.taskId)
  assert.equal(child.mainParent.mainTaskId, (await s.mainSessions()).chief); assert.match(child.taskState.goal, /处理这条发现/)
  assert.equal((await s.findings.act({ id: a.id, action: 'handle' })).taskId, handled.taskId) // idempotent
  await s.findings.act({ id: b.id, action: 'dismiss' })
  assert.equal((await s.detectorWorker.tick()).delivered, 0)
  await s.findings.act({ id: b.id, action: 'mute' }); await addTodo(s, '丙', '2026-10-01')
  assert.equal((await s.detectorWorker.tick()).delivered, 0); assert.deepEqual((await s.findings.list()).muted, ['overdue'])
  await s.findings.act({ action: 'unmute', detector: 'overdue' }); await addTodo(s, '丁', '2026-10-01')
  assert.equal((await s.detectorWorker.tick()).delivered, 1)
  await assert.rejects(s.findings.act({ action: 'explode' }), { code: 'INVALID_FINDING_ACTION' })
  const server = createApiServer({ tasks: s, token: 'detect-token' }); await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/findings`
    assert.equal((await fetch(url)).status, 401); assert.equal((await fetch(url, { headers: { Authorization: 'Bearer detect-token' } })).status, 200)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
}))
