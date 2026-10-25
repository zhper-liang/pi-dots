import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { ruleText } from './inbox.mjs'
import { eventArgs, externalFixture } from './fixtures/workspace-external.mjs'

// PLAN §8.5 routines under each Bot (phase 5). IDs follow T5-01..T5-05; D-12..D-14 per PLAN §11.
const start = Date.parse('2026-10-19T00:00:00Z'), MIN = 60000
const modelConfig = { baseUrl: 'https://routine-fixture.invalid/v1', model: 'routine-fixture', apiKey: 'fixture-only' }
const text = (content = '完成') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
let seq = 0
const turn = (...calls) => { const content = calls.map(([name, args]) => ({ type: 'toolCall', id: `r-${++seq}`, name, arguments: args })); return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } } }
const spec = (extra = {}) => ({ kind: 'agent_readonly_workflow', botId: 'calendar', sourceIds: ['local'], prompt: '整理本地待办', promptVersion: 'v1', callLimits: { modelCalls: 5, toolCalls: 12, totalTokens: 5000 }, notification: 'inbox', ...extra })
const plan = (requestId, rule, extra = {}) => ({ requestId, command: 'create', title: `例行-${requestId}`, timezone: 'Asia/Shanghai', rule, actionSpec: spec(extra), confirmed: true })
const proposal = (extra = {}) => ({ title: '每日待办整理', prompt: '整理今天到期的待办', rule: { type: 'daily', time: '08:00' }, sourceIds: ['local'], notification: 'inbox', ...extra })

