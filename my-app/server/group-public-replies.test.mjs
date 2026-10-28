import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { mentionNames } from './groups.mjs'
// A Bot admin that can delegate and review, with two other members. The child simply answers.
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'group-public-fixture', apiKey: 'fixture-only' }
const text = (content) => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 4 } } })
const offered = new Map() // taskId -> tool names the model was offered on its latest call
async function until(fn, check = Boolean) { for (let i = 0; i < 900; i++) { const value = await fn(); if (check(value)) return value; await new Promise((r) => setTimeout(r, 10)) } throw new Error('group public timeout') }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-group-public-'))
  const s = await openTaskStore({ file: join(dir, 'test.sqlite'), bots: listBots(config), modelReply: async (_m, o) => {
    offered.set(o.taskId, (o.context?.tools ?? []).map((tool) => tool.name))
    return text(o.parametersBotId === 'todo' ? '管理员回报' : `${o.parametersBotId} 的公开回答`)
  } })
  t.after(async () => { await s.close(); await rm(dir, { recursive: true, force: true }) })
  const { bot } = await s.getBotConfiguration('todo')
  await s.updateBotConfiguration('todo', { requestId: 'public-admin-config-001', expectedVersion: bot.configRef.version, description: bot.description, tools: ['collaborators_list', 'task_assign', 'task_review', 'report_blocker'], resources: [] })
  const { task } = await s.createGroup({ requestId: 'public-group-request-001', title: '公开回复群', adminBotId: 'todo', memberBotIds: ['todo', 'calendar', 'chief'] })
  return { s, task }
}

test('"@名" in prose reaches that member; code, quotes and e-mail stay data', () => {
  assert.deepEqual(mentionNames('@日程助理 看看明天'), ['日程助理'])
  assert.deepEqual(mentionNames('请 ＠待办助理 整理'), ['待办助理'])
  assert.deepEqual(mentionNames('mail a@example.com `@chief` "> @todo" \n```\n@calendar\n```'), [])
})

test('a group @ dispatches every member in order; retry never duplicates a child', { timeout: 20000 }, async (t) => {
  const { s, task } = await fixture(t)
  const input = { message: '@日程助理 @Chief 各自说说', targetBotIds: ['calendar', 'chief'], requestId: 'public-fanout-001' }
  const accepted = await s.send(task.taskId, input)
  const again = await s.send(task.taskId, input)
  assert.equal(again.messageId, accepted.messageId)
  const done = await until(() => s.get(task.taskId), (v) => ['calendar', 'chief'].every((id) => v.collaborations.some((r) => r.executorBotId === id && r.businessStatus === 'submitted')))
  assert.deepEqual(done.collaborations.map((r) => r.executorBotId), ['calendar', 'chief'])
  assert.equal(done.callUsage.toolCalls, 2)
  for (const relation of done.collaborations) {
    assert.equal(relation.parentInputId, accepted.messageId)
    assert.equal(relation.reviewRequired, true)
    const child = await s.get(relation.childTaskId)
    assert.equal(child.messages.filter((m) => m.role === 'user').length, 1)
    // Every Bot holds every group (T01); a delegated child is still never offered delegation.
    assert.ok(offered.get(relation.childTaskId)?.length, 'child made a model call')
    assert.ok(!offered.get(relation.childTaskId).includes('task_assign'))
  }
})

test('accepted group replies are published once with Bot identity, never before review', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-group-review-public-'))
  let store
  store = await openTaskStore({ file: join(dir, 'test.sqlite'), bots: listBots(config), modelReply: async (_m, o) => {
    if (o.parametersBotId !== 'todo') return text(`${o.parametersBotId} 的公开回答`)
    const task = await store.get(taskId)
    const relation = task.collaborations.find((r) => r.businessStatus === 'submitted' && !r.result.accepted)
    if (!relation) return text('管理员总结')
    const call = { type: 'toolCall', id: `accept-${relation.childTaskId}`, name: 'task_review', arguments: { operationId: `accept-${relation.childTaskId}`, childTaskId: relation.childTaskId, rootWorkId: relation.rootWorkId, revision: relation.result.revision, expectedState: 'submitted', decision: 'accept', reason: '已核对原回答' } }
    return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
  } })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const { bot } = await store.getBotConfiguration('todo')
  await store.updateBotConfiguration('todo', { requestId: 'public-review-config', expectedVersion: bot.configRef.version, description: bot.description, tools: ['collaborators_list', 'task_assign', 'task_review', 'report_blocker'], resources: [] })
  const { task } = await store.createGroup({ requestId: 'public-review-group', title: '验收公开回复群', adminBotId: 'todo', memberBotIds: ['todo', 'calendar', 'chief'] })
  const taskId = task.taskId
  const input = { message: '@日程助理 @Chief 各自说说', targetBotIds: ['calendar', 'chief'], requestId: 'public-review-input' }
  await store.send(taskId, input)
  // The admin can accept immediately; absence before acceptance is covered by the publish gate and audit below.
  const done = await until(() => store.get(taskId), (v) => v.collaborations.length === 2 && v.collaborations.every((r) => r.businessStatus === 'accepted') && v.activeInputId === null)
  const replies = done.messages.filter((m) => m.systemKind === 'group-reply')
  const messageId = done.messages.find((m) => m.role === 'user').id
  assert.deepEqual(replies.map((m) => [m.botId, m.content, m.replyFor]), [['calendar', 'calendar 的公开回答', messageId], ['chief', 'chief 的公开回答', messageId]])
  assert.equal(new Set(replies.map((m) => m.childTaskId)).size, 2)
  await store.harness.commit(async (tx) => {
    const { Collaboration } = await import('./collaboration.mjs')
    const relations = (await tx.doc(Collaboration)).items.filter((r) => r.parentTaskId === taskId)
    assert.ok(relations.every((r) => r.publicReplies.length === 1 && r.revisionPublished === 1))
  }, (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT)
})

test('inactive, foreign or unknown targets are refused before any work is created', async (t) => {
  const { s, task } = await fixture(t)
  await assert.rejects(s.send(task.taskId, { message: '@不存在 你好', requestId: 'public-bad-001' }), { code: 'GROUP_MENTION_UNKNOWN' })
  await assert.rejects(s.send(task.taskId, { message: 'hi', targetBotIds: ['bot-not-member'], requestId: 'public-bad-002' }), { code: 'GROUP_TARGET_DENIED' })
  await assert.rejects(s.send(task.taskId, { message: 'hi', targetBotIds: Array.from({ length: 9 }, () => 'calendar'), requestId: 'public-bad-003' }), { code: 'GROUP_TARGET_LIMIT' })
  await assert.rejects(s.send(task.taskId, { message: '没有 requestId', targetBotId: 'calendar' }), { code: 'INVALID_GROUP_TARGET' })
  assert.equal((await s.get(task.taskId)).collaborations.length, 0)
})
