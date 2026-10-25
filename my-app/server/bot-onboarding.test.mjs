import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { createApiServer } from './app.mjs'
import { listBots } from './bots.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { COLLABORATION_TOOLS } from './collaboration-tools.mjs'
import { NEW_BOT_WORKSPACE_TOOLS } from './bot-configuration.mjs'
import { inferBotRole } from './bot-templates.mjs'
import { decide } from './policy.mjs'

// PLAN §8.6 建 Bot 降门槛 (phase 6). IDs follow T6-01..T6-04; D-15..D-17 per PLAN §11.
const modelConfig = { baseUrl: 'https://onboarding-fixture.invalid/v1', model: 'onboarding-fixture', apiKey: 'fixture-only' }
const text = (content = '好的') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
let seq = 0
const turn = (...calls) => { const content = calls.map(([name, args]) => ({ type: 'toolCall', id: `o-${++seq}`, name, arguments: args })); return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } } }
// Replies come from state.byTask[taskId], then state.byBot[botId], then a plain text.
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-onboarding-')), state = { byTask: new Map(), byBot: new Map(), seen: [] }
  const modelReply = async (_m, opts) => {
    state.seen.push(opts)
    const queue = state.byTask.get(opts.taskId)?.length ? state.byTask.get(opts.taskId) : state.byBot.get(opts.parametersBotId) ?? []
    const next = queue.shift()
    return typeof next === 'function' ? next(opts) : next ?? text()
  }
  let s
  try { s = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots: listBots(modelConfig), modelReply }); await fn({ s, state }) }
  finally { await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function until(s, id, check) { for (let i = 0; i < 1000; i++) { const t = await s.get(id); if (await check(t)) return t; await new Promise(r => setTimeout(r, 5)) } assert.fail(`Task ${id} did not settle`) }
const settle = (s, id) => until(s, id, t => t.activeInputId === null && t.runtime.checkpoint?.phase === 'awaitInput')
const grantLocal = (s, tools = WORKSPACE_TOOLS) => s.updateCapabilityPool({ requestId: `onboarding-assign-${++seq}`, operation: 'grant', tools, resources: ['workspace:local'] })
const localCall = (botId, action) => ({ botId, tool: 'workspace.prepare_change', action, sourceId: 'local', type: 'Todo', sourceAuthority: 'local', origin: 'user' })

test('T6-01 a name alone creates a Bot, on the page and through Chief, with no confirmation card', () => fixture(async ({ s, state }) => {
  const { bot, created, mainTaskId, inferred } = await s.createBot({ name: '日程管家', requestId: 'onboard-name-only' })
  assert.equal(created, true); assert.equal(bot.profile, 'general')
  assert.equal(bot.description, inferBotRole('日程管家').description); assert.equal(inferred.role, '日程管理')
  assert.equal(mainTaskId, (await s.mainSessions())[bot.id])
  // HTTP: name + requestId is a complete request.
  const server = createApiServer({ tasks: s, token: 'onboarding-token' }); await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots`, { method: 'POST', headers: { Authorization: 'Bearer onboarding-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '费用小帮手', requestId: 'onboard-http-name' }) })
    const body = await response.json()
    assert.equal(response.status, 201); assert.equal(body.bot.description, inferBotRole('费用小帮手').description); assert.equal(typeof body.mainTaskId, 'number')
    for (const description of ['', '   ']) assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/bots`, { method: 'POST', headers: { Authorization: 'Bearer onboarding-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '空职责', description, requestId: `onboard-empty-${description.length}` }) })).status, 400)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  // D-16: Chief creates by name only (no description, no profile) and it runs at once.
  const chiefMain = (await s.mainSessions()).chief
  state.byTask.set(chiefMain, [turn(['bot_manage', { action: 'create', name: '周报小助手' }]), text('建好了')])
  await s.send(chiefMain, '建一个写周报的 Bot')
  const chief = await settle(s, chiefMain)
  const receipt = chief.messages.find(m => m.toolName === 'bot_manage').result
  assert.equal(receipt.ok, true); assert.equal(receipt.data.created, true)
  assert.equal(receipt.data.bot.description, inferBotRole('周报小助手').description)
  assert.equal(chief.approvals.items.length, 0)
  assert.ok((await s.mainSessions())[receipt.data.bot.id])
}))

test('T6-02 inference is predictable: same name, same result; specific duties win over the generic row', () => fixture(async ({ s }) => {
  for (const name of ['日程助理', '待办管家', '费用整理', 'Bug 复现', '小明', '周报小助手']) assert.deepEqual(inferBotRole(name), inferBotRole(name))
  assert.deepEqual(inferBotRole('ＣＡＬＥＮＤＡＲ Bot'), inferBotRole('calendar bot')) // NFKC + case-insensitive
  assert.equal(inferBotRole('日程助理').role, '日程管理')
  assert.equal(inferBotRole('周报小助手').role, '汇报助理')
  assert.equal(inferBotRole('待办管家').role, '待办管理')
  assert.equal(inferBotRole('我的秘书').role, '日常助理')
  assert.equal(inferBotRole('出差助手').role, '差旅助理')
  assert.equal(inferBotRole('小明').template, 'fallback')
  // The stored description is a pure function of the name, so a retry is the same request.
  const first = await s.createBot({ name: '待办管家', requestId: 'onboard-replay' })
  const again = await s.createBot({ name: '待办管家', requestId: 'onboard-replay' })
  assert.equal(again.created, false); assert.deepEqual(again.bot, first.bot); assert.equal(again.mainTaskId, first.mainTaskId)
  assert.equal((await s.createBot({ name: '待办管家', description: inferBotRole('待办管家').description, requestId: 'onboard-replay' })).created, false)
  await assert.rejects(s.createBot({ name: '待办管家', description: '别的职责', requestId: 'onboard-replay' }), { code: 'BOT_REQUEST_CONFLICT' })
}))

test('T6-03 a new Bot gets local workspace tools directly assigned (D-15)', () => fixture(async ({ s }) => {
  const bare = (await s.createBot({ name: '本地助理', requestId: 'onboard-no-pool' })).bot
  const bot = bare
  assert.deepEqual(bot.defaults.tools.filter(t => t.startsWith('workspace.')), NEW_BOT_WORKSPACE_TOOLS)
  assert.ok(!bot.defaults.tools.includes('workspace.prepare_schedule')); assert.deepEqual(bot.defaults.toolResources, ['workspace:local'])
  assert.deepEqual(bare.defaults.tools.filter(t => t.startsWith('workspace.')), NEW_BOT_WORKSPACE_TOOLS)
  assert.deepEqual(bare.defaults.toolResources, ['workspace:local'])
  const verdict = action => s.harness.commit(tx => decide(tx, localCall(bot.id, action)), context)
  assert.equal((await verdict('create')).effect, 'allow'); assert.equal((await verdict('update')).effect, 'allow')
  assert.equal((await verdict('delete')).effect, 'ask')
  // The Bot's Tasks can actually use them.
  const task = await s.create({ botId: bot.id })
  for (const name of NEW_BOT_WORKSPACE_TOOLS) assert.ok(task.toolSets.authorized.includes(name), name)
}))

test('T6-04 creation returns the Bot\'s main session; it opens empty (no suggested first task) and replays to the same one', () => fixture(async ({ s }) => {
  const { bot, mainTaskId } = await s.createBot({ name: '会议助手', requestId: 'onboard-main' })
  const main = await s.get(mainTaskId)
  assert.deepEqual([main.kind, main.bot.id], ['main', bot.id])
  assert.deepEqual(main.messages, [])
  for (const name of ['workspace.list', 'workspace.get', 'task_create']) assert.ok(main.toolSets.authorized.includes(name), name)
  assert.ok(main.toolSets.authorized.includes('workspace.prepare_change'))
  assert.equal((await s.createBot({ name: '会议助手', requestId: 'onboard-main' })).mainTaskId, mainTaskId)
}))

test('D-15/D-16 chain: Chief creates a Bot by name, then hands it work through a derived Task', () => fixture(async ({ s, state }) => {
  await grantLocal(s, [...WORKSPACE_TOOLS, ...COLLABORATION_TOOLS])
  const { bot: chiefBot } = await s.getBotConfiguration('chief')
  await s.updateBotConfiguration('chief', { requestId: 'onboard-chief-collab', expectedVersion: chiefBot.configRef.version, description: chiefBot.description, tools: COLLABORATION_TOOLS, resources: [] })
  await s.workspace.executeLocal({ sourceId: 'local', requestId: 'onboard-todo-1', type: 'Todo', action: 'create', data: { title: '交周报' } })
  const chiefMain = (await s.mainSessions()).chief
  const newBotId = () => s.bots().find(b => b.name === '待办小帮手')?.id
  state.byTask.set(chiefMain, [
    turn(['bot_manage', { action: 'create', name: '待办小帮手' }]),
    () => {
      // The new Bot exists once bot_manage committed; script its replies before any work reaches it.
      state.byBot.set(newBotId(), [turn(['workspace.list', { sourceId: 'local', type: 'Todo' }]), text('未完成：交周报')])
      return turn(['task_create', { operationId: 'hand-off', goal: '让新建的待办小帮手整理我的待办', completionCriteria: ['待办小帮手给出整理结果'] }])
    },
    text('已交给待办小帮手'),
  ])
  // The derived Chief Task assigns to the new Bot; the new Bot reads the local to-dos.
  state.byBot.set('chief', [
    () => turn(['task_assign', { operationId: 'assign-1', botId: newBotId(), goal: '整理我的待办', completionCriteria: ['列出未完成的待办'] }]),
    text('待办小帮手已完成'),
  ])
  await s.send(chiefMain, '建一个待办小帮手，然后让它整理我的待办')
  const main = await settle(s, chiefMain)
  const derivedId = main.messages.find(m => m.toolName === 'task_create').result.data.taskId
  const derived = await until(s, derivedId, t => t.collaborations?.length && t.collaborations[0].result)
  const child = await settle(s, derived.collaborations[0].childTaskId)
  assert.equal(child.bot.id, newBotId())
  const read = child.messages.find(m => m.toolName === 'workspace.list').result
  assert.equal(read.ok, true); assert.ok(JSON.stringify(read.data).includes('交周报'))
}))

test('D-18 main session: collaborators_list works with its own grant; the hand-off hint appears only when the Bot can delegate', () => fixture(async ({ s, state }) => {
  const chiefMain = (await s.mainSessions()).chief
  const promptOf = () => state.seen.filter(o => o.taskId === chiefMain).at(-1).context.systemPrompt
  await s.send(chiefMain, '你好'); await settle(s, chiefMain)
  assert.doesNotMatch(promptOf(), /主会话里没有task_assign/) // no collaboration tools assigned yet
  await grantLocal(s, COLLABORATION_TOOLS)
  const { bot: chiefBot } = await s.getBotConfiguration('chief')
  await s.updateBotConfiguration('chief', { requestId: 'onboard-chief-collab-2', expectedVersion: chiefBot.configRef.version, description: chiefBot.description, tools: COLLABORATION_TOOLS, resources: [] })
  state.byTask.set(chiefMain, [turn(['collaborators_list', {}]), text('有这些 Bot')])
  await s.send(chiefMain, '现在有哪些 Bot 可以帮忙？')
  const main = await settle(s, chiefMain)
  assert.match(promptOf(), /若当前工具集中有task_assign/)
  assert.ok(main.toolSets.authorized.includes('task_assign'))
  const listed = main.messages.find(m => m.toolName === 'collaborators_list').result
  assert.equal(listed.ok, true); assert.ok(listed.data.collaborators.some(b => b.id === 'calendar'))
  assert.ok(!listed.data.collaborators.some(b => b.id === 'chief'))
}))