// Main sessions reply from state.main; every other Task (runs, derived) from state.run.
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-routine-')); let s, time = start
  const state = { mains: new Set(), main: [], run: [] }
  const modelReply = async (_m, opts) => (state.mains.has(opts.taskId) ? state.main : state.run).shift() ?? text()
  const opts = { file: join(dir, 'isolated.sqlite'), bots: listBots(modelConfig), modelReply, legacyApprovalRules: false, workspaceScheduleOptions: { autoStart: false, onError: e => console.error(e), now: () => time } }
  try {
    s = await openTaskStore(opts)
    for (const id of Object.values(await s.mainSessions())) state.mains.add(id)
    const { bot } = await s.getBotConfiguration('calendar')
    await s.updateBotConfiguration('calendar', { requestId: 'routine-bot', expectedVersion: bot.configRef.version, description: '日程助理', tools: WORKSPACE_TOOLS, resources: ['workspace:local'] })
    await fn({ s, state, setTime: t => { time = t }, tick: () => s.workspaceScheduler.tick() })
  } finally { await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function until(s, id, check) { for (let i = 0; i < 600; i++) { const t = await s.get(id); if (await check(t)) return t; await new Promise(r => setTimeout(r, 10)) } assert.fail(`Task ${id} did not settle`) }
const settled = (s, id) => until(s, id, t => t.activeInputId === null && t.runtime.checkpoint?.lastOutcome && t.runtime.checkpoint.phase === 'awaitInput')
const awaiting = (s, id) => until(s, id, t => t.runtime.checkpoint?.phase === 'awaitApproval' && t.approvals.activeId !== null)
const runs = async (s, id) => (await s.workspaceSchedules.list({ scheduleId: id })).items
const todos = async s => (await s.workspace.query({ sourceId: 'local', type: 'Todo' })).items.filter(x => !x.deletedAt)
const addTodo = (s, requestId, data) => s.workspace.executeLocal({ sourceId: 'local', requestId, type: 'Todo', action: 'create', data })
async function runOnce(s, setTime, tick, rule = { type: 'at', at: new Date(start + MIN).toISOString() }, extra = {}) {
  const p = (await s.workspaceSchedules.manage(plan(`run-${++seq}`, rule, extra))).receipt.schedule
  setTime(start + MIN); await tick()
  const [row] = await runs(s, p.id)
  return { p, id: row.taskId, task: await settled(s, row.taskId) }
}

test('S3 routine proposals run directly; an ask rule restores the approval card', () => fixture(async ({ s, state }) => {
  const mainId = (await s.mainSessions()).calendar
  state.main.push(turn(['routine_propose', proposal()]), text('已设置'))
  await s.send(mainId, '每天早上八点帮我整理待办')
  const first = await settled(s, mainId)
  const receipt = first.messages.filter(m => m.toolName === 'routine_propose').at(-1).result
  assert.equal(receipt.ok, true)
  assert.equal(first.approvals.items.length, 0)
  assert.equal((await s.workspaceSchedules.list({})).items.length, 1)

  await s.rules.add({ botId: 'calendar', match: { tool: 'routine_propose' }, effect: 'ask' })
  state.main.push(turn(['routine_propose', proposal({ title: '第二个' })]), text('已设置'))
  await s.send(mainId, '再加一个')
  const card = (await awaiting(s, mainId)).approvals.items.at(-1)
  assert.deepEqual([card.toolName, card.allowAlways], ['routine_propose', true])
  assert.equal((await s.workspaceSchedules.list({})).items.length, 1)
  await s.decideApproval(mainId, card.id, { decision: 'approved', always: true })
  await settled(s, mainId)
  assert.equal((await s.workspaceSchedules.list({})).items.length, 2)
  assert.ok((await s.rules.list()).some(r => r.match.tool === 'routine_propose' && r.effect === 'allow'))
}))

test('T5-02 test run is read-only, never delivered, marked as a test, and allowed while paused', () => fixture(async ({ s, state, tick }) => {
  await addTodo(s, 'seed', { title: '买牛奶' })
  const p = (await s.workspaceSchedules.manage(plan('daily', { type: 'daily', time: '08:00' }, { writes: true }))).receipt.schedule
  await s.setAutomation({ paused: true, confirmed: true })
  state.run.push(turn(['workspace.prepare_change', { sourceId: 'local', requestId: 'test-write', action: 'create', change: { type: 'Todo', data: { title: '不该出现' } } }]), text('只看了看'))
  const op = await s.workspaceSchedules.testRun({ id: p.id, requestId: 'test-1' })
  const t = await settled(s, op.receipt.taskId)
  assert.ok(t.title.startsWith('测试运行'))
  assert.deepEqual(t.parameters.tools, ['workspace.list', 'workspace.get'])
  assert.ok(!t.toolSets.authorized.includes('workspace.prepare_change'))
  assert.equal(t.messages.find(m => m.toolName === 'workspace.prepare_change').result.error.code, 'TOOL_NOT_AUTHORIZED')
  assert.deepEqual((await todos(s)).map(x => x.title), ['买牛奶'])
  await assert.rejects(s.workspaceSchedules.testRun({ id: p.id, requestId: 'test-2' }), { code: 'WORKSPACE_SCHEDULE_TEST_RUNNING' }) // until reconciled
  await tick()
  const row = (await runs(s, p.id)).find(r => r.test)
  assert.deepEqual([row.state, row.taskId, row.result.notificationDelivered], ['succeeded', t.taskId, false])
  assert.equal((await s.workspaceReminders.list({})).items.length, 0) // not delivered
  assert.equal((await s.workspaceSchedules.list({})).items[0].testOccurrenceId, null)
}))

test('T5-03 events fire once each (todo due, schedule change, own Task finished); paused events are skipped, never back-filled', () => fixture(async ({ s, state, setTime, tick }) => {
  const due = (await s.workspaceSchedules.manage(plan('due', { type: 'event', event: 'todo_due' }))).receipt.schedule
  const changed = (await s.workspaceSchedules.manage(plan('changed', { type: 'event', event: 'event_changed' }))).receipt.schedule
  const finished = (await s.workspaceSchedules.manage(plan('finished', { type: 'event', event: 'task_finished' }))).receipt.schedule
  assert.equal(changed.nextDueAt, null)
  await tick()
  for (const p of [due, changed, finished]) assert.deepEqual(await runs(s, p.id), [], p.title)

  await addTodo(s, 'due-soon', { title: '交水费', due: new Date(start + 2 * MIN).toISOString() })
  setTime(start + MIN); await tick()
  assert.deepEqual(await runs(s, due.id), []) // not due yet
  setTime(start + 3 * MIN); await tick()
  let [row] = await runs(s, due.id)
  assert.deepEqual([row.trigger.event, row.trigger.refs.map(r => r.title)], ['todo_due', ['交水费']])
  const dueTask = await settled(s, row.taskId)
  assert.equal(dueTask.messages[0].content.includes('触发：待办到期（「交水费」）'), true)
  assert.equal((await s.harness.snapshot((await import('./tasks.mjs')).TaskCard, row.taskId, context)).origin, 'event')

  setTime(start + 4 * MIN)
  await s.workspace.executeLocal({ sourceId: 'local', requestId: 'meeting', type: 'Event', action: 'create', data: { title: '周会', start: '2026-10-20T15:00:00+08:00', end: '2026-10-20T16:00:00+08:00', timezone: 'Asia/Shanghai' } })
  await tick()
  ;[row] = await runs(s, changed.id)
  assert.equal(row.trigger.event, 'event_changed'); await settled(s, row.taskId)

  const mainId = (await s.mainSessions()).calendar
  state.main.push(turn(['task_create', { operationId: 'derive-1', goal: '整理周会资料', completionCriteria: ['列出要点'] }]), text('派出去了'))
  await s.send(mainId, '帮我整理周会资料'); await settled(s, mainId)
  const childId = (await s.get(mainId)).messages.find(m => m.toolName === 'task_create').result.data.taskId
  await settled(s, childId)
  await until(s, mainId, t => t.messages.some(m => m.mirrorKind === 'finished'))
  setTime(start + 5 * MIN); await tick()
  ;[row] = await runs(s, finished.id)
  assert.deepEqual([row.trigger.event, row.trigger.refs.map(r => r.id)], ['task_finished', [String(childId)]]); await settled(s, row.taskId)

  // Each fired exactly once; the finished runs reconcile and nothing new fires.
  setTime(start + 6 * MIN); await tick(); setTime(start + 7 * MIN); await tick()
  for (const p of [due, changed, finished]) assert.equal((await runs(s, p.id)).length, 1, p.title)

  // I-14: while paused an event is recorded as skipped, no Task; after resume nothing is back-filled.
  const before = (await s.list()).length
  await s.setAutomation({ paused: true, confirmed: true })
  setTime(start + 8 * MIN)
  await s.workspace.executeLocal({ sourceId: 'local', requestId: 'meeting-2', type: 'Event', action: 'create', data: { title: '复盘', start: '2026-10-21T15:00:00+08:00', end: '2026-10-21T16:00:00+08:00', timezone: 'Asia/Shanghai' } })
  await tick()
  const skipped = (await runs(s, changed.id)).find(r => r.state === 'skipped')
  assert.deepEqual([skipped.reason, skipped.taskId], ['automation_paused', undefined])
  await s.setAutomation({ paused: false, confirmed: true })
  setTime(start + 9 * MIN); await tick(); setTime(start + 10 * MIN); await tick()
  assert.equal((await runs(s, changed.id)).filter(r => r.taskId).length, 1)
  assert.equal((await s.list()).length, before)
}))

test('T5-03b D-14: a schedule-change routine is not re-triggered by its own changes', () => fixture(async ({ s, state, setTime, tick }) => {
  const p = (await s.workspaceSchedules.manage(plan('self', { type: 'event', event: 'event_changed' }, { writes: true }))).receipt.schedule
  await s.workspace.executeLocal({ sourceId: 'local', requestId: 'seed-event', type: 'Event', action: 'create', data: { title: '周会', start: '2026-10-20T15:00:00+08:00', end: '2026-10-20T16:00:00+08:00', timezone: 'Asia/Shanghai' } })
  state.run.push(turn(['workspace.prepare_change', { sourceId: 'local', requestId: 'self-write', action: 'create', change: { type: 'Event', data: { title: '会前准备', start: '2026-10-20T14:30:00+08:00', end: '2026-10-20T15:00:00+08:00', timezone: 'Asia/Shanghai' } } }]), text('加了会前准备'))
  await tick()
  const [row] = await runs(s, p.id)
  const t = await settled(s, row.taskId)
  assert.equal(t.messages.find(m => m.toolName === 'workspace.prepare_change').result.data.state, 'succeeded')
  for (let i = 1; i <= 3; i++) { setTime(start + i * MIN); await tick() }
  assert.equal((await runs(s, p.id)).length, 1)
  // Undoing the routine's automatic change is not a new schedule change either (no undo/redo fight).
  await s.workspaceAgent.undoAuto({ requestId: 'self-write', confirmed: true })
  for (let i = 4; i <= 6; i++) { setTime(start + i * MIN); await tick() }
  assert.equal((await runs(s, p.id)).length, 1)
  // A real change by the user still triggers it.
  await s.workspace.executeLocal({ sourceId: 'local', requestId: 'user-event', type: 'Event', action: 'create', data: { title: '复盘', start: '2026-10-21T15:00:00+08:00', end: '2026-10-21T16:00:00+08:00', timezone: 'Asia/Shanghai' } })
  setTime(start + 7 * MIN); await tick()
  assert.equal((await runs(s, p.id)).length, 2)
}))

// Expiry checks use the store's wall clock; Date is mocked before the store opens so it can be advanced.
test('S3 unattended routine skips deletion and records why; six ordinary writes still run', () => fixture(async ({ s, state, setTime, tick }) => {
  await addTodo(s, 'old', { title: '旧待办' })
  const old = (await todos(s))[0]
  const creates = Array.from({ length: 6 }, (_, i) => ['workspace.prepare_change', { sourceId: 'local', requestId: 'batch-' + i, action: 'create', change: { type: 'Todo', data: { title: '批量' + i } } }])
  state.run.push(turn(...creates, ['workspace.prepare_change', { sourceId: 'local', requestId: 'remove-old', action: 'delete', change: { type: 'Todo', id: old.id, expectedVersion: old.version } }]), text('整理好了'))
  const { id, task } = await runOnce(s, setTime, tick, undefined, { writes: true })
  const results = task.messages.filter(m => m.toolName === 'workspace.prepare_change').map(m => m.result.data)
  assert.deepEqual(results.map(r => r.state), ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'skipped'])
  assert.match(results.at(-1).receipt.notice, /已跳过：这一步需要你来做/)
  assert.equal((await s.inbox()).items.filter(i => i.kind === 'workspace-proposal').length, 0)
  assert.equal(task.messages.filter(m => m.systemKind === 'auto-applied').length, 6)
  assert.ok((await todos(s)).some(x => x.id === old.id))
  await s.workspaceAgent.undoAuto({ requestId: 'batch-0', confirmed: true })
  assert.ok(!(await todos(s)).some(x => x.title === '批量0'))
  assert.equal((await s.get(id)).runtime.checkpoint.lastOutcome, 'completed')
}))

