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
import { MockCalendar, calendarIdempotencyCapability, calendarWriteTool, calendarRecoveryCapability } from './approvals.mjs'
import { executeMockCalendarOperation, validIdempotentResult } from './calendar-write.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'unknown-action-fixture', apiKey: 'fixture-only' }
const answer = { mode: 'model', reply: { content: '原幂等标识恢复完成，没有第二次业务修改；仅模拟日历。' }, execution: { usage: { totalTokens: 7, input: 5, output: 2 } } }
const idle = (x) => x.runtime.checkpoint?.phase === 'awaitInput' && x.runtime.checkpoint.lastOutcome === 'completed'
const stopped = (x) => Boolean(x.approvals.items[0]?.operation?.idempotency?.stopped)
const calendar = (s) => s.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(MockCalendar))), ctx)
async function until(read, predicate = Boolean) { for (let n = 0; n < 2500; n++) { const x = await read(); if (predicate(x)) return x; await delay(5) }; throw new Error('Expected idempotency checkpoint not reached') }
async function fixture(t, { scenario = 'effect', mode = '', query = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss23-')), file = join(dir, 'task.sqlite'), stores = [], requests = [], writes = [], queries = []
  const child = spawn(process.execPath, [new URL('./fixtures/idempotency-action-process.mjs', import.meta.url).pathname, dir, scenario], {
    env: { ...process.env, PIDOT_IDEMPOTENCY_GUARD: mode, PIDOT_NO_QUERY: query ? '0' : '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const dead = once(child, 'exit'); let output = ''
  child.stdout.on('data', (x) => { output += x }); child.stderr.on('data', (x) => { output += x })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await dead }; for (const s of stores) await s.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const saved = await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null } })
  child.kill('SIGKILL'); assert.equal((await dead)[1], 'SIGKILL')
  async function open(options = {}) {
    const s = await openTaskStore({ file, bots: listBots(config), modelReply: async (message, options) => { requests.push({ message, context: options.context }); return answer },
      calendarWriteImpl: async (op, helpers) => { writes.push(JSON.parse(JSON.stringify(op))); return options.write ? options.write(op, helpers) : helpers.execute() },
      calendarQueryImpl: async (r, helpers) => { queries.push(r); return helpers.execute() } })
    stores.push(s); return s
  }
  return { dir, file, saved, open, requests, writes, queries }
}
for (const scenario of ['effect', 'intent']) test(`ISS23 SIGKILL ${scenario}: original key and exact approval, one effect, sourced receipt and continuation`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { scenario }), s = await f.open(), task = await until(() => s.get(f.saved.taskId), idle), item = task.approvals.items[0]
  assert.deepEqual(item.operation.capabilities, calendarIdempotencyCapability)
  assert.equal(item.operation.id, f.saved.operation.id); assert.deepEqual(item.arguments, f.saved.operation.arguments)
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].id, item.operation.id); assert.equal(f.queries.length, 0)
  assert.equal(item.receipt.source, 'tool-idempotent-recovery'); assert.equal(item.receipt.result.data.independentlyVerified, true)
  assert.equal(item.receipt.result.data.replayed, scenario === 'effect'); assert.equal(item.operation.idempotency.attempts[0].status, 'completed')
  assert.equal((await calendar(s)).revision, 1); assert.equal(task.callUsage.toolCalls, 5); assert.equal(task.callUsage.modelCalls, 4)
  assert.match(JSON.stringify(f.requests[0].context.messages), /tool-idempotent-recovery/)
  await s.close(); const again = await f.open(); await delay(80)
  assert.equal((await again.get(task.taskId)).approvals.items[0].receipt.id, item.receipt.id); assert.equal(f.writes.length, 1)
})
test('ISS23 tool guarantee: repeated exact key returns saved result despite later event edits; changed parameters rejected', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), op = f.saved.operation, s = await f.open(), task = await until(() => s.get(f.saved.taskId), idle), state = await calendar(s)
  state.events[op.arguments.eventId].title = '独立后续修改'
  for (let n = 0; n < 8; n++) { const response = executeMockCalendarOperation(state, op); assert.ok(response.replayed); assert.deepEqual(response.result, f.saved.result); assert.ok(validIdempotentResult(response, op)) }
  const changed = structuredClone(op); changed.arguments.start = '2026-10-20T11:30:00+08:00'
  assert.equal(executeMockCalendarOperation(state, changed).result.error.code, 'IDEMPOTENCY_KEY_CONFLICT')
  assert.equal(state.revision, 1); assert.equal(state.events[op.arguments.eventId].title, '独立后续修改'); assert.ok(task.approvals.items[0].receipt)
  const end = Date.parse(op.createdAt) + calendarIdempotencyCapability.idempotency.windowMs
  assert.equal(executeMockCalendarOperation(state, op, end).result.error.code, 'IDEMPOTENCY_WINDOW_EXPIRED')
  assert.equal(executeMockCalendarOperation(state, op, Date.parse(op.createdAt) - 1).result.error.code, 'IDEMPOTENCY_WINDOW_EXPIRED')
})
for (const mode of ['expired', 'future']) for (const query of [true, false]) test(`ISS23 ${mode} window query=${query}: never unguarded retry, fallback query/wait`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { mode, query }), s = await f.open(), task = await until(() => s.get(f.saved.taskId), query ? idle : stopped), item = task.approvals.items[0]
  assert.equal(f.writes.length, 0); assert.equal((await calendar(s)).revision, 1)
  assert.equal(item.operation.idempotency.stopped.reason, 'IDEMPOTENCY_WINDOW_EXPIRED')
  if (query) { assert.equal(item.receipt.source, 'tool-result-query'); assert.equal(f.queries.length, 1) }
  else { assert.equal(item.receipt, null); assert.equal(task.waiting.kind, 'action-outcome'); await s.send(task.taskId, '不要当作批准'); await delay(60); assert.equal(f.writes.length, 0) }
})
for (const mode of ['revoked-write', 'resource', 'budget', 'tokens', 'identity', 'binding', 'capabilities', 'pool-write', 'pool-resource', 'bot-write', 'bot-resource']) test(`ISS23 current ${mode}: no retry or false receipt`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { mode }), s = await f.open(); await delay(180)
  const task = await s.get(f.saved.taskId)
  assert.equal(f.writes.length, 0); assert.equal(f.queries.length, 0); assert.equal(f.requests.length, 0)
  assert.equal(task.approvals.items[0].receipt, null); assert.equal(task.callUsage.toolCalls, 4); assert.equal((await calendar(s)).revision, 1)
})
test('ISS23 finite retries persist across reopen and unknown user/messages; no extra write effect', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { query: false }), s = await f.open({ write: async () => { throw new Error('secret-value-never-store') } }), task = await until(() => s.get(f.saved.taskId), stopped), item = task.approvals.items[0]
  assert.equal(f.writes.length, 3); assert.ok(f.writes.every((op) => op.id === item.operation.id)); assert.equal(task.callUsage.toolCalls, 7)
  assert.equal(item.operation.idempotency.stopped.reason, 'IDEMPOTENCY_ATTEMPTS_EXHAUSTED'); assert.equal(item.receipt, null)
  assert.ok(!JSON.stringify(task).includes('secret-value')); await s.verifyAction(task.taskId, item.id, { outcome: 'unknown', note: '仍无法确认' })
  await s.send(task.taskId, '普通消息'); await s.close(); const again = await f.open(); await delay(100)
  assert.equal(f.writes.length, 3); assert.equal((await again.get(task.taskId)).callUsage.toolCalls, 7); assert.equal((await calendar(again)).revision, 1)
})
test('ISS23 invalid receipt never proves success; exhausted retries use reliable query', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), s = await f.open({ write: async (_op, { execute }) => { const result = await execute(); result.evidence.operationId = 'not-original'; return result } })
  const task = await until(() => s.get(f.saved.taskId), idle), item = task.approvals.items[0]
  assert.equal(item.receipt.source, 'tool-result-query'); assert.equal(f.writes.length, 3); assert.equal(f.queries.length, 1); assert.equal((await calendar(s)).revision, 1)
  assert.ok(item.operation.idempotency.attempts.every((a) => a.status === 'unconfirmed' && !a.evidence))
})
for (const mode of ['revoke', 'budget', 'cancel']) test(`ISS23 ${mode} after attempt reservation blocks dispatch; manual verification race rejected`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { scenario: 'intent', query: false }); let started, release
  const ready = new Promise((r) => { started = r }), held = new Promise((r) => { release = r })
  const s = await f.open({ write: async (_op, { execute }) => { started(); await held; return execute() } }), id = f.saved.taskId
  await ready
  await assert.rejects(s.verifyAction(id, f.saved.operation.approvalId, { outcome: 'completed', note: '并发核实' }), { code: 'ACTION_RETRY_IN_PROGRESS' })
  if (mode === 'revoke') await s.revokeTool('calendar', 'calendar_reschedule_event')
  if (mode === 'budget') await s.harness.commit(async (tx) => { (await tx.doc(TaskCard, id)).parameters.callLimits.toolCalls = 4 }, ctx)
  if (mode === 'cancel') await s.cancel(id, {})
  release(); await delay(150)
  const task = await s.get(id); assert.equal((await calendar(s)).revision, 0); assert.equal(task.approvals.items[0].receipt, null)
  assert.equal(f.writes.length, 1); assert.equal(task.callUsage.toolCalls, 5); assert.equal(f.requests.length, 0)
})
test('ISS23 lost recovery response after dedup is bounded; tool called many times but effect once', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), s = await f.open({ write: async (_op, { execute }) => { await execute(); throw new Error('response lost') } }), task = await until(() => s.get(f.saved.taskId), idle)
  assert.equal(f.writes.length, 3); assert.equal(task.approvals.items[0].receipt.source, 'tool-result-query'); assert.equal((await calendar(s)).revision, 1)
})
test('ISS23 model allowance exhausted: receipt retained, no model/queue bypass', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { mode: 'model-limit' }), s = await f.open(), task = await until(() => s.get(f.saved.taskId), (x) => x.runtime.checkpoint?.lastOutcome === 'limited')
  assert.equal(task.approvals.items[0].receipt.source, 'tool-idempotent-recovery'); assert.equal(f.requests.length, 0); assert.equal((await calendar(s)).revision, 1)
})
test('ISS23 capability is explicit and recovery does not expand model tool set', () => {
  assert.equal(calendarWriteTool.recovery.stableIdempotency, true); assert.equal(calendarWriteTool.recovery.idempotency.windowMs, 86400000)
  assert.equal(calendarRecoveryCapability(true, false).stableIdempotency, false); assert.equal(calendarRecoveryCapability(false, false).reliableQuery, false)
})

