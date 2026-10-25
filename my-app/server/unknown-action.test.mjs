import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { MockCalendar, TaskApprovals } from './approvals.mjs'
import { createApiServer } from './app.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'unknown-action-fixture', apiKey: 'fixture-only' }
const answer = { mode: 'model', reply: { content: '根据用户核实记录继续，非工具独立验证。' }, execution: { usage: { totalTokens: 7, input: 5, output: 2 } } }
async function until(read, predicate = Boolean) { for (let n = 0; n < 800; n++) { const value = await read(); if (predicate(value)) return value; await delay(10) } throw new Error('Unknown-action checkpoint not reached') }
const idle = (x) => x.activeInputId === null && x.queueLength === 0 && x.runtime.disposition === 'idle'
const unknown = (x) => x.approvals.items[0]?.status === 'outcome-unknown'
const calendar = (store) => store.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(MockCalendar))), ctx)
const audits = (store, id, kind) => store.harness.commit(async (tx) => { const all = []; let cursor; do { const page = await tx.scanEntries({ conversationId: id }, 100, cursor); all.push(...page.items.filter((x) => x.kind === kind)); cursor = page.next } while (cursor); return all }, ctx)
async function fixture(t, scenario = 'effect') {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss21-')), file = join(dir, 'task.sqlite'), stores = [], requests = [], writes = []
  const child = spawn(process.execPath, [new URL('./fixtures/unknown-action-process.mjs', import.meta.url).pathname, dir, scenario], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit'); let output = ''
  child.stdout.on('data', (x) => { output += x }); child.stderr.on('data', (x) => { output += x })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }; for (const store of stores) await store.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const saved = await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null } })
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  const open = async () => { const store = await openTaskStore({ file, bots: listBots(config), modelReply: async (message, options) => { requests.push({ message, context: options.context }); return answer }, calendarWriteImpl: async (operation, { execute }) => { writes.push(operation); return execute() } }); stores.push(store); return store }
  return { store: await open(), open, saved, requests, writes }
}
for (const scenario of ['intent', 'effect']) test(`ISS21 SIGKILL ${scenario}: original intent and approval survive, no automatic replay or fabricated receipt`, { timeout: 20000 }, async (t) => {
  const { store, saved, requests, writes, open } = await fixture(t, scenario), id = saved.taskId
  const task = await until(() => store.get(id), unknown), item = task.approvals.items[0]
  await delay(120); assert.equal(requests.length, 0); assert.equal(writes.length, 0)
  assert.equal(task.runtime.disposition, 'waiting'); assert.equal(task.waiting.kind, 'action-outcome'); assert.equal(task.waiting.reason, 'action-outcome-unknown'); assert.equal(task.waiting.status, 'pending')
  assert.equal(item.operation.id, saved.operation.id); assert.deepEqual(item.arguments, saved.waiting.approvals.items[0].arguments)
  assert.equal(item.receipt, null); assert.equal(item.decision.decision, 'approved'); assert.deepEqual(item.operation.decision, item.decision)
  assert.equal(item.inReplyTo, saved.inputId); assert.equal(task.callUsage.toolCalls, 4); assert.equal(task.callUsage.modelCalls, 3)
  const entries = await audits(store, task.conversationId, 'pidot.action-dispatch-intent')
  assert.equal(entries.length, 1); assert.equal(entries[0].id, item.operation.intentEntryId); assert.deepEqual(entries[0].data.arguments, item.arguments)
  assert.deepEqual(item.operation.capabilities, { reliableQuery: false, stableIdempotency: false })
  assert.equal((await calendar(store)).revision, scenario === 'effect' ? 1 : 0)
  assert.equal((await audits(store, task.conversationId, 'pidot.approval-executed')).length, 0)
  assert.equal(task.recoveryHistory.at(-1).waiting.kind, 'action-outcome')
  await store.close(); const reopened = await open(); await delay(60)
  assert.equal((await reopened.get(id)).approvals.items[0].operation.id, item.operation.id); assert.equal(writes.length, 0); assert.equal(requests.length, 0)
})
test('ISS21 user still uncertain remains quiet; completed verification continues original input before FIFO exactly once', { timeout: 20000 }, async (t) => {
  const { store, saved, requests, writes } = await fixture(t), id = saved.taskId
  const waiting = await until(() => store.get(id), unknown), item = waiting.approvals.items[0], usage = waiting.callUsage
  const queued = await store.send(id, '排队消息不是核实完成，也不是重新操作批准')
  await store.verifyAction(id, item.id, { outcome: 'unknown', note: '暂时看不到日历，不能确定' })
  await store.verifyAction(id, item.id, { outcome: 'unknown', note: '暂时看不到日历，不能确定' })
  await delay(80); const pending = await store.get(id)
  assert.equal(requests.length, 0); assert.equal(writes.length, 0); assert.deepEqual(pending.callUsage, usage)
  assert.equal(pending.waiting.status, 'pending'); assert.equal(pending.approvals.items[0].operation.verifications.length, 1)
  await Promise.all([store.verifyAction(id, item.id, { outcome: 'completed', note: '核对会议ID，已是11:00–12:00' }), store.verifyAction(id, item.id, { outcome: 'completed', note: '核对会议ID，已是11:00–12:00' })])
  const final = await until(() => store.get(id), idle), receipt = final.approvals.items[0].receipt
  assert.equal(receipt.source, 'authenticated-user-verification'); assert.equal(receipt.result.data.source, receipt.source)
  assert.equal(receipt.result.data.independentlyVerified, false); assert.equal(receipt.result.data.event, undefined)
  assert.equal(final.callUsage.toolCalls, usage.toolCalls); assert.equal(requests.length, 2); assert.equal(writes.length, 0)
  assert.equal(requests[0].message, saved.waiting.messages.find((x) => x.id === saved.inputId).content)
  assert.equal(requests[1].message, '排队消息不是核实完成，也不是重新操作批准')
  assert.match(requests[0].context.systemPrompt, /authenticated-user-verification/)
  assert.match(JSON.stringify(requests[0].context.messages), /核对会议ID/)
  assert.equal(final.messages.find((x) => x.id === queued.messageId).deliveryStatus, 'completed')
  assert.equal((await calendar(store)).revision, 1)
  assert.equal((await audits(store, final.conversationId, 'pidot.approval-executed')).length, 1)
  await assert.rejects(store.verifyAction(id, item.id, { outcome: 'retry', note: '改成重做' }), (e) => e.code === 'ACTION_ALREADY_VERIFIED')
})
for (const scenario of ['verification', 'retry', 'receipt', 'cancel']) test(`ISS21 SIGKILL ${scenario} saved: restore response without consuming or dispatching twice`, { timeout: 20000 }, async (t) => {
  const { store, saved, requests, writes, open } = await fixture(t, scenario), id = saved.taskId
  if (scenario === 'cancel') {
    const final = await until(() => store.get(id), (x) => x.runtime.disposition === 'ended')
    assert.ok(final.cancellation); assert.equal(final.approvals.items[0].receipt, null)
    await assert.rejects(store.verifyAction(id, final.approvals.items[0].id, { outcome: 'completed', note: '旧回应' }), (e) => e.code === 'TASK_CANCELLED')
  } else if (scenario === 'retry') {
    const task = await until(() => store.get(id), (x) => x.approvals.items.length === 2 && x.runtime.checkpoint.approvalId === x.approvals.activeId)
    assert.equal(task.approvals.items[0].receipt, null); assert.equal(task.approvals.items[1].decision, null)
    assert.deepEqual(task.approvals.items[1].arguments, task.approvals.items[0].arguments); assert.equal(task.waiting.kind, 'approval'); assert.equal(requests.length, 0)
  } else {
    const task = await until(() => store.get(id), idle)
    assert.equal(task.approvals.items[0].receipt.source, scenario === 'verification' ? 'authenticated-user-verification' : 'tool')
    assert.equal(requests.length, 1); assert.equal(task.callUsage.toolCalls, 4)
    assert.equal((await audits(store, task.conversationId, 'pidot.approval-executed')).length, 1)
  }
  assert.equal(writes.length, 0); assert.equal((await calendar(store)).revision, 1)
  const n = requests.length; await store.close(); const reopened = await open(); await delay(70)
  assert.equal(requests.length, n); assert.equal(writes.length, 0); assert.equal((await calendar(reopened)).revision, 1)
})
test('ISS21 retry is not a write: new exact approval, explicit duplicate-risk acknowledgment, unchanged original unknown record', { timeout: 20000 }, async (t) => {
  const { store, saved, writes } = await fixture(t, 'intent'), id = saved.taskId
  const task = await until(() => store.get(id), unknown), original = task.approvals.items[0]
  await store.verifyAction(id, original.id, { outcome: 'retry', note: '仍未知，但要求再次执行这个精确操作' })
  const pending = await until(() => store.get(id), (x) => x.approvals.items.length === 2 && x.runtime.checkpoint.approvalId === x.approvals.activeId), retry = pending.approvals.items[1]
  await delay(60); assert.equal(writes.length, 0); assert.equal((await calendar(store)).revision, 0)
  assert.notEqual(retry.binding, original.binding); assert.deepEqual(retry.arguments, original.arguments); assert.equal(retry.retryOf.operationId, original.operation.id)
  assert.match(retry.duplicateRisk, /重复/)
  await assert.rejects(store.decideApproval(id, retry.id, { decision: 'approved' }), (e) => e.code === 'DUPLICATE_RISK_ACK_REQUIRED')
  await store.decideApproval(id, retry.id, { decision: 'approved', acknowledgeDuplicateRisk: true, reason: '理解重复风险，批准相同精确参数' })
  const final = await until(() => store.get(id), idle)
  assert.equal(writes.length, 1); assert.notEqual(writes[0].id, original.operation.id)
  assert.equal(final.approvals.items[0].receipt, null); assert.equal(final.approvals.items[0].status, 'outcome-unknown')
  assert.equal(final.approvals.items[1].receipt.result.ok, true); assert.equal((await calendar(store)).revision, 1)
})
for (const mode of ['reject', 'revoke', 'budget', 'conflict']) test(`ISS21 exact retry ${mode}: current safeguards still apply`, { timeout: 20000 }, async (t) => {
  const { store, saved, writes } = await fixture(t, mode === 'conflict' ? 'effect' : 'intent'), id = saved.taskId
  const original = (await until(() => store.get(id), unknown)).approvals.items[0]
  await store.verifyAction(id, original.id, { outcome: 'retry', note: '请求重新操作' })
  const task = await until(() => store.get(id), (x) => x.approvals.items.length === 2 && x.runtime.checkpoint.approvalId === x.approvals.activeId), retry = task.approvals.items[1]
  if (mode === 'revoke') await store.revokeTool('calendar', 'calendar_reschedule_event')
  if (mode === 'budget') { const { TaskCard } = await import('./tasks.mjs'); await store.harness.commit(async (tx) => { (await tx.doc(TaskCard, id)).parameters.callLimits.toolCalls = task.callUsage.toolCalls }, ctx) }
  await store.decideApproval(id, retry.id, { decision: mode === 'reject' ? 'rejected' : 'approved', ...(mode === 'reject' ? {} : { acknowledgeDuplicateRisk: true }) })
  const final = await until(() => store.get(id), (x) => x.approvals.items[1].receipt !== null)
  const code = final.approvals.items[1].receipt.result.error.code
  assert.equal(code, { reject: 'APPROVAL_REJECTED', revoke: 'TOOL_NOT_AUTHORIZED', budget: 'CALL_LIMIT_REACHED', conflict: 'CALENDAR_CONFLICT' }[mode])
  assert.equal(writes.length, 0); assert.equal(final.approvals.items[0].receipt, null)
  assert.equal((await calendar(store)).revision, mode === 'conflict' ? 1 : 0)
})
test('ISS21 authenticated verify HTTP: exact Task/item, strict schema, uncertain and completed decisions', { timeout: 20000 }, async (t) => {
  const { store, saved } = await fixture(t), id = saved.taskId, task = await until(() => store.get(id), unknown), item = task.approvals.items[0]
  const server = createApiServer({ token: 'verify-secret', tasks: store }); await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => server.close(r)))
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${id}/approvals/${item.id}/verify`
  const send = (body, auth = true, target = url) => fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer verify-secret' } : {}) }, body: JSON.stringify(body) })
  assert.equal((await send({ outcome: 'completed', note: '已核实' }, false)).status, 401)
  for (const body of [{ outcome: 'completed' }, { outcome: 'failed', note: '猜测失败' }, { outcome: 'retry', note: '重做', arguments: item.arguments }, { outcome: 'completed', note: ' ' }, { outcome: 'completed', note: 'x'.repeat(2001) }]) assert.equal((await send(body)).status, 400)
  const other = await store.create({ botId: 'calendar' })
  assert.equal((await send({ outcome: 'completed', note: '错Task' }, true, url.replace(`/tasks/${id}/`, `/tasks/${other.taskId}/`))).status, 404)
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer verify-secret' } })).status, 405)
  assert.equal((await send({ outcome: 'unknown', note: '仍无法确定' })).status, 200)
  assert.equal((await store.get(id)).waiting.status, 'pending')
  assert.equal((await send({ outcome: 'completed', note: '核对该事件已改期' })).status, 200)
  await until(() => store.get(id), idle)
  assert.equal((await send({ outcome: 'completed', note: '核对该事件已改期' })).status, 200)
  assert.equal((await send({ outcome: 'retry', note: '更改决定' })).status, 409)
})
test('ISS21 tampered operation parameters cannot be attested as the original action', { timeout: 20000 }, async (t) => {
  const { store, saved, requests, writes } = await fixture(t), id = saved.taskId
  const task = await until(() => store.get(id), unknown), item = task.approvals.items[0]
  await store.harness.commit(async (tx) => { (await tx.doc(TaskApprovals, id)).items[0].operation.arguments.start = '2026-10-20T14:30:00+08:00' }, ctx)
  await assert.rejects(store.verifyAction(id, item.id, { outcome: 'completed', note: '试图替换参数' }), (e) => e.code === 'ACTION_BINDING_MISMATCH')
  assert.equal(requests.length, 0); assert.equal(writes.length, 0); assert.equal((await store.get(id)).approvals.items[0].receipt, null)
})

test('ISS21 dispatch interrupted after effect and cancellation retains a late real receipt without resuming', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss21-late-'))
  let notify, release, store, models = 0
  const started = new Promise((resolve) => { notify = resolve }), held = new Promise((resolve) => { release = resolve })
  t.after(async () => { release(); if (store) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const args = { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' }
  store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => {
    models++
    const [name, parameters] = models === 1 ? ['calendar_read_schedule', { date: '2026-10-20', resource: args.resource }] : models === 2 ? ['calendar_read_event', { eventId: args.eventId, resource: args.resource }] : ['calendar_reschedule_event', args]
    const calls = [{ type: 'toolCall', id: `call-${models}`, name, arguments: parameters }]
    return { ...answer, reply: { content: '' }, toolCalls: calls, assistant: { role: 'assistant', content: calls, provider: 'fixture', api: 'openai-completions', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
  }, calendarWriteImpl: async (_operation, { execute }) => { const result = await execute(); notify(); await held; return result } })
  const task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, '模拟改期')
  const pending = await until(() => store.get(task.taskId), (x) => x.runtime.checkpoint?.phase === 'awaitApproval')
  await store.decideApproval(task.taskId, pending.approvals.activeId, { decision: 'approved' }); await started
  const inFlight = await store.get(task.taskId)
  assert.equal(inFlight.approvals.items[0].receipt, null); assert.equal((await calendar(store)).revision, 1)
  await store.cancel(task.taskId, {}); release()
  const cancelled = await until(() => store.get(task.taskId), (x) => x.runtime.disposition === 'ended' && x.approvals.items[0].receipt !== null)
  assert.ok(cancelled.cancellation); assert.equal(cancelled.approvals.items[0].receipt.source, 'tool')
  assert.equal(cancelled.approvals.items[0].receipt.result.ok, true); assert.equal(models, 3); assert.equal((await calendar(store)).revision, 1)
  await assert.rejects(store.verifyAction(task.taskId, pending.approvals.activeId, { outcome: 'completed', note: '迟到核实' }), (e) => e.code === 'TASK_CANCELLED')
})

test('ISS21 verification records completion but cannot undo revocation, replenish usage or bypass exhausted model limits', { timeout: 20000 }, async (t) => {
  const { store, saved, requests, writes } = await fixture(t), id = saved.taskId, task = await until(() => store.get(id), unknown)
  await store.revokeTool('calendar', 'calendar_reschedule_event')
  const { TaskCard } = await import('./tasks.mjs')
  await store.harness.commit(async (tx) => { (await tx.doc(TaskCard, id)).parameters.callLimits.modelCalls = task.callUsage.modelCalls }, ctx)
  await store.verifyAction(id, task.approvals.activeId, { outcome: 'completed', note: '用户核对原操作确已完成，不申请新权限或预算' })
  const final = await until(() => store.get(id), (x) => x.runtime.checkpoint?.lastOutcome === 'limited')
  assert.equal(final.approvals.items[0].receipt.source, 'authenticated-user-verification'); assert.deepEqual(final.callUsage, task.callUsage)
  assert.equal(requests.length, 0); assert.equal(writes.length, 0); assert.ok(!(final.toolSets.authorized.includes('calendar_reschedule_event')))
  assert.equal((await calendar(store)).revision, 1)
})