test('S3 external routine writes directly; an ask rule skips without dispatch', () => {
  let time = start
  const state = { run: [] }
  return externalFixture(async f => {
    const s = f.store, resources = ['workspace:local', 'workspace:' + f.sourceId]
    const { bot } = await s.getBotConfiguration('calendar')
    await s.updateBotConfiguration('calendar', { requestId: 'r3-bot-0001', expectedVersion: bot.configRef.version, description: '日程助理', tools: WORKSPACE_TOOLS, resources })
    const first = (await s.workspaceSchedules.manage({ ...plan('r3-direct', { type: 'at', at: new Date(start + MIN).toISOString() }, { writes: true }), actionSpec: spec({ writes: true, sourceIds: [f.sourceId] }) })).receipt.schedule
    state.run.push(turn(['workspace.prepare_change', { sourceId: f.sourceId, requestId: 'r3-create', action: 'create', change: { arguments: eventArgs } }]), text('已创建'))
    time = start + MIN; await s.workspaceScheduler.tick()
    const [row] = (await s.workspaceSchedules.list({ scheduleId: first.id })).items
    const direct = (await settled(s, row.taskId)).messages.find(m => m.toolName === 'workspace.prepare_change').result.data
    assert.equal(direct.state, 'succeeded')
    assert.equal(f.writes.length, 1)

    await s.rules.add({ botId: 'calendar', match: { tool: 'workspace.prepare_change', action: 'create', sourceId: f.sourceId }, effect: 'ask' })
    const second = (await s.workspaceSchedules.manage({ ...plan('r3-ask', { type: 'at', at: new Date(start + 2 * MIN).toISOString() }, { writes: true }), actionSpec: spec({ writes: true, sourceIds: [f.sourceId] }) })).receipt.schedule
    state.run.push(turn(['workspace.prepare_change', { sourceId: f.sourceId, requestId: 'r3-skip', action: 'create', change: { arguments: eventArgs } }]), text('已跳过'))
    time = start + 2 * MIN; await s.workspaceScheduler.tick()
    const [skipRow] = (await s.workspaceSchedules.list({ scheduleId: second.id })).items
    const skipped = (await settled(s, skipRow.taskId)).messages.find(m => m.toolName === 'workspace.prepare_change').result.data
    assert.equal(skipped.state, 'skipped')
    assert.match(skipped.receipt.notice, /已跳过：这一步需要你来做/)
    assert.equal(f.writes.length, 1)
  }, { bots: listBots(modelConfig), modelReply: async () => state.run.shift() ?? text(), storeOptions: { workspaceScheduleOptions: { autoStart: false, now: () => time } } })
})

