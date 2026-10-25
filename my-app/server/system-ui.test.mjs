import test from 'node:test'
import assert from 'node:assert/strict'
import { CARD_KINDS, canAlways, cardActions, cardView, mirrorCard, inboxCard, openApproval, openBlocker } from '../src/system-cards.mjs'
import { buildTimeline, summarizeArgs, toolLabel } from '../src/timeline.mjs'
import { todayParts, nextEvent } from '../src/today-summary.mjs'
import { buildInbox } from './inbox.mjs'

// PLAN §8.4 (phase 4) T4-01: pure logic behind the unified system cards, the Task timeline and the home summary.
test('S3 every ordinary approval offers "always" except pause and retry', () => {
  assert.deepEqual(Object.keys(CARD_KINDS).sort(), ['approval', 'auto-applied', 'blocker', 'bot-management', 'finding', 'mirror', 'routine-proposal', 'summary'])
  assert.equal(canAlways({ kind: 'approval', toolName: 'calendar_feishu_create_event' }), true)
  assert.equal(canAlways({ kind: 'approval', toolName: 'workspace.prepare_change' }), true)
  for (const card of [{ kind: 'approval', toolName: 'bot_manage' }, { kind: 'approval', toolName: 'workspace.prepare_schedule' },
    { kind: 'approval', toolName: 'routine_propose' }, { kind: 'bot-management', toolName: 'bot_manage' }, { kind: 'routine-proposal' }])
    assert.equal(canAlways(card), true, JSON.stringify(card))
  for (const card of [
    { kind: 'approval', toolName: 'calendar_reschedule_event', retry: true }, { kind: 'approval', toolName: 'workspace.prepare_change', allowAlways: false },
    { kind: 'blocker' }, { kind: 'finding' },
  ]) assert.equal(canAlways(card), false, JSON.stringify(card))
})

test('T4-01b card buttons follow kind and live state', () => {
  const actions = card => cardActions(card)
  assert.deepEqual(actions({ kind: 'approval', state: 'pending', toolName: 'calendar_feishu_update_event' }), ['approve', 'always', 'reject'])
  assert.deepEqual(actions({ kind: 'approval', state: 'pending', toolName: 'calendar_reschedule_event', retry: true }), ['approve', 'reject'])
  assert.deepEqual(actions({ kind: 'bot-management', state: 'pending', toolName: 'bot_manage' }), ['approve', 'always', 'reject'])
  assert.deepEqual(actions({ kind: 'routine-proposal', state: 'pending' }), ['approve', 'always', 'reject'])
  for (const state of ['executed', 'rejected', 'expired', 'outcome-unknown', 'not-executed']) assert.deepEqual(actions({ kind: 'approval', state }), [], state)
  assert.deepEqual(actions({ kind: 'blocker', state: 'pending' }), ['answer'])
  assert.deepEqual(actions({ kind: 'blocker', state: 'resolved' }), [])
  assert.deepEqual(actions({ kind: 'auto-applied', state: 'applied' }), ['undo'])
  assert.deepEqual(actions({ kind: 'auto-applied', state: 'undone' }), [])
  assert.deepEqual(actions({ kind: 'finding', state: 'open' }), ['handle', 'dismiss', 'mute'])
  assert.deepEqual(actions({ kind: 'summary', state: 'open' }), ['handle', 'dismiss'])
  for (const state of ['resolved', 'dismissed', 'muted', 'handled']) assert.deepEqual(actions({ kind: 'finding', state }), [], state)
  const view = cardView({ kind: 'finding', detector: 'conflict', state: 'open' })
  assert.deepEqual([view.label, view.tone, view.waiting], ['日程冲突', 'attention', true])
  assert.equal(cardView({ kind: 'finding', detector: 'overdue', state: 'resolved' }).state, '已处理或已过时')
  assert.equal(cardView({ kind: 'blocker', state: 'resolved' }).state, '已补充')
  assert.deepEqual([cardView({ kind: 'auto-applied', state: 'applied' }).tone, cardView({ kind: 'approval', state: 'executed' }).tone], ['busy', 'muted'])
  assert.equal(cardView({ kind: 'unknown-kind' }).kind, 'mirror')
})

