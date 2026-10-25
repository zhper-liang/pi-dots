import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { listBots } from './bots.mjs'
import { TaskDigest, MainSessions } from './main-session.mjs'

// PLAN §8.1 main session (phase 1). IDs follow T1-01..T1-09; D-04/D-05 per PLAN §11.
const modelConfig = { baseUrl: 'https://fixture.invalid/v1', model: 'main-fixture', apiKey: 'fixture-only' }
const text = (content = '好的') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
let seq = 0
const turn = (...calls) => { const content = calls.map(([name, args]) => ({ type: 'toolCall', id: `m-${++seq}`, name, arguments: args })); return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } } }
const gate = () => { let release; const promise = new Promise(r => { release = r }); return { promise, release } }
// Main sessions take replies from state.script[taskId]; derived Tasks from state.derived (optionally held by state.gate).
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-main-')), file = join(dir, 'isolated.sqlite')
  const state = { main: new Set(), script: new Map(), derived: [], gate: null, seen: [] }
  const modelReply = async (_message, opts) => {
    state.seen.push(opts)
    const queue = state.main.has(opts.taskId) ? state.script.get(opts.taskId) ?? [] : (state.gate && await state.gate.promise, state.derived)
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next ?? text(state.main.has(opts.taskId) ? '好的' : '派生任务完成')
  }
  let s
  const open = async () => { s = await openTaskStore({ file, bots: listBots(modelConfig), modelReply }); for (const id of Object.values(await s.mainSessions())) state.main.add(id); return s }
  try { await open(); await fn({ s, state, reopen: async () => { await s.close(); return open() } }) }
  finally { state.gate?.release(); await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function until(s, id, check) { for (let i = 0; i < 1000; i++) { const t = await s.get(id); if (await check(t)) return t; await new Promise(r => setTimeout(r, 5)) } assert.fail(`Task ${id} did not settle`) }
async function finished(s, id) { for (let i = 0; i < 1000; i++) { const r = await s.harness.getTask(id, context); if (r.state.status === 'terminal' || r.state.checkpoint?.lastOutcome) return r; await new Promise(r => setTimeout(r, 5)) } assert.fail(`Task ${id} did not finish`) }
const settle = (s, id) => until(s, id, t => t.activeInputId === null && t.runtime.checkpoint?.phase === 'awaitInput')
const mainOf = async (s, botId) => (await s.mainSessions())[botId]
async function say(s, state, botId, message, ...replies) {
  const id = await mainOf(s, botId)
  state.script.set(id, [...(state.script.get(id) ?? []), ...replies])
  await s.send(id, message)
  return settle(s, id)
}
const created = t => t.messages.filter(m => m.toolName === 'task_create').map(m => m.result)
async function configure(s, extra = [], botId = 'calendar') {
  const tools = [...WORKSPACE_TOOLS, ...extra], resources = ['workspace:local']
  const { bot } = await s.getBotConfiguration(botId)
  await s.updateBotConfiguration(botId, { requestId: `main-bot-${++seq}`, expectedVersion: bot.configRef.version, description: '日程助理', tools, resources })
}
const create = (operationId, goal = '整理本周待办', completionCriteria = ['列出未完成的待办']) => ['task_create', { operationId, goal, completionCriteria }]
test('T1-01 every Bot has exactly one main session; backfill and creation are atomic and idempotent', () => fixture(async ({ s, state, reopen }) => {
  const mains = await s.mainSessions()
  assert.deepEqual(Object.keys(mains).sort(), s.bots().map(b => b.id).sort())
  for (const [botId, id] of Object.entries(mains)) { const t = await s.get(id); assert.deepEqual([t.kind, t.bot.id, t.title], ['main', botId, s.bots().find(b => b.id === botId).name]) }
  assert.deepEqual(await s.list(), []) // main sessions are not ordinary Task-list rows
  const { bot } = await s.createBot({ name: '新主会话', description: '整理资料', requestId: 'main-new-bot-1' })
  const id = (await s.mainSessions())[bot.id]; assert.equal((await s.get(id)).kind, 'main')
  const again = await s.createBot({ name: '新主会话', description: '整理资料', requestId: 'main-new-bot-1' })
  assert.equal(again.created, false); assert.equal((await s.mainSessions())[bot.id], id)
  const reopened = await reopen()
  assert.deepEqual(await reopened.mainSessions(), { ...mains, [bot.id]: id })
  // A Bot created by Chief in conversation gets its main session in the same commit.
  const made = await say(reopened, state, 'chief', '建一个松针', turn(['bot_manage', { action: 'create', name: '松针', description: '记笔记', profile: 'general' }]))
  const newId = made.messages.find(m => m.toolName === 'bot_manage').result.data.bot.id
  assert.equal((await reopened.get((await reopened.mainSessions())[newId])).kind, 'main')
}))
test('T1-02 the main session carries assigned write tools alongside task_create/task_status/automation_pause', () => fixture(async ({ s, state }) => {
  await configure(s, ['calendar_reschedule_event', 'calendar_read_event', 'report_blocker', 'task_assign'])
  const t = await say(s, state, 'calendar', '你好')
  const authorized = t.toolSets.authorized
  for (const name of ['workspace.list', 'workspace.get', 'task_create', 'task_status', 'automation_pause', 'calendar_read_event']) assert.ok(authorized.includes(name), name)
  for (const name of ['workspace.prepare_change', 'calendar_reschedule_event', 'task_assign']) assert.ok(authorized.includes(name), name)
  assert.ok(authorized.includes('report_blocker'))
  assert.ok(authorized.includes('workspace.prepare_schedule'))
  assert.ok(state.seen.at(-1).context.tools.some(x => x.name === 'workspace.prepare_change'))
  const chief = await say(s, state, 'chief', '你好')
  assert.ok(chief.toolSets.authorized.includes('bot_manage') && chief.toolSets.authorized.includes('bot_inspect') && chief.toolSets.authorized.includes('report_blocker'))
  // Main-session tools are intrinsic and do not appear on a normal Task.
  const thread = await s.create({ botId: 'calendar' }); assert.ok(!thread.toolSets.authorized.includes('task_create'))
}))
test('T1-03 task_create: idempotent, conflicting reuse refused, self only, inactive and concurrency refused', () => fixture(async ({ s, state }) => {
  state.gate = gate()
  let t = await say(s, state, 'calendar', '帮我整理', turn(create('op-1'), create('op-1'), create('op-1', '换了目标'), ['task_create', { operationId: 'op-2', goal: '给别的Bot', completionCriteria: ['x'], botId: 'todo' }]))
  const [first, replay, conflict, other] = created(t)
  assert.equal(first.ok, true); assert.equal(replay.replayed, true); assert.equal(replay.data.taskId, first.data.taskId)
  assert.equal(conflict.error.code, 'MAIN_REQUEST_CONFLICT'); assert.equal(other.error.code, 'TOOL_INVALID_ARGUMENTS')
  const child = await s.get(first.data.taskId)
  assert.deepEqual([child.kind, child.bot.id, child.mainParent.mainTaskId, child.origin], ['chat', 'calendar', await mainOf(s, 'calendar'), 'user'])
  t = await say(s, state, 'calendar', '再派五个', turn(...['a', 'b', 'c', 'd', 'e'].map(k => create(`op-${k}`, `任务 ${k}`))))
  assert.deepEqual(created(t).slice(-5).map(r => r.ok ? 'ok' : r.error.code), ['ok', 'ok', 'ok', 'ok', 'MAIN_CONCURRENCY_LIMIT'])
  state.gate.release(); state.gate = null
}))
test('T1-04 the main session keeps answering while a derived Task runs', () => fixture(async ({ s, state }) => {
  state.gate = gate()
  const t = await say(s, state, 'calendar', '帮我整理', turn(create('busy')), text('已派出，后台进行中'))
  const childId = created(t)[0].data.taskId
  assert.equal(t.messages.at(-1).content, '已派出，后台进行中')
  assert.notEqual((await s.get(childId)).activeInputId, null) // the derived Task is still working
  assert.equal((await say(s, state, 'calendar', '在吗', text('在'))).messages.at(-1).content, '在')
  state.gate.release(); state.gate = null
  await settle(s, childId)
}))
test('T1-05 over on success, failure and cancel; the digest is injected next turn and deleted only after a committed reply', () => fixture(async ({ s, state }) => {
  const mainId = await mainOf(s, 'calendar')
  const digest = async () => (await s.harness.snapshot(TaskDigest, undefined, context)).byMain[mainId]
  const children = async () => (await s.harness.snapshot(MainSessions, undefined, context)).children
  const mainCalls = () => state.seen.filter(o => o.taskId === mainId)
  state.derived.push(text('整理好了'))
  let t = await say(s, state, 'calendar', '派一个', turn(create('ok-1', '会成功的任务')))
  const okId = created(t)[0].data.taskId; await settle(s, okId)
  assert.deepEqual((await digest()).map(i => [i.taskId, i.state, i.outcome]), [[okId, 'over', 'succeeded']])
  assert.ok((await s.get(mainId)).messages.some(m => m.mirrorKind === 'finished' && m.childTaskId === okId))
  // A failed main reply keeps the item and re-injects it next time.
  await say(s, state, 'calendar', '刚才那个怎样了', new Error('provider down'))
  assert.match(mainCalls().at(-1).context.systemPrompt, /会成功的任务/)
  assert.deepEqual((await digest()).map(i => [i.taskId, i.consumingEntryId]), [[okId, undefined]])
  await say(s, state, 'calendar', '再说一次')
  assert.match(mainCalls().at(-1).context.systemPrompt, /会成功的任务/)
  assert.deepEqual(await digest(), [])
  // Later chat inside the derived Task never writes back.
  await s.send(okId, '继续'); await settle(s, okId); assert.deepEqual(await digest(), [])
  state.derived.push(new Error('derived provider down'))
  t = await say(s, state, 'calendar', '派一个会失败的', turn(create('fail-1', '会失败的任务')))
  const failId = created(t).at(-1).data.taskId; await settle(s, failId)
  state.gate = gate()
  t = await say(s, state, 'calendar', '派一个要取消的', turn(create('cancel-1', '要取消的任务')))
  const cancelId = created(t).at(-1).data.taskId
  await s.cancel(cancelId, {}); state.gate.release(); state.gate = null
  await until(s, mainId, async () => (await children())[cancelId]?.outcome === 'cancelled')
  const rows = await children()
  assert.deepEqual([rows[okId].outcome, rows[failId].outcome, rows[cancelId].outcome], ['succeeded', 'failed', 'cancelled'])
}))
test('T1-06 mirror cards (blocker, proposal, finished) never wake the main session or count against it', () => fixture(async ({ s, state }) => {
  await configure(s, ['report_blocker'])
  await s.rules.add({ botId: 'calendar', match: { tool: 'workspace.prepare_change', action: 'create' }, effect: 'ask' })
  const mainId = await mainOf(s, 'calendar')
  state.derived.push(turn(['report_blocker', { question: '周几开会？', requiredInformation: '日期', assignee: 'user' }]))
  let t = await say(s, state, 'calendar', '安排会议', turn(create('mirror-1', '安排会议')))
  const blockerChild = created(t)[0].data.taskId
  await until(s, blockerChild, c => c.runtime.checkpoint?.phase === 'awaitBlocker')
  state.derived.push(turn(['workspace.prepare_change', { sourceId: 'local', requestId: 'mirror-prop', action: 'create', change: { type: 'Todo', data: { title: '镜像提案' } } }]))
  t = await say(s, state, 'calendar', '加个待办', turn(create('mirror-2', '加待办')))
  const propChild = created(t).at(-1).data.taskId
  await settle(s, propChild)
  let main = await until(s, mainId, m => m.messages.some(x => x.mirrorKind === 'finished' && x.childTaskId === propChild))
  const blocker = main.messages.find(m => m.mirrorKind === 'blocker'), proposal = main.messages.find(m => m.mirrorKind === 'proposal')
  assert.deepEqual([blocker.live, blocker.childTaskId], ['pending', blockerChild]); assert.match(blocker.summary, /周几开会/)
  assert.equal(proposal.live, 'awaiting_confirmation')
  await s.workspaceAgent.confirmLocal({ sourceId: 'local', requestId: 'mirror-prop', payloadHash: proposal.payloadHash, confirmed: true })
  main = await s.get(mainId)
  assert.equal(main.messages.find(m => m.mirrorKind === 'proposal').live, 'succeeded')
  // Two user inputs × (tool turn + reply) = 4 model calls; mirrors added none.
  assert.equal(state.seen.filter(o => o.taskId === mainId).length, 4)
  assert.equal(main.callUsage.modelCalls + main.callUsage.lifetime.modelCalls, 4); assert.equal(main.activeInputId, null)
}))
test('T1-07 the main session keeps talking past 25 inputs; budget is per input with a lifetime total; derived Tasks count per Task', () => fixture(async ({ s, state }) => {
  const mainId = await mainOf(s, 'calendar')
  for (let n = 0; n < 26; n++) await say(s, state, 'calendar', `第 ${n} 句`)
  const t = await s.get(mainId)
  assert.deepEqual([t.callUsage.modelCalls, t.callUsage.lifetime.modelCalls], [1, 25])
  assert.equal(t.messages.filter(m => m.role === 'assistant').length, 26)
  const r = await say(s, state, 'calendar', '派一个', turn(create('count-1')))
  const childId = created(r)[0].data.taskId; await settle(s, childId)
  await s.send(childId, '继续'); await settle(s, childId)
  assert.equal((await s.get(childId)).callUsage.modelCalls, 2)
}))
test('S1 removing a tool after derivation blocks the child at its next call', () => fixture(async ({ s, state }) => {
  await configure(s)
  state.gate = gate()
  state.derived.push(turn(['workspace.prepare_change', { sourceId: 'local', requestId: 'revoked-1', action: 'create', change: { type: 'Todo', data: { title: '不该写入' } } }]))
  const t = await say(s, state, 'calendar', '加待办', turn(create('rev-1', '加待办')))
  const childId = created(t)[0].data.taskId
  const { bot } = await s.getBotConfiguration('calendar')
  await s.updateBotConfiguration('calendar', { requestId: 'main-remove-write-' + ++seq, expectedVersion: bot.configRef.version, description: bot.description, tools: WORKSPACE_TOOLS.filter(name => name !== 'workspace.prepare_change'), resources: ['workspace:local'] })
  state.gate.release(); state.gate = null
  const record = await finished(s, childId) // dies at the model guard or has its tool denied: either way no write
  assert.equal((await s.workspace.query({ sourceId: 'local', type: 'Todo' })).items.length, 0)
  // The next main input settles a terminally faulted child so it no longer holds a concurrency slot.
  const main = await say(s, state, 'calendar', '刚才的任务呢', text('那个任务没能完成'))
  const row = (await s.harness.snapshot(MainSessions, undefined, context)).children[childId]
  assert.equal(row.state, 'over'); if (record.state.status === 'terminal') assert.equal(row.outcome, 'failed')
  assert.ok(main.messages.some(m => m.mirrorKind === 'finished' && m.childTaskId === childId))
  // Lowering a workspace Grant does not remove the Bot's live tool assignment.
  assert.equal(main.messages.at(-1).content, '那个任务没能完成'); assert.ok(main.toolSets.authorized.includes('workspace.list'))
}))
test('T1-09 the main session cannot be cancelled or archived; after deactivation it is read-only', () => fixture(async ({ s, state }) => {
  const id = await mainOf(s, 'todo')
  await say(s, state, 'todo', '你好')
  await assert.rejects(s.cancel(id, {}), { code: 'MAIN_SESSION_PERMANENT' })
  await assert.rejects(s.setArchived(id, { archived: true }), { code: 'MAIN_SESSION_PERMANENT' })
  await s.deactivateBot('todo', { confirm: true })
  await assert.rejects(s.send(id, '还在吗'), { code: 'BOT_INACTIVE' })
  const t = await s.get(id); assert.equal(t.kind, 'main'); assert.ok(t.messages.length >= 2)
}))
test('S1 main session uses live tool assignment without a permission context floor', () => fixture(async ({ s, state }) => {
  await configure(s)
  const mainId = await mainOf(s, 'calendar'), last = () => state.seen.filter(o => o.taskId === mainId).at(-1)
  await say(s, state, 'calendar', '机密暗号是蓝鲸')
  let t = await say(s, state, 'calendar', '你记得吗')
  assert.ok(JSON.stringify(last().context).includes('蓝鲸')) // permissions unchanged: history kept
  const floors = t.messages.filter(m => m.systemKind === 'context-floor').length
  const { bot } = await s.getBotConfiguration('calendar')
  await s.updateBotConfiguration('calendar', { requestId: `main-live-${++seq}`, expectedVersion: bot.configRef.version, description: bot.description, tools: ['calendar_read_schedule'], resources: [] })
  t = await say(s, state, 'calendar', '还记得暗号吗')
  assert.equal(t.messages.filter(m => m.systemKind === 'context-floor').length, floors)
  assert.ok(JSON.stringify(last().context).includes('蓝鲸'))
  assert.equal(t.messages.at(-1).role, 'assistant'); assert.ok(!t.toolSets.authorized.includes('workspace.list'))
}))
