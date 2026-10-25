import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { TaskCard } from './tasks.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { TaskApprovals, MockCalendar, calendarQueryCapability } from './approvals.mjs'
import { CallUsage, ToolAccess } from './tools.mjs'
import { createApiServer } from './app.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'query-fixture', apiKey: 'fixture-only' }
const answer = { mode: 'model', reply: { content: '工具已按原操作ID查询确认完成并补录，未重放写入。' }, execution: { usage: { totalTokens: 7, input: 5, output: 2 } } }
async function until(read, predicate = Boolean) { for (let n = 0; n < 2000; n++) { const x = await read(); if (predicate(x)) return x; await delay(5) }; throw new Error('Expected query checkpoint not reached') }
const idle = (x) => x.runtime.checkpoint?.phase === 'awaitInput' && x.runtime.checkpoint.lastOutcome === 'completed'
const stopped = (x) => Boolean(x.approvals.items[0]?.operation?.query?.stopped)
const calendar = (s) => s.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(MockCalendar))), ctx)
async function fixture(t, scenario = 'effect', mutate) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss22-')), file = join(dir, 'task.sqlite'), stores = [], requests = [], writes = [], queries = []
  const child = spawn(process.execPath, [new URL('./fixtures/unknown-action-process.mjs', import.meta.url).pathname, dir, scenario], { env: { ...process.env, PIDOT_QUERY_FIXTURE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const dead = once(child, 'exit'); let output = ''
  child.stdout.on('data', (x) => { output += x }); child.stderr.on('data', (x) => { output += x })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await dead }; for (const s of stores) await s.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const saved = await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null } })
  child.kill('SIGKILL'); assert.equal((await dead)[1], 'SIGKILL')
  // Optional mutations occur before scheduler start through a no-query reopen.
  if (mutate) {
    const s = await openTaskStore({ file, bots: listBots(config), calendarQueryImpl: async () => ({ status: 'unknown' }) }); stores.push(s)
    await until(() => s.get(saved.taskId), stopped)
    await s.harness.commit(async (tx) => {
      const item = (await tx.doc(TaskApprovals, saved.taskId)).items[0]
      // Reset ONLY test query history/usage, to stage current guards before next reopen.
      item.operation.query = { attempts: [], stopped: null }; (await tx.doc(CallUsage, saved.taskId)).toolCalls = 4
      await mutate(tx, s, saved)
    }, ctx)
    await s.close()
  }
  async function open(options = {}) {
    const s = await openTaskStore({ file, bots: listBots(config), modelReply: async (message, options) => { requests.push({ message, context: options.context }); return answer },
      calendarWriteImpl: async (op, { execute }) => { writes.push(op); return execute() },
      calendarQueryImpl: async (request, helpers) => { queries.push(request); return options.query ? options.query(request, helpers) : helpers.execute() } })
    stores.push(s); return s
  }
  return { file, dir, saved, open, requests, writes, queries }
}

test('ISS22 SIGKILL effect before receipt: query exact original operation, source receipt, continue once and never redispatch', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), s = await f.open(), id = f.saved.taskId
  const task = await until(() => s.get(id), idle), item = task.approvals.items[0]
  assert.deepEqual(item.operation.capabilities, calendarQueryCapability)
  assert.equal(item.operation.id, f.saved.operation.id); assert.deepEqual(item.arguments, f.saved.operation.arguments)
  assert.equal(item.receipt.source, 'tool-result-query'); assert.equal(item.receipt.result.data.independentlyVerified, true)
  assert.equal(item.receipt.result.data.evidence.operationId, item.operation.id); assert.equal(item.operation.query.attempts.length, 1)
  assert.equal(item.operation.query.attempts[0].status, 'completed'); assert.equal(f.queries.length, 1); assert.equal(f.writes.length, 0)
  assert.equal(f.requests.length, 1); assert.match(JSON.stringify(f.requests[0].context.messages), /tool-result-query/)
  assert.equal(task.callUsage.toolCalls, 5); assert.equal(task.callUsage.modelCalls, 4); assert.equal((await calendar(s)).revision, 1)
  const receiptId = item.receipt.id; await s.close(); const again = await f.open(); await delay(90)
  assert.equal((await again.get(id)).approvals.items[0].receipt.id, receiptId); assert.equal(f.queries.length, 1); assert.equal(f.requests.length, 1)
})

