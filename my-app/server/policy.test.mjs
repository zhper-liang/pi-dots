import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { listBots } from './bots.mjs'
import { addRule, decide, listRules, pickRule, PolicyRules, setAutomationPause, unattended, validateRule } from './policy.mjs'

const fakeTx = () => { const docs = new Map(); return { async doc(token) { const key = token.definition.kind; if (!docs.has(key)) docs.set(key, token.definition.initial()); return docs.get(key) } } }
const call = (action, extra = {}) => ({ botId: 'calendar', tool: 'workspace.prepare_change', action, sourceId: 'local', type: 'Todo', ...extra })

test('S3 only deletion asks by default; reads bypass rules and unknown tools are denied', async () => {
  const tx = fakeTx()
  assert.equal((await decide(tx, call('create'))).effect, 'allow')
  assert.equal((await decide(tx, call('update'))).effect, 'allow')
  const deletion = await decide(tx, call('delete'))
  assert.deepEqual([deletion.effect, deletion.reason, deletion.allowAlways, deletion.expiresInMs], ['ask', 'delete-default', true, 300000])
  assert.equal((await decide(tx, { botId: 'calendar', tool: 'calendar_feishu_delete_event' })).effect, 'ask')
  assert.equal((await decide(tx, { botId: 'chief', tool: 'bot_manage', action: 'deactivate' })).effect, 'ask')
  for (const tool of ['calendar_feishu_create_event', 'calendar_feishu_update_event', 'calendar_reschedule_event', 'routine_propose', 'workspace.prepare_schedule'])
    assert.equal((await decide(tx, { botId: 'calendar', tool })).effect, 'allow', tool)
  await assert.rejects(addRule(tx, { botId: 'calendar', match: { tool: 'workspace.get' }, effect: 'deny' }), { code: 'POLICY_RULE_INVALID' })
  assert.equal((await decide(tx, { botId: 'calendar', tool: 'workspace.get' })).effect, 'allow')
  assert.equal((await decide(tx, { botId: 'calendar', tool: 'shell_exec' })).effect, 'deny')
  assert.equal(unattended('routine'), true); assert.equal(unattended('event'), true); assert.equal(unattended('detector'), true); assert.equal(unattended('user'), false)
})

test('S3 most specific rule wins; equal specificity prefers deny then ask', async () => {
  const tx = fakeTx(), rules = (await tx.doc(PolicyRules)).items
  rules.push({ id: 'legacy', botId: 'calendar', origin: 'preset', effect: 'deny', match: { tool: 'workspace.prepare_change' } })
  rules.push({ id: 'legacy-risk', botId: 'calendar', origin: 'user', effect: 'deny', match: { risk: 'R1' } })
  assert.equal((await decide(tx, call('create'))).effect, 'allow')
  await addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change' }, effect: 'ask' })
  assert.ok(!(await tx.doc(PolicyRules)).items.some(r => r.origin === 'preset'))
  await addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change', action: 'delete' }, effect: 'allow' })
  assert.equal((await decide(tx, call('delete'))).effect, 'allow')
  ;(await tx.doc(PolicyRules)).items.push({ id: 'equal', botId: 'calendar', origin: 'user', effect: 'deny', match: { tool: 'workspace.prepare_change', action: 'delete' } })
  assert.deepEqual([pickRule((await tx.doc(PolicyRules)).items, call('delete')).id, (await decide(tx, call('delete'))).effect], ['equal', 'deny'])
  ;(await tx.doc(PolicyRules)).items.push({ id: 'source', botId: 'calendar', origin: 'user', effect: 'ask', match: { tool: 'workspace.prepare_change', sourceId: 'local' } })
  assert.equal(pickRule((await tx.doc(PolicyRules)).items, call('delete')).id, 'equal')
  assert.equal((await listRules(tx, 'calendar')).some(r => r.origin === 'preset'), false)
  assert.doesNotThrow(() => validateRule({ match: { tool: 'bot_manage', action: 'deactivate' }, effect: 'allow' }))
  assert.throws(() => validateRule({ match: { risk: 'R4' }, effect: 'allow' }), { code: 'POLICY_RULE_INVALID' })
})