test('T4-01c mirror, inbox and Task cards for the same item offer the same buttons', () => {
  const same = (mirror, inbox) => assert.deepEqual(cardActions(mirrorCard(mirror)), cardActions(inboxCard(inbox)))
  same({ mirrorKind: 'approval', toolName: 'calendar_feishu_create_event', live: 'pending' }, { kind: 'approval', detail: { toolName: 'calendar_feishu_create_event' } })
  same({ mirrorKind: 'approval', toolName: 'bot_manage', live: 'pending' }, { kind: 'approval', detail: { toolName: 'bot_manage' } })
  same({ mirrorKind: 'approval', toolName: 'calendar_reschedule_event', live: 'pending', retryOf: { approvalId: 1 } }, { kind: 'approval', detail: { toolName: 'calendar_reschedule_event', retryOf: { approvalId: 1 } } })
  same({ mirrorKind: 'proposal', live: 'awaiting_confirmation', allowAlways: false }, { kind: 'workspace-proposal', detail: { allowAlways: false } })
  same({ mirrorKind: 'proposal', live: 'awaiting_confirmation' }, { kind: 'workspace-proposal', detail: {} })
  same({ mirrorKind: 'blocker', live: 'pending' }, { kind: 'blocker', detail: {} })
  same({ mirrorKind: 'auto-applied', live: 'undone' }, { kind: 'auto-applied', detail: { undone: true } })
  assert.deepEqual(cardActions({ kind: 'approval', state: 'pending', toolName: 'calendar_feishu_create_event' }), cardActions(mirrorCard({ mirrorKind: 'approval', toolName: 'calendar_feishu_create_event', live: 'pending' })))
  assert.equal(cardView(mirrorCard({ mirrorKind: 'finished', outcome: 'succeeded' })).state, '已完成')
  assert.equal(cardView(mirrorCard({ mirrorKind: 'approval', toolName: 'calendar_feishu_create_event', live: 'executed' })).state, '已执行')
  assert.deepEqual(inboxCard({ kind: 'finding', detail: { detector: 'summary', state: 'open' } }), { kind: 'summary', detector: 'summary', state: 'open' })
})

test('T4-01d the inbox carries retryOf so an unknown-outcome retry never shows "always"', async () => {
  const task = { taskId: 7, bot: { id: 'calendar', name: '日程' }, approvals: { items: [
    { id: 2, status: 'pending', toolName: 'calendar_reschedule_event', arguments: { title: '周会' }, createdAt: '2026-10-22T01:00:00.000Z', retryOf: { approvalId: 1, operationId: 'op-1' } },
    { id: 3, status: 'pending', toolName: 'calendar_reschedule_event', arguments: { title: '周会' }, createdAt: '2026-10-22T01:00:00.000Z' }] } }
  const { items } = await buildInbox({ listTasks: async () => [task], pendingOperations: async () => ({ items: [] }), bots: [] })
  const [retry, plain] = items
  assert.deepEqual(retry.detail.retryOf, { approvalId: 1, operationId: 'op-1' })
  assert.equal(plain.detail.retryOf, undefined)
  assert.deepEqual(cardActions(inboxCard(retry)), ['approve', 'reject'])
  assert.deepEqual(cardActions(inboxCard(plain)), ['approve', 'always', 'reject'])
})

test('T4-01e D-11 open vs settled: a card leaves the pending area only with a receipt', () => {
  assert.equal(openApproval({ status: 'pending' }), true)
  assert.equal(openApproval({ status: 'dispatching', decision: {} }), true)
  assert.equal(openApproval({ status: 'outcome-unknown', operation: {} }, true), true) // unknown outcome still needs verifying after cancel
  assert.equal(openApproval({ status: 'pending' }, true), false)
  assert.equal(openApproval({ status: 'executed', receipt: { id: 1 } }), false)
  assert.equal(openBlocker({ status: 'pending' }), true)
  assert.equal(openBlocker({ status: 'pending' }, true), false)
  assert.equal(openBlocker({ status: 'resolved' }), false)
})