test('T5-05 "接着聊" derives a new Task in the Bot main session with the run link; the run is unchanged', () => fixture(async ({ s, state, setTime, tick }) => {
  state.run.push(text('今天有 2 个待办到期：交水费、买牛奶。'))
  const { id, task } = await runOnce(s, setTime, tick)
  assert.deepEqual(task.parameters.tools, ['workspace.list', 'workspace.get']) // D-13: no writes=true, stays read-only
  await tick()
  const messages = task.messages.length
  const mainId = (await s.mainSessions()).calendar
  const first = await s.followUpRun(id), again = await s.followUpRun(id)
  assert.equal(again.taskId, first.taskId) // one follow-up per run; reopening returns it
  const child = await settled(s, first.taskId)
  assert.ok(child.title.startsWith('接着聊：例行-'), child.title)
  assert.match(child.messages[0].content, new RegExp(`运行任务 #${id}`))
  assert.match(child.messages[0].content, /交水费、买牛奶/)
  assert.equal((await s.harness.snapshot((await import('./tasks.mjs')).TaskCard, first.taskId, context)).mainParent.mainTaskId, mainId)
  const run = await s.get(id)
  assert.equal(run.messages.length, messages)
  await assert.rejects(s.send(id, '继续'), { code: 'WORKSPACE_WORKFLOW_INPUT_IMMUTABLE' })
  await assert.rejects(s.followUpRun(mainId), { code: 'NOT_ROUTINE_RUN' })
}))

