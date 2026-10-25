import test from 'node:test'
import assert from 'node:assert/strict'
import { applicationAvailability, localDateBoundary } from './feishu-availability.mjs'
import { validFeishuArgs, createFeishuClient, FEISHU_TOOLS } from './feishu-calendar.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const start = '2026-10-20T00:00:00+08:00', end = '2026-10-21T00:00:00+08:00', origin = Date.parse(start)
const iso = h => new Date(origin + h * 3600000).toISOString()
const event = (s, e, extra = {}) => ({ start: { timestamp: (origin + s * 3600000) / 1000 }, end: { timestamp: (origin + e * 3600000) / 1000 }, status: 'confirmed', freeBusyStatus: 'busy', ...extra })
const schedule = (events, extra = {}) => ({ start, end, timezone: 'Asia/Shanghai', source: { provider: 'feishu', resource: `feishu:${'a'.repeat(64)}` }, complete: true, coverage: 'expanded-instance-view', events, ...extra })
const calc = events => applicationAvailability(schedule(events), { durationMinutes: 60 }, '2026-10-19T00:00:00Z')
test('merge overlap adjacent containment cross-midnight clipping and zero length with exact complement', () => {
 const r = calc([event(10, 11), event(-2, 1), event(1, 2), event(1.5, 3), event(2, 2.5), event(24, 27), event(4, 4), event(23, 26)])
 assert.deepEqual(r.busy, [[0, 3], [10, 11], [23, 24]].map(([s, e]) => ({ start: iso(s), end: iso(e) })))
 assert.deepEqual(r.free, [[3, 10], [11, 23]].map(([s, e]) => ({ start: iso(s), end: iso(e) })))
 assert.deepEqual(r.suggestions, [[3, 4], [11, 12]].map(([s, e]) => ({ start: iso(s), end: iso(e) })))
 assert.equal(r.collectedAt, '2026-10-19T00:00:00Z'); assert.equal(r.scope, 'selected-application-calendar-only')
})
test('cancelled recurring exception and transparent instance cannot block; no text leaks', () => {
 const r = calc([event(1, 2, { status: 'cancelled', recurringEventId: 'series' }), event(3, 4, { isFree: true, title: 'private-title', description: 'secret' }), event(5, 6, { recurringEventId: 'series', isException: true })])
 assert.deepEqual(r.busy, [{ start: iso(5), end: iso(6) }]); assert(!JSON.stringify(r).includes('private-title')); assert(!JSON.stringify(r).includes('series'))
})
for (const date of ['2026-03-08', '2026-11-01']) test(`all-day DST local dates ${date} are not fixed 24h`, () => {
 const last = date === '2026-03-08' ? '2026-03-09' : '2026-11-02'
 const s = localDateBoundary(date, 'America/New_York'), e = localDateBoundary(last, 'America/New_York')
 assert.equal((e - s) / 3600000, date.includes('03-08') ? 23 : 25)
 const r = applicationAvailability(schedule([{ ...event(0, 1), allDay: true, start: { date, timezone: 'America/New_York' }, end: { date: last, timezone: 'America/New_York' } }], { start: new Date(s).toISOString(), end: new Date(e).toISOString() }))
 assert.equal(r.free.length, 0); assert.equal(r.complete, true)
})
test('nonexistent local date and ambiguous midnight fail closed', () => {
 assert.throws(() => localDateBoundary('2011-12-30', 'Pacific/Apia')); assert.throws(() => localDateBoundary('2026-02-30', 'UTC')); assert.throws(() => localDateBoundary('2020-11-01', 'America/Havana'))
})
for (const extra of [{ complete: false, incompleteReason: 'page-failure' }, { coverage: 'list-only' }]) test(`incomplete ${JSON.stringify(extra)} never returns free or suggestions`, () => { const r = applicationAvailability(schedule([], extra), { durationMinutes: 30 }); assert.equal(r.free, null); assert.equal(r.suggestions, null); assert.equal(r.complete, false) })
for (const e of [event(1, 2, { status: 'unknown' }), event(1, 2, { freeBusyStatus: 'tentative' }), event(1, 2, { allDay: true, start: { date: '2011-12-30', timezone: 'Pacific/Apia' }, end: { date: '2011-12-31', timezone: 'Pacific/Apia' } })]) test('unknown event semantics prohibit availability', () => { const r = calc([e]); assert.equal(r.free, null); assert.equal(r.complete, false) })
test('empty complete range all free and dense inputs deterministic', () => { assert.deepEqual(calc([]).free, [{ start: iso(0), end: iso(24) }]); const events = Array.from({ length: 10000 }, (_, i) => event(i / 1000, i / 1000 + 1)); assert.equal(calc(events).busy.length, 1); assert.deepEqual(calc(events), calc(events.reverse())) })
test('arguments default timezone and reject DST gaps offset mismatch excessive duration and empty range', () => {
 const resource = `feishu:${'a'.repeat(64)}`, args = { resource, start, end }
 assert(validFeishuArgs(FEISHU_TOOLS[2], args)); assert(!validFeishuArgs(FEISHU_TOOLS[2], { ...args, start: end })); assert(!validFeishuArgs(FEISHU_TOOLS[2], { ...args, durationMinutes: 0 })); assert(!validFeishuArgs(FEISHU_TOOLS[2], { ...args, timezone: 'America/New_York' }));
 assert(!validFeishuArgs(FEISHU_TOOLS[2], { resource, start: '2026-03-08T02:30:00-05:00', end: '2026-03-08T04:30:00-04:00', timezone: 'America/New_York' }));
 for (const offset of ['-04:00', '-05:00']) assert(validFeishuArgs(FEISHU_TOOLS[2], { resource, start: `2026-11-01T01:30:00${offset}`, end: '2026-11-01T03:30:00-05:00', timezone: 'America/New_York' }))
})
let seq = 0
async function fixture(t, read) {
 const dir = await mkdtemp(join(tmpdir(), 'pidot-freebusy-')), file = join(dir, 'test.sqlite'), urls = []
 const response = data => new Response(JSON.stringify({ code: 0, data }))
 const client = createFeishuClient({ env: { FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'secret' }, fetchImpl: async (url, init) => { urls.push({ url, method: init.method }); if (url.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'secret-token', expire: 1000 })); assert.equal(init.method, 'GET'); if (url.includes('/events/instance_view')) return read(url, response); return response({ calendar_id: 'fixture-calendar', summary: 'Pidot-test-fixture', role: 'owner', type: 'shared' }) } })
 const stores = [], open = async () => { const s = await openTaskStore({ file, feishuClient: client }); stores.push(s); return s }
 t.after(async () => { for (const s of stores) await s.close(); await rm(dir, { recursive: true, force: true }) })
 const s = await open(), binding = await s.feishuCalendar.manage({ action: 'bind', calendarId: 'fixture-calendar', confirm: true }), resource = binding.resource
 await s.updateCapabilityPool({ requestId: `availability-pool-${++seq}`, operation: 'grant', tools: FEISHU_TOOLS, resources: [resource] }); const { bot } = await s.getBotConfiguration('calendar'); await s.updateBotConfiguration('calendar', { requestId: `availability-bot-${++seq}`, expectedVersion: bot.configRef.version, description: '应用忙闲', tools: FEISHU_TOOLS, resources: [resource] }); const task = await s.create({ botId: 'calendar' })
 const input = { taskId: task.taskId, name: FEISHU_TOOLS[2], arguments: { resource, start, end } }
 return { s, open, input, urls, resource, task }
}
const raw = (id = 'fixture-event') => ({ event_id: id, summary: 'NEVER-LEAK', start_time: { timestamp: String((origin + 3600000) / 1000) }, end_time: { timestamp: String((origin + 7200000) / 1000) }, status: 'confirmed', free_busy_status: 'busy', recurring_event_id: 'series' })
test('provider expanded slices deduplicate boundary instances and preserve source, requery timestamp and no writes', async t => {
 const { s, input, urls } = await fixture(t, (_u, r) => r({ items: [raw()] })); input.arguments.end = '2026-10-22T00:00:00+08:00';
 const a = await s.readFeishuCalendar(input), b = await s.readFeishuCalendar(input); assert.equal(a.busy.length, 1); assert.equal(a.complete, true); assert(Date.parse(b.collectedAt) >= Date.parse(a.collectedAt)); assert.equal(urls.filter(u => u.url.includes('instance_view')).length, 4); assert(!JSON.stringify(a).includes('NEVER-LEAK')); assert(!urls.some(u => u.url.includes('/freebusy'))); assert.equal(a.source.resource, input.arguments.resource)
})
for (const [name, response] of [['has-more', r => r({ items: [], has_more: true })], ['dense', r => r({ items: Array.from({ length: 1000 }, (_, i) => raw(`e-${i}`)) })], ['invalid-time', r => r({ items: [{ ...raw(), start_time: { date: 'invalid' } }] })], ['rate-limit', () => new Response(JSON.stringify({ code: 190005 }), { status: 429 })], ['transport', () => { throw Error('private-secret') }]]) test(`provider ${name} never masquerades as all-free`, async t => { const { s, input } = await fixture(t, (_u, r) => response(r)); const result = await s.readFeishuCalendar(input); assert.equal(result.complete, false); assert.equal(result.free, null) })
test('later slice failure retains known busy but cannot recommend free', async t => { let calls = 0; const { s, input } = await fixture(t, (_u, r) => { if (++calls > 1) throw Error('network'); return r({ items: [raw()] }) }); input.arguments.end = '2026-10-22T00:00:00+08:00'; const r = await s.readFeishuCalendar(input); assert.equal(r.complete, false); assert.equal(r.busy.length, 1); assert.equal(r.free, null) })
test('reopen same database retains Task identity usage grants then revoked resource stays denied', async t => { const { s, open, input, resource } = await fixture(t, (_u, r) => r({ items: [] })); await s.readFeishuCalendar(input); const before = await s.get(input.taskId); await s.close(); const next = await open(); const after = await next.get(input.taskId); assert.deepEqual(after.usage, before.usage); await next.updateCapabilityPool({ requestId: 'availability-revoke', operation: 'revoke', tools: [], resources: [resource] }); await assert.rejects(next.readFeishuCalendar(input)); await next.close(); const last = await open(); await assert.rejects(last.readFeishuCalendar(input)) })
test('canonical UTC end from UI is accepted and converted by selected timezone', () => { assert(validFeishuArgs(FEISHU_TOOLS[2], { resource: `feishu:${'a'.repeat(64)}`, start, end: new Date(end).toISOString(), timezone: 'Asia/Shanghai' })) })
test('tool-only revoke blocks derived historical projection and context even while schedule remains granted', async t => {
 const { s, input } = await fixture(t, (_u, r) => r({ items: [] })); await s.readFeishuCalendar(input);
 await s.updateCapabilityPool({ requestId: 'availability-tool-only-revoke', operation: 'revoke', tools: [FEISHU_TOOLS[2]], resources: [] });
 await assert.rejects(s.readFeishuCalendar(input)); const state = await s.get(input.taskId); assert.equal(state.title, '真实日历来源不可访问'); assert(state.toolSets.authorized.includes(FEISHU_TOOLS[0]));
})
test('conflicting repeated instance snapshots across slices cannot prove free', async t => { let n = 0; const { s, input } = await fixture(t, (_u, r) => { const e = raw(); if (++n > 1) e.end_time.timestamp = String(Number(e.end_time.timestamp) + 60); return r({ items: [e] }) }); input.arguments.end = '2026-10-22T00:00:00+08:00'; const result = await s.readFeishuCalendar(input); assert.equal(result.complete, false); assert.equal(result.incompleteReason, 'instance-changed-between-slices'); assert.equal(result.free, null) })
test('invalid provider response array is not an empty calendar', async t => { const { s, input } = await fixture(t, (_u, r) => r([])); const result = await s.readFeishuCalendar(input); assert.equal(result.complete, false); assert.equal(result.free, null) })
test('resource revoked during read prevents late derived result disclosure', async t => { let started, release; const waiting = new Promise(r => { started = r }), blocked = new Promise(r => { release = r }); const { s, input, resource } = await fixture(t, async (_u, r) => { started(); await blocked; return r({ items: [raw()] }) }); const pending = s.readFeishuCalendar(input); await waiting; await s.updateCapabilityPool({ requestId: 'availability-midread-revoke', operation: 'revoke', tools: [], resources: [resource] }); release(); await assert.rejects(pending) })
test('provider zero-duration boundary event does not block a complete window', async t => { const { s, input } = await fixture(t, (_u, r) => { const e = raw(); e.end_time = e.start_time; return r({ items: [e] }) }); const result = await s.readFeishuCalendar(input); assert(result.complete); assert.equal(result.busy.length, 0); assert.equal(result.free.length, 1) })
test('provider window and instance limit errors explicitly reject availability without retries', async t => { for (const code of [193103, 193104]) { const { s, input, urls } = await fixture(t, () => new Response(JSON.stringify({ code }), { status: 400 })); const result = await s.readFeishuCalendar(input); assert.equal(result.free, null); assert.equal(result.complete, false); assert.equal(urls.filter(x => x.url.includes('instance_view')).length, 1) } })
test('mixed all-day timezone cannot silently shift date coverage', () => { const r = calc([{ ...event(0, 1), allDay: true, start: { date: '2026-10-20', timezone: 'Asia/Shanghai' }, end: { date: '2026-10-21', timezone: 'UTC' } }]); assert.equal(r.free, null) })