for (const boundary of ['retry-started', 'retry-returned', 'retry-receipt-saved']) test(`ISS23 second SIGKILL at ${boundary}: original key, durable attempt/allowance, one effect`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t), child = spawn(process.execPath, [new URL('./fixtures/idempotency-recovery-process.mjs', import.meta.url).pathname, f.dir, boundary], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''; child.stderr.on('data', (x) => { output += x }); const dead = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await dead } })
  await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return JSON.parse(await readFile(join(f.dir, 'retry-checkpoint.json'), 'utf8')) } catch { return null } })
  child.kill('SIGKILL'); assert.equal((await dead)[1], 'SIGKILL')
  const s = await f.open(), task = await until(() => s.get(f.saved.taskId), idle), item = task.approvals.items[0], saved = boundary === 'retry-receipt-saved'
  assert.equal(item.operation.id, f.saved.operation.id); assert.equal(item.receipt.source, 'tool-idempotent-recovery')
  assert.equal(item.operation.idempotency.attempts.length, saved ? 1 : 2)
  if (!saved) assert.equal(item.operation.idempotency.attempts[0].status, 'interrupted')
  assert.equal(task.callUsage.toolCalls, saved ? 5 : 6); assert.equal(f.writes.length, saved ? 0 : 1); assert.equal(f.queries.length, 0)
  assert.equal((await calendar(s)).revision, 1); assert.equal(f.requests.length, 1)
})