test('ISS22 SIGKILL intent before effect: absent ledger != failed, three queries then same quiet wait across restarts', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, 'intent'), s = await f.open(), id = f.saved.taskId
  const task = await until(() => s.get(id), stopped), item = task.approvals.items[0]
  assert.equal(item.receipt, null); assert.equal(item.operation.query.attempts.length, 3)
  assert.ok(item.operation.query.attempts.every((x) => x.status === 'unknown'))
  assert.equal(item.operation.query.stopped.reason, 'QUERY_ATTEMPTS_EXHAUSTED'); assert.equal(task.waiting.kind, 'action-outcome'); assert.equal(task.runtime.disposition, 'waiting')
  assert.equal(task.callUsage.toolCalls, 7); assert.equal((await calendar(s)).revision, 0)
  assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0)
  await s.send(id, '普通消息不是查询结果或批准'); await delay(120); assert.equal(f.queries.length, 3)
  await s.close(); const again = await f.open(); await delay(120)
  assert.equal((await again.get(id)).callUsage.toolCalls, 7); assert.equal(f.queries.length, 3); assert.equal(f.requests.length, 0)
  await again.verifyAction(id, item.id, { outcome: 'unknown', note: '仍不确定' }); await delay(80); assert.equal(f.queries.length, 3)
})

for (const mode of ['error', 'wrong-operation', 'similar-event', 'wrong-arguments', 'wrong-task', 'bad-schema']) test(`ISS22 ${mode}: no invented success, bounded queries, user verification keeps distinct source`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t), s = await f.open({ query: async (_r, { execute }) => {
    if (mode === 'error') throw new Error('secret-should-not-persist')
    const result = await execute()
    if (mode === 'wrong-operation') result.evidence.operationId = 'similar-but-not-original'
    if (mode === 'similar-event') return { status: 'completed', evidence: { event: result.evidence.event } }
    if (mode === 'wrong-arguments') result.evidence.arguments.start = '2026-10-20T11:30:00+08:00'
    if (mode === 'wrong-task') result.evidence.taskId++
    if (mode === 'bad-schema') result.evidence.secret = 'must-not-persist'
    return result
  } }), id = f.saved.taskId
  const task = await until(() => s.get(id), stopped), item = task.approvals.items[0]
  assert.equal(item.receipt, null); assert.equal(f.queries.length, 3); assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0)
  assert.ok(!JSON.stringify(task).includes('secret-should-not-persist')); assert.ok(!JSON.stringify(task).includes('must-not-persist'))
  await s.verifyAction(id, item.id, { outcome: 'completed', note: '用户手工核对原会议已完成' })
  const final = await until(() => s.get(id), idle)
  assert.equal(final.approvals.items[0].receipt.source, 'authenticated-user-verification'); assert.equal(final.approvals.items[0].receipt.result.data.independentlyVerified, false)
  assert.equal(final.approvals.items[0].operation.query.attempts.length, 3); assert.equal((await calendar(s)).revision, 1)
})

