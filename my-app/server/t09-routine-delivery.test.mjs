import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { createModelReply } from './model-reply.mjs'
import { createWorkspaceRepository } from './workspace-repository.mjs'
import { ruleText, summarizeApproval, buildInbox } from './inbox.mjs'
import { ruleLabel, routineInput } from '../src/routines.mjs'

const start = Date.parse('2026-10-19T00:00:00Z')
const token = 't09-isolated-api-token', resultText = 'T09 本地确定性正式运行结果：已整理三项待办。'
const rules = [
  [{ type: 'weekly', weekdays: [1, 3, 5], time: '09:00' }, '每周 周一、周三、周五 09:00'],
  [{ type: 'monthly', day: 31, time: '09:00' }, '每月 31 日 09:00（短月取最后一天）'],
]

test('T09 inbox weekly/monthly summaries match the actual approval card labels', async () => {
  for (const [rule, expected] of rules) {
    assert.equal(ruleText(rule), expected)
    assert.equal(ruleText(rule), ruleLabel(rule))
    const args = { title: '周期整理', rule }
    const summary = `日程助理想新建例行任务「周期整理」（${expected}）`
    assert.equal(summarizeApproval('日程助理', 'routine_propose', args), summary)
    const inbox = await buildInbox({ bots: [{ id: 'calendar', name: '日程助理' }], pendingOperations: async () => ({ items: [] }), listTasks: async () => [{ taskId: 17, bot: { id: 'calendar', name: '日程助理' }, approvals: { items: [{ id: 23, toolName: 'routine_propose', status: 'pending', arguments: args }] } }] })
    assert.equal(inbox.items.length, 1)
    assert.equal(inbox.items[0].summary, summary)
    assert.equal(inbox.items[0].approvalId, 23)
    assert.equal(inbox.items[0].taskId, 17)
  }
  assert.equal(ruleText({ type: 'weekly', weekdays: [7, 1, 5], time: '08:15' }), '每周 周一、周五、周日 08:15')
})

test('T09 inbox recurrence keeps legacy rule wording unchanged', () => {
  for (const [rule, expected] of [
    [{ type: 'daily', time: '08:00' }, '每天 08:00'], [{ type: 'interval', seconds: 7200 }, '每 2 小时'],
    [{ type: 'interval', seconds: 90 }, '每 90 秒'], [{ type: 'interval', seconds: 120 }, '每 2 分钟'],
    [{ type: 'at', at: '2026-10-20T01:00:00Z' }, '10月20日 09:00 一次'],
    [{ type: 'event', event: 'todo_due' }, '待办到期时'], [{ type: 'restricted' }, '时间未定'],
  ]) assert.equal(ruleText(rule), expected)
})

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}
async function closeServer(server) {
  if (!server) return
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
}

