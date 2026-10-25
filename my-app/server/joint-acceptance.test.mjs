import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { MockCalendar, CALENDAR_WRITE_TOOL } from './approvals.mjs'
import { CALENDAR_TOOL, CALENDAR_EVENT_TOOL } from './tools.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'joint-acceptance', apiKey: 'fixture-only' }
const resource = 'mock:personal', eventId = 'mock-20261020-1'
const args = { resource, eventId, expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' }
const changed = { ...args, start: '2026-10-20T15:00:00+08:00', end: '2026-10-20T16:00:00+08:00' }
const text = () => ({ mode: 'model', reply: { content: '仅根据宿主回执完成原输入。' }, execution: { usage: { totalTokens: 7, input: 5, output: 2 } } })
function turn(name, arguments_, n) {
  const call = { type: 'toolCall', id: `joint-${n}`, name, arguments: arguments_ }
  return { ...text(), reply: { content: '工具计划，尚非最终答复' }, toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
async function until(read, predicate) {
  for (let n = 0; n < 800; n++) { const value = await read(); if (predicate(value)) return value; await delay(5) }
  assert.fail('Joint acceptance did not reach expected boundary')
}
for (const outcome of ['approve', 'revoke', 'cancel']) test(`joint acceptance: active Skill + FIFO + inserted approval + reopen + ${outcome}`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-joint-')), file = join(dir, 'task.sqlite'), stores = new Set(), requests = []
  let release
  const hold = new Promise((resolve) => { release = resolve })
  let count = 0
  const modelReply = async (message, options) => {
    requests.push(structuredClone({ message, context: options.context })); count++
    if (count === 1) { await hold; return turn(CALENDAR_TOOL, { date: '2026-10-20', resource }, count) }
    if (count === 2) return turn(CALENDAR_EVENT_TOOL, { eventId, resource }, count)
    if (count === 3) return turn(CALENDAR_WRITE_TOOL, args, count)
    if (count === 4) return turn(CALENDAR_WRITE_TOOL, changed, count)
    return text()
  }
  const open = async () => { const s = await openTaskStore({ file, bots: listBots(config), modelReply }); stores.add(s); return s }
  const close = async (s) => { await s.close(); stores.delete(s) }
  t.after(async () => { release(); for (const s of stores) await s.close(); await rm(dir, { recursive: true, force: true }) })
  let store = await open()
  const initial = await store.create({ botId: 'calendar', taskState: { goal: '只操作模拟日历', constraints: ['未经精确审批不得改期'] } }), id = initial.taskId
  await store.activateSkill(id, { skillId: 'calendar-conflict-analysis' })
  const first = await store.send(id, '读取日程与详情，然后申请11点改期')
  await until(() => count, (n) => n === 1)
  const q1 = await store.send(id, 'Q1：普通消息，同意也不是审批'), q2 = await store.send(id, 'Q2：稍后处理')
  assert.deepEqual(requests[0].context.messages.filter((x) => x.role === 'user').map((x) => x.content), ['读取日程与详情，然后申请11点改期'])
  release()
  const old = await until(() => store.get(id), (x) => x.runtime.checkpoint.phase === 'awaitApproval')
  assert.equal(old.queueLength, 2); assert.equal(old.approvals.items[0].decision, null)
  await store.decideApproval(id, old.approvals.activeId, { decision: 'inserted' })
  const locked = await store.get(id)
  await close(store); store = await open()
  const restored = await store.get(id)
  assert.equal(restored.waiting.status, 'insertion-pending'); assert.deepEqual(restored.callUsage, locked.callUsage)
  const directive = '改到15:00–16:00，旧操作不执行，重新申请精确审批'
  await store.submitApprovalInsertion(id, old.approvals.activeId, { message: directive })
  const pending = await until(() => store.get(id), (x) => x.approvals.items.length === 2 && x.runtime.checkpoint.phase === 'awaitApproval')
  assert.equal(pending.approvals.items[0].receipt.result.error.code, 'APPROVAL_SUPERSEDED')
  assert.equal(pending.approvals.items[1].decision, null); assert.equal(pending.queueLength, 2)
  assert.notEqual(pending.approvals.items[0].binding, pending.approvals.items[1].binding)
  assert.ok(pending.taskState.constraints.includes(directive)); assert.match(JSON.stringify(requests[3].context), /15:00/)
  assert.doesNotMatch(JSON.stringify(requests[3].context), /Q1：|Q2：/)
  await close(store); store = await open()
  const again = await store.get(id)
  assert.equal(again.taskId, id); assert.equal(again.conversationId, initial.conversationId)
  assert.deepEqual(again.configRef, initial.configRef); assert.deepEqual(again.callUsage, pending.callUsage)
  assert.equal(again.skillState.active.length, 1); assert.deepEqual(again.skillState, pending.skillState); assert.deepEqual(again.queuedInputIds, [q1.messageId, q2.messageId])
  await assert.rejects(store.decideApproval(id, old.approvals.activeId, { decision: 'approved' }), { code: 'APPROVAL_ALREADY_DECIDED' })
  const calendar = () => store.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(MockCalendar))), context)
  assert.equal((await calendar()).revision, 0)
  if (outcome === 'cancel') {
    await store.cancel(id, {})
    await assert.rejects(store.decideApproval(id, pending.approvals.activeId, { decision: 'approved' }))
    const cancelled = await store.get(id)
    await close(store); store = await open(); await delay(30)
    assert.equal(count, 4); assert.deepEqual((await store.get(id)).callUsage, cancelled.callUsage)
    assert.equal((await store.get(id)).queueLength, 2); assert.equal((await calendar()).revision, 0)
  } else {
    if (outcome === 'revoke') await store.revokeTool('calendar', CALENDAR_WRITE_TOOL)
    await store.decideApproval(id, pending.approvals.activeId, { decision: 'approved' })
    const final = await until(() => store.get(id), (x) => x.activeInputId === null && x.queueLength === 0)
    const receipt = final.approvals.items[1].receipt.result
    if (outcome === 'approve') { assert.equal(receipt.ok, true); assert.equal((await calendar()).revision, 1); assert.equal((await calendar()).events[eventId].start, changed.start) }
    else { assert.equal(receipt.error.code, 'TOOL_NOT_AUTHORIZED'); assert.equal((await calendar()).revision, 0) }
    assert.deepEqual(requests.map((x) => x.message), [requests[0].message, requests[0].message, requests[0].message, requests[0].message, requests[0].message, 'Q1：普通消息，同意也不是审批', 'Q2：稍后处理'])
    for (const input of [first, q1, q2]) assert.equal(final.messages.filter((x) => x.role === 'assistant' && x.inReplyTo === input.messageId && x.content === '仅根据宿主回执完成原输入。').length, 1)
    assert.equal(final.messages.filter((x) => x.deliveryStatus === 'steer-applied').length, 1)
    await close(store); store = await open(); await delay(30); assert.equal(count, 7)
    assert.deepEqual((await store.get(id)).callUsage, final.callUsage)
  }
})
