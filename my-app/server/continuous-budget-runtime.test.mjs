import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { ContinuousBudget } from './continuous-task.mjs'
import { MockCalendar, TaskApprovals, CALENDAR_WRITE_TOOL } from './approvals.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { CALENDAR_TOOL, CALENDAR_EVENT_TOOL } from './tools.mjs'
import { createFeishuClient, FEISHU_TOOLS } from './feishu-calendar.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'budget-runtime', apiKey: 'fixture-only', contextWindow: 32768 }
const text = () => ({ mode: 'model', reply: { content: '保留原目标，按回执继续核验。' }, execution: { usage: { totalTokens: 7 } } })
const turn = (name, args) => { const calls = [{ type: 'toolCall', id: name, name, arguments: args }]; return { ...text(), toolCalls: calls, assistant: { role: 'assistant', content: calls, timestamp: Date.now() } } }
const blocked = signal => new Promise((_, reject) => { const stop = () => reject(signal.reason); if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }) })
async function until(read, match) { for (let i = 0; i < 600; i++) { const value = await read(); if (match(value)) return value; await delay(5) } assert.fail(`state did not settle: ${JSON.stringify(await read())}`) }
async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-budget-runtime-'))
  const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), ...options })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return store
}
async function start(store, toolCalls = 10) {
  return (await store.startContinuous({ requestId: 'budget-start', origin: { kind: 'main', taskId: (await store.mainSessions()).calendar },
    goal: '核验隔离日历操作', completionCriteria: ['目标事件回读符合要求'], limits: { modelCalls: 10, toolCalls, totalTokens: 1000000, durationMs: 60000 } })).rootTaskId
}
async function control(store, id, action) { const task = await store.get(id); return store.controlContinuous(id, { requestId: `${action}-${task.continuous.version}`, expectedVersion: task.continuous.version, action }) }

test('LR03 approved write is held while paused and root reservation is durable before execution', async t => {
  let store, models = 0, writes = 0
  const resource = 'mock:personal', eventId = 'mock-20261020-1'
  const args = { resource, eventId, expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' }
  store = await fixture(t, { modelReply: async (_message, { signal }) => {
    models++
    if (models === 1) return turn(CALENDAR_TOOL, { resource, date: '2026-10-20' })
    if (models === 2) return turn(CALENDAR_EVENT_TOOL, { resource, eventId })
    if (models === 3) return turn(CALENDAR_WRITE_TOOL, args)
    return blocked(signal)
  }, calendarWriteImpl: async (operation, { execute }) => {
    writes++
    const budget = await store.harness.snapshot(ContinuousBudget, operation.taskId, context)
    assert.equal(budget.attempts[operation.budgetAttempt.attemptId].state, 'reserved')
    return execute()
  } })
  const id = await start(store)
  const pending = await until(() => store.get(id), task => Boolean(task.approvals.activeId))
  await control(store, id, 'pause')
  await store.decideApproval(id, pending.approvals.activeId, { decision: 'approved' })
  await until(() => store.get(id), task => task.runtime.checkpoint.phase === 'continuousWait')
  assert.equal(writes, 0)
  assert.deepEqual((await store.harness.snapshot(MockCalendar, undefined, context)).events, {})
  await control(store, id, 'resume')
  const done = await until(() => store.get(id), task => Boolean(task.approvals.items[0].receipt))
  assert.equal(done.approvals.items[0].receipt.result.ok, true)
  assert.equal(writes, 1)
  assert.equal(done.continuous.usage.toolCalls, 4)
  assert.equal(done.executionPolicy.rootInputId, pending.executionPolicy.rootInputId)
  await store.cancel(id, {})
})

test('LR03 direct read shares root budget, pauses before transport and cannot spend the last tool slot twice', async t => {
  let reads = 0, store, id
  const response = data => new Response(JSON.stringify({ code: 0, data }))
  const client = createFeishuClient({ env: { FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture-only' }, fetchImpl: async url => {
    if (url.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'fixture-only', expire: 100 }))
    if (url.includes('/events')) {
      reads++
      const budget = await store.harness.snapshot(ContinuousBudget, id, context)
      assert.equal(Object.values(budget.attempts).filter(a => a.kind === 'tool' && a.state === 'reserved').length, 1)
      return response({ items: [], has_more: false })
    }
    return response({ calendar: { calendar_id: 'test-calendar', summary: 'Pidot fixture', role: 'owner', type: 'shared' } })
  } })
  store = await fixture(t, { feishuClient: client, modelReply: async () => turn('report_blocker', { question: '核验哪一天？', requiredInformation: '具体日期', assignee: 'user' }) })
  const { resource } = await store.feishuCalendar.manage({ action: 'bind', calendarId: 'test-calendar', confirm: true })
  const { bot } = await store.getBotConfiguration('calendar')
  await store.updateBotConfiguration('calendar', { requestId: 'direct-grant', expectedVersion: bot.configRef.version, description: bot.description, tools: [...FEISHU_TOOLS, 'report_blocker'], resources: [resource] })
  id = await start(store, 2)
  await until(() => store.get(id), task => task.runtime.checkpoint.phase === 'awaitBlocker')
  const read = () => store.readFeishuCalendar({ taskId: id, name: FEISHU_TOOLS[0], arguments: { resource, start: '2026-10-20T00:00:00+08:00', end: '2026-10-21T00:00:00+08:00', timezone: 'Asia/Shanghai' } })
  await control(store, id, 'pause')
  await assert.rejects(read(), { code: 'CONTINUOUS_DISPATCH_STOPPED' })
  assert.equal(reads, 0)
  await control(store, id, 'resume')
  const results = await Promise.allSettled([read(), read()])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(reads, 1)
  assert.equal((await store.get(id)).continuous.usage.toolCalls, 2)
  await store.cancel(id, {})
})

