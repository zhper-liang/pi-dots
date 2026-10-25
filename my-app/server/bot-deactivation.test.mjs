import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { readMockSchedule, CALENDAR_TOOL } from './tools.mjs'
import { BLOCKER_TOOL } from './blockers.mjs'
import { CALENDAR_WRITE_TOOL } from './approvals.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'deactivation-fixture', apiKey: 'fixture-only' }
const bots = () => listBots(config, { contextWindows: { [config.model]: 65536 } })
const text = (content = '真实返回的夹具回复') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
let seq = 0
function turn(name, args) { const call = { type: 'toolCall', id: `deactivate-${++seq}`, name, arguments: args }; return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } } }
async function until(read, predicate) { for (let i = 0; i < 600; i++) { const value = await read(); if (predicate(value)) return value; await delay(5) } assert.fail('deactivation state did not settle') }
const idle = (s, id) => until(() => s.get(id), t => t.activeInputId === null && t.runtime.checkpoint?.phase === 'awaitInput')
const denied = e => e.code === 'BOT_INACTIVE'
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-04-')), file = join(dir, 'tasks.sqlite'), stores = new Set()
  const open = async (extra = {}) => { const s = await openTaskStore({ file, bots: bots(), modelReply: async () => text(), ...options, ...extra }); stores.add(s); return s }
  const close = async s => { await s.close(); stores.delete(s) }
  t.after(async () => { for (const s of stores) await s.close(); await rm(dir, { force: true, recursive: true }) })
  return { store: await open(), open, close, file }
}
async function apiFixture(t, options = {}) {
  const f = await fixture(t, options), server = createApiServer({ token: '04-test', tasks: f.store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)) })
  return { ...f, request: (path, body, auth = true, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(auth ? { Authorization: 'Bearer 04-test' } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
}
test('04 authenticated explicit confirmation; Chief protected; unknown and malformed requests; idempotent audit', async t => {
  const { store: s, request } = await apiFixture(t)
  assert.equal((await request('/api/bots/calendar/deactivate', { confirm: true }, false)).status, 401)
  for (const body of [{}, { confirm: false }, { confirm: true, status: 'active' }, null, []]) assert.equal((await request('/api/bots/calendar/deactivate', body)).status, 400)
  assert.equal((await request('/api/bots/calendar/deactivate', undefined, true, 'GET')).status, 405)
  assert.equal((await request('/api/bots/chief/deactivate', { confirm: true })).status, 409)
  assert.equal((await request('/api/bots/missing/deactivate', { confirm: true })).status, 404)
  await Promise.all(Array.from({ length: 5 }, () => s.deactivateBot('calendar', { confirm: true })))
  assert.equal((await request('/api/bots/calendar/deactivate', { confirm: true })).status, 200)
  const d = await s.harness.snapshot(BotDirectory, undefined, context)
  assert.equal(d.managementAudit.filter(a => a.type === 'bot-deactivated').length, 1)
  assert.equal(s.bots().find(b => b.id === 'calendar').status, 'inactive')
})
test('04 idle Bot retains identity/history/config/usage; all new work blocked, cancellation remains available; reopen cannot reactivate', async t => {
  let calls = 0
  const { store: s, open, close } = await fixture(t, { modelReply: async () => { calls++; return text() } })
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '保留历史'); const before = await idle(s, task.taskId)
  const conf = await s.getBotConfiguration('calendar')
  const update = { requestId: '04-config-before', expectedVersion: conf.bot.configRef.version, description: '新职责', tools: conf.bot.defaults.tools, resources: conf.bot.defaults.toolResources }
  await s.updateBotConfiguration('calendar', update)
  const preview = await s.previewMigration(task.taskId)
  await s.deactivateBot('calendar', { confirm: true })
  for (const work of [() => s.create({ botId: 'calendar' }), () => s.send(task.taskId, '重新启用'), () => s.steer(task.taskId, { message: '继续' }), () => s.updateState(task.taskId, { goal: '继续' }), () => s.raiseLimits(task.taskId, { modelCalls: 30 }), () => s.previewMigration(task.taskId), () => s.migrateConfiguration(task.taskId, { requestId: '04-migrate-blocked', expectedVersion: preview.previous.version, targetVersion: preview.next.version, previewToken: preview.previewToken, confirm: true })]) await assert.rejects(work(), denied)
  const after = await s.get(task.taskId)
  for (const key of ['taskId', 'conversationId', 'configRef', 'messages', 'callUsage', 'taskState', 'parameterSources']) assert.deepEqual(after[key], before[key])
  assert.equal(after.cancellation, null); assert.notEqual(after.runtime.status, 'terminal')
  // Replaying an old config receipt cannot overwrite lifecycle in the in-memory catalog.
  await s.updateBotConfiguration('calendar', update)
  assert.equal(s.bots().find(b => b.id === 'calendar').status, 'inactive')
  await close(s); const next = await open(); await delay(30)
  assert.equal((await next.get(task.taskId)).botLifecycle, 'inactive'); assert.equal(calls, 1)
  await assert.rejects(next.send(task.taskId, '重启后继续'), denied)
  await next.cancel(task.taskId, {}); await until(() => next.get(task.taskId), v => v.runtime.status === 'terminal')
  const chief = await next.create({ botId: 'chief' }); await next.send(chief.taskId, '其他Bot正常'); await idle(next, chief.taskId); assert.equal(calls, 2)
})
test('04 in-flight model is signalled; ignored abort saves late truth and actual usage; FIFO and planned tools never dispatch', async t => {
  let release, started, calls = 0, toolCalls = 0, signal
  const ready = new Promise(r => { started = r }), gate = new Promise(r => { release = r })
  const { store: s, open, close } = await fixture(t, { modelReply: async (_, o) => { calls++; signal = o.signal; started(); return gate }, toolImpl: async () => { toolCalls++; return null } })
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '执行'); await ready; await s.send(task.taskId, '队列保留')
  await s.deactivateBot('calendar', { confirm: true }); assert.equal(signal.aborted, true)
  release(turn(CALENDAR_TOOL, { date: '2026-10-20', resource: 'mock:personal' }))
  const after = await until(() => s.get(task.taskId), v => v.messages.some(m => m.assistant))
  assert.equal(after.callUsage.totalTokens, 7); assert.equal(after.callUsage.unknownTokenCalls, 0); assert.equal(after.queueLength, 1)
  await delay(40); assert.equal(calls, 1); assert.equal(toolCalls, 0); assert.equal(after.cancellation, null)
  await close(s); const next = await open(); await delay(40); assert.equal(calls, 1); assert.equal((await next.get(task.taskId)).queueLength, 1); assert.equal(toolCalls, 0)
})
test('04 abort-aware model stops without invented success or known usage; cancel while parked still works', async t => {
  let started; const ready = new Promise(r => { started = r })
  const { store: s } = await fixture(t, { modelReply: async (_, { signal }) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('transport aborted')), { once: true })) } })
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '执行'); await ready; await s.deactivateBot('calendar', { confirm: true })
  const after = await until(() => s.get(task.taskId), v => v.messages.some(m => m.role === 'error'))
  assert.equal(after.callUsage.unknownTokenCalls, 1); assert.equal(after.callUsage.totalTokens, 0); assert.equal(after.messages.some(m => m.role === 'assistant'), false)
  await s.cancel(task.taskId, {}); await until(() => s.get(task.taskId), v => v.runtime.status === 'terminal')
})
test('04 in-flight read keeps late valid receipt but never starts following model/tool; cancellation archives preserve it', async t => {
  let started, release, calls = 0, signal
  const ready = new Promise(r => { started = r }), gate = new Promise(r => { release = r })
  const args = { date: '2026-10-20', resource: 'mock:personal' }
  const { store: s } = await fixture(t, { modelReply: async () => { calls++; return turn(CALENDAR_TOOL, args) }, toolImpl: async (_, o) => { signal = o.signal; started(); await gate; return readMockSchedule(args) } })
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '读'); await ready; await s.deactivateBot('calendar', { confirm: true }); assert.equal(signal.aborted, true); release()
  const after = await until(() => s.get(task.taskId), v => v.messages.some(m => m.role === 'tool'))
  assert.equal(after.messages.find(m => m.role === 'tool').result.ok, true); await delay(40); assert.equal(calls, 1)
  await s.cancel(task.taskId, {}); const final = await until(() => s.get(task.taskId), v => v.runtime.status === 'terminal'); assert.deepEqual(final.messages.filter(m => m.role === 'tool'), after.messages.filter(m => m.role === 'tool'))
})
for (const waiting of ['blocker', 'approval', 'limited']) test(`04 ${waiting} waiting survives deactivation and reopen without answer/approval/limit bypass`, async t => {
  let calls = 0
  const { store: s, open, close } = await fixture(t, { modelReply: async (message, { context: ctx }) => {
    calls++; if (waiting === 'blocker') return turn(BLOCKER_TOOL, { question: '选择时区？', requiredInformation: 'IANA时区', assignee: 'user' })
    const results = ctx.messages.filter(m => m.role === 'toolResult')
    if (!results.length) return turn(CALENDAR_TOOL, { date: '2026-10-20', resource: 'mock:personal' })
    if (results.length === 1) return turn('calendar_read_event', { eventId: 'mock-20261020-1', resource: 'mock:personal' })
    return turn(CALENDAR_WRITE_TOOL, { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' })
  } })
  const task = await s.create({ botId: 'calendar', ...(waiting === 'limited' ? { parameters: { callLimits: { modelCalls: 1, toolCalls: 10 } } } : {}) }); await s.send(task.taskId, '等待')
  const before = await until(() => s.get(task.taskId), v => waiting === 'blocker' ? v.blockers.activeId : waiting === 'approval' ? v.approvals.activeId : v.runtime.checkpoint?.lastOutcome === 'limited')
  await s.deactivateBot('calendar', { confirm: true })
  const count = calls
  await assert.rejects(s.send(task.taskId, '批准并启用'), denied)
  if (waiting === 'blocker') await assert.rejects(s.resolveBlocker(task.taskId, before.blockers.activeId, { answer: 'UTC' }), denied)
  if (waiting === 'approval') await assert.rejects(s.decideApproval(task.taskId, before.approvals.activeId, { decision: 'approved' }), denied)
  if (waiting === 'limited') await assert.rejects(s.raiseLimits(task.taskId, { modelCalls: 30 }), denied)
  await close(s); const next = await open(); await delay(40); const after = await next.get(task.taskId)
  assert.deepEqual(after.approvals, before.approvals); assert.deepEqual(after.blockers, before.blockers); assert.deepEqual(after.waiting, before.waiting); assert.equal(calls, count)
})
async function approvalTask(s) {
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '改期')
  return until(() => s.get(task.taskId), v => v.approvals.activeId)
}
function writeModel(_message, { context: ctx }) {
  const results = ctx.messages.filter(m => m.role === 'toolResult')
  if (!results.length) return turn(CALENDAR_TOOL, { date: '2026-10-20', resource: 'mock:personal' })
  if (results.length === 1) return turn('calendar_read_event', { eventId: 'mock-20261020-1', resource: 'mock:personal' })
  if (results.length === 2) return turn(CALENDAR_WRITE_TOOL, { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' })
  return text()
}
for (const mode of ['late-success', 'unknown', 'before-effect']) test(`04 write ${mode}: no rollback claim, no recovery dispatch after reopen`, async t => {
  let started, release, attempts = 0, modelCalls = 0, queryCalls = 0, signal
  const ready = new Promise(r => { started = r }), gate = new Promise(r => { release = r })
  const { store: s, open, close } = await fixture(t, { modelReply: (...args) => { modelCalls++; return writeModel(...args) }, calendarQueryImpl: () => { queryCalls++; return { status: 'unknown' } }, calendarWriteImpl: async (_op, o) => {
    attempts++; signal = o.signal
    if (mode === 'before-effect') { started(); await gate; return o.execute() }
    const result = await o.execute(); started(); await gate
    if (mode === 'unknown') throw new Error('response lost after actual effect')
    return result
  } })
  const task = await approvalTask(s), approvalId = task.approvals.activeId
  await s.decideApproval(task.taskId, approvalId, { decision: 'approved' }); await ready
  await s.deactivateBot('calendar', { confirm: true }); assert.equal(signal.aborted, true); release()
  const after = await until(() => s.get(task.taskId), v => mode === 'late-success' ? v.approvals.items.at(-1).receipt : Boolean(v.approvals.items.at(-1).operation?.unknownAt))
  const item = after.approvals.items.at(-1)
  if (mode === 'late-success') assert.equal(item.receipt.result.ok, true)
  else assert.equal(item.receipt, null)
  const count = modelCalls
  await assert.rejects(s.decideApproval(task.taskId, approvalId, { decision: 'approved' }), denied)
  await close(s); const next = await open(); await delay(40)
  const reopened = await next.get(task.taskId)
  assert.deepEqual(reopened.approvals, after.approvals); assert.equal(attempts, 1); assert.equal(queryCalls, 0); assert.equal(modelCalls, count)
})
test('04 create/send races serialize with deactivation; never dispatch admitted input after durable inactive', async t => {
  let calls = 0
  const { store: s } = await fixture(t, { modelReply: async () => { calls++; return text() } })
  const existing = await s.create({ botId: 'calendar' })
  await s.deactivateBot('calendar', { confirm: true })
  const results = await Promise.allSettled([s.create({ botId: 'calendar' }), s.send(existing.taskId, '消息'), s.deactivateBot('calendar', { confirm: true })])
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected', 'fulfilled']); await delay(30); assert.equal(calls, 0)
})
test('04 pending steer and FIFO retained after late final model result, never applied to stopped Task', async t => {
  let started, release, calls = 0
  const ready = new Promise(r => { started = r }), gate = new Promise(r => { release = r })
  const { store: s } = await fixture(t, { modelReply: async () => { calls++; started(); await gate; return text('迟到最终回复') } })
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '执行'); await ready
  await s.send(task.taskId, 'FIFO'); await s.steer(task.taskId, { message: '插入要求' })
  const before = await s.get(task.taskId)
  await s.deactivateBot('calendar', { confirm: true }); release()
  const after = await until(() => s.get(task.taskId), v => v.messages.some(m => m.content === '迟到最终回复'))
  assert.deepEqual(after.taskState, before.taskState); assert.equal(after.steerLength, 1); assert.equal(after.queueLength, 1); await delay(30); assert.equal(calls, 1)
})
test('04 SIGKILL after durable deactivation never redispatches unknown model or FIFO on fresh process open', { timeout: 15000 }, async t => {
  const { spawn } = await import('node:child_process'), { readFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-04-crash-'))
  const child = spawn(process.execPath, [new URL('./fixtures/bot-deactivation-process.mjs', import.meta.url).pathname, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = '', s, calls = 0; child.stderr.on('data', part => { stderr += part })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } if (s) await s.close(); await rm(dir, { force: true, recursive: true }) })
  const saved = await until(async () => { if (child.exitCode !== null) throw new Error(stderr); try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null } }, Boolean)
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  s = await openTaskStore({ file: join(dir, 'tasks.sqlite'), bots: bots(), modelReply: async () => { calls++; return text() } })
  await delay(50); const task = await s.get(saved.taskId)
  assert.equal(task.conversationId, saved.conversationId); assert.equal(task.botLifecycle, 'inactive'); assert.equal(task.cancellation, null); assert.equal(task.callUsage.unknownTokenCalls, 1); assert.equal(task.queueLength, 1); assert.equal(calls, 0)
  await assert.rejects(s.send(task.taskId, '重启启用'), denied)
  await s.cancel(task.taskId, {}); await until(() => s.get(task.taskId), v => v.runtime.status === 'terminal')
})
test('04 concurrent send/create/deactivate share admission transaction; accepted history stays, no future work', async t => {
  const { store: s } = await fixture(t)
  const task = await s.create({ botId: 'calendar' })
  const results = await Promise.allSettled([s.send(task.taskId, '并发输入'), s.deactivateBot('calendar', { confirm: true }), s.create({ botId: 'calendar' })])
  assert.equal(results[1].status, 'fulfilled')
  for (const r of [results[0], results[2]]) if (r.status === 'rejected') assert.equal(r.reason.code, 'BOT_INACTIVE')
  await assert.rejects(s.create({ botId: 'calendar' }), denied); await assert.rejects(s.send(task.taskId, '后续'), denied)
  if (results[0].status === 'fulfilled') assert.ok((await s.get(task.taskId)).messages.some(m => m.content === '并发输入'))
})
test('04 inactive new configuration cannot reactivate; immutable config versions do not encode lifecycle', async t => {
  const { store: s } = await fixture(t)
  const before = await s.getBotConfiguration('calendar')
  await s.deactivateBot('calendar', { confirm: true })
  await assert.rejects(s.updateBotConfiguration('calendar', { requestId: '04-config-inactive', expectedVersion: before.bot.configRef.version, description: '重新启用', tools: before.bot.defaults.tools, resources: before.bot.defaults.toolResources }), denied)
  const after = await s.getBotConfiguration('calendar')
  assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.bot.configRef, before.bot.configRef); assert.equal(after.bot.status, 'inactive')
})
test('04 cancellation while deactivated in-flight model preserves late truth through original cancellation archive', async t => {
  let started, release
  const ready = new Promise(r => { started = r }), gate = new Promise(r => { release = r })
  const { store: s } = await fixture(t, { modelReply: async () => { started(); await gate; return text('停用并取消后迟到') } })
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '执行'); await ready
  await s.deactivateBot('calendar', { confirm: true }); await s.cancel(task.taskId, {}); release()
  const after = await until(() => s.get(task.taskId), v => v.runtime.status === 'terminal' && v.messages.some(m => m.content === '停用并取消后迟到'))
  assert.equal(after.messages.at(-1).afterCancellation, true); assert.equal(after.callUsage.totalTokens, 7); assert.equal(after.botLifecycle, 'inactive')
})