// Real HTTP on loopback for both the authenticated app API and a deterministic
// OpenAI-compatible SSE provider. No external provider, credentials or formal data.
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-t09-delivery-')), calls = [], logs = [], errors = []
  const provider = createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    const body = JSON.parse(raw)
    calls.push({ path: req.url, model: body.model, messages: body.messages, stream: body.stream })
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return }
    const chunk = (delta, finish_reason = null) => ({ id: 't09-local-completion', object: 'chat.completion.chunk', created: 1, model: 't09-local-model', choices: [{ index: 0, delta, finish_reason }] })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([chunk({ role: 'assistant', content: resultText }), chunk({}, 'stop'), { ...chunk({}), choices: [], usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 } }].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n')
  })
  const providerUrl = await listen(provider)
  const config = { baseUrl: `${providerUrl}/v1`, model: 't09-local-model', apiKey: 't09-only-fake-provider-key' }
  let time = start, store, api, baseUrl
  const options = { file: join(dir, 'isolated.sqlite'), bots: listBots(config), readModelSettings: async () => config, modelReply: createModelReply(async () => config), workspaceScheduleOptions: { autoStart: false, now: () => time, onError: e => errors.push(e) }, memoryOptions: { enabled: false } }
  const open = async () => {
    store = await openTaskStore(options)
    api = createApiServer({ token, tasks: store, logger: { error: e => logs.push(e), info() {} } })
    baseUrl = await listen(api)
  }
  t.after(async () => { await closeServer(api); await store?.close(); await closeServer(provider); await rm(dir, { recursive: true, force: true }) })
  await open()
  const { bot, assigned } = await store.getBotConfiguration('calendar')
  await store.updateBotConfiguration('calendar', { requestId: 't09-local-setup', expectedVersion: bot.configRef.version, description: bot.description, tools: assigned.tools, resources: [...new Set([...assigned.resources, 'workspace:local'])] })
  const request = async (path, input) => {
    const response = await fetch(`${baseUrl}${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    const body = await response.json()
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`)
    return body
  }
  const post = async (path, input) => (await request(`/api/workspace/${path}`, input)).data
  const records = async type => {
    const repo = createWorkspaceRepository({ harness: store.harness, context })
    return repo.transaction(async tx => (await repo.list(tx, type, 'local-owner', 'local', { limit: 100 })).items)
  }
  const settled = async id => {
    for (let i = 0; i < 400; i++) {
      const task = await store.get(id)
      if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput' && task.runtime.checkpoint?.lastOutcome) return task
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail(`T09 run ${id} did not settle`)
  }
  return { get store() { return store }, calls, logs, errors, config, request, post, records, settled, setTime: at => { time = Date.parse(at) }, restart: async () => { await closeServer(api); await store.close(); await open() } }
}
const scheduleInput = (id, rule, notification = 'inbox') => ({ requestId: id, command: 'create', title: `T09-${id}`, timezone: 'Asia/Shanghai', rule, confirmed: true,
  actionSpec: { kind: 'agent_readonly_workflow', botId: 'calendar', sourceIds: ['local'], prompt: '只整理待办，不调用工具。', promptVersion: 'v1', callLimits: { modelCalls: 2, toolCalls: 0, totalTokens: 1000 }, notification } })
const mirrorRows = (task, id) => task.messages.filter(m => m.systemKind === 'mirror' && m.childTaskId === id)

