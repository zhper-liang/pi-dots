import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { ToolAccess, CALENDAR_TOOL, CALENDAR_EVENT_TOOL, readMockSchedule } from './tools.mjs'
import { MockCalendar, CALENDAR_WRITE_TOOL } from './approvals.mjs'
import { createApiServer } from './app.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'config-fixture', apiKey: 'do-not-persist-fixture-secret' }
const args = { resource: 'mock:personal', date: '2026-10-20' }
const write = { resource: args.resource, eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' }
const text = () => ({ mode: 'model', reply: { content: '按真实回执完成；不是授权。' }, execution: { usage: { totalTokens: 4 } } })
const turn = (name, arguments_ = args) => { const call = { type: 'toolCall', id: name, name, arguments: arguments_ }; return { ...text(), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } } }
async function until(read, predicate = Boolean) { for (let i = 0; i < 900; i++) { const x = await read(); if (predicate(x)) return x; await delay(5) } assert.fail('configuration fixture did not settle') }
const done = (s, id) => until(() => s.get(id), (t) => t.activeInputId === null && t.queueLength === 0 && t.runtime.checkpoint?.phase === 'awaitInput')
const waiting = (s, id) => until(() => s.get(id), (t) => t.approvals?.activeId != null && t.runtime.checkpoint?.phase === 'awaitApproval')
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-config-02-')), file = join(dir, 'task.sqlite'), stores = new Set()
  const open = async (extra = {}) => { const s = await openTaskStore({ file, bots: listBots(config), modelReply: async () => text(), ...options, ...extra }); stores.add(s); return s }
  const close = async (s) => { await s.close(); stores.delete(s) }
  t.after(async () => { for (const s of stores) await s.close(); await rm(dir, { recursive: true, force: true }) })
  return { store: await open(), dir, file, open, close }
}
let sequence = 0
const requestId = () => `config-request-${++sequence}`
async function edit(s, id = 'calendar', changes = {}) {
  const { bot } = await s.getBotConfiguration(id)
  return { requestId: requestId(), expectedVersion: bot.configRef.version, description: bot.description, tools: bot.defaults.tools, resources: bot.defaults.toolResources, ...changes }
}
const pool = (s, operation, tools = [], resources = []) => s.updateCapabilityPool({ requestId: requestId(), operation, tools, resources })
function planner() {
  return async (message, { context: ctx }) => {
    const start = ctx.messages.findLastIndex((m) => m.role === 'user' && m.content === message)
    const results = ctx.messages.slice(start + 1).filter((m) => m.role === 'toolResult')
    if (results.some((r) => r.isError)) return text()
    return !results.length ? turn(CALENDAR_TOOL) : results.length === 1 ? turn(CALENDAR_EVENT_TOOL, { eventId: write.eventId, resource: args.resource }) : results.length === 2 ? turn(CALENDAR_WRITE_TOOL, write) : text()
  }
}

test('02 immutable configuration versions update Bot metadata while Task access follows live assignment', async (t) => {
  const { store } = await fixture(t)
  const old = await store.create({ botId: 'calendar' }), before = await store.getBotConfiguration('calendar')
  const changed = await store.updateBotConfiguration('calendar', await edit(store, 'calendar', { description: '新的专业职责', tools: [CALENDAR_TOOL], parameters: { model: { id: config.model }, maxOutputTokens: 1024 } }))
  const fresh = await store.create({ botId: 'calendar' }), current = await store.get(old.taskId)
  assert.deepEqual(current.parameters, old.parameters); assert.deepEqual(current.configRef, old.configRef); assert.deepEqual(current.bot, old.bot)
  assert.deepEqual(current.toolSets.authorized, [CALENDAR_TOOL])
  assert.equal(fresh.bot.description, '新的专业职责'); assert.deepEqual(fresh.configRef, changed.bot.configRef); assert.equal(fresh.parameters.maxOutputTokens, 1024)
  const after = await store.getBotConfiguration('calendar')
  assert.equal(after.versions.length, 2); assert.deepEqual(after.versions[0], before.versions[0]); assert.equal(after.versions[1].source, 'authenticated-user')
  assert.ok(after.audit.some((e) => e.type === 'configuration-saved'))
  after.versions[0].description = 'mutated caller'
  assert.deepEqual((await store.getBotConfiguration('calendar')).versions[0], before.versions[0])
})

