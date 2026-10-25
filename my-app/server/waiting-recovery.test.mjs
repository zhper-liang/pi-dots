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
import { MockCalendar } from './approvals.mjs'
import { createApiServer } from './app.mjs'
import { readMockSchedule } from './tools.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'waiting-recovery-fixture', apiKey: 'fixture-only' }
const answer = { mode: 'model', reply: { content: '已按原事项和真实回执继续，仅模拟数据。' }, execution: { usage: { totalTokens: 7, input: 5, output: 2 } } }
const idle = (task) => task.activeInputId === null && task.queueLength === 0 && task.runtime.disposition === 'idle'
async function until(read, predicate = Boolean) {
  for (let n = 0; n < 800; n++) { const value = await read(); if (predicate(value)) return value; await delay(10) }
  throw new Error('ISS20 expected checkpoint not reached')
}
async function fixture(t, scenario, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss20-')), file = join(dir, 'task.sqlite'), stores = []
  const child = spawn(process.execPath, [new URL('./fixtures/waiting-recovery-process.mjs', import.meta.url).pathname, dir, scenario], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit'); let output = ''
  child.stdout.on('data', (x) => { output += x }); child.stderr.on('data', (x) => { output += x })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    for (const store of stores) await store.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  const saved = await until(async () => {
    if (child.exitCode !== null) throw new Error(output)
    try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null }
  })
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  const requests = [], before = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  let reads = 0
  const open = async () => { const store = await openTaskStore({ file, bots: listBots(config), modelReply: async (message, opts) => {
    requests.push({ message, context: opts.context }); return options.modelReply ? options.modelReply(message, opts) : answer
  }, toolImpl: async (args) => { reads++; return readMockSchedule(args) } }); stores.push(store); return store }
  return { store: await open(), open, saved, requests, before, reads: () => reads }
}
const calendar = (store) => store.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(MockCalendar))), ctx)
const audits = (store, id, kind) => store.harness.commit(async (tx) => { const all = []; let cursor; do { const page = await tx.scanEntries({ conversationId: id }, 100, cursor); all.push(...page.items.filter((x) => x.kind === kind)); cursor = page.next } while (cursor); return all }, ctx)
for (const scenario of ['blocker-pending', 'approval-pending', 'limits-pending']) test(`ISS20 SIGKILL ${scenario}: original wait survives without implicit consent or budget`, { timeout: 20000 }, async (t) => {
  const { store, saved, requests, before, open } = await fixture(t, scenario), id = saved.taskId
  await delay(80); const restored = await store.get(id)
  assert.equal(requests.length, 0); assert.equal(restored.runtime.disposition, 'waiting')
  assert.equal(restored.conversationId, saved.conversationId); assert.deepEqual(restored.configRef, saved.waiting.configRef)
  assert.deepEqual(restored.callUsage, saved.waiting.callUsage); assert.deepEqual(restored.effectiveCallLimits, saved.waiting.effectiveCallLimits)
  assert.equal(restored.waiting.inputId, saved.inputId); assert.equal(restored.waiting.status, 'pending')
  assert.deepEqual(restored.recoveryHistory[0].waiting, saved.waiting.waiting)
  assert.deepEqual((await calendar(store)).events, {})
  if (scenario.startsWith('blocker')) {
    const item = restored.blockers.items[0]; assert.deepEqual(item, saved.waiting.blockers.items[0])
    await store.resolveBlocker(id, item.id, { answer: '2026-10-20，Asia/Shanghai' })
    await until(() => store.get(id), idle)
    assert.match(JSON.stringify(requests[0].context.messages), /2026-10-20，Asia\/Shanghai/)
    assert.equal((await audits(store, saved.conversationId, 'pidot.blocker-reported')).length, 1)
    assert.equal((await audits(store, saved.conversationId, 'pidot.blocker-resolved')).length, 1)
  } else if (scenario.startsWith('approval')) {
    const item = restored.approvals.items[0]; assert.deepEqual(item, saved.waiting.approvals.items[0])
    await store.decideApproval(id, item.id, { decision: 'approved', reason: '重启后明确批准' })
    const final = await until(() => store.get(id), idle)
    assert.equal(final.approvals.items[0].status, 'executed'); assert.equal((await calendar(store)).revision, 1)
    assert.equal(final.callUsage.toolCalls, 4); assert.equal(final.callUsage.modelCalls, 4)
    assert.equal(final.callUsage.totalTokens, 25)
    await store.decideApproval(id, item.id, { decision: 'approved', reason: '重启后明确批准' })
    assert.equal((await calendar(store)).revision, 1)
  } else {
    await store.send(id, '普通消息不能续额')
    await delay(40); assert.equal(requests.length, 0)
    await assert.rejects(store.raiseLimits(id, { modelCalls: 1 }), (e) => ['LIMITS_STILL_BLOCKED', 'INVALID_CALL_LIMITS'].includes(e.code))
    await store.raiseLimits(id, { modelCalls: 5 })
    const final = await until(() => store.get(id), idle)
    assert.deepEqual(requests.map((x) => x.message), [saved.waiting.messages.find((x) => x.id === saved.inputId).content, '普通消息不能续额'])
    assert.equal(final.callUsage.modelCalls, before.filter((x) => x.kind === 'model').length + 2)
    assert.equal(final.callUsage.toolCalls, saved.waiting.callUsage.toolCalls)
  }
  const done = await store.get(id); assert.equal(done.taskId, id); assert.equal(done.callUsage.unknownTokenCalls, 0)
  await store.close(); const n = requests.length; const reopened = await open(); await delay(40)
  assert.equal(requests.length, n); assert.equal((await reopened.get(id)).runtime.disposition, 'idle')
})
for (const scenario of ['blocker-answered', 'blocker-continued', 'approval-approved', 'approval-rejected', 'approval-executed', 'limits-raised']) test(`ISS20 SIGKILL ${scenario}: use saved response once, continue original input`, { timeout: 20000 }, async (t) => {
  const { store, saved, requests, reads, open } = await fixture(t, scenario)
  const final = await until(() => store.get(saved.taskId), idle)
  assert.equal(requests.length, 1); assert.equal(reads(), 0); assert.equal(final.taskId, saved.taskId)
  assert.equal(final.callUsage.totalTokens, saved.waiting.callUsage.totalTokens + 7)
  if (scenario.startsWith('blocker')) {
    assert.equal(final.blockers.items.length, 1); assert.equal(final.blockers.items[0].status, 'resolved')
    assert.equal((await audits(store, saved.conversationId, 'pidot.blocker-resolved')).length, 1)
    assert.match(JSON.stringify(requests[0].context.messages), /2026-10-20，Asia\/Shanghai/)
  } else if (scenario.startsWith('approval')) {
    assert.equal(final.approvals.items.length, 1)
    assert.equal(final.approvals.items[0].status, scenario === 'approval-rejected' ? 'rejected' : 'executed')
    assert.equal((await calendar(store)).revision, scenario === 'approval-rejected' ? 0 : 1)
    assert.equal((await audits(store, saved.conversationId, 'pidot.approval-decided')).length, 1)
    assert.equal((await audits(store, saved.conversationId, 'pidot.approval-executed')).length, 1)
    assert.match(JSON.stringify(requests[0].context.messages), /重启前保存的决定/)
  } else {
    assert.equal(final.callLimitHistory.length, 1); assert.equal(final.effectiveCallLimits.modelCalls, 5)
    assert.equal(final.recoveryHistory[0].waiting.status, 'response-saved')
    assert.equal(final.recoveryHistory[0].disposition, 'resumable')
  }
  await store.close(); const reopened = await open(); await delay(40)
  assert.equal(requests.length, 1); assert.equal((await reopened.get(saved.taskId)).taskId, saved.taskId)
})
test('saved approval never bypasses revocation applied during wait', { timeout: 20000 }, async (t) => {
  const { store, saved } = await fixture(t, 'approval-revoked')
  const final = await until(() => store.get(saved.taskId), idle)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'TOOL_NOT_AUTHORIZED')
  assert.deepEqual((await calendar(store)).events, {}); assert.equal(final.callUsage.toolCalls, 3)
})
test('approved but exhausted tool budget remains limited, explicit raise preserves counters and cannot reuse old approval', { timeout: 20000 }, async (t) => {
  const { store, saved, requests } = await fixture(t, 'approval-budget')
  const limited = await until(() => store.get(saved.taskId), (x) => x.runtime.checkpoint.lastOutcome === 'limited')
  assert.equal(limited.approvals.items[0].receipt.result.error.code, 'CALL_LIMIT_REACHED')
  assert.equal(limited.callUsage.toolCalls, 3); assert.equal(requests.length, 0)
  assert.deepEqual((await calendar(store)).events, {})
  await store.raiseLimits(saved.taskId, { toolCalls: 8 })
  const final = await until(() => store.get(saved.taskId), idle)
  assert.equal(final.callUsage.toolCalls, 3); assert.equal(final.callUsage.modelCalls, 4)
  assert.deepEqual((await calendar(store)).events, {})
  assert.equal(final.approvals.items[0].status, 'not-executed')
})
for (const scenario of ['approval-cancelled', 'blocker-cancelled', 'limits-cancelled']) test(`ISS20 ${scenario}: persisted cancellation forbids any stale response`, { timeout: 20000 }, async (t) => {
  const { store, saved, requests } = await fixture(t, scenario)
  const final = await until(() => store.get(saved.taskId), (x) => x.runtime.status === 'terminal')
  assert.equal(final.runtime.outcome.status, 'aborted'); assert.equal(requests.length, 0)
  if (scenario.startsWith('approval')) await assert.rejects(store.decideApproval(saved.taskId, saved.waiting.approvals.activeId, { decision: 'approved' }), { code: 'TASK_CANCELLED' })
  else if (scenario.startsWith('blocker')) await assert.rejects(store.resolveBlocker(saved.taskId, saved.waiting.blockers.activeId, { answer: '2026-10-20' }), { code: 'TASK_CANCELLED' })
  else await assert.rejects(store.raiseLimits(saved.taskId, { modelCalls: 5 }), { code: 'TASK_CANCELLED' })
  assert.deepEqual((await calendar(store)).events, {})
})
test('answered problem retains exhausted budget; ordinary answer cannot grant model attempts', { timeout: 20000 }, async (t) => {
  const { store, saved, requests } = await fixture(t, 'blocker-budget')
  await store.resolveBlocker(saved.taskId, saved.waiting.blockers.activeId, { answer: '2026-10-20，Asia/Shanghai' })
  const limited = await until(() => store.get(saved.taskId), (x) => x.runtime.checkpoint.lastOutcome === 'limited')
  assert.equal(requests.length, 0); assert.equal(limited.callUsage.modelCalls, 1)
  assert.equal(limited.blockers.items[0].status, 'resolved')
  await store.raiseLimits(saved.taskId, { modelCalls: 5 }); const final = await until(() => store.get(saved.taskId), idle)
  assert.equal(final.callUsage.modelCalls, 2); assert.equal(final.blockers.items.length, 1)
})
test('recovered HTTP approval targets the original item, authenticates and rejects parameter changes', { timeout: 20000 }, async (t) => {
  const { store, saved } = await fixture(t, 'approval-pending')
  const server = createApiServer({ token: 'iss20-test-token', tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/tasks/`, id = saved.waiting.approvals.activeId
  const request = (taskId, itemId, body, auth = true) => fetch(`${base}${taskId}/approvals/${itemId}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer iss20-test-token' } : {}) }, body: JSON.stringify(body) })
  assert.equal((await request(saved.taskId, id, { decision: 'approved' }, false)).status, 401)
  const other = await store.create({ botId: 'calendar' })
  assert.equal((await request(other.taskId, id, { decision: 'approved' })).status, 404)
  assert.equal((await request(saved.taskId, id, { decision: 'approved', arguments: {} })).status, 400)
  assert.equal((await request(saved.taskId, id, { decision: 'approved' })).status, 200)
  await until(() => store.get(saved.taskId), idle)
  assert.equal((await request(saved.taskId, id, { decision: 'approved' })).status, 200)
  assert.equal((await calendar(store)).revision, 1)
})

test('recovered approval detects changed parameters instead of using an old binding', { timeout: 20000 }, async (t) => {
  const { store, saved } = await fixture(t, 'approval-binding')
  const final = await until(() => store.get(saved.taskId), idle)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'APPROVAL_BINDING_MISMATCH')
  assert.deepEqual((await calendar(store)).events, {})
})
test('permission revoked while problem waits is checked again after the answer, not restored from old context', { timeout: 20000 }, async (t) => {
  let n = 0
  const { store, saved, reads } = await fixture(t, 'blocker-pending', { modelReply: async () => {
    if (n++ > 0) return answer
    const calls = [{ type: 'toolCall', id: 'denied-read', name: 'calendar_read_schedule', arguments: { date: '2026-10-20', resource: 'mock:personal' } }]
    return { ...answer, toolCalls: calls, assistant: { role: 'assistant', content: calls, provider: 'bb-api', api: 'openai-completions', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
  } })
  await store.revokeTool('calendar', 'calendar_read_schedule')
  await store.resolveBlocker(saved.taskId, saved.waiting.blockers.activeId, { answer: '2026-10-20，Asia/Shanghai' })
  const final = await until(() => store.get(saved.taskId), idle)
  assert.equal(reads(), 0)
  assert.equal(final.messages.find((x) => x.callId === 'denied-read').result.error.code, 'TOOL_NOT_AUTHORIZED')
  assert.equal(final.blockers.items.length, 1)
})

for (const scenario of ['limits-token', 'limits-unknown']) test(`ISS20 ${scenario}: persisted token limit requires explicit safe change`, { timeout: 20000 }, async (t) => {
  const { store, saved, requests } = await fixture(t, scenario)
  await delay(50); assert.equal(requests.length, 0)
  const restored = await store.get(saved.taskId)
  assert.equal(restored.runtime.checkpoint.waitingReason, 'totalTokens')
  assert.equal(restored.waiting.limits.totalTokens, 6)
  if (scenario === 'limits-unknown') {
    assert.equal(restored.callUsage.unknownTokenCalls, 1)
    await assert.rejects(store.raiseLimits(saved.taskId, { totalTokens: 100 }), { code: 'LIMITS_STILL_BLOCKED' })
    await store.raiseLimits(saved.taskId, { totalTokens: null })
  } else await store.raiseLimits(saved.taskId, { totalTokens: 100 })
  const final = await until(() => store.get(saved.taskId), idle)
  assert.equal(final.callUsage.modelCalls, 2); assert.equal(final.callUsage.unknownTokenCalls, scenario === 'limits-unknown' ? 1 : 0)
  assert.equal(final.callUsage.totalTokens, scenario === 'limits-unknown' ? 7 : 13)
})

for (const scenario of ['approval-inserted', 'approval-insert-submitted']) test(`SIGKILL ${scenario}: locked choice and inserted requirement survive without executing old intent`, { timeout: 20000 }, async (t) => {
  const { store, saved, requests } = await fixture(t, scenario), id = saved.taskId, approvalId = saved.waiting.approvals.activeId
  if (scenario === 'approval-inserted') {
    await delay(80)
    const task = await store.get(id)
    assert.equal(task.waiting.status, 'insertion-pending'); assert.equal(requests.length, 0)
    assert.equal(task.approvals.items[0].decision.decision, 'inserted')
    await assert.rejects(store.decideApproval(id, approvalId, { decision: 'approved' }), { code: 'APPROVAL_ALREADY_DECIDED' })
    await store.submitApprovalInsertion(id, approvalId, { message: '改到下午，重新审批' })
  }
  const final = await until(() => store.get(id), idle)
  assert.equal(final.approvals.items[0].receipt.result.error.code, 'APPROVAL_SUPERSEDED')
  assert.ok(final.taskState.constraints.includes('改到下午，重新审批'))
  assert.equal(requests.length, 1); assert.deepEqual((await calendar(store)).events, {})
  assert.equal(final.messages.filter((x) => x.role === 'user' && x.content === '改到下午，重新审批').length, 1)
})