test('S3 global pause downgrades allowed writes to ask, without an always choice', async () => {
  const tx = fakeTx()
  await setAutomationPause(tx, { paused: true, by: 'test' })
  assert.equal((await decide(tx, call('create'))).effect, 'ask')
  assert.equal((await decide(tx, call('create'))).allowAlways, false)
  assert.equal((await decide(tx, { botId: 'calendar', tool: 'workspace.list' })).effect, 'allow')
  await setAutomationPause(tx, { paused: false, by: 'test' })
  assert.equal((await decide(tx, call('create'))).effect, 'allow')
})

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'policy-fixture', apiKey: 'fixture-only' }
const text = () => ({ mode: 'model', reply: { content: '好了' }, execution: { usage: { totalTokens: 7 } } })
let seq = 0
const turn = (name, args) => { const content = [{ type: 'toolCall', id: 'policy-' + ++seq, name, arguments: args }]; return { ...text(), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } } }
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-policy-s3-')), script = []
  let s
  try { s = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots: listBots(config), modelReply: async () => script.shift() ?? text(), legacyApprovalRules: false }); await fn(s, script) }
  finally { await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function settled(s, id) { for (let i = 0; i < 800; i++) { const t = await s.get(id); if (t.activeInputId === null && t.runtime.checkpoint?.phase === 'awaitInput') return t; await new Promise(r => setTimeout(r, 5)) } assert.fail('Task did not settle') }
async function configured(s) { const { bot } = await s.getBotConfiguration('calendar'); await s.updateBotConfiguration('calendar', { requestId: 'policy-assign-' + ++seq, expectedVersion: bot.configRef.version, description: bot.description, tools: WORKSPACE_TOOLS, resources: ['workspace:local'] }) }
async function run(s, script, id, args) { script.push(turn('workspace.prepare_change', args)); await s.send(id, '请处理'); return (await settled(s, id)).messages.filter(m => m.toolName === 'workspace.prepare_change').at(-1).result.data }

test('S3 deleting locally asks; always on the card makes the next delete direct', () => fixture(async (s, script) => {
  await configured(s)
  const { taskId } = await s.create({ botId: 'calendar' })
  const create = requestId => ({ sourceId: 'local', requestId, action: 'create', change: { type: 'Todo', data: { title: requestId } } })
  const del = (requestId, made) => ({ sourceId: 'local', requestId, action: 'delete', change: { type: 'Todo', id: made.receipt.target.id, expectedVersion: made.receipt.version } })
  const first = await run(s, script, taskId, create('s3-first'))
  assert.equal(first.state, 'succeeded')
  const pending = await run(s, script, taskId, del('s3-delete-first', first))
  assert.deepEqual([pending.state, pending.confirmation.allowAlways], ['awaiting_confirmation', true])
  await s.workspaceAgent.confirmLocal({ sourceId: 'local', requestId: pending.requestId, payloadHash: pending.payloadHash, confirmed: true, always: true })
  const second = await run(s, script, taskId, create('s3-second'))
  const direct = await run(s, script, taskId, del('s3-delete-second', second))
  assert.equal(direct.state, 'succeeded')
  assert.equal((await s.inbox()).items.some(i => i.kind === 'workspace-proposal' && i.requestId === 's3-delete-second'), false)
  assert.ok((await s.rules.list()).some(r => r.match.action === 'delete' && r.effect === 'allow'))
}))

test('S3 Chief configures another Bot immediately', () => fixture(async (s, script) => {
  const target = s.bots().find(b => b.id === 'todo')
  const { taskId } = await s.create({ botId: 'chief' })
  script.push(turn('bot_manage', { action: 'configure', botId: target.id, expectedVersion: target.configRef.version, description: '整理待办', tools: [], resources: [] }))
  await s.send(taskId, '调整待办 Bot')
  const done = await settled(s, taskId)
  const result = done.messages.find(m => m.toolName === 'bot_manage').result
  assert.equal(result.ok, true)
  assert.equal(done.approvals.items.length, 0)
  assert.equal(s.bots().find(b => b.id === target.id).description, '整理待办')
}))
