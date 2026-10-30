import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutDay, periodDays, weekStart, shiftAnchor, eventDays, dueDay, dayKey, toOffsetIso, dayStart, workspacePanes, calendarTodos } from './calendar-layout.mjs'

const at = (d, t) => Date.parse(`${d}T${t}:00+08:00`)
const D = '2026-05-14' // Thursday

test('week starts Monday in Asia/Shanghai', () => {
  assert.equal(weekStart(D), '2026-05-11')
  assert.deepEqual(periodDays('week', D), ['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-16', '2026-05-17'])
  assert.equal(dayKey(Date.parse('2026-05-13T16:30:00Z')), '2026-05-14')
})

test('month grid covers whole weeks', () => {
  const days = periodDays('month', D)
  assert.equal(days.length % 7, 0); assert.equal(days[0], '2026-04-27'); assert.ok(days.includes('2026-05-31'))
  assert.equal(shiftAnchor('month', '2026-01-31', 1), '2026-02-01')
  assert.equal(shiftAnchor('week', D, -1), '2026-05-07')
})

test('non-overlapping events take full width', () => {
  const r = layoutDay([{ key: 'a', start: at(D, '16:00'), end: at(D, '17:00') }, { key: 'b', start: at(D, '17:00'), end: at(D, '18:00') }], D)
  assert.deepEqual(r.map(x => [x.key, x.top, x.height, x.col, x.cols]), [['a', 960, 60, 0, 1], ['b', 1020, 60, 0, 1]])
})

test('overlaps split into columns and reuse freed columns', () => {
  const r = layoutDay([
    { key: 'a', start: at(D, '09:00'), end: at(D, '11:00') },
    { key: 'b', start: at(D, '09:30'), end: at(D, '10:00') },
    { key: 'c', start: at(D, '10:00'), end: at(D, '10:30') },
    { key: 'd', start: at(D, '12:00'), end: at(D, '13:00') },
  ], D)
  const m = Object.fromEntries(r.map(x => [x.key, x]))
  assert.equal(m.a.col, 0); assert.equal(m.b.col, 1); assert.equal(m.c.col, 1)
  assert.equal(m.a.cols, 2); assert.equal(m.c.cols, 2); assert.equal(m.d.cols, 1)
})

test('cross-midnight events are clipped and min height applied', () => {
  const r = layoutDay([{ key: 'x', start: at('2026-05-13', '23:00'), end: at(D, '01:00') }, { key: 'y', start: at(D, '08:00'), end: at(D, '08:05') }], D)
  assert.equal(r[0].top, 0); assert.equal(r[0].height, 60); assert.equal(r[1].height, 20)
  assert.deepEqual(eventDays(at('2026-05-13', '23:00'), at(D, '00:00')), ['2026-05-13'])
})

test('due parsing and iso formatting', () => {
  assert.equal(dueDay('2026-05-14'), D); assert.equal(dueDay('2026-05-14T23:30:00+08:00'), D); assert.equal(dueDay(null), null)
  assert.equal(toOffsetIso(dayStart(D) + 16 * 3600000), '2026-05-14T16:00:00+08:00')
})

test('T08 desktop shows calendar and todo panes; mobile shows exactly the selected pane', () => {
  for (const pane of ['calendar', 'todos']) assert.deepEqual(workspacePanes(false, pane), { calendar: true, todos: true })
  assert.deepEqual(workspacePanes(true), { calendar: true, todos: false })
  assert.deepEqual(workspacePanes(true, 'todos'), { calendar: false, todos: true })
})

test('T08 same-screen todos include overdue and undated items without completed/deleted history', () => {
  const items = [
    { id: 'undated', title: '无日期' },
    { id: 'future', title: '明天', due: '2026-05-15' },
    { id: 'deleted', title: '已删', due: '2026-05-10', deletedAt: '2026-05-11' },
    { id: 'done', title: '完成', due: D, status: 'completed' },
    { id: 'today', title: '今天上午', due: '2026-05-14T01:00:00Z' },
    { id: 'overdue', title: '逾期', due: '2026-05-13' },
    { id: 'invalid', title: '异常日期', due: 'invalid' }
  ]
  const original = [...items]
  assert.deepEqual(calendarTodos(items).map(item => item.id), ['overdue', 'today', 'future', 'undated', 'invalid'])
  assert.deepEqual(items, original)
})