test('ISS23 timeout and late execution cannot bypass abort, bounded across original operation', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { scenario: 'intent', query: false }), late = []
  const s = await f.open({ write: async (_op, { execute }) => { late.push(execute); return new Promise(() => {}) } })
  const task = await until(() => s.get(f.saved.taskId), stopped)
  assert.equal(f.writes.length, 3); assert.ok(task.approvals.items[0].operation.idempotency.attempts.every((a) => a.status === 'timeout'))
  for (const execute of late) await assert.rejects(execute())
  assert.equal((await calendar(s)).revision, 0); assert.equal(task.approvals.items[0].receipt, null); assert.equal(task.callUsage.toolCalls, 7)
})

test('ISS23 late tool receipt after cancellation retained with source, does not revive Task or FIFO', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); let started, release
  const ready = new Promise((r) => { started = r }), held = new Promise((r) => { release = r })
  const s = await f.open({ write: async (_op, { execute }) => { const result = await execute(); started(); await held; return result } }), id = f.saved.taskId
  await ready; await s.send(id, '排队不应执行'); await s.cancel(id, {}); release()
  const task = await until(() => s.get(id), (x) => x.approvals.items[0].receipt)
  assert.equal(task.approvals.items[0].receipt.source, 'tool-idempotent-recovery'); assert.equal(task.runtime.status, 'terminal')
  assert.equal(task.runtime.outcome.status, 'aborted'); assert.equal(f.requests.length, 0); assert.equal((await calendar(s)).revision, 1)
  await s.close(); const again = await f.open(); await delay(80); assert.equal(f.writes.length, 1); assert.equal(f.requests.length, 0)
  assert.equal((await again.get(id)).runtime.outcome.status, 'aborted')
})