for (const [name, rule, dueAt] of [
  ['weekly', rules[0][0], '2026-10-19T01:00:00Z'],
  ['monthly', rules[1][0], '2026-10-31T01:00:00Z'],
]) test(`T09 scheduled ${name} result reaches owning Bot conversation and durable inbox exactly once across restart`, async t => {
  const f = await fixture(t)
  const p = (await f.post('schedule-manage', scheduleInput(`${name}-enabled`, rule))).receipt.schedule
  const mainIds = await f.store.mainSessions()
  assert.equal(f.calls.length, 0)
  f.setTime(dueAt); await f.store.workspaceScheduler.tick()
  let [row] = (await f.post('schedule-list', { scheduleId: p.id })).items
  assert.ok(row.taskId); assert.notEqual(row.test, true)
  const originalId = row.taskId, run = await f.settled(originalId)
  assert.equal(run.runtime.checkpoint.lastOutcome, 'completed')
  assert.equal(run.messages.filter(m => m.role === 'assistant').at(-1).content, resultText)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].model, 't09-local-model')
  assert.equal(f.calls[0].path, '/v1/chat/completions')
  await f.store.workspaceScheduler.tick()
  ;[row] = (await f.post('schedule-list', { scheduleId: p.id })).items
  assert.equal(row.state, 'succeeded'); assert.ok(row.deliveryId)
  assert.equal(row.result.notificationDelivered, false) // application record is not system push/user receipt
  assert.equal(row.result.usage.modelCalls, 1)
  const inbox = await f.post('reminder-list', {})
  assert.equal(inbox.items.length, 1)
  assert.deepEqual([inbox.items[0].scheduleId, inbox.items[0].taskId, inbox.items[0].deliveryId], [p.id, originalId, row.deliveryId])
  assert.notEqual(inbox.items[0].redacted, true)
  const main = (await f.request(`/api/tasks/${mainIds.calendar}`)).task
  const [mirror] = mirrorRows(main, originalId)
  assert.equal(mirrorRows(main, originalId).length, 1)
  assert.deepEqual([mirror.botId, mirror.mirrorKind, mirror.live], ['calendar', 'finished', 'succeeded'])
  assert.match(mirror.summary, /例行任务已完成/)
  assert.equal(mirrorRows((await f.request(`/api/tasks/${mainIds.chief}`)).task, originalId).length, 0)
  assert.equal(mirrorRows((await f.request(`/api/tasks/${mainIds.todo}`)).task, originalId).length, 0)
  // Only a link card crosses conversations; source content stays permission-filtered in its Task.
  assert.equal(JSON.stringify(main.messages).includes(resultText), false)
  assert.equal((await f.request(`/api/tasks/${mirror.childTaskId}`)).task.messages.filter(m => m.role === 'assistant').at(-1).content, resultText)
  assert.equal((await f.records('Notification')).length, 1)
  assert.equal((await f.records('Delivery')).length, 1)
  const read = await f.post('notification-read', { id: inbox.items[0].id })
  assert.equal(read.status, 'read')
  assert.deepEqual(await f.post('notification-read', { id: inbox.items[0].id }), read)
  await f.store.workspaceScheduler.tick(); await f.restart(); await f.store.workspaceScheduler.tick()
  assert.equal(f.calls.length, 1)
  assert.equal((await f.post('schedule-list', { scheduleId: p.id })).items.length, 1)
  const persistedInbox = await f.post('reminder-list', {})
  assert.equal(persistedInbox.items.length, 1)
  assert.equal(persistedInbox.items[0].status, 'read')
  assert.equal(persistedInbox.items[0].readAt, read.readAt)
  assert.equal(mirrorRows((await f.request(`/api/tasks/${mainIds.calendar}`)).task, originalId).length, 1)
  assert.equal((await f.records('Notification')).length, 1)
  assert.equal((await f.records('Delivery')).length, 1)
  // A second genuine cycle gets a new original Task and exactly one new pair of receipts.
  // For monthly-31 this also exercises the November-30 clamp through actual dispatch.
  const next = (await f.post('schedule-list', {})).items.find(s => s.id === p.id).nextDueAt
  assert.equal(next, name === 'weekly' ? '2026-10-21T01:00:00.000Z' : '2026-11-30T01:00:00.000Z')
  f.setTime(next); await f.store.workspaceScheduler.tick()
  const second = (await f.post('schedule-list', { scheduleId: p.id })).items.find(r => r.id !== row.id)
  assert.notEqual(second.taskId, originalId)
  await f.settled(second.taskId); await f.store.workspaceScheduler.tick(); await f.store.workspaceScheduler.tick()
  assert.equal(f.calls.length, 2)
  assert.equal((await f.records('Notification')).length, 2)
  assert.equal((await f.records('Delivery')).length, 2)
  const secondMain = (await f.request(`/api/tasks/${mainIds.calendar}`)).task
  assert.equal(mirrorRows(secondMain, originalId).length, 1)
  assert.equal(mirrorRows(secondMain, second.taskId).length, 1)
  assert.deepEqual(f.errors, [])
  assert.equal(JSON.stringify([inbox, row, main, f.calls, f.logs]).includes(f.config.apiKey), false)
})

test('T09 notification checkbox off serializes none and a formal run does not deliver either channel', async t => {
  const f = await fixture(t)
  const form = routineInput({ title: '关闭通知', prompt: '整理待办', when: 'weekly', value: '09:00', weekdays: [1], notification: 'none', botId: 'calendar', requestId: randomUUID(), now: start }).input
  assert.equal(form.actionSpec.notification, 'none')
  const p = (await f.post('schedule-manage', form)).receipt.schedule
  f.setTime('2026-10-19T01:00:00Z'); await f.store.workspaceScheduler.tick()
  let [row] = (await f.post('schedule-list', { scheduleId: p.id })).items
  const task = await f.settled(row.taskId)
  assert.equal(task.runtime.checkpoint.lastOutcome, 'completed')
  await f.store.workspaceScheduler.tick()
  ;[row] = (await f.post('schedule-list', { scheduleId: p.id })).items
  assert.equal(row.state, 'succeeded'); assert.equal(row.deliveryId, undefined)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.post('reminder-list', {})).items.length, 0)
  assert.deepEqual(await f.records('Notification'), [])
  assert.deepEqual(await f.records('Delivery'), [])
  const mainId = (await f.store.mainSessions()).calendar
  assert.deepEqual(mirrorRows((await f.request(`/api/tasks/${mainId}`)).task, row.taskId), [])
  await f.restart(); await f.store.workspaceScheduler.tick()
  assert.equal((await f.post('reminder-list', {})).items.length, 0)
  assert.deepEqual(await f.records('Delivery'), [])
  assert.deepEqual(mirrorRows((await f.request(`/api/tasks/${mainId}`)).task, row.taskId), [])
  assert.equal(f.calls.length, 1)
})

