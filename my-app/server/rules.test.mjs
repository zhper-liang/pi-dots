import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'rules-fixture', apiKey: 'fixture-only' }
const text = () => ({ mode: 'model', reply: { content: '好了' }, execution: { usage: { totalTokens: 7 } } })
let seq = 0
const turn = (name, args) => { const content = [{ type: 'toolCall', id: 'rule-' + ++seq, name, arguments: args }]; return { ...text(), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } } }
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-rules-s3-')), script = []
  let s
  try { s = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots: listBots(config), modelReply: async () => script.shift() ?? text() }); await fn(s, script) }
  finally { await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function until(s, id, check) { for (let n = 0; n < 800; n++) { const t = await s.get(id); if (check(t)) return t; await new Promise(r => setTimeout(r, 5)) } assert.fail('Task did not settle') }
const settled = (s, id) => until(s, id, t => t.activeInputId === null && t.runtime.checkpoint?.phase === 'awaitInput')
const waiting = (s, id) => until(s, id, t => t.runtime.checkpoint?.phase === 'awaitApproval' && t.approvals.activeId !== null)

test('S3 rule API allows exact write rules and rejects retired risk matches', () => fixture(async s => {
  const rule = await s.rules.add({ botId: 'calendar', match: { tool: 'routine_propose' }, effect: 'allow' })
  assert.equal(rule.effect, 'allow')
  assert.ok((await s.rules.list()).some(r => r.id === rule.id))
  await assert.rejects(s.rules.add({ botId: 'calendar', match: { risk: 'H' }, effect: 'allow' }), { code: 'POLICY_RULE_INVALID' })
  await s.rules.remove({ id: rule.id })
  assert.ok(!(await s.rules.list()).some(r => r.id === rule.id))
}))

test('S3 Chief deactivate asks; always on its card allows the next deactivation', () => fixture(async (s, script) => {
  const { taskId } = await s.create({ botId: 'chief' })
  const todo = s.bots().find(b => b.id === 'todo')
  script.push(turn('bot_manage', { action: 'deactivate', botId: todo.id, expectedVersion: todo.configRef.version, confirm: true }))
  await s.send(taskId, '停用待办 Bot')
  const first = await waiting(s, taskId), card = first.approvals.items.at(-1)
  assert.deepEqual([card.toolName, card.allowAlways], ['bot_manage', true])
  await s.decideApproval(taskId, card.id, { decision: 'approved', always: true })
  await settled(s, taskId)
  assert.equal(s.bots().find(b => b.id === todo.id).status, 'inactive')
  const calendar = s.bots().find(b => b.id === 'calendar')
  script.push(turn('bot_manage', { action: 'deactivate', botId: calendar.id, expectedVersion: calendar.configRef.version, confirm: true }))
  await s.send(taskId, '停用日历 Bot')
  const second = await settled(s, taskId)
  assert.equal(s.bots().find(b => b.id === calendar.id).status, 'inactive')
  assert.equal(second.approvals.items.length, 1)
  assert.ok((await s.rules.list()).some(r => r.match.tool === 'bot_manage' && r.match.action === 'deactivate' && r.effect === 'allow'))
}))

test('S3 an allow rule becomes ask during pause and cannot be made always then', () => fixture(async (s, script) => {
  const { taskId } = await s.create({ botId: 'chief' })
  const target = s.bots().find(b => b.id === 'todo')
  await s.rules.add({ botId: 'chief', match: { tool: 'bot_manage', action: 'configure' }, effect: 'allow' })
  await s.setAutomation({ paused: true, confirmed: true })
  script.push(turn('bot_manage', { action: 'configure', botId: target.id, expectedVersion: target.configRef.version, description: '整理事项', tools: [], resources: [] }))
  await s.send(taskId, '调整待办 Bot')
  const card = (await waiting(s, taskId)).approvals.items.at(-1)
  assert.equal(card.allowAlways, false)
  await assert.rejects(s.decideApproval(taskId, card.id, { decision: 'approved', always: true }), { code: 'POLICY_RULE_HARD' })
  await s.decideApproval(taskId, card.id, { decision: 'rejected' })
  await settled(s, taskId)
}))
