import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { createApiServer } from './app.mjs'
import { listBots } from './bots.mjs'
import { MAIN_READ_TOOLS } from './main-tools.mjs'
import { cardActions } from '../src/system-cards.mjs'

// PLAN §8.7 "帮我想办法" (phase 7). IDs follow T7-01..T7-03; D-19/D-20 per PLAN §11.
const now = Date.parse('2026-10-23T02:00:00Z') // 10:00 Asia/Shanghai
const modelConfig = { baseUrl: 'https://assist-fixture.invalid/v1', model: 'assist-fixture', apiKey: 'fixture-only' }
const text = (content = '好的') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 3 } } })
let seq = 0
const turn = (...calls) => { const content = calls.map(([name, args]) => ({ type: 'toolCall', id: `a-${++seq}`, name, arguments: args })); return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } } }
// Every model call is counted per Task; state.reply decides what the (derived) Task gets.
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-assist-')), state = { reply: () => text(), calls: new Map(), total: 0 }
  const modelReply = async (_m, opts) => { state.total++; state.calls.set(opts.taskId, (state.calls.get(opts.taskId) ?? 0) + 1); return state.reply(opts) }
  let s
  try { s = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots: listBots(modelConfig), modelReply, detectorOptions: { now: () => now } }); await fn({ s, state }) }
  finally { await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function until(s, id, check) { for (let i = 0; i < 1000; i++) { const t = await s.get(id); if (await check(t)) return t; await new Promise(r => setTimeout(r, 5)) } assert.fail(`Task ${id} did not settle`) }
const stopped = (s, id) => until(s, id, t => t.activeInputId === null && t.runtime.checkpoint?.lastOutcome)
const addTodo = (s, title, due = '2026-10-01') => s.workspace.executeLocal({ requestId: `assist-todo-${++seq}`, sourceId: 'local', type: 'Todo', action: 'create', data: { title, due } })
async function findings(s, ...titles) {
  for (const t of titles) await addTodo(s, t)
  await s.detectorWorker.tick()
  return (await s.findings.list()).items.filter(f => f.detector === 'overdue')
}
const chiefMain = async s => s.get((await s.mainSessions()).chief)
const cards = async s => (await chiefMain(s)).messages.filter(m => m.systemKind === 'finding')
test('T7-01 off by default: no button anywhere and the action is refused', () => fixture(async ({ s, state }) => {
  const [f] = await findings(s, '交周报')
  assert.equal((await s.findings.list()).assist, false)
  for (const card of await cards(s)) { assert.equal(card.assist, false); assert.equal(card.assistTaskId, null) }
  const inbox = (await s.inbox()).items.filter(i => i.kind === 'finding')
  assert.ok(inbox.length && inbox.every(i => i.detail.assist === false))
  // The card logic shows the button only when the setting is on (card.assist).
  assert.deepEqual(cardActions({ kind: 'finding', state: 'open' }), ['handle', 'dismiss', 'mute'])
  assert.deepEqual(cardActions({ kind: 'summary', state: 'open' }), ['handle', 'dismiss'])
  const before = (await s.list()).length
  await assert.rejects(s.findings.act({ id: f.id, action: 'assist' }), { code: 'FINDING_ASSIST_OFF' })
  assert.equal((await s.list()).length, before); assert.equal(state.total, 0)
}))

test('T7-02 on: a read-only Task in Chief\'s main session, origin user, 5 model / 10 tool calls; the finding stays open', () => fixture(async ({ s, state }) => {
  const [a, b] = await findings(s, '交周报', '订机票')
  assert.deepEqual((await s.findings.act({ action: 'assist-setting', enabled: true })).assist, true)
  for (const card of await cards(s)) assert.equal(card.assist, true)
  assert.ok((await s.inbox()).items.filter(i => i.kind === 'finding').every(i => i.detail.assist === true))
  assert.deepEqual(cardActions({ kind: 'finding', state: 'open', assist: true }), ['handle', 'assist', 'dismiss', 'mute'])
  assert.deepEqual(cardActions({ kind: 'summary', state: 'open', assist: true }), ['handle', 'assist', 'dismiss'])
  for (const st of ['resolved', 'dismissed', 'muted', 'handled']) assert.deepEqual(cardActions({ kind: 'finding', state: st, assist: true }), [])
  // The analysis keeps calling a tool: the 5-model-call cap stops it.
  state.reply = () => turn(['task_history_read', {}])
  const r = await s.findings.act({ id: a.id, action: 'assist' })
  const child = await stopped(s, r.taskId)
  assert.equal(child.mainParent.mainTaskId, (await s.mainSessions()).chief)
  assert.equal(child.origin, 'user'); assert.deepEqual(child.findingAssist, { findingId: a.id })
  assert.match(child.taskState.goal, /^分析这条发现，给出方案：/); assert.match(child.title, /^想办法：/)
  assert.deepEqual([child.parameters.callLimits.modelCalls, child.parameters.callLimits.toolCalls], [5, 10])
  assert.equal(child.runtime.checkpoint.lastOutcome, 'limited'); assert.equal(child.callUsage.modelCalls, 5); assert.equal(state.calls.get(r.taskId), 5)
  for (const name of child.toolSets.authorized) assert.ok(MAIN_READ_TOOLS.includes(name), name)
  for (const name of ['report_blocker', 'bot_manage', 'bot_inspect', 'workspace.prepare_change', 'task_assign']) assert.ok(!child.toolSets.authorized.includes(name), name)
  // The finding is still open; the card links the analysis; a second click returns the same Task.
  const listed = (await s.findings.list()).items.find(f => f.id === a.id)
  assert.equal(listed.state, 'open'); assert.equal(listed.assistTaskId, r.taskId)
  assert.equal((await cards(s)).find(c => c.findingId === a.id).assistTaskId, r.taskId)
  assert.equal((await s.findings.act({ id: a.id, action: 'assist' })).taskId, r.taskId)
  // D-20: a finished analysis shows its conclusion on the main session's finished card.
  state.reply = () => text('方案一：今天下午 3 点前交周报。方案二：先和主管说明延期。')
  const second = await s.findings.act({ id: b.id, action: 'assist' })
  await stopped(s, second.taskId)
  const done = await until(s, (await s.mainSessions()).chief, t => t.messages.some(m => m.systemKind === 'mirror' && m.mirrorKind === 'finished' && m.childTaskId === second.taskId))
  const finished = done.messages.find(m => m.systemKind === 'mirror' && m.mirrorKind === 'finished' && m.childTaskId === second.taskId)
  assert.match(finished.result, /方案一/)
  // Ordinary derived Tasks keep the plain finished card.
  const handled = await s.findings.act({ id: (await findings(s, '买票'))[0].id, action: 'handle' })
  await stopped(s, handled.taskId)
  const plain = (await until(s, (await s.mainSessions()).chief, t => t.messages.some(m => m.mirrorKind === 'finished' && m.childTaskId === handled.taskId))).messages.find(m => m.mirrorKind === 'finished' && m.childTaskId === handled.taskId)
  assert.equal(plain.result, undefined)
  // A closed finding cannot start an analysis.
  const [c] = (await s.findings.list()).items.filter(f => f.detector === 'overdue' && !f.assistTaskId)
  await s.findings.act({ id: c.id, action: 'dismiss' })
  await assert.rejects(s.findings.act({ id: c.id, action: 'assist' }), { code: 'FINDING_CLOSED' })
}))

test('D-19 turning it on can assign Chief read-only local access without a capability pool', () => fixture(async ({ s, state }) => {
  assert.deepEqual((await s.findings.list()).chiefRead, { available: true, enabled: false })
  for (const bad of [{ action: 'assist-setting' }, { action: 'assist-setting', enabled: false, chiefRead: true }, { action: 'assist', id: 'x', enabled: true }, { action: 'assist-setting', enabled: 'yes' }])
    await assert.rejects(s.findings.act(bad), { code: 'INVALID_FINDING_ACTION' })
  assert.deepEqual((await s.findings.list()).chiefRead, { available: true, enabled: false })
  const version = (await s.getBotConfiguration('chief')).bot.configRef.version
  const on = await s.findings.act({ action: 'assist-setting', enabled: true, chiefRead: true })
  assert.deepEqual(on, { assist: true, chiefRead: { available: true, enabled: true } })
  const config = await s.getBotConfiguration('chief')
  assert.ok(config.assigned.tools.includes('workspace.list') && config.assigned.tools.includes('workspace.get'))
  assert.ok(!config.assigned.tools.includes('workspace.prepare_change')); assert.ok(config.assigned.resources.includes('workspace:local'))
  // Repeating changes nothing.
  const after = config.bot.configRef.version; assert.notEqual(after, version)
  await s.findings.act({ action: 'assist-setting', enabled: true, chiefRead: true })
  assert.equal((await s.getBotConfiguration('chief')).bot.configRef.version, after)
  // The analysis can now read the local to-dos.
  const [f] = await findings(s, '交周报')
  let replies = 0
  state.reply = () => ++replies === 1 ? turn(['workspace.list', { sourceId: 'local', type: 'Todo' }]) : text('看过待办了')
  const r = await s.findings.act({ id: f.id, action: 'assist' })
  const child = await stopped(s, r.taskId)
  const read = child.messages.find(m => m.toolName === 'workspace.list').result
  assert.equal(read.ok, true); assert.ok(JSON.stringify(read.data).includes('交周报'))
  // Chief's main session uses the same current assignment.
  state.reply = () => text('好的')
  await s.send((await s.mainSessions()).chief, '你好')
  const main = await stopped(s, (await s.mainSessions()).chief)
  assert.ok(main.toolSets.authorized.includes('workspace.list')); assert.ok(!main.toolSets.authorized.includes('workspace.prepare_change'))
}))

test('T7-03 turning it off removes the button and refuses new analyses; running ones finish; detection never calls a model', () => fixture(async ({ s, state }) => {
  await s.findings.act({ action: 'assist-setting', enabled: true })
  const [a, b] = await findings(s, '交周报', '订机票')
  const started = await s.findings.act({ id: a.id, action: 'assist' })
  await stopped(s, started.taskId)
  assert.deepEqual(await s.findings.act({ action: 'assist-setting', enabled: false }), { assist: false, chiefRead: { available: true, enabled: false } })
  for (const card of await cards(s)) assert.equal(card.assist, false)
  assert.ok((await s.inbox()).items.filter(i => i.kind === 'finding').every(i => i.detail.assist === false))
  await assert.rejects(s.findings.act({ id: b.id, action: 'assist' }), { code: 'FINDING_ASSIST_OFF' })
  assert.equal((await s.findings.act({ id: a.id, action: 'assist' })).taskId, started.taskId) // the earlier analysis stays linked
  // With the setting on or off, a detection pass makes no model call (I-07).
  for (const enabled of [true, false]) {
    await s.findings.act({ action: 'assist-setting', enabled })
    const before = state.total
    await addTodo(s, `新的逾期-${enabled}`); await s.detectorWorker.tick()
    assert.equal(state.total, before, `assist=${enabled}`)
  }
  // HTTP: the setting is behind the API token.
  const server = createApiServer({ tasks: s, token: 'assist-token' }); await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/findings`, body = JSON.stringify({ action: 'assist-setting', enabled: true })
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401)
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer assist-token', 'Content-Type': 'application/json' }, body })
    assert.equal(response.status, 200); assert.equal((await response.json()).data.assist, true)
    assert.equal((await (await fetch(url, { headers: { Authorization: 'Bearer assist-token' } })).json()).data.assist, true)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
}))