const t = (min) => new Date(Date.UTC(2026, 9, 22, 1, min)).toISOString()
const sampleTask = () => ({
  messages: [
    { id: 1, role: 'user', content: '帮我把周会改到下午三点', createdAt: t(0) },
    { id: 2, role: 'assistant', content: '先查一下', createdAt: t(1), execution: { model: 'm', provider: 'p', apiKey: 'never-shown' }, assistant: { content: [
      { type: 'text', text: '先查一下' },
      { type: 'toolCall', id: 'c1', name: 'calendar_read_schedule', arguments: { start: '2026-10-22', end: '2026-10-23' } },
      { type: 'toolCall', id: 'c2', name: 'calendar_reschedule_event', arguments: { eventId: 'e1', title: '周会', start: '15:00', end: '16:00', description: 'x'.repeat(200) } },
      { type: 'toolCall', id: 'c3', name: 'task_status', arguments: {} }] } },
    { id: 3, role: 'tool', callId: 'c1', toolName: 'calendar_read_schedule', arguments: { start: '2026-10-22' }, result: { ok: true, data: { items: [1, 2] } }, createdAt: t(2) },
    { id: 4, role: 'tool', callId: 'c2', toolName: 'calendar_reschedule_event', arguments: { eventId: 'e1' }, result: { ok: true, data: { status: 'waiting-for-user-approval', approvalId: 9 } }, createdAt: t(2) },
    { id: 5, role: 'system', systemKind: 'context-floor', content: '权限有变化', createdAt: t(3) },
    { id: 6, role: 'assistant', content: '已改好', createdAt: t(8) },
    { id: 7, role: 'error', errorCode: 'MODEL_TIMEOUT', content: '超时', createdAt: t(9) },
    { id: 8, role: 'tool', content: '真实日历来源权限不足；派生内容已隐藏。' },
  ],
  approvals: { items: [{ id: 9, toolName: 'calendar_reschedule_event', status: 'executed', arguments: { title: '周会' }, createdAt: t(2), decision: { decision: 'approved', source: 'policy-rule', reason: '', createdAt: t(4) }, receipt: { id: 1, createdAt: t(5), result: { ok: true } } }] },
  blockers: { items: [{ id: 4, question: '用哪个时区？', status: 'resolved', createdAt: t(6), answer: { content: 'Asia/Shanghai', createdAt: t(7) } }] },
  cancellation: { requestedAt: t(10) },
})

test('T4-01f the timeline lists turns, tool calls, results, approvals, questions and the end in time order', () => {
  const entries = buildTimeline(sampleTask())
  assert.deepEqual(entries.map(e => e.kind), ['input', 'model', 'tool', 'tool', 'tool', 'approval', 'system', 'decision', 'receipt', 'question', 'answer', 'reply', 'error', 'tool', 'end'])
  const [read, reschedule, status] = entries.filter(e => e.kind === 'tool')
  assert.deepEqual([read.title, read.status, read.result], ['读取模拟日程', 'ok', '2 条'])
  assert.deepEqual([reschedule.status, reschedule.result], ['ok', '等你审批'])
  assert.equal(status.status, 'running') // a call without a saved result is not shown as finished
  // P-14: a short summary by default; the raw arguments and result are kept for "展开".
  assert.ok(reschedule.summary.length <= 80 && reschedule.summary.startsWith('title: 周会'), reschedule.summary)
  assert.equal(reschedule.detail.arguments.description.length, 200)
  assert.deepEqual(reschedule.detail.result, { ok: true, data: { status: 'waiting-for-user-approval', approvalId: 9 } })
  assert.deepEqual(entries.find(e => e.kind === 'model').detail, { model: 'm', provider: 'p' })
  assert.match(entries.find(e => e.kind === 'decision').summary, /总是允许/)
  assert.deepEqual([entries.find(e => e.kind === 'receipt').status, entries.find(e => e.kind === 'error').status], ['ok', 'error'])
  assert.equal(entries.at(-1).title, '已取消')
  assert.equal(buildTimeline({ messages: [], runtime: { status: 'terminal' } }).at(-1).title, '执行异常结束')
  const unknown = buildTimeline({ approvals: { items: [{ id: 1, toolName: 'calendar_feishu_create_event', status: 'outcome-unknown', arguments: {}, createdAt: t(0), decision: { decision: 'approved', createdAt: t(1) }, operation: { unknownAt: t(2) }, receipt: null }] } })
  assert.deepEqual(unknown.map(e => [e.kind, e.status]), [['approval', 'muted'], ['decision', 'muted'], ['receipt', 'waiting']])
  assert.deepEqual(buildTimeline({}), [])
})