test('02 CAS concurrency chooses one complete version; failed stale edit persists only denial audit', async (t) => {
  const { store } = await fixture(t), a = await edit(store, 'calendar', { description: '胜者A' }), b = { ...a, requestId: requestId(), description: '胜者B', tools: [] }
  const results = await Promise.allSettled([store.updateBotConfiguration('calendar', a), store.updateBotConfiguration('calendar', b)])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFIG_VERSION_CONFLICT')
  const view = await store.getBotConfiguration('calendar')
  assert.equal(view.versions.length, 2); assert.equal(view.bot.description, '胜者A'); assert.deepEqual(view.assigned.tools, a.tools)
  assert.ok(view.audit.some((e) => e.type === 'management-denied' && e.code === 'CONFIG_VERSION_CONFLICT'))
})

test('02 immutable idempotency receipts survive newer configs, base changes and restart', async (t) => {
  const { store, open, close } = await fixture(t)
  const initial = await edit(store, 'calendar', { description: '初次版本' }), saved = await store.updateBotConfiguration('calendar', initial)
  await store.updateBotConfiguration('calendar', await edit(store, 'calendar', { description: '后续版本' }))
  assert.deepEqual(await store.updateBotConfiguration('calendar', initial), saved)
  assert.equal((await store.getBotConfiguration('calendar')).bot.description, '后续版本')
  await assert.rejects(store.updateBotConfiguration('calendar', { ...initial, description: '篡改' }), { code: 'CONFIG_REQUEST_CONFLICT' })
  await close(store); const reopened = await open()
  assert.deepEqual(await reopened.updateBotConfiguration('calendar', initial), saved)
  assert.equal((await reopened.getBotConfiguration('calendar')).versions.length, 3)
})

test('02 installed tools can be assigned directly; assignment changes reach existing Tasks', async (t) => {
  const { store } = await fixture(t)
  const { bot } = await store.createBot({ name: '权限专家', description: '独立职责', profile: 'general', requestId: requestId() })
  const old = await store.create({ botId: bot.id }), sameBotOld = await store.create({ botId: 'calendar' })
  const before = await store.getBotConfiguration(bot.id)
  assert.ok(before.installed.includes(CALENDAR_TOOL)); assert.ok(!before.assigned.tools.includes(CALENDAR_TOOL))
  await store.updateBotConfiguration(bot.id, await edit(store, bot.id, { tools: [CALENDAR_TOOL], resources: [args.resource] }))
  assert.ok((await store.get(old.taskId)).toolSets.authorized.includes(CALENDAR_TOOL))
  assert.ok((await store.get(sameBotOld.taskId)).toolSets.authorized.includes(CALENDAR_TOOL))
  assert.ok((await store.create({ botId: bot.id })).toolSets.authorized.includes(CALENDAR_TOOL))
  assert.ok(!(await store.create({ botId: 'todo' })).toolSets.authorized.includes(CALENDAR_TOOL))
})

for (const level of ['bot-tools', 'bot-resources']) test(`02 ${level} removal and regrant immediately update old Tasks across restart`, async (t) => {
  const { store, close, open } = await fixture(t), old = await store.create({ botId: 'calendar' })
  const resource = level.endsWith('resources')
  await store.updateBotConfiguration('calendar', await edit(store, 'calendar', resource ? { resources: [] } : { tools: [] }))
  let current = await store.get(old.taskId)
  assert.ok(resource ? !current.toolSets.resources.includes(args.resource) : !current.toolSets.authorized.includes(CALENDAR_TOOL))
  assert.deepEqual(current.parameters, old.parameters)
  await store.updateBotConfiguration('calendar', await edit(store, 'calendar', resource ? { resources: [args.resource] } : { tools: old.parameters.tools }))
  await close(store); const reopened = await open(); current = await reopened.get(old.taskId)
  assert.ok(resource ? current.toolSets.resources.includes(args.resource) : current.toolSets.authorized.includes(CALENDAR_TOOL))
  const fresh = await reopened.create({ botId: 'calendar' })
  assert.ok(resource ? fresh.toolSets.resources.includes(args.resource) : fresh.toolSets.authorized.includes(CALENDAR_TOOL))
})

