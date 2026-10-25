import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { listBots } from './bots.mjs'
import { summarizeApproval, summarizeOperation } from './inbox.mjs'
import { addRule } from './policy.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

// S2: former tier checks now cover live Bot tool/resource assignments.
const modelConfig = { baseUrl: 'https://fixture.invalid/v1', model: 'tier-fixture', apiKey: 'fixture-only' }
const text = (content = '已处理') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
const toolCall = (name, args, id) => { const call = { type: 'toolCall', id, name, arguments: args }; return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } } }
const movie = { title: '看电影', start: '2026-10-23T16:00:00+08:00', end: '2026-10-23T18:00:00+08:00', timezone: 'Asia/Shanghai' }
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-tiers-')); let s, n = 0
  const script = { next: null }
  try {
    s = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots: listBots(modelConfig), modelReply: async () => { const r = script.next; script.next = null; n++; return r ?? text() } })
    await fn(s, script, () => n)
  } finally { await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function settle(s, id) { for (let i = 0; i < 600; i++) { const t = await s.get(id); if (t.activeInputId === null) return t; await new Promise(r => setTimeout(r, 5)) } assert.fail('Task did not settle') }
async function configure(s, tools = WORKSPACE_TOOLS, resources = ['workspace:local']) {
  const { bot } = await s.getBotConfiguration('calendar')
  await s.updateBotConfiguration('calendar', { requestId: `assignment-${Math.random().toString(36).slice(2)}`, expectedVersion: bot.configRef.version, description: '日程助理', tools, resources })
}
async function propose(s, script, taskId, requestId, data = movie) {
  script.next = toolCall('workspace.prepare_change', { sourceId: 'local', requestId, action: 'create', change: { type: 'Event', data } }, requestId)
  await s.send(taskId, '帮我加日程'); const t = await settle(s, taskId)
  return t.messages.filter(m => m.toolName === 'workspace.prepare_change').at(-1)?.result
}
const events = async s => (await s.workspace.query({ sourceId: 'local', type: 'Event' })).items

test('owner has implicit local access: no grant call needed, status authorized, revoke refused', () => fixture(async s => {
  const status = (await s.workspaceDiagnostics()).sources.find(x => x.id === 'local')
  assert.equal(status.authorized, true); assert.equal(typeof status.grantEpoch, 'number')
  assert.equal((await s.workspace.executeLocal({ sourceId: 'local', requestId: 'owner-1', type: 'Todo', action: 'create', data: { title: '买牛奶' } })).state, 'succeeded')
  await assert.rejects(s.workspace.manageLocalGrant({ requestId: 'off', sourceId: 'local', enabled: false, expectedEpoch: 0, confirmed: true }), { code: 'WORKSPACE_OWNER_IMPLICIT' })
  assert.equal((await s.workspace.query({ sourceId: 'local', type: 'Todo' })).items.length, 1)
}))

test('existing Task gains an assigned write tool and loses history access on revocation', () => fixture(async (s, script, calls) => {
  const task = await s.create({ botId: 'calendar' })
  await configure(s, ['workspace.list', 'workspace.get'])
  assert.equal((await propose(s, script, task.taskId, 'read-only')).error.code, 'TOOL_NOT_AUTHORIZED')
  assert.equal((await events(s)).length, 0)
  await configure(s)
  await s.harness.commit(tx => addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change' }, effect: 'ask' }), context)
  const prepared = await propose(s, script, task.taskId, 'live-write')
  assert.equal(prepared.ok, true); assert.equal(prepared.data.state, 'awaiting_confirmation')
  const done = await s.workspaceAgent.confirmLocal({ sourceId: 'local', requestId: prepared.data.requestId, payloadHash: prepared.data.payloadHash, confirmed: true })
  assert.equal(done.state, 'succeeded'); assert.equal((await events(s)).length, 1)
  const before = calls()
  await configure(s, ['workspace.list', 'workspace.get'])
  await s.send(task.taskId, '撤权后不得复用历史'); await settle(s, task.taskId)
  assert.equal(calls(), before); assert.equal((await events(s)).length, 1)
}))

test('Bot Grant and tier management endpoints are absent', () => fixture(async s => {
  for (const name of ['manageGrant', 'grantStatus', 'setTier', 'tierStatus']) assert.equal(s.workspaceAgent[name], undefined)
  const server = createApiServer({ tasks: s, token: 'workspace-token' }); await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/workspace/`
    for (const path of ['agent-grant', 'agent-grant-status', 'agent-tier', 'agent-tier-status']) {
      const response = await fetch(url + path, { method: 'POST', headers: { Authorization: 'Bearer workspace-token', 'content-type': 'application/json' }, body: '{}' })
      assert.equal(response.status, 405, path)
      assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED')
    }
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
}))

test('GET /api/inbox is authenticated and GET-only', () => fixture(async s => {
  const server = createApiServer({ tasks: s, token: 'inbox-token' }); await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/api/inbox`
  try {
    assert.equal((await fetch(url)).status, 401)
    const ok = await fetch(url, { headers: { Authorization: 'Bearer inbox-token' } }); assert.equal(ok.status, 200); assert.deepEqual((await ok.json()).data.items, [])
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer inbox-token' } })).status, 405)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
}))

test('inbox summaries are plain Chinese sentences', () => {
  assert.equal(summarizeOperation('日程助理', { action: 'create', normalizedArgs: { type: 'Event', data: movie } }), '日程助理想在 10月23日 16:00 添加「看电影」')
  assert.equal(summarizeOperation('日程助理', { action: 'delete', normalizedArgs: { type: 'Todo' }, confirmation: { before: { title: '买菜' } } }), '日程助理想删除待办「买菜」')
  assert.equal(summarizeApproval('日程助理', 'calendar_feishu_create_event', { title: '周会', start: '2026-10-23T08:00:00Z' }), '日程助理想在 10月23日 16:00 添加飞书日程「周会」')
})
