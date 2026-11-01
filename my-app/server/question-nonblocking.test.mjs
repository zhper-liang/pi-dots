import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { TaskBlockers } from './blockers.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

const config = { baseUrl: 'https://question.invalid/v1', model: 'question-a', apiKey: 'fixture-only' }
const reply = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 3 } } })
const question = (questions) => {
  const calls = [{ type: 'toolCall', id: 'question', name: 'report_blocker', arguments: { question: '使用哪个时区？', requiredInformation: '时区', assignee: 'user', ...(questions ? { questions } : {}) } }]
  return { ...reply('需要补充'), toolCalls: calls, assistant: { role: 'assistant', content: calls, api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
async function until(read, check) {
  for (let i = 0; i < 500; i++) { const data = await read(); if (check(data)) return data; await delay(5) }
  assert.fail('question state did not settle')
}
const waiting = (s, id) => until(() => s.get(id), t => t.runtime.checkpoint?.phase === 'awaitBlocker')
const idle = (s, id) => until(() => s.get(id), t => t.activeInputId === null && t.queueLength === 0 && t.runtime.checkpoint?.phase === 'awaitInput')
async function fixture(t, modelReply, main = false) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-question-'))
  const bots = listBots(config); bots.find(bot => bot.id === 'calendar').defaults.model.id = 'question-b'
  let store
  const open = async () => { store = await openTaskStore({ file: join(dir, 'test.sqlite'), bots, modelReply }); return store }
  await open()
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const id = main ? (await store.mainSessions()).chief : (await store.create({ botId: 'calendar' })).taskId
  return { store, id, reopen: async () => { await store.close(); return open() } }
}

test('pending question yields to a new message, then resumes exact original input once after reopen', async t => {
  const seen = []
  const f = await fixture(t, async (message, opts) => { seen.push({ message, context: structuredClone(opts.context) }); return seen.length === 1 ? question() : reply(`完成${message}`) })
  const a = await f.store.send(f.id, '原请求A'); const first = await waiting(f.store, f.id)
  await f.store.send(f.id, '新请求B')
  const afterB = await idle(f.store, f.id)
  assert.equal(afterB.blockers.items[0].parked, true)
  assert.deepEqual(seen.map(row => row.message), ['原请求A', '新请求B'])
  assert.ok(!seen[1].context.messages.some(row => row.role === 'user' && row.content === '原请求A'))
  const store = await f.reopen()
  await store.resolveBlocker(f.id, first.blockers.activeId, { answer: 'Asia/Shanghai', version: 1, inReplyTo: a.messageId })
  await idle(store, f.id)
  assert.deepEqual(seen.map(row => row.message), ['原请求A', '新请求B', '原请求A'])
  assert.ok(!seen[2].context.messages.some(row => row.role === 'user' && row.content === '新请求B'))
  await store.resolveBlocker(f.id, first.blockers.activeId, { answer: 'Asia/Shanghai', version: 1, inReplyTo: a.messageId })
  await delay(30); assert.equal(seen.length, 3)
})

test('adjusting a waiting request replaces its question without fabricating an answer', async t => {
  const seen = []
  const { store, id } = await fixture(t, async (message, opts) => { seen.push({ message, context: structuredClone(opts.context) }); return seen.length === 1 ? question() : reply('已按调整继续') })
  await store.send(id, '原请求'); const first = await waiting(store, id)
  await store.steer(id, { message: '这次只列需要的信息，不查询日历' })
  const done = await idle(store, id)
  assert.equal(done.blockers.items[0].status, 'superseded')
  assert.equal(done.blockers.items[0].answer.action, 'adjust')
  assert.equal(seen.length, 2)
  assert.ok(seen[1].context.messages.some(row => String(row.content).includes('调整')))
  await assert.rejects(store.resolveBlocker(id, first.blockers.activeId, { answer: '旧回答' }), { code: 'BLOCKER_ALREADY_RESOLVED' })
})

test('cancelling one parked request never cancels the chat or calls its model again', async t => {
  let calls = 0
  const { store, id } = await fixture(t, async () => ++calls === 1 ? question() : reply('新消息成功'))
  await store.send(id, '原请求'); const first = await waiting(store, id)
  await store.send(id, '先处理另一个问题'); await idle(store, id)
  await store.resolveBlocker(id, first.blockers.activeId, { action: 'cancel', version: 1 })
  const cancelled = await idle(store, id)
  assert.equal(cancelled.cancellation, null)
  assert.equal(cancelled.blockers.items[0].status, 'cancelled')
  assert.equal(calls, 2)
  await store.send(id, '继续聊'); await idle(store, id); assert.equal(calls, 3)
})

test('structured answers reject missing required fields, foreign options and stale versions', async t => {
  let calls = 0
  const questions = [{ id: 'zone', question: '选择时区', type: 'single', options: [{ id: 'cn', label: 'Asia/Shanghai' }, { id: 'utc', label: 'UTC' }] }]
  const { store, id } = await fixture(t, async () => ++calls === 1 ? question(questions) : reply('已使用选择'))
  const a = await store.send(id, '查询'); const first = await waiting(store, id); const qid = first.blockers.activeId
  for (const answers of [{}, { zone: { optionId: 'bad' } }, { zone: { optionId: 'other' } }]) await assert.rejects(store.resolveBlocker(id, qid, { answers }), { code: 'INVALID_BLOCKER_ANSWER' })
  await assert.rejects(store.resolveBlocker(id, qid, { action: 'skip' }), { code: 'BLOCKER_REQUIRED' })
  await assert.rejects(store.resolveBlocker(id, qid, { answers: { zone: { optionId: 'cn' } }, version: 8 }), { code: 'BLOCKER_VERSION_CONFLICT' })
  await store.resolveBlocker(id, qid, { answers: { zone: { optionId: 'cn' } }, version: 1, inReplyTo: a.messageId, requestId: 'same' })
  const done = await idle(store, id)
  assert.equal(done.blockers.items[0].answer.content, 'Asia/Shanghai')
  assert.deepEqual(done.blockers.items[0].answer.answers, { zone: { optionId: 'cn' } })
})

test('main session resumes original selected model and its budget after another selected model', async t => {
  const seen = []
  const { store, id } = await fixture(t, async (message, opts) => { seen.push({ message, model: opts.parameters.model.id }); return seen.length === 1 ? question() : reply('完成') }, true)
  await store.send(id, '请求A', undefined, { model: { id: 'question-a' } }); const a = await waiting(store, id)
  await store.send(id, '请求B', undefined, { model: { id: 'question-b' } }); await idle(store, id)
  await store.resolveBlocker(id, a.blockers.activeId, { answer: 'UTC' }); const done = await idle(store, id)
  assert.deepEqual(seen.map(row => row.model), ['question-a', 'question-b', 'question-a'])
  assert.equal(done.callUsage.modelCalls, 2)
  assert.equal(done.callUsage.lifetime.modelCalls, 1)
})

function gate() { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }

test('answer A while B is in flight; a question from B parks separately and both resume their own model and budget', async t => {
  const holdB = gate(), enteredB = gate(), seen = [], counts = new Map()
  const { store, id } = await fixture(t, async (message, opts) => {
    const count = (counts.get(message) ?? 0) + 1; counts.set(message, count)
    seen.push({ message, model: opts.parameters.model.id, context: structuredClone(opts.context) })
    if (message === 'B' && count === 1) { enteredB.release(); await holdB.promise }
    return count === 1 ? question() : reply(`完成${message}`)
  }, true)
  await store.send(id, 'A', undefined, { model: { id: 'question-a' } })
  const a = await waiting(store, id), aid = a.blockers.activeId
  await store.send(id, 'B', undefined, { model: { id: 'question-b' } }); await enteredB.promise
  await store.resolveBlocker(id, aid, { answer: 'Asia/Shanghai' })
  assert.deepEqual(seen.map(row => row.message), ['A', 'B'])
  holdB.release()
  const afterA = await idle(store, id)
  assert.deepEqual(seen.map(row => [row.message, row.model]), [['A', 'question-a'], ['B', 'question-b'], ['A', 'question-a']])
  const b = afterA.blockers.items.find(item => item.inReplyTo !== a.blockers.items[0].inReplyTo)
  assert.equal(b.status, 'pending'); assert.equal(b.parked, true)
  assert.ok(!seen[2].context.messages.some(row => row.role === 'user' && row.content === 'B'))
  await store.resolveBlocker(id, b.id, { answer: 'UTC' })
  const done = await idle(store, id)
  assert.deepEqual(seen.map(row => [row.message, row.model]), [['A', 'question-a'], ['B', 'question-b'], ['A', 'question-a'], ['B', 'question-b']])
  assert.equal(done.callUsage.modelCalls, 2)
  assert.equal(done.callUsage.lifetime.modelCalls, 2)
  assert.equal(done.blockers.items.every(item => !item.parked && !item.resumeQueued && !item.resumeState), true)
})

test('a resumed input can ask a second question and park again without losing its accumulated budget', async t => {
  const counts = new Map(), seen = []
  const { store, id } = await fixture(t, async (message, opts) => {
    const count = (counts.get(message) ?? 0) + 1; counts.set(message, count)
    seen.push({ message, model: opts.parameters.model.id, context: structuredClone(opts.context) })
    return message === 'A' && count <= 2 ? question() : reply(`完成${message}`)
  }, true)
  await store.send(id, 'A', undefined, { model: { id: 'question-a' } }); const a = await waiting(store, id)
  await store.send(id, 'B', undefined, { model: { id: 'question-b' } }); await idle(store, id)
  await store.resolveBlocker(id, a.blockers.activeId, { answer: 'Asia/Shanghai' })
  const second = await until(() => store.get(id), task => task.blockers.items.length === 2 && task.runtime.checkpoint?.phase === 'awaitBlocker')
  await store.send(id, 'C', undefined, { model: { id: 'question-b' } }); await idle(store, id)
  await store.resolveBlocker(id, second.blockers.activeId, { answer: '周五下午' })
  const done = await idle(store, id)
  assert.deepEqual(seen.map(row => row.message), ['A', 'B', 'A', 'C', 'A'])
  assert.equal(done.callUsage.modelCalls, 3)
  assert.equal(done.callUsage.lifetime.modelCalls, 2)
  assert.ok(!seen.at(-1).context.messages.some(row => row.role === 'user' && ['B', 'C'].includes(row.content)))
  assert.equal((await store.harness.snapshot(TaskBlockers, id, context)).items.every(item => !item.resumeState), true)
})

test('parked Skill resumes only for its original request and cancellation leaves no active Skill for later inputs', async t => {
  const seen = []
  const { store, id } = await fixture(t, async (message, opts) => {
    seen.push({ message, context: structuredClone(opts.context) })
    return message === 'A' ? question() : reply(`完成${message}`)
  })
  await store.activateSkill(id, { skillId: 'calendar-conflict-analysis' })
  await store.send(id, 'A'); const first = await waiting(store, id)
  await store.send(id, 'B'); const afterB = await idle(store, id)
  assert.ok(seen[0].context.systemPrompt.includes('活动 Skill（固定完整版本）'))
  assert.ok(!seen[1].context.systemPrompt.includes('活动 Skill（固定完整版本）'))
  assert.equal(afterB.blockers.items[0].resumeState, undefined)
  assert.equal((await store.harness.snapshot(TaskBlockers, id, context)).items[0].resumeState.activeSkills.length, 1)
  await store.resolveBlocker(id, first.blockers.activeId, { answer: 'Asia/Shanghai' })
  const second = await until(() => store.get(id), task => task.blockers.items.length === 2 && task.runtime.checkpoint?.phase === 'awaitBlocker')
  assert.ok(seen[2].context.systemPrompt.includes('活动 Skill（固定完整版本）'))
  await store.send(id, 'C'); await idle(store, id)
  await store.resolveBlocker(id, second.blockers.activeId, { action: 'cancel' }); const cancelled = await idle(store, id)
  assert.equal(cancelled.skillState.active.length, 0)
  assert.equal((await store.harness.snapshot(TaskBlockers, id, context)).items.every(item => !item.resumeState), true)
  await store.send(id, 'D'); const done = await idle(store, id)
  assert.deepEqual(seen.map(row => row.message), ['A', 'B', 'A', 'C', 'D'])
  assert.ok(!seen.at(-1).context.systemPrompt.includes('活动 Skill（固定完整版本）'))
  assert.equal(done.callUsage.modelCalls, 5)
})

test('cancelling a parked main request accounts its prior usage once without a new model call', async t => {
  const seen = []
  const { store, id } = await fixture(t, async message => { seen.push(message); return message === 'A' ? question() : reply(message) }, true)
  await store.send(id, 'A'); const first = await waiting(store, id)
  await store.send(id, 'B'); await idle(store, id)
  await store.resolveBlocker(id, first.blockers.activeId, { action: 'cancel' }); await idle(store, id)
  assert.deepEqual(seen, ['A', 'B'])
  await store.send(id, 'C'); const done = await idle(store, id)
  assert.deepEqual(seen, ['A', 'B', 'C'])
  assert.equal(done.callUsage.modelCalls, 1)
  assert.equal(done.callUsage.lifetime.modelCalls, 2)
  assert.equal(done.callUsage.totalTokens, 3)
  assert.equal(done.callUsage.lifetime.totalTokens, 6)
})