test('LR03 goal revision wakes a pending approval without authorizing the old operation', async t => {
  let calls = 0
  const resource = 'mock:personal', eventId = 'mock-20261020-1'
  const store = await fixture(t, { modelReply: async (_message, { signal }) => {
    calls++
    if (calls === 1) return turn(CALENDAR_TOOL, { resource, date: '2026-10-20' })
    if (calls === 2) return turn(CALENDAR_EVENT_TOOL, { resource, eventId })
    if (calls === 3) return turn(CALENDAR_WRITE_TOOL, { resource, eventId, expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' })
    return blocked(signal)
  } })
  const id = await start(store)
  const pending = await until(() => store.get(id), task => task.runtime.checkpoint.phase === 'awaitApproval')
  await store.controlContinuous(id, { requestId: 'revise-approval', expectedVersion: pending.continuous.version, action: 'revise-goal', goalPatch: { goal: '只读取日历，不再修改时间' } })
  const revised = await until(() => store.get(id), task => task.continuous.goalRevision === 2 && calls === 4)
  assert.equal(revised.activeInputId, pending.activeInputId)
  assert.equal(revised.approvals.items[0].decision, null)
  assert.equal(revised.approvals.items[0].status, 'superseded')
  assert.equal(revised.approvals.activeId, null)
  assert.deepEqual((await store.harness.snapshot(MockCalendar, undefined, context)).events, {})
  await store.cancel(id, {})
})

test('LR03 pre-transport approval rejection settles the persisted reservation without masking its cause', async t => {
  let calls = 0, writes = 0, revoked = false
  const resource = 'mock:personal', eventId = 'mock-20261020-1'
  const store = await fixture(t, { modelReply: async (_message, { signal }) => {
    calls++
    if (calls === 1) return turn(CALENDAR_TOOL, { resource, date: '2026-10-20' })
    if (calls === 2) return turn(CALENDAR_EVENT_TOOL, { resource, eventId })
    if (calls === 3) return turn(CALENDAR_WRITE_TOOL, { resource, eventId, expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' })
    return blocked(signal)
  }, calendarWriteImpl: async (_operation, { execute }) => { writes++; return execute() } })
  const id = await start(store)
  const pending = await until(() => store.get(id), task => task.runtime.checkpoint.phase === 'awaitApproval')
  let revocation
  const off = store.harness.subscribeCommits(event => {
    if (revoked || !event.changes.some(change => change.record?.kind === TaskApprovals.definition.kind && change.value?.items.some(item => item.operation?.budgetAttempt))) return
    revoked = true
    revocation = store.harness.commit(async tx => { (await tx.doc(BotDirectory)).items.find(bot => bot.id === 'calendar').status = 'inactive' }, context)
  })
  t.after(off)
  await store.decideApproval(id, pending.approvals.activeId, { decision: 'approved' })
  const approvals = await until(() => store.harness.snapshot(TaskApprovals, id, context), value => Boolean(value.items[0].receipt))
  await revocation
  assert.equal(writes, 0)
  assert.equal(approvals.items[0].receipt.result.error.code, 'BOT_INACTIVE')
  assert.equal(approvals.items[0].receipt.result.error.notDispatched, true)
  const budget = await store.harness.snapshot(ContinuousBudget, id, context)
  assert.equal(budget.attempts[approvals.items[0].operation.budgetAttempt.attemptId].state, 'settled')
})
