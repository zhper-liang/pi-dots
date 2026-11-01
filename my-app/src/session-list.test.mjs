import test from 'node:test'
import assert from 'node:assert/strict'
import { lastActivity, timeBucket, relativeTime, matchesQuery, parsePins, togglePin, sessionSections, sessionPreview } from './session-list.mjs'

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

test('search matches title or robot name, ignoring case and outer spaces', () => {
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

test('deleted sessions disappear from pinned/search/archived sections, archive alone is not deletion', async () => {
  const { isSessionDeleted, removeSessionPin } = await import('./session-list.mjs')
  const items = [
    { id: 1, title: 'needle one', botName: 'Chief', at: NOW, confirm: true, archived: false, deleted: true },
    { id: 2, title: 'needle two', botName: 'Chief', at: NOW, confirm: false, archived: true, deletedAt: '2026-10-29T00:00:00Z' },
    { id: 3, title: 'needle three', botName: 'Chief', at: NOW, confirm: false, archived: true },
  ]
  assert.deepEqual(sessionSections(items, { pins: [1, 2, 3], query: 'needle', now: NOW }).map(section => section.items.map(item => item.id)), [[3]])
  assert.equal(isSessionDeleted(items[2]), false)
  assert.deepEqual(removeSessionPin([1, 2, 3], 2), [1, 3])
})

test('labels distinguish stop/delete and main replacement without calling archive deletion', async () => {
  const { sessionDeleteLabel } = await import('./session-list.mjs')
  assert.equal(sessionDeleteLabel({ kind: 'session', running: true }), '停止并删除')
  assert.equal(sessionDeleteLabel({ kind: 'group', running: true }), '停止并删除')
  assert.equal(sessionDeleteLabel({ kind: 'session' }), '删除会话')
  assert.equal(sessionDeleteLabel({ kind: 'main', running: true }), '清空并开始新会话')
})

test('only exact confirmed deletion receipts may hide rows or switch the main reference', async () => {
  const { isSessionActionReceipt } = await import('./session-list.mjs')
  const target = { taskId: 4, botId: 'chief', title: 'x', kind: 'session' }
  const receipt = { taskId: 4, botId: 'chief', action: 'delete', deleted: true, deletedAt: '2026-10-29T00:00:00Z', replacementTaskId: null, requestId: 'request-one', replayed: false }
  assert.equal(isSessionActionReceipt(receipt, target, 'request-one'), true)
  for (const invalid of [null, { ok: true }, { status: 'unknown' }, { ...receipt, deleted: false }, { ...receipt, taskId: 9 },
    { ...receipt, botId: 'other' }, { ...receipt, requestId: 'other' }, { ...receipt, action: 'archive' }, { ...receipt, deletedAt: 'bad' }, { ...receipt, replacementTaskId: 9 }]) {
    assert.equal(isSessionActionReceipt(invalid, target, 'request-one'), false)
  }
  const main = { ...target, kind: 'main' }, replaced = { ...receipt, action: 'clear-main', replacementTaskId: 9 }
  assert.equal(isSessionActionReceipt(replaced, main, 'request-one'), true)
  assert.equal(isSessionActionReceipt({ ...replaced, replacementTaskId: 4 }, main, 'request-one'), false)
  assert.equal(isSessionActionReceipt({ ...replaced, replacementTaskId: null }, main, 'request-one'), false)
})

test('sidebar confirmation uses shared EditorDialog, stable retry identity and no implicit send/archive', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./SessionActions.tsx', import.meta.url), 'utf8')
  const sidebar = await readFile(new URL('./ShellSidebar.tsx', import.meta.url), 'utf8')
  assert.match(source, /<EditorDialog/)
  assert.match(source, /requestId\.current \?\?= crypto\.randomUUID\(\)/)
  assert.match(source, /isSessionActionReceipt\(response, target, requestId\.current\)/)
  assert.match(source, /核对删除结果/)
  assert.match(source, /uncertain \? onVerify \? '核对删除结果' : '重试'/)
  assert.match(source, /uncertain && onVerify && !retryOriginal \? await onVerify\(target, input\) : await onAction\(target, input\)/)
  assert.match(sidebar, /onVerify=\{props.onVerifySessionAction\}/)
  assert.match(source, /已有记忆和操作记录保留/)
  assert.match(sidebar, /title="机器人设置"/)
  assert.match(sidebar, />新建机器人</)
  assert.match(sidebar, /'派活和验收'/)
  assert.doesNotMatch(source, /fetch\(|\/archive|\.send\(/)
  assert.match(sidebar, /sessions\.filter\(item => !deletedIds\.includes\(item.id\)\)/)
  assert.match(sidebar, /removeSessionPin\(previous, result.taskId\)/)
})

test('sidebar preview is the last thing said, flattened, with who said it', () => {
  const user = content => ({ role: 'user', content }), bot = (content, extra = {}) => ({ role: 'assistant', content, ...extra })
  assert.equal(sessionPreview([]), '')
  assert.equal(sessionPreview([user('明天几点开会？'), bot('**10 点**，在 `A` 会议室。')]), '10 点，在 A 会议室。')
  assert.equal(sessionPreview([bot('好的'), user('改到 2026-11-02')]), '你：改到 2026-11-02')
  assert.equal(sessionPreview([bot('- 第一项\n- 第二项')]), '第一项 第二项')
  assert.equal(sessionPreview([bot('看 [日程](#bot=calendar)')]), '看 日程')
  // Tool rows, system cards, interim and undone turns, and empty tool-call turns are skipped.
  assert.equal(sessionPreview([bot('结论在这'), { role: 'tool', content: 'raw' }, { role: 'system', content: '卡片' }, bot(''), bot('草稿', { intermediate: true }), { ...user('撤回'), undone: true }]), '结论在这')
  assert.equal(sessionPreview([bot('提醒卡', { systemKind: 'finding' })]), '')
  assert.equal(sessionPreview([bot('周六天气不错', { systemKind: 'group-reply', botName: '日程助理' })], { group: true }), '日程助理：周六天气不错')
  assert.equal(sessionPreview([bot('周六天气不错', { botName: '日程助理' })]), '周六天气不错')
  assert.equal(sessionPreview([user('长'.repeat(200))]).length, 80)
})