for (const mode of ['revoked-write', 'revoked-read', 'resource', 'budget', 'tokens', 'identity', 'binding', 'capabilities', 'pool-write', 'pool-resource', 'bot-write', 'bot-resource']) test(`ISS22 current ${mode} prevents recovery calls and does not replay writes`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t, 'effect', async (tx, s, saved) => {
    const card = await tx.doc(TaskCard, saved.taskId), item = (await tx.doc(TaskApprovals, saved.taskId)).items[0]
    if (mode.startsWith('revoked')) { const { ToolAccess } = await import('./tools.mjs'); (await tx.doc(ToolAccess)).revoked.calendar = [mode === 'revoked-write' ? 'calendar_reschedule_event' : 'calendar_read_event'] }
    const access = await tx.doc(ToolAccess)
    if (mode === 'resource') access.assignments.calendar.resources = []
    if (mode === 'pool-write' || mode === 'bot-write') access.assignments.calendar.tools = access.assignments.calendar.tools.filter((n) => n !== 'calendar_reschedule_event')
    if (mode === 'pool-resource' || mode === 'bot-resource') access.assignments.calendar.resources = []
    if (mode === 'budget') card.parameters.callLimits.toolCalls = 4
    if (mode === 'tokens') { card.parameters.callLimits.totalTokens = 999; (await tx.doc(CallUsage, saved.taskId)).unknownTokenCalls = 1 }
    if (mode === 'identity') card.bot.id = 'chief'
    if (mode === 'binding') item.operation.arguments.start = '2026-10-20T11:30:00+08:00'
    if (mode === 'capabilities') item.operation.capabilities.query.maxAttempts = 999
  }), s = await f.open(), task = await until(() => s.get(f.saved.taskId), stopped)
  assert.equal(f.queries.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.requests.length, 0)
  assert.equal(task.approvals.items[0].receipt, null); assert.equal(task.callUsage.toolCalls, 4)
})

test('ISS22 three timeouts remain bounded and never store transport result as success', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), s = await f.open({ query: () => new Promise(() => {}) })
  const task = await until(() => s.get(f.saved.taskId), stopped)
  assert.deepEqual(task.approvals.items[0].operation.query.attempts.map((x) => x.status), ['timeout', 'timeout', 'timeout'])
  assert.equal(task.approvals.items[0].receipt, null); assert.equal(task.callUsage.toolCalls, 7); assert.equal(f.writes.length, 0)
})

