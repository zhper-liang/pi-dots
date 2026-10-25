import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { BotDirectory } from './bot-directory.mjs'
import { listBots } from './bots.mjs'
import { TaskCard } from './tasks.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { createApiServer } from './app.mjs'
import { ToolResults, boundToolResult, readToolResult } from './tool-results.mjs'
import { CALENDAR_TOOL } from './tools.mjs'
import { BLOCKER_TOOL } from './blockers.mjs'
import { CALENDAR_WRITE_TOOL } from './approvals.mjs'
import { addRule } from './policy.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'multi-bot-fixture', apiKey: 'fixture-secret-never-persist' }
const token = 'multi-bot-test-token'
const creation = (name = '分析师', requestId = 'request-0001', profile = 'general') => ({ name, description: `负责${name}的独立工作`, requestId, profile })
const text = (content = '已按此Bot职责回复') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 5, input: 3, output: 2 } } })
function turn(name, args) {
  const call = { type: 'toolCall', id: `call-${name}`, name, arguments: args }
  return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
async function until(read, predicate) {
  for (let n = 0; n < 600; n++) { const value = await read(); if (predicate(value)) return value; await delay(5) }
  assert.fail('multi-bot state did not settle')
}
const idle = (task) => task.activeInputId === null && task.queueLength === 0 && task.runtime.checkpoint?.lastOutcome === 'completed'
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-bot-directory-')), file = join(dir, 'task.sqlite'), stores = new Set()
  const open = async (extra = {}) => { const store = await openTaskStore({ file, ...options, ...extra }); stores.add(store); return store }
  const close = async (store) => { await store.close(); stores.delete(store) }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, file, open, close, store: await open() }
}
async function apiFixture(t, options = {}) {
  const f = await fixture(t, options)
  const server = createApiServer({ token, tasks: f.store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { ...f, base, request: (path, method = 'GET', body) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
}

test('directory initializes three stable presets once; seeds cannot replace persisted config or Task snapshots', async (t) => {
  const { store, open, close } = await fixture(t)
  const before = store.bots(), old = await store.create({ botId: 'calendar' })
  const { bot } = await store.createBot(creation())
  const snapshot = await store.get(old.taskId)
  before[0].name = 'mutated caller copy'
  assert.equal(store.bots()[0].name, 'Chief')
  await close(store)
  const changed = listBots(config).map((item) => ({ ...item, name: 'changed seed', configRef: { ...item.configRef, version: 'changed' } }))
  let next = await open({ bots: changed })
  assert.deepEqual(next.bots().map((item) => item.id), ['chief', 'calendar', 'todo', bot.id])
  assert.equal(next.bots()[0].defaults.mode, 'test')
  assert.deepEqual(await next.get(old.taskId), snapshot)
  assert.deepEqual((await next.create({ botId: bot.id })).bot, { id: bot.id, name: bot.name, description: bot.description })
  await close(next); next = await open({ bots: changed })
  assert.equal(next.bots().length, 4)
  assert.deepEqual((await next.createBot(creation())).bot, bot)
})

test('legacy bootstrap retains original cards, names, configuration and unknown historical Bot identities', async (t) => {
  const seeds = [...listBots(), { ...listBots()[0], id: 'legacy-specialist', name: '旧专家', configRef: { botId: 'legacy-specialist', version: 'old' } }]
  const { store, open, close } = await fixture(t, { bots: seeds })
  const old = await store.create({ botId: 'legacy-specialist' })
  await store.harness.commit(async (tx) => { const doc = await tx.doc(BotDirectory); doc.initialized = false; doc.items = []; doc.requests = {} }, context)
  await close(store)
  const next = await open({ bots: listBots(config) })
  assert.equal(next.bots().length, 4)
  assert.equal(next.bots().find((bot) => bot.id === 'legacy-specialist').source, 'legacy-task')
  assert.deepEqual(await next.get(old.taskId), old)
  assert.deepEqual((await next.create({ botId: 'legacy-specialist' })).parameters, old.parameters)
})

test('creation is atomic, concurrent retries deduplicate, request mismatch and duplicate names are rejected', async (t) => {
  const { store } = await fixture(t)
  const results = await Promise.all(Array.from({ length: 12 }, () => store.createBot(creation())))
  assert.equal(new Set(results.map((x) => x.bot.id)).size, 1)
  assert.equal(results.filter((x) => x.created).length, 1)
  assert.equal(store.bots().length, 4)
  await assert.rejects(store.createBot({ ...creation(), description: 'different' }), { code: 'BOT_REQUEST_CONFLICT' })
  await assert.rejects(store.createBot(creation('分析师', 'request-0002')), { code: 'BOT_NAME_EXISTS' })
  const names = await Promise.allSettled([store.createBot(creation('Same', 'request-0003')), store.createBot(creation('ＳＡＭＥ', 'request-0004'))])
  assert.equal(names.filter((x) => x.status === 'fulfilled').length, 1)
  assert.equal((await store.list()).length, 0)
})

test('SQLite failed Bot commit publishes neither identity nor receipt; retry after failure and restart is safe', async (t) => {
  const { store, file, close, open } = await fixture(t)
  const db = new DatabaseSync(file)
  const docId = db.prepare("SELECT id FROM documents WHERE json_extract(record, '$.kind') = 'pidot.bot-directory'").get().id
  db.exec(`CREATE TRIGGER fail_bot BEFORE INSERT ON document_revisions WHEN NEW.document_id = ${docId} BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`)
  await assert.rejects(store.createBot(creation()))
  assert.equal(store.bots().length, 3)
  db.exec('DROP TRIGGER fail_bot'); db.close()
  await close(store)
  const reopened = await open()
  assert.equal(reopened.bots().length, 3)
  assert.deepEqual((await reopened.harness.snapshot(BotDirectory, context)).requests, {})
  const { bot } = await reopened.createBot(creation())
  await close(reopened); const next = await open()
  assert.equal((await next.createBot(creation())).bot.id, bot.id)
  assert.equal(next.bots().length, 4)
})

test('creation only permits bounded ordinary settings and server-owned capability profiles; no credentials persist', async (t) => {
  const { store } = await fixture(t, { bots: listBots(config) })
  for (const invalid of [null, [], {}, { ...creation(), tools: [] }, { ...creation(), credentials: 'secret' }, { ...creation(), name: ' ' }, { ...creation(), description: 'x'.repeat(2001) }, { ...creation(), requestId: '__proto__' }, { ...creation(), requestId: 'constructor' }, { ...creation(), profile: 'chief' }, { ...creation(), parameters: { tools: [] } }, { ...creation(), parameters: { toolResources: ['other'] } }, { ...creation(), parameters: { model: { id: 'x', baseUrl: 'https://evil.invalid' } } }, { ...creation(), parameters: { maxOutputTokens: 0 } }]) await assert.rejects(store.createBot(invalid))
  assert.equal(store.bots().length, 3)
  const general = (await store.createBot({ ...creation(), parameters: { maxOutputTokens: 128, callLimits: { modelCalls: 4 } } })).bot
  const calendar = (await store.createBot(creation('模拟日程专家', 'request-0002', 'mock-calendar'))).bot
  assert.deepEqual(general.defaults.tools, [BLOCKER_TOOL, 'workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status']); assert.deepEqual(general.defaults.toolResources, ['workspace:local'])
  assert.ok(calendar.defaults.tools.includes(CALENDAR_TOOL)); assert.deepEqual(calendar.defaults.toolResources, ['mock:personal', 'workspace:local'])
  assert.equal(general.defaults.maxOutputTokens, 128)
  assert.equal(JSON.stringify(await store.harness.snapshot(BotDirectory, context)).includes(config.apiKey), false)
})

test('general specialists cannot inherit Chief management tools; reordered settings retry the same identity', async (t) => {
  const seeds = listBots(); seeds[0].defaults.tools.push('manage_bots'); seeds[0].defaults.toolResources = ['admin:all']
  const { store } = await fixture(t, { bots: seeds })
  const input = { ...creation(), parameters: { thinkingLevel: 'off', maxOutputTokens: 128, callLimits: { modelCalls: 3, toolCalls: 2 } } }
  const first = await store.createBot(input)
  const retry = await store.createBot({ ...input, parameters: { callLimits: { toolCalls: 2, modelCalls: 3 }, maxOutputTokens: 128, thinkingLevel: 'off' } })
  assert.equal(retry.created, false); assert.equal(retry.bot.id, first.bot.id)
  assert.deepEqual(first.bot.defaults.tools, [BLOCKER_TOOL, 'workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status']); assert.deepEqual(first.bot.defaults.toolResources, ['workspace:local'])
})

test('authenticated Bot HTTP creation, idempotent retry, filtering and every scoped Task control reject wrong Bot', async (t) => {
  const { store, base, request } = await apiFixture(t)
  assert.equal((await fetch(base + '/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creation()) })).status, 401)
  let response = await request('/api/bots', 'POST', creation()); assert.equal(response.status, 201)
  const { bot } = await response.json()
  assert.equal((await request('/api/bots', 'POST', creation())).status, 200)
  assert.equal((await request('/api/bots', 'PATCH', {})).status, 405)
  assert.equal((await request('/api/bots', 'POST', { ...creation(), tools: ['shell'] })).status, 400)
  response = await request(`/api/bots/${bot.id}/tasks`, 'POST', { title: '独立会话' })
  assert.equal(response.status, 201); const { task } = await response.json()
  const other = await store.create({ botId: 'todo' })
  assert.deepEqual((await (await request(`/api/bots/${bot.id}/tasks`)).json()).tasks.map((item) => item.taskId), [task.taskId])
  assert.equal((await request(`/api/bots/${bot.id}/tasks`, 'POST', { botId: 'todo' })).status, 400)
  for (const [suffix, method, body] of [['', 'GET'], ['/messages', 'POST', { message: '串用' }], ['/state', 'PATCH', { goal: '串用' }], ['/limits', 'PATCH', {}], ['/steer', 'POST', { message: '串用' }], ['/cancel', 'POST', {}], ['/skills', 'POST', { skillId: 'calendar-conflict-analysis' }], ['/approvals/1/decide', 'POST', { decision: 'approved' }], ['/approvals/1/verify', 'POST', {}], ['/approvals/1/insert', 'POST', {}], ['/blockers/1/resolve', 'POST', { content: '串用' }]]) {
    assert.equal((await request(`/api/bots/${bot.id}/tasks/${other.taskId}${suffix}`, method, body)).status, 404, suffix)
  }
  assert.deepEqual((await store.get(other.taskId)).messages, [])
  assert.equal((await request(`/api/bots/${bot.id}/tasks/${task.taskId}/messages`, 'POST', { message: '直接接单' })).status, 202)
  const done = await until(() => store.get(task.taskId), idle)
  assert.match(done.messages.at(-1).content, /直接接单/)
  assert.equal((await request(`/api/bots/missing/tasks`)).status, 404)
})

test('independent Bot Tasks keep FIFO queues, frozen duties and model history separate', async (t) => {
  let entered, release; const started = new Promise((r) => { entered = r }), held = new Promise((r) => { release = r }), calls = []
  const { store } = await fixture(t, { bots: listBots(config), modelReply: async (message, options) => { calls.push({ message, context: options.context }); if (message === 'A-private-first') { entered(); await held } return text(message) } })
  t.after(() => release())
  const a = (await store.createBot(creation('A专家'))).bot, b = (await store.createBot(creation('B专家', 'request-0002'))).bot
  const ta = await store.create({ botId: a.id }), tb = await store.create({ botId: b.id })
  await store.send(ta.taskId, 'A-private-first'); await started
  await store.send(ta.taskId, 'A-private-second'); await store.send(tb.taskId, 'B-private-only')
  const bd = await until(() => store.get(tb.taskId), idle)
  assert.equal((await store.get(ta.taskId)).queueLength, 1); assert.equal(bd.queueLength, 0)
  release(); const ad = await until(() => store.get(ta.taskId), idle)
  assert.deepEqual(ad.messages.filter((m) => m.role === 'user').map((m) => m.content), ['A-private-first', 'A-private-second'])
  const ac = calls.filter((c) => c.message.startsWith('A-')), bc = calls.find((c) => c.message.startsWith('B-'))
  assert.ok(ac.every((c) => c.context.systemPrompt.includes('负责A专家的独立工作') && !JSON.stringify(c.context).includes('B-private')))
  assert.ok(bc.context.systemPrompt.includes('负责B专家的独立工作')); assert.ok(!JSON.stringify(bc.context).includes('A-private'))
  assert.equal(ad.callUsage.modelCalls, 2); assert.equal(bd.callUsage.modelCalls, 1)
  assert.equal((await store.list(a.id)).length, 1)
  const second = await store.create({ botId: a.id }); assert.notEqual(second.conversationId, ta.conversationId); assert.deepEqual(second.messages, [])
})

test('Bot profile Skill activation and produced artifacts never copy into another Bot or conversation', async (t) => {
  const { store } = await fixture(t, { bots: listBots(config) })
  const a = (await store.createBot(creation('A日历', 'request-0001', 'mock-calendar'))).bot, b = (await store.createBot(creation('B日历', 'request-0002', 'mock-calendar'))).bot
  const ta = await store.create({ botId: a.id }), tb = await store.create({ botId: b.id }), tc = await store.create({ botId: a.id })
  await store.activateSkill(ta.taskId, { skillId: 'calendar-conflict-analysis' })
  assert.equal((await store.get(ta.taskId)).skillState.active.length, 1)
  assert.deepEqual((await store.get(tb.taskId)).skillState.active, []); assert.deepEqual((await store.get(tc.taskId)).skillState.active, [])
  await store.revokeTool(a.id, CALENDAR_TOOL)
  assert.ok((await store.get(tb.taskId)).toolSets.authorized.includes(CALENDAR_TOOL))
  await store.harness.commit(async (tx) => {
    const card = await tx.doc(TaskCard, ta.taskId)
    const result = await boundToolResult(tx, card,
      { ok: true, data: { resource: 'mock:personal', events: Array.from({ length: 100 }, (_, n) => ({ id: `a-${n}`, title: 'A-private-artifact'.repeat(30) })) } },
      { toolName: CALENDAR_TOOL, arguments: { month: '2026-10', resource: 'mock:personal' }, turnId: 10, inReplyTo: 11 })
    assert.ok(result.data.resultRef)
    const other = await readToolResult(tx, await tx.doc(TaskCard, tb.taskId), { resultRef: result.data.resultRef, resource: 'mock:personal' })
    assert.equal(other.ok, false)
  }, context)
  assert.deepEqual((await store.harness.snapshot(ToolResults, tb.taskId, context)).artifacts, {})
})

test('Bot problems and approvals remain attached to original Task, another Bot cannot answer or approve them', async (t) => {
  const { store, request } = await apiFixture(t, { bots: listBots(config), modelReply: async (message, { context: ctx }) => {
    const lastUser = ctx.messages.findLastIndex((m) => m.role === 'user' && m.content === message)
    const results = ctx.messages.slice(lastUser + 1).filter((m) => m.role === 'toolResult')
    if (message === 'ask' && !results.length) return turn(BLOCKER_TOOL, { question: '请指定时区', requiredInformation: 'IANA时区', assignee: 'user' })
    if (message === 'approve') {
      if (!results.length) return turn('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' })
      if (results.length === 1) return turn('calendar_read_event', { eventId: 'mock-20261020-1', resource: 'mock:personal' })
      if (results.length === 2) return turn(CALENDAR_WRITE_TOOL, { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' })
    }
    return text()
  } })
  const a = (await store.createBot(creation('A日历', 'request-0001', 'mock-calendar'))).bot, b = (await store.createBot(creation('B日历', 'request-0002', 'mock-calendar'))).bot
  await store.harness.commit(tx => addRule(tx, { botId: a.id, match: { tool: CALENDAR_WRITE_TOOL }, effect: 'ask' }), context)
  const ta = await store.create({ botId: a.id }), tb = await store.create({ botId: b.id })
  await store.send(ta.taskId, 'ask'); const blocked = await until(() => store.get(ta.taskId), (v) => v.blockers.activeId)
  const blocker = blocked.blockers.activeId
  assert.equal((await request(`/api/bots/${b.id}/tasks/${ta.taskId}/blockers/${blocker}/resolve`, 'POST', { answer: 'UTC' })).status, 404)
  await assert.rejects(store.resolveBlocker(tb.taskId, blocker, { answer: 'UTC' }))
  assert.equal((await store.get(ta.taskId)).blockers.activeId, blocker)
  await store.resolveBlocker(ta.taskId, blocker, { answer: 'Asia/Shanghai' }); await until(() => store.get(ta.taskId), idle)
  await store.send(ta.taskId, 'approve'); const waiting = await until(() => store.get(ta.taskId), (v) => v.approvals.activeId)
  const approval = waiting.approvals.activeId
  assert.equal((await request(`/api/bots/${b.id}/tasks/${ta.taskId}/approvals/${approval}/decide`, 'POST', { decision: 'approved' })).status, 404)
  await assert.rejects(store.decideApproval(tb.taskId, approval, { decision: 'approved' }))
  assert.equal((await store.get(ta.taskId)).approvals.activeId, approval)
  assert.equal((await store.get(tb.taskId)).approvals.items.length, 0)
})

test('corrupt native/conversation associations are rejected before a scoped request can mutate them', async (t) => {
  const { store, request } = await apiFixture(t)
  const a = await store.create({ botId: 'chief' }), b = await store.create({ botId: 'todo' })
  await store.harness.commit(async (tx) => { (await tx.doc(TaskCard, a.taskId)).conversationId = b.conversationId }, context)
  assert.equal((await request(`/api/bots/chief/tasks/${a.taskId}/messages`, 'POST', { message: 'wrong' })).status, 409)
  await assert.rejects(store.send(a.taskId, 'wrong'), { code: 'TASK_BINDING_MISMATCH' })
  assert.deepEqual((await store.get(b.taskId)).messages, [])
  await store.harness.commit(async (tx) => { (await tx.doc(TaskCard, a.taskId)).conversationId = a.conversationId; (await tx.doc(TaskCard, a.taskId)).configRef.botId = 'todo' }, context)
  assert.equal((await request(`/api/bots/chief/tasks/${a.taskId}/state`, 'PATCH', { goal: 'wrong' })).status, 409)
})

test('SIGKILL restores dynamic Bot, original conversation, pending input and FIFO without borrowing another Bot history', { timeout: 15000 }, async (t) => {
  const { spawn } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-dynamic-process-'))
  const child = spawn(process.execPath, [new URL('./fixtures/bot-directory-process.mjs', import.meta.url).pathname, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', (part) => { stderr += part })
  const exited = once(child, 'exit'); let store
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } if (store) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const saved = await until(async () => { if (child.exitCode !== null) throw new Error(stderr); try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null } }, Boolean)
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  const calls = []
  store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(), modelReply: async (message, options) => { calls.push({ message, context: options.context }); return text(message) } })
  const done = await until(() => store.get(saved.taskId), idle)
  assert.equal(done.bot.id, saved.bot.id); assert.equal(done.conversationId, saved.conversationId)
  assert.deepEqual(done.parameters, saved.saved.parameters); assert.deepEqual(done.configRef, saved.saved.configRef)
  assert.deepEqual(calls.map((item) => item.message), ['first-private', 'second-private'])
  assert.ok(calls.every((item) => item.context.systemPrompt.includes(saved.bot.description)))
  assert.equal((await store.createBot(saved.input)).bot.id, saved.bot.id)
  assert.deepEqual((await store.get(saved.otherId)).messages, [])
  assert.equal(done.callUsage.unknownTokenCalls, 1)
  assert.equal(done.recoveryHistory.length, 1)
})

test('committed creation with lost HTTP response retries the same receipt after API restart', async (t) => {
  const { store, close, open } = await fixture(t)
  const server = createApiServer({ token, tasks: store })
  const originalCreate = store.createBot
  let committed
  const persisted = new Promise((resolve) => { committed = resolve })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  store.createBot = async (input) => { const result = await originalCreate(input); committed(result); await gate; return result }
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { release(); server.closeAllConnections(); server.close() })
  const controller = new AbortController()
  const response = fetch(`http://127.0.0.1:${server.address().port}/api/bots`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(creation()), signal: controller.signal }).catch((error) => error)
  const first = await persisted
  controller.abort(); release(); assert.equal((await response).name, 'AbortError')
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await close(store)
  const next = await open()
  const retry = await next.createBot(creation())
  assert.equal(retry.created, false); assert.equal(retry.bot.id, first.bot.id); assert.equal(next.bots().length, 4)
})