test('ISS23 first response lost in live invocation uses same original intent without restarting service', { timeout: 20000 }, async (t) => {
  // The fixture leaves no receipt and the same process enters recovery after a thrown response.
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss23-live-')); let count = 0, writes = 0, task
  const args = { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' }
  const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => {
    count++; if (count > 3) return answer
    const [name, arguments_] = count === 1 ? ['calendar_read_schedule', { date: '2026-10-20', resource: args.resource }] : count === 2 ? ['calendar_read_event', { eventId: args.eventId, resource: args.resource }] : ['calendar_reschedule_event', args]
    const calls = [{ type: 'toolCall', id: `call-${count}`, name, arguments: arguments_ }]
    return { ...answer, toolCalls: calls, assistant: { role: 'assistant', content: calls, provider: 'fixture', api: 'openai-completions', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
  }, calendarWriteImpl: async (_op, { execute }) => { writes++; const result = await execute(); if (writes === 1) throw new Error('response-lost'); return result } })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '改期并审批')
  const waiting = await until(() => store.get(task.taskId), (x) => x.runtime.checkpoint?.phase === 'awaitApproval')
  await store.decideApproval(task.taskId, waiting.approvals.activeId, { decision: 'approved' })
  const final = await until(() => store.get(task.taskId), idle)
  assert.equal(writes, 2); assert.equal((await calendar(store)).revision, 1); assert.equal(final.approvals.items[0].receipt.source, 'tool-idempotent-recovery')
})

test('ISS23 idempotent continuation handles queued input FIFO and does not overwrite later meeting edit', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); let started, release
  const ready = new Promise((r) => { started = r }), held = new Promise((r) => { release = r })
  const s = await f.open({ write: async (_op, { execute }) => { started(); await held; return execute() } }), id = f.saved.taskId
  await ready; await s.send(id, '后续问题')
  await s.harness.commit(async (tx) => { (await tx.doc(MockCalendar)).events['mock-20261020-1'].title = '后续编辑' }, ctx)
  release(); const task = await until(() => s.get(id), (x) => idle(x) && x.queueLength === 0 && f.requests.length === 2)
  assert.equal(f.requests[1].message, '后续问题'); assert.equal(task.approvals.items[0].receipt.result.data.event.title, f.saved.operation.before.title)
  const state = await calendar(s); assert.equal(state.revision, 1); assert.equal(state.events['mock-20261020-1'].title, '后续编辑')
})

for (const mode of ['wrong-arguments', 'wrong-source', 'wrong-hash', 'extra-evidence', 'wrong-window']) test(`ISS23 malformed ${mode} result never becomes recovered receipt`, { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { query: false }), s = await f.open({ write: async (_op, { execute }) => {
    const result = await execute()
    if (mode === 'wrong-arguments') result.result.data.event.start = '2026-10-20T11:30:00+08:00'
    if (mode === 'wrong-source') result.evidence.source = 'untrusted'
    if (mode === 'wrong-hash') result.evidence.requestHash = 'mismatch'
    if (mode === 'extra-evidence') result.evidence.secret = 'never-persist-this'
    if (mode === 'wrong-window') result.evidence.expiresAt = '2099-01-01T00:00:00.000Z'
    return result
  } }), task = await until(() => s.get(f.saved.taskId), stopped)
  assert.equal(task.approvals.items[0].receipt, null); assert.equal(f.writes.length, 3); assert.equal((await calendar(s)).revision, 1)
  assert.ok(!JSON.stringify(task).includes('never-persist-this')); assert.ok(task.approvals.items[0].operation.idempotency.attempts.every((a) => !a.evidence))
})

test('ISS23 reserved final allowed attempt executes at equal tool limit, without double charging', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); let started, release
  const ready = new Promise((r) => { started = r }), held = new Promise((r) => { release = r })
  const s = await f.open({ write: async (_op, { execute }) => { started(); await held; return execute() } })
  await ready; await s.harness.commit(async (tx) => { (await tx.doc(TaskCard, f.saved.taskId)).parameters.callLimits.toolCalls = 5 }, ctx); release()
  const task = await until(() => s.get(f.saved.taskId), idle)
  assert.equal(task.approvals.items[0].receipt.source, 'tool-idempotent-recovery'); assert.equal(task.callUsage.toolCalls, 5); assert.equal((await calendar(s)).revision, 1)
})