test('T4-01g argument summary and labels', () => {
  assert.equal(summarizeArgs({ action: 'create', type: 'Todo', data: { title: '买牛奶', due: '2026-10-23' }, sourceId: 'local' }), 'action: create · title: 买牛奶 · type: Todo …')
  // prepare_change nests the item under change; bookkeeping ids go last.
  assert.equal(summarizeArgs({ sourceId: 'local', requestId: 'del-1', action: 'delete', change: { type: 'Todo', id: 'abc', expectedVersion: 1 } }), 'action: delete · type: Todo · sourceId: local …')
  assert.equal(summarizeArgs({ sourceId: 'local', requestId: 'add-1', action: 'create', change: { type: 'Todo', data: { title: '买牛奶' } } }), 'action: create · title: 买牛奶 · type: Todo …')
  const proposal = buildTimeline({ messages: [
    { id: 1, role: 'assistant', createdAt: t(0), assistant: { content: [{ type: 'toolCall', id: 'p1', name: 'workspace.prepare_change', arguments: { action: 'delete', change: { type: 'Todo' } } }] } },
    { id: 2, role: 'tool', callId: 'p1', toolName: 'workspace.prepare_change', result: { ok: true, data: { state: 'awaiting_confirmation' } }, createdAt: t(1) }] }).find(e => e.kind === 'tool')
  assert.deepEqual([proposal.title, proposal.result], ['提议改动', '等你确认'])
  assert.equal(summarizeArgs({}), '')
  assert.equal(summarizeArgs(undefined), '')
  assert.equal(summarizeArgs('plain'), 'plain')
  assert.ok(summarizeArgs({ title: 'x'.repeat(100) }).endsWith('…'))
  assert.equal(toolLabel('task_create'), '派活')
  assert.equal(toolLabel('not_registered'), 'not_registered')
})

test('T4-01h home summary line (P-13)', () => {
  const day = '2026-10-22', at = (h, m = 0) => `2026-10-22T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`
  const now = Date.parse(at(10))
  const events = [{ title: '早会', start: at(9), end: at(9, 30) }, { title: '周会', start: at(15), end: at(16) }, { title: '评审', start: at(9, 45), end: at(11) }]
  assert.equal(nextEvent(events, now).title, '评审')
  assert.deepEqual(todayParts({ events, todos: [{ due: '2026-10-22' }, { due: '2026-10-20' }], confirmations: 2, now, day }), ['3 个日程', '进行中 评审', '2 项到期（1 项已逾期）', '2 项等你确认'])
  assert.deepEqual(todayParts({ events: [events[1]], now, day }), ['1 个日程', '下一个 15:00 周会'])
  assert.deepEqual(todayParts({ now, day }), ['今天没有日程'])
  assert.deepEqual(todayParts({ authorized: false, confirmations: 1, now, day }), ['本地日程未开放读取', '1 项等你确认'])
})