test('02 invalid model, credentials, source, request keys, unknown resources and inherited fields cannot partially save', async (t) => {
  const { store } = await fixture(t), before = await store.getBotConfiguration('calendar'), input = await edit(store)
  for (const patch of [{ parameters: { model: { id: 'not-configured' } } }, { parameters: { model: { id: config.model, baseUrl: 'evil' } } }, { credentials: 'TOP_SECRET' }, { source: 'chief' }, { tools: ['shell'] }, { resources: ['mock:someone-else'] }, { requestId: '__proto__' }, { requestId: 'constructor' }, { description: '' }, { expectedVersion: 'stale' }]) {
    await assert.rejects(store.updateBotConfiguration('calendar', { ...input, ...patch }))
  }
  const after = await store.getBotConfiguration('calendar')
  assert.deepEqual(after.bot, before.bot); assert.deepEqual(after.versions, before.versions); assert.ok(!JSON.stringify(after).includes('TOP_SECRET'))
  await assert.rejects(store.create({ botId: 'chief', parameters: { model: { id: 'not-configured' } } }), { code: 'MODEL_NOT_CONFIGURED' })
})

test('02 new configured model can be selected; unsupported provider is rejected without changing snapshots', async (t) => {
  const bots = listBots(config); bots[1].defaults.model.id = 'configured-second'
  const { store } = await fixture(t, { bots }), old = await store.create({ botId: 'chief' })
  await store.updateBotConfiguration('chief', await edit(store, 'chief', { parameters: { model: { id: 'configured-second' } } }))
  assert.equal((await store.create({ botId: 'chief' })).parameters.model.id, 'configured-second')
  assert.equal((await store.get(old.taskId)).parameters.model.id, config.model)
  await assert.rejects(store.updateBotConfiguration('chief', await edit(store, 'chief', { parameters: { model: { id: 'configured-second', provider: 'other' } } })))
})

test('02 delayed model response uses the latest Bot assignment at dispatch time', async (t) => {
  let entered, release, executions = 0
  const ready = new Promise((r) => { entered = r }), held = new Promise((r) => { release = r })
  const { store } = await fixture(t, { modelReply: async (_m, { context: ctx }) => {
    if (!ctx.messages.some((m) => m.role === 'toolResult')) { entered(); await held; return turn(CALENDAR_TOOL) } return text()
  }, toolImpl: (a) => { executions++; return readMockSchedule(a) } })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '读取'); await ready
  const before = await store.getBotConfiguration('calendar')
  await store.updateBotConfiguration('calendar', await edit(store, 'calendar', { tools: before.assigned.tools.filter(n => n !== CALENDAR_TOOL) }))
  release()
  const final = await done(store, task.taskId)
  assert.equal(executions, 0); assert.ok(final.messages.some((m) => m.result?.error?.code === 'TOOL_NOT_AUTHORIZED'))
})

test('02 resource revocation blocks actual read dispatch, not only tool visibility', async (t) => {
  let executions = 0
  const { store } = await fixture(t, { modelReply: async (_m, { context: ctx }) => ctx.messages.some((m) => m.role === 'toolResult') ? text() : turn(CALENDAR_TOOL), toolImpl: (a) => { executions++; return readMockSchedule(a) } })
  const old = await store.create({ botId: 'calendar' }); await pool(store, 'revoke', [], [args.resource]); await store.send(old.taskId, '读取')
  const final = await done(store, old.taskId); assert.equal(executions, 0)
  assert.ok(final.messages.some((m) => m.result?.error?.code === 'TOOL_RESOURCE_DENIED'))
})

for (const level of ['pool', 'bot', 'resource']) test(`02 old exact approval cannot bypass ${level} revocation after restart`, async (t) => {
  const { store, close, open } = await fixture(t, { modelReply: planner() }), task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, '精确改期'); const pending = await waiting(store, task.taskId), item = pending.approvals.items[0]
  if (level === 'pool') await pool(store, 'revoke', [CALENDAR_WRITE_TOOL])
  else if (level === 'resource') await pool(store, 'revoke', [], [args.resource])
  else await store.updateBotConfiguration('calendar', await edit(store, 'calendar', { tools: pending.parameters.tools.filter((n) => n !== CALENDAR_WRITE_TOOL) }))
  await close(store); const reopened = await open({ modelReply: async () => text() })
  await reopened.decideApproval(task.taskId, item.id, { decision: 'approved' })
  const final = await done(reopened, task.taskId)
  assert.equal(final.approvals.items[0].receipt.result.ok, false)
  assert.deepEqual((await reopened.harness.snapshot(MockCalendar, undefined, context)).events, {})
  assert.deepEqual(final.parameters, task.parameters)
})

