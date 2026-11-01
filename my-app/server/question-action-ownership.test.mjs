import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { COLLABORATION_TOOLS } from './collaboration-tools.mjs'

const config = { baseUrl: 'https://question-action.invalid/v1', model: 'question-action', apiKey: 'fixture' }
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 4 } } })
let sequence = 0
const tool = (name, args) => {
  const content = [{ type: 'toolCall', id: `question-action-${++sequence}`, name, arguments: args }]
  return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
const question = (assignee = 'user') => tool('report_blocker', { question: '还需要哪项信息？', requiredInformation: '用户选择', assignee })
async function until(store, id, check) {
  for (let i = 0; i < 600; i++) {
    const state = await store.get(id)
    if (check(state)) return state
    await delay(5)
  }
  assert.fail(`question action did not settle: ${JSON.stringify((await store.get(id)).runtime)}`)
}
const waiting = (store, id) => until(store, id, state => state.runtime.checkpoint?.phase === 'awaitBlocker')
const idle = (store, id) => until(store, id, state => state.activeInputId === null && state.queueLength === 0 && state.runtime.checkpoint?.phase === 'awaitInput')
async function fixture(t, modelReply) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-question-action-'))
  const store = await openTaskStore({ file: join(dir, 'test.sqlite'), bots: listBots(config), modelReply })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return store
}

test('an explicit foreign or settled question target never falls back to another pending request', async t => {
  let calls = 0
  const store = await fixture(t, async () => ++calls === 1 ? question() : text('完成新消息'))
  const { taskId } = await store.create({ botId: 'calendar' })
  await store.send(taskId, 'A'); const a = await waiting(store, taskId)
  const questionId = a.blockers.activeId
  await assert.rejects(store.steer(taskId, { message: '错误问题调整', blockerId: questionId + 100000 }), { code: 'BLOCKER_UNAVAILABLE' })
  assert.equal((await store.get(taskId)).blockers.items[0].status, 'pending')
  await store.send(taskId, 'B'); await idle(store, taskId)
  await assert.rejects(store.steer(taskId, { message: '错误问题调整', blockerId: questionId + 100000 }), { code: 'BLOCKER_UNAVAILABLE' })
  const after = await store.get(taskId)
  assert.equal(after.blockers.items[0].status, 'pending')
  assert.equal(after.blockers.items[0].answer, null)
  assert.equal(calls, 2)
})

test('question requestId binds exact target and contents while an exact answer retry resumes only once', async t => {
  const counts = new Map()
  const store = await fixture(t, async message => { const count = (counts.get(message) ?? 0) + 1; counts.set(message, count); return count === 1 ? question() : text(`完成${message}`) })
  const { taskId } = await store.create({ botId: 'calendar' })
  const firstInput = await store.send(taskId, 'A'); const a = await waiting(store, taskId)
  const firstQuestionId = a.blockers.activeId
  await store.send(taskId, 'B'); const b = await until(store, taskId, state => state.runtime.checkpoint?.phase === 'awaitBlocker' && state.blockers.activeId !== firstQuestionId)
  const secondQuestionId = b.blockers.activeId
  const input = { requestId: 'stable-question-answer', version: 1, inReplyTo: firstInput.messageId, answer: '第一项' }
  await store.resolveBlocker(taskId, firstQuestionId, input)
  await idle(store, taskId)
  await store.resolveBlocker(taskId, firstQuestionId, input)
  assert.equal(counts.get('A'), 2)
  await assert.rejects(store.steer(taskId, { message: '对已回答A的过期调整', blockerId: firstQuestionId }), { code: 'BLOCKER_UNAVAILABLE' })
  await assert.rejects(store.resolveBlocker(taskId, firstQuestionId, { ...input, answer: '换一个答案' }), { code: 'BLOCKER_REQUEST_CONFLICT' })
  await assert.rejects(store.resolveBlocker(taskId, secondQuestionId, { requestId: input.requestId, version: 1, answer: '第一项' }), { code: 'BLOCKER_REQUEST_CONFLICT' })
  assert.equal((await store.get(taskId)).blockers.items.find(item => item.id === secondQuestionId).status, 'pending')
  assert.equal(counts.get('B'), 1)
})

test('cancelling a parent question stops that input children and permits subsequent chat without another parent model call', async t => {
  let parentCalls = 0
  const store = await fixture(t, async (_message, options) => options.parametersBotId === 'todo'
    ? ++parentCalls === 1 ? tool('task_assign', { operationId: 'child-for-input', botId: 'calendar', goal: '模拟子工作', completionCriteria: ['注明模拟来源'] }) : parentCalls === 2 ? question() : text('后续独立消息成功')
    : question('supervisor'))
  const tools = [...COLLABORATION_TOOLS, 'report_blocker']
  await store.updateCapabilityPool({ requestId: 'question-action-tools', operation: 'grant', tools, resources: [] })
  for (const botId of ['todo', 'calendar']) {
    const { bot } = await store.getBotConfiguration(botId)
    await store.updateBotConfiguration(botId, { requestId: `question-action-${botId}`, expectedVersion: bot.configRef.version, description: bot.description, tools: botId === 'todo' ? tools : ['report_blocker'], resources: [] })
  }
  const { taskId } = await store.create({ botId: 'todo' })
  await store.send(taskId, '原请求：派子工作并收集信息')
  const a = await waiting(store, taskId), relation = a.collaborations[0]
  assert.ok(relation)
  await store.resolveBlocker(taskId, a.blockers.activeId, { requestId: 'cancel-parent-input', action: 'cancel', version: 1 })
  const parent = await idle(store, taskId)
  const child = await until(store, relation.childTaskId, state => state.runtime.status === 'terminal')
  assert.equal(parentCalls, 2)
  assert.equal(parent.cancellation, null)
  assert.equal(parent.blockers.items[0].status, 'cancelled')
  assert.equal(parent.collaborationOverview.stops.some(stop => stop.rootWorkId === relation.rootWorkId), true)
  assert.equal(child.cancellation !== null || child.runtime.outcome?.status === 'aborted', true)
  await store.send(taskId, '下一项独立消息')
  const next = await idle(store, taskId)
  assert.equal(parentCalls, 3)
  assert.ok(next.messages.some(message => message.content === '后续独立消息成功'))
})