test('T5-06 Bot page routine form and labels (pure UI logic)', async () => {
  const { routineInput, ruleLabel, runLabel, ROUTINE_LIMITS } = await import('../src/routines.mjs')
  const { cardActions, inboxCard } = await import('../src/system-cards.mjs')
  const { ROUTINE_CALL_LIMITS } = await import('./main-tools.mjs')
  const now = Date.parse('2026-10-22T00:00:00Z'), base = { title: '每日整理', prompt: '整理待办', botId: 'calendar', requestId: 'req-00001', now }
  const daily = routineInput({ ...base, when: 'daily', value: '08:00' }).input
  assert.deepEqual([daily.rule, daily.actionSpec.writes, daily.actionSpec.botId, daily.actionSpec.sourceIds, daily.confirmed], [{ type: 'daily', time: '08:00' }, true, 'calendar', ['local'], true])
  assert.deepEqual(ROUTINE_LIMITS, ROUTINE_CALL_LIMITS) // the page and a proposal create the same kind of routine
  assert.deepEqual(routineInput({ ...base, when: 'interval', value: '90' }).input.rule.seconds, 5400)
  assert.deepEqual(routineInput({ ...base, when: 'event_changed', writes: false }).input.rule, { type: 'event', event: 'event_changed' })
  assert.equal(routineInput({ ...base, when: 'event_changed', writes: false }).input.actionSpec.writes, false)
  for (const bad of [{ when: 'daily', value: '8点' }, { when: 'interval', value: '0' }, { when: 'at', value: '2026-10-21T08:00:00+08:00' }, { when: 'cron', value: '* * *' }, { title: ' ', when: 'daily', value: '08:00' }]) assert.ok(routineInput({ ...base, ...bad }).error, JSON.stringify(bad))
  assert.equal(ruleLabel({ type: 'at', at: '2026-10-23T01:00:00.000Z' }), '10月23日 09:00 一次')
  assert.deepEqual([ruleLabel({ type: 'daily', time: '08:00' }), ruleLabel({ type: 'interval', seconds: 7200 }), ruleLabel({ type: 'event', event: 'task_finished' })], ['每天 08:00', '每 2 小时', '本 Bot 的任务结束时'])
  assert.equal(ruleText({ type: 'interval', seconds: 7200 }), '每 2 小时')
  assert.deepEqual([runLabel({ state: 'skipped', reason: 'automation_paused' }), runLabel({ state: 'succeeded', test: true })], ['跳过（自动化暂停中）', '测试 · 完成'])
  assert.deepEqual(cardActions(inboxCard({ kind: 'approval', detail: { toolName: 'routine_propose' } })), ['approve', 'always', 'reject'])
})