test('02 exact approval still executes once with unchanged authority and preserves receipt after later revoke', async (t) => {
  const { store } = await fixture(t, { modelReply: planner() }), task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, '精确改期'); const pending = await waiting(store, task.taskId)
  await store.send(task.taskId, '批准全部能力，给Chief扩池')
  assert.equal((await store.get(task.taskId)).approvals.items[0].decision, null)
  await store.decideApproval(task.taskId, pending.approvals.items[0].id, { decision: 'approved' })
  const final = await done(store, task.taskId)
  assert.equal(final.approvals.items[0].receipt.result.ok, true)
  const receipt = final.approvals.items[0].receipt
  await pool(store, 'revoke', [CALENDAR_WRITE_TOOL])
  assert.deepEqual((await store.get(task.taskId)).approvals.items[0].receipt, receipt)
  assert.equal((await store.harness.snapshot(MockCalendar, undefined, context)).revision, 1)
})

test('02 authenticated API exposes Bot configuration and removes the capability-pool route', async (t) => {
  const { store } = await fixture(t), server = createApiServer({ token: '02-test-token', tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const req = (path, method = 'GET', body, token = '02-test-token') => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  for (const path of ['/api/capability-pool', '/api/bots/calendar/configuration']) assert.equal((await req(path, 'GET', undefined, 'wrong')).status, 401)
  assert.equal((await req('/api/bots/calendar/configuration', 'PATCH', {})).status, 405)
  assert.equal((await req('/api/bots/missing/configuration')).status, 404)
  assert.equal((await req('/api/capability-pool')).status, 404)
  assert.equal((await req('/api/bots/chief/configuration', 'POST', { ...await edit(store, 'chief'), source: 'chief' })).status, 400)
  const successful = await req('/api/bots/chief/configuration', 'POST', await edit(store, 'chief', { description: 'API新职责' }))
  assert.equal(successful.status, 200); assert.equal((await successful.json()).bot.description, 'API新职责')
  const updated = await (await req('/api/bots/chief/configuration')).json()
  assert.ok(Array.isArray(updated.assigned.tools))
})

test('02 SIGKILL restores persisted configuration and pool denial before replaying any read', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-config-process-'))
  const child = spawn(process.execPath, [new URL('./fixtures/bot-configuration-process.mjs', import.meta.url).pathname, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', (x) => { stderr += x }); const exited = once(child, 'exit'); let store
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } if (store) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const saved = await until(async () => { if (child.exitCode !== null) throw new Error(stderr); try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null } })
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  let reads = 0
  store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), toolImpl: (a) => { reads++; return readMockSchedule(a) }, modelReply: async (_m, { context: ctx }) => ctx.messages.some((m) => m.role === 'toolResult') ? text() : turn(CALENDAR_TOOL) })
  const final = await done(store, saved.taskId)
  assert.equal(reads, 0); assert.ok(final.messages.some((m) => m.result?.error?.code === 'TOOL_NOT_AUTHORIZED'))
  assert.equal((await store.getBotConfiguration('calendar')).bot.description, 'SIGKILL前新职责')
  assert.equal((await store.getBotConfiguration('calendar')).assigned.tools.includes(CALENDAR_TOOL), false)
  assert.equal((await store.harness.snapshot(ToolAccess, undefined, context)).pool, undefined)
})

test('02 new Bot defaults are assigned without an intermediate capability pool', async (t) => {
  const { store, close, open } = await fixture(t)
  await pool(store, 'revoke', [CALENDAR_TOOL], [args.resource])
  const input = { name: '池未授权时创建', description: '不借用模板提升能力', profile: 'mock-calendar', requestId: requestId() }
  const { bot } = await store.createBot(input)
  assert.ok(bot.defaults.tools.includes(CALENDAR_TOOL)); assert.ok(bot.defaults.toolResources.includes('workspace:local'))
  assert.deepEqual((await store.getBotConfiguration(bot.id)).bot.defaults, bot.defaults)
  await pool(store, 'grant', [CALENDAR_TOOL], [args.resource]); await close(store)
  const reopened = await open(), fresh = await reopened.create({ botId: bot.id })
  assert.ok(fresh.parameters.tools.includes(CALENDAR_TOOL)); assert.ok(fresh.parameters.toolResources.includes('workspace:local'))
  assert.deepEqual((await reopened.createBot(input)).bot, bot)
})