test('T09 testRun with inbox enabled retains the result only in the test Task and never delivers', async t => {
  const f = await fixture(t)
  const p = (await f.post('schedule-manage', scheduleInput('test-inbox-enabled', rules[0][0]))).receipt.schedule
  const tested = await f.post('schedule-test', { requestId: randomUUID(), id: p.id })
  const run = await f.settled(tested.receipt.taskId)
  assert.equal(run.runtime.checkpoint.lastOutcome, 'completed')
  assert.equal(run.messages.filter(m => m.role === 'assistant').at(-1).content, resultText)
  await f.store.workspaceScheduler.tick()
  const [row] = (await f.post('schedule-list', { scheduleId: p.id })).items
  assert.equal(row.test, true); assert.equal(row.state, 'succeeded'); assert.equal(row.deliveryId, undefined)
  assert.equal((await f.post('reminder-list', {})).items.length, 0)
  assert.deepEqual(await f.records('Notification'), [])
  assert.deepEqual(await f.records('Delivery'), [])
  const mainId = (await f.store.mainSessions()).calendar
  assert.deepEqual(mirrorRows((await f.request(`/api/tasks/${mainId}`)).task, row.taskId), [])
  assert.equal(f.calls.length, 1)
  f.setTime('2026-10-19T01:00:00Z'); await f.store.workspaceScheduler.tick()
  const scheduled = (await f.post('schedule-list', { scheduleId: p.id })).items.find(r => !r.test)
  assert.ok(scheduled.taskId); assert.notEqual(scheduled.taskId, row.taskId)
  await f.settled(scheduled.taskId); await f.store.workspaceScheduler.tick()
  assert.equal(f.calls.length, 2)
  assert.equal((await f.post('reminder-list', {})).items.length, 1)
  const messages = (await f.request(`/api/tasks/${mainId}`)).task
  assert.equal(mirrorRows(messages, scheduled.taskId).length, 1)
  assert.deepEqual(mirrorRows(messages, row.taskId), [])
})

test('T09 boolean notification false is not silently interpreted as inbox or a persisted rule', async t => {
  const f = await fixture(t)
  await assert.rejects(f.store.workspaceSchedules.manage(scheduleInput('boolean-notification', rules[1][0], false)), { code: 'WORKSPACE_WORKFLOW_INPUT' })
  assert.equal((await f.post('schedule-list', {})).items.length, 0)
  assert.deepEqual(await f.records('Notification'), [])
  assert.deepEqual(await f.records('Delivery'), [])
  assert.equal(f.calls.length, 0)
})

test('T09 permission revoked after completion suppresses both result channels without replay after regrant', async t => {
  const f = await fixture(t)
  const p = (await f.post('schedule-manage', scheduleInput('revoke-before-delivery', rules[0][0]))).receipt.schedule
  f.setTime('2026-10-19T01:00:00Z'); await f.store.workspaceScheduler.tick()
  const [claimed] = (await f.post('schedule-list', { scheduleId: p.id })).items
  await f.settled(claimed.taskId)
  await f.store.revokeTool('calendar', 'workspace.get')
  await f.store.workspaceScheduler.tick()
  const row = (await f.records('Occurrence')).find(r => r.id === claimed.id)
  assert.equal(row.state, 'succeeded'); assert.equal(row.deliveryId, undefined)
  assert.deepEqual(await f.records('Notification'), [])
  assert.deepEqual(await f.records('Delivery'), [])
  const mainId = (await f.store.mainSessions()).calendar
  assert.deepEqual(mirrorRows((await f.request(`/api/tasks/${mainId}`)).task, claimed.taskId), [])
  const { bot, assigned } = await f.store.getBotConfiguration('calendar')
  await f.store.updateBotConfiguration('calendar', { requestId: 't09-regrant', expectedVersion: bot.configRef.version, description: bot.description, tools: [...new Set([...assigned.tools, 'workspace.get'])], resources: assigned.resources })
  await f.store.workspaceScheduler.tick(); await f.restart(); await f.store.workspaceScheduler.tick()
  assert.deepEqual(await f.records('Notification'), [])
  assert.deepEqual(await f.records('Delivery'), [])
  assert.deepEqual(mirrorRows((await f.request(`/api/tasks/${mainId}`)).task, claimed.taskId), [])
  assert.equal(f.calls.length, 1)
})