test('ISS22 API exposes query evidence only with auth; user cannot replace querying result; cancellation stays terminal', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); let release, started
  const held = new Promise((r) => { release = r }), ready = new Promise((r) => { started = r })
  const s = await f.open({ query: async (_r, { execute }) => { const result = await execute(); started(); await held; return result } }), id = f.saved.taskId
  await ready
  const task = await s.get(id), server = createApiServer({ token: 'query-test-token', tasks: s })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => server.close(r)))
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${id}`
  assert.equal((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: { Authorization: 'Bearer query-test-token' } }); assert.equal(response.status, 200)
  assert.match(await response.text(), /querying/)
  await assert.rejects(s.verifyAction(id, task.approvals.items[0].id, { outcome: 'completed', note: '抢先猜测' }), (e) => e.code === 'ACTION_QUERY_IN_PROGRESS')
  await s.cancel(id, {}); release()
  const cancelled = await until(() => s.get(id), (x) => x.runtime.disposition === 'ended' && x.approvals.items[0].receipt)
  assert.equal(cancelled.approvals.items[0].receipt.source, 'tool-result-query'); assert.ok(cancelled.cancellation)
  assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0); assert.equal((await calendar(s)).revision, 1)
})

for (const boundary of ['query-started', 'query-returned', 'query-receipt-saved']) test(`ISS22 second SIGKILL at ${boundary}: reserved attempt persists, recover receipt without repeating write`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t), child = spawn(process.execPath, [new URL('./fixtures/query-recovery-process.mjs', import.meta.url).pathname, f.dir, boundary], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''; child.stderr.on('data', (x) => { output += x }); const dead = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await dead } })
  await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return JSON.parse(await readFile(join(f.dir, 'query-checkpoint.json'), 'utf8')) } catch { return null } })
  child.kill('SIGKILL'); assert.equal((await dead)[1], 'SIGKILL')
  const s = await f.open(), task = await until(() => s.get(f.saved.taskId), idle), item = task.approvals.items[0]
  assert.equal(item.operation.id, f.saved.operation.id); assert.equal(item.receipt.source, 'tool-result-query')
  assert.equal(item.operation.query.attempts.length, boundary === 'query-receipt-saved' ? 1 : 2)
  if (boundary !== 'query-receipt-saved') assert.equal(item.operation.query.attempts[0].status, 'interrupted')
  assert.equal(task.callUsage.toolCalls, boundary === 'query-receipt-saved' ? 5 : 6)
  assert.equal(f.queries.length, boundary === 'query-receipt-saved' ? 0 : 1); assert.equal(f.writes.length, 0); assert.equal(f.requests.length, 1)
  assert.equal((await calendar(s)).revision, 1)
})

test('ISS22 eventual query success uses original input before FIFO and survives unrelated later event state', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); let started, release
  const ready = new Promise((r) => { started = r }), held = new Promise((r) => { release = r })
  const s = await f.open({ query: async (request, { execute }) => {
    if (request.number === 1) { started(); await held; return { status: 'unknown' } }
    return execute()
  } }), id = f.saved.taskId
  await ready
  const queued = await s.send(id, '第二条输入，保持FIFO')
  await s.harness.commit(async (tx) => { (await tx.doc(MockCalendar)).events['mock-20261020-1'].title = '后来另一修改；原操作账本仍可核实' }, ctx)
  release()
  const task = await until(() => s.get(id), (x) => idle(x) && x.messages.find((m) => m.id === queued.messageId)?.deliveryStatus === 'completed')
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].message, '第二条输入，保持FIFO')
  assert.equal(task.approvals.items[0].receipt.result.data.event.title, f.saved.operation.before.title)
  assert.equal(task.approvals.items[0].operation.query.attempts.length, 2); assert.equal(task.callUsage.toolCalls, 6)
  assert.equal(f.writes.length, 0)
})

test('ISS22 similar current meeting without original ledger never confirms success; remaining query budget stops retry', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, 'intent', async (tx, _s, saved) => {
    const item = (await tx.doc(TaskApprovals, saved.taskId)).items[0], state = await tx.doc(MockCalendar)
    state.events[item.arguments.eventId] = { ...JSON.parse(JSON.stringify(item.before)), start: item.arguments.start, end: item.arguments.end }
    ;(await tx.doc(TaskCard, saved.taskId)).parameters.callLimits.toolCalls = 5
  }), s = await f.open(), task = await until(() => s.get(f.saved.taskId), stopped)
  assert.equal(task.approvals.items[0].receipt, null); assert.equal(f.queries.length, 1)
  assert.equal(task.approvals.items[0].operation.query.stopped.reason, 'CALL_LIMIT_REACHED'); assert.equal(task.callUsage.toolCalls, 5)
  assert.equal(f.writes.length, 0); assert.equal(f.requests.length, 0)
})

test('ISS22 revocation between reserved query and actual read blocks transport read and later retries', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); let started, release
  const ready = new Promise((r) => { started = r }), held = new Promise((r) => { release = r })
  const s = await f.open({ query: async (_request, { execute }) => { started(); await held; return execute() } }), id = f.saved.taskId
  await ready; await s.revokeTool('calendar', 'calendar_read_event'); release()
  const task = await until(() => s.get(id), stopped)
  assert.equal(task.approvals.items[0].receipt, null); assert.equal(task.approvals.items[0].operation.query.attempts[0].status, 'unknown')
  assert.equal(task.approvals.items[0].operation.query.stopped.reason, 'TOOL_NOT_AUTHORIZED')
  assert.equal(f.queries.length, 1); assert.equal(task.callUsage.toolCalls, 5); assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0)
})

test('ISS22 successful recovered receipt does not replenish exhausted model limit or reopen old write', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, 'effect', async (tx, _s, saved) => { (await tx.doc(TaskCard, saved.taskId)).parameters.callLimits.modelCalls = 3 })
  const s = await f.open(), task = await until(() => s.get(f.saved.taskId), (x) => x.runtime.checkpoint?.lastOutcome === 'limited')
  assert.equal(task.approvals.items[0].receipt.source, 'tool-result-query'); assert.equal(task.callUsage.modelCalls, 3); assert.equal(task.callUsage.toolCalls, 5)
  assert.equal(f.queries.length, 1); assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0)
})