test('02 in-flight read receipt remains real after revoke; next dispatch denied without deleting prior result', async (t) => {
  let entered, release, reads = 0
  const ready = new Promise((r) => { entered = r }), held = new Promise((r) => { release = r })
  const { store } = await fixture(t, { modelReply: async (_m, { context: ctx }) => {
    const results = ctx.messages.filter((m) => m.role === 'toolResult')
    return results.length < 2 ? turn(CALENDAR_TOOL, results.length ? { ...args, date: '2026-10-21' } : args) : text()
  }, toolImpl: async (a) => { reads++; entered(); await held; return readMockSchedule(a) } })
  const task = await store.create({ botId: 'calendar' }); await store.send(task.taskId, '先读再读'); await ready
  await pool(store, 'revoke', [CALENDAR_TOOL]); release()
  const final = await done(store, task.taskId), receipts = final.messages.filter((m) => m.role === 'tool')
  assert.equal(reads, 1); assert.equal(receipts[0].result.ok, true); assert.equal(receipts[1].result.error.code, 'TOOL_NOT_AUTHORIZED')
})

test('02 fresh and legacy runtime initialize current assignments from Bot defaults', async (t) => {
  const { openTaskStore: rawOpen } = await import('./tasks.mjs')
  const { BotDirectory } = await import('./bot-directory.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-raw-pool-')), file = join(dir, 'task.sqlite'); let store
  t.after(async () => { if (store) await store.close(); await rm(dir, { recursive: true, force: true }) })
  store = await rawOpen({ file, bots: listBots(config), modelReply: async () => text() })
  let view = await store.getBotConfiguration('calendar')
  assert.ok(view.installed.includes(CALENDAR_TOOL)); assert.deepEqual(view.assigned.tools, view.bot.defaults.tools)
  const old = await store.create({ botId: 'calendar' }); assert.ok(old.toolSets.authorized.includes(CALENDAR_TOOL))
  // A prior record without assignment metadata initializes from the current Bot defaults.
  await store.harness.commit(async (tx) => { const access = await tx.doc(ToolAccess); delete access.assignments; const directory = await tx.doc(BotDirectory); delete directory.configurations; delete directory.managementAudit; delete directory.managementRequests }, context)
  await store.close(); store = await rawOpen({ file, bots: listBots(config) })
  view = await store.getBotConfiguration('calendar')
  assert.ok(view.assigned.tools.includes(CALENDAR_TOOL))
  assert.ok((await store.get(old.taskId)).toolSets.authorized.includes(CALENDAR_TOOL))
  assert.equal((await store.harness.snapshot(ToolAccess, undefined, context)).pool, undefined)
})

test('02 storage failure cannot partially save config, grants, audit or version; reopened state is original', async (t) => {
  const { DatabaseSync } = await import('node:sqlite')
  const { store, file, close, open } = await fixture(t)
  const before = await store.getBotConfiguration('calendar'), input = await edit(store, 'calendar', { description: '不得部分保存', tools: [] })
  const db = new DatabaseSync(file)
  try {
    db.exec("CREATE TRIGGER fail_bot_config BEFORE INSERT ON document_revisions WHEN NEW.document_id IN (SELECT id FROM documents WHERE json_extract(kind, '$') = 'pidot.bot-directory') BEGIN SELECT RAISE(ABORT, 'simulated configuration storage failure'); END")
    await assert.rejects(store.updateBotConfiguration('calendar', input))
    await close(store); db.exec('DROP TRIGGER fail_bot_config')
    const reopened = await open()
    assert.deepEqual(await reopened.getBotConfiguration('calendar'), before)
    assert.deepEqual((await reopened.create({ botId: 'calendar' })).configRef, before.bot.configRef)
  } finally { db.close() }
})
