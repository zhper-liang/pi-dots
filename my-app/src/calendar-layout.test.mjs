import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutDay, periodDays, weekStart, shiftAnchor, eventDays, dueDay, dayKey, toOffsetIso, dayStart } from './calendar-layout.mjs'

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
