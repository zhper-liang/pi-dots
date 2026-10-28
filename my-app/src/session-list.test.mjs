import test from 'node:test'
import assert from 'node:assert/strict'
import { lastActivity, timeBucket, relativeTime, matchesQuery, parsePins, togglePin, sessionSections } from './session-list.mjs'

// Local wall-clock times, so the tests hold in any timezone.
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const NOW = at(2026, 10, 29, 9, 30)

test('time groups follow local calendar days, not 24-hour windows', () => {
  assert.equal(timeBucket(at(2026, 10, 29, 0, 5), NOW), 'today')
  assert.equal(timeBucket(at(2026, 10, 28, 23, 59), NOW), 'yesterday')
  assert.equal(timeBucket(at(2026, 10, 27, 23, 0), NOW), 'week')
  assert.equal(timeBucket(at(2026, 10, 23), NOW), 'week')
  assert.equal(timeBucket(at(2026, 10, 22), NOW), 'earlier')
  assert.equal(timeBucket(at(2026, 10, 30), NOW), 'today') // a clock skew in the future is not "earlier"
})

test('relative time is short and never negative', () => {
  assert.equal(relativeTime(NOW - 20000, NOW), '刚刚')
  assert.equal(relativeTime(NOW + 60000, NOW), '刚刚')
  assert.equal(relativeTime(NOW - 5 * 60000, NOW), '5分')
  assert.equal(relativeTime(at(2026, 10, 29, 6, 0), NOW), '3时')
  assert.equal(relativeTime(at(2026, 10, 28, 23, 0), NOW), '1天')
  assert.equal(relativeTime(at(2026, 7, 26), NOW), '95天')
  assert.equal(relativeTime(at(2025, 10, 3), NOW), '10月3日')
})

test('last activity is the newest message, else creation; bad dates are ignored', () => {
  assert.equal(lastActivity({ createdAt: '2026-10-01T00:00:00Z', messages: [] }), Date.parse('2026-10-01T00:00:00Z'))
  assert.equal(lastActivity({ createdAt: '2026-10-01T00:00:00Z', messages: [{ createdAt: '2026-10-05T00:00:00Z' }] }), Date.parse('2026-10-05T00:00:00Z'))
  assert.equal(lastActivity({ createdAt: 'nope' }), 0)
})

test('search matches title or Bot name, ignoring case and outer spaces', () => {
  const item = { title: 'Weekly 复盘', botName: '日程助理' }
  assert.equal(matchesQuery(item, '  weekly '), true)
  assert.equal(matchesQuery(item, '日程'), true)
  assert.equal(matchesQuery(item, '待办'), false)
  assert.equal(matchesQuery(item, '   '), true)
})

test('pins survive bad storage and stay unique, ordered and bounded', () => {
  for (const raw of [null, '', 'not json', '{"a":1}', '"7"']) assert.deepEqual(parsePins(raw), [])
  assert.deepEqual(parsePins('[3, 3, -1, 0, 2.5, "4", 9]'), [3, 9])
  assert.deepEqual(togglePin([3, 9], 5), [5, 3, 9])
  assert.deepEqual(togglePin([5, 3, 9], 3), [5, 9])
  assert.equal(parsePins(JSON.stringify(Array.from({ length: 80 }, (_, i) => i + 1))).length, 50)
})

test('sections put each session in exactly one place, in a fixed order', () => {
  const item = (id, title, when, extra = {}) => ({ id, title, botName: 'Chief', at: when, confirm: false, archived: false, ...extra })
  const items = [
    item(1, '老的', at(2026, 9, 1)),
    item(2, '今天早', at(2026, 10, 29, 8)),
    item(3, '今天晚', at(2026, 10, 29, 9)),
    item(4, '等确认', at(2026, 10, 29, 7), { confirm: true }),
    item(5, '置顶也等确认', at(2026, 10, 20), { confirm: true }),
    item(6, '归档的置顶', at(2026, 10, 29), { archived: true }),
    item(7, '昨天', at(2026, 10, 28)),
  ]
  const sections = sessionSections(items, { pins: [6, 5], now: NOW })
  assert.deepEqual(sections.map((s) => [s.id, s.items.map((i) => i.id)]), [
    ['pinned', [5]], ['confirm', [4]], ['today', [3, 2]], ['yesterday', [7]], ['earlier', [1]], ['archived', [6]],
  ])
  assert.equal(sections[0].label, '已置顶')
  const ids = sections.flatMap((s) => s.items.map((i) => i.id)).sort()
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(sessionSections(items, { query: '今天', now: NOW }).map((s) => s.id), ['today'])
  assert.deepEqual(sessionSections([], { now: NOW }), [])
})