test('R1-06 local display and geometry use the supplied device zone without changing legacy defaults', async () => {
  const { hm } = await import('./calendar-layout.mjs')
  const instant = Date.parse('2026-10-29T01:15:00Z')
  assert.equal(dayKey(instant, 'America/New_York'), '2026-10-28')
  assert.equal(hm(instant, 'America/New_York'), '21:15')
  assert.equal(dayKey(instant), '2026-10-29')
  const start = dayStart('2026-10-28', 'America/New_York')
  assert.equal(start, Date.parse('2026-10-28T04:00:00Z'))
  const placed = layoutDay([{ key: 'local', start: instant, end: instant + 3600000 }], '2026-10-28', 20, 'America/New_York')
  assert.equal(placed[0].top, 21 * 60 + 15)
  assert.equal(placed[0].height, 60)
  assert.deepEqual(eventDays(instant, instant + 3600000, 'America/New_York'), ['2026-10-28'])
  assert.equal(dueDay('2026-10-29T01:15:00Z', 'America/New_York'), '2026-10-28')
})

test('R1-06 editing in another device zone preserves saved timezone and event instants', async () => {
  const { eventTimeDraft, eventTimeData } = await import('./calendar-layout.mjs')
  const start = at('2026-10-29', '09:17'), end = at('2026-10-29', '10:59')
  const draft = eventTimeDraft(start, end, 'Asia/Shanghai', 'America/New_York')
  assert.deepEqual(draft.start, { date: '2026-10-28', time: '21:17', timezone: 'America/New_York' })
  assert.equal(draft.timezone, 'Asia/Shanghai')
  const data = eventTimeData(draft)
  assert.equal(data.timezone, 'Asia/Shanghai')
  assert.equal(Date.parse(data.start), start)
  assert.equal(Date.parse(data.end), end)
  assert.equal(data.start, '2026-10-29T09:17:00+08:00')
})

test('R1-06 new cards capture local zone and accept cross-day full minute values', async () => {
  const { eventTimeDraft, eventTimeData } = await import('./calendar-layout.mjs')
  const start = Date.parse('2026-10-29T23:59:00-04:00'), end = Date.parse('2026-10-30T00:07:00-04:00')
  const draft = eventTimeDraft(start, end, 'America/New_York', 'America/New_York')
  assert.equal(draft.start.time, '23:59')
  assert.equal(draft.end.time, '00:07')
  const data = eventTimeData(draft)
  assert.equal(data.timezone, 'America/New_York')
  assert.equal(data.start, '2026-10-29T23:59:00-04:00')
  assert.equal(Date.parse(data.end), end)
})

test('R1-06 invalid, backwards and DST-gap drafts reject before mutation; overlap uses shared first UTC', async () => {
  const { eventTimeData } = await import('./calendar-layout.mjs')
  const value = (date, time) => ({ date, time, timezone: 'America/New_York' })
  const start = value('2026-03-08', '01:30')
  assert.ok(eventTimeData({ start, end: start, timezone: start.timezone }).error)
  assert.ok(eventTimeData({ start, end: value('2026-03-08', '00:30'), timezone: start.timezone }).error)
  assert.ok(eventTimeData({ start: value('2026-03-08', '02:30'), end: value('2026-03-08', '03:30'), timezone: start.timezone }).error)
  assert.ok(eventTimeData({ start: value('2026-02-30', '09:00'), end: value('2026-03-01', '09:00'), timezone: start.timezone }).error)
  const overlap = eventTimeData({ start: value('2026-11-01', '01:30'), end: value('2026-11-01', '02:30'), timezone: start.timezone })
  assert.equal(overlap.start, '2026-11-01T01:30:00-04:00')
  assert.equal(overlap.end, '2026-11-01T02:30:00-05:00')
})

test('R1-06 geometry on DST dates follows wall-clock rows while day bounds use real local midnights', () => {
  const start = Date.parse('2026-03-08T09:00:00-04:00')
  const placed = layoutDay([{ key: 'dst', start, end: start + 3600000 }], '2026-03-08', 20, 'America/New_York')
  assert.equal(placed[0].top, 540)
  assert.equal(placed[0].height, 60)
  assert.deepEqual(eventDays(Date.parse('2026-03-08T23:00:00-04:00'), Date.parse('2026-03-09T00:00:00-04:00'), 'America/New_York'), ['2026-03-08'])
})


test('R1-06 title-only edits preserve saved seconds and the second repeated DST instant', async () => {
  const { eventTimeDraft, eventTimeData } = await import('./calendar-layout.mjs')
  for (const [start, end] of [
    ['2026-10-29T09:17:21+08:00', '2026-10-29T09:17:59+08:00'],
    ['2026-11-01T01:30:17-05:00', '2026-11-01T02:00:17-05:00']
  ]) {
    const draft = eventTimeDraft(Date.parse(start), Date.parse(end), 'America/New_York', 'America/New_York')
    const data = eventTimeData(draft)
    assert.equal(Date.parse(data.start), Date.parse(start))
    assert.equal(Date.parse(data.end), Date.parse(end))
  }
})
