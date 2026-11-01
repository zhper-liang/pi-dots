import { MAIN_MEMORY_TOOLS } from './memory-tools.mjs'
import { SESSION_HISTORY_TOOLS } from './history-search.mjs'
import { INTRINSIC_TOOLS } from './tools.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'
import { listBots } from './bots.mjs'
import { ToolAccess, toolSets, toolDefinitions, checkToolCall } from './tools.mjs'
import { PolicyRules, addRule, decide } from './policy.mjs'
import { MAIN_TOOLS } from './main-tools.mjs'

// Main-only discovery and manual review never become ordinary Task abilities.
const mainIntrinsicTools = () => toolDefinitions([...INTRINSIC_TOOLS, ...SESSION_HISTORY_TOOLS, ...MAIN_MEMORY_TOOLS]).map(tool => tool.name)

const copy = value => JSON.parse(JSON.stringify(value))
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'r1-static', apiKey: 'fixture-only' }
const text = (content = '正常聊天') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 3 } } })
let sequence = 0
function toolCall(name, args) {
  const content = [{ type: 'toolCall', id: `r1-static-${++sequence}`, name, arguments: args }]
  return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }
}
async function fixture(t, { modelReply = async () => text(), toolImpl } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r1-static-'))
  const file = join(dir, 'tasks.sqlite'), token = randomUUID()
  let store, server
  async function open() {
    store = await openTaskStore({ file, bots: listBots(config), modelReply, ...(toolImpl ? { toolImpl } : {}) })
    server = createApiServer({ token, tasks: store })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  }
  async function close() {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    if (store) await store.close()
  }
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  await open()
  async function request(botId, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/${botId}/capabilities`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await response.json()
    assert.equal(response.status, 200, JSON.stringify(payload))
    return payload.data
  }
  return { get store() { return store }, commit: fn => store.harness.commit(fn, context),
    reopen: async () => { await close(); await open() },
    async toggle(botId, capabilityId, enabled) {
      const view = await request(botId)
      return request(botId, { requestId: randomUUID(), expectedRevision: view.revision, capabilityId, enabled,
        expectedCatalogRevision: view.items.find(item => item.id === capabilityId).revision })
    } }
}
async function settle(store, id) {
  for (let n = 0; n < 600; n++) {
    const task = await store.get(id)
    if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput') return task
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('R1 static Task did not settle')
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

for (const scenario of [
  { name: 'calendar_read_schedule', group: 'tool:todos', args: { date: '2026-10-29', resource: 'mock:personal' } },
  { name: 'routine_propose', group: 'tool:todos', args: { title: '不得创建', prompt: '测试', sourceIds: ['local'], notification: 'none', rule: { type: 'daily', time: '09:00', timezone: 'Asia/Shanghai' } } },
  { name: 'task_status', group: 'tool:reports', args: {} },
  { name: 'automation_pause', group: 'tool:automation', args: {} },
]) test(`R1 seen schema then HTTP revoke rejects next ${scenario.name} call`, { timeout: 10000 }, async t => {
  const seen = deferred(), release = deferred()
  let calls = 0, dispatched = 0
  t.after(() => release.resolve())
  const f = await fixture(t, {
    modelReply: async (_message, options) => {
      if (++calls === 1) {
        seen.resolve((options.context?.tools ?? []).map(tool => tool.name))
        await release.promise
        return toolCall(scenario.name, scenario.args)
      }
      return text('已拒绝，不执行')
    },
    toolImpl: () => { dispatched++; throw new Error('revoked tool reached implementation') },
  })
  await f.toggle('calendar', scenario.group, true)
  const id = (await f.store.mainSessions()).calendar
  await f.store.send(id, '执行测试')
  assert.ok((await seen.promise).includes(scenario.name), 'model really saw schema before revocation')
  await f.toggle('calendar', scenario.group, false)
  release.resolve()
  const task = await settle(f.store, id)
  const receipt = task.messages.find(message => message.toolName === scenario.name)
  assert.ok(receipt, 'denied tool has an actual execution receipt')
  assert.equal(receipt.result.ok, false)
  assert.equal(receipt.result.error.code, 'TOOL_NOT_AUTHORIZED')
  assert.ok(!task.toolSets.authorized.includes(scenario.name))
  assert.ok(!task.toolSets.displayed.includes(scenario.name))
  assert.equal(dispatched, 0)
  if (scenario.name === 'automation_pause') assert.equal((await f.store.automationStatus()).paused, false)
})

test('R1 new blank Bot chats in main and ordinary Task with no default business or main tools, including restart', async t => {
  const offered = []
  const f = await fixture(t, { modelReply: async (_message, options) => { offered.push((options.context?.tools ?? []).map(tool => tool.name)); return text() } })
  const { bot, mainTaskId } = await f.store.createBot({ capabilities: [], name: '日历专家', requestId: randomUUID() })
  assert.deepEqual(bot.defaults.tools, [])
  assert.deepEqual(bot.defaults.toolResources, [])
  for (const reopen of [false, true]) {
    if (reopen) await f.reopen()
    await f.store.send(mainTaskId, '你好')
    const main = await settle(f.store, mainTaskId)
    assert.ok(main.messages.some(message => message.role === 'assistant' && message.content === '正常聊天'))
    assert.deepEqual(main.toolSets.authorized, mainIntrinsicTools())
    assert.deepEqual(offered.at(-1), mainIntrinsicTools())
  }
  const task = await f.store.create({ botId: bot.id })
  await f.store.send(task.taskId, '普通聊天')
  const done = await settle(f.store, task.taskId)
  assert.deepEqual(done.toolSets.authorized, [...INTRINSIC_TOOLS])
  assert.ok(done.messages.some(message => message.role === 'assistant' && message.content === '正常聊天'))
})

test('R1 exact main revocations override stale schema and assignments without policy becoming a grant', async t => {
  const f = await fixture(t)
  const identity = { bot: { id: 'calendar' }, kind: 'main', taskId: 1, configRef: { botId: 'calendar' } }
  for (const name of [...MAIN_TOOLS, 'automation_pause']) {
    const access = { assignments: { calendar: { tools: [name], resources: [] } }, revoked: { calendar: [name] } }
    const sets = toolSets(identity, f.store.bots(), access)
    assert.ok(!sets.authorized.includes(name))
    assert.deepEqual(toolDefinitions(sets.displayed).map(tool => tool.name), mainIntrinsicTools())
    const denied = checkToolCall({ card: identity, record: { id: 1, input: { botId: 'calendar' } }, conversation: { owner: { taskId: 1 } },
      call: { name, arguments: {} }, displayed: [name], sets })
    assert.equal(denied.error.code, 'TOOL_NOT_AUTHORIZED')
  }
  // Policy is write confirmation, not a capability grant: a read/internal allow never defeats check.
  assert.equal((await f.commit(tx => decide(tx, { botId: 'calendar', tool: 'task_status' }))).effect, 'allow')
})

test('R1 HTTP toggles expose grouped main schemas, preserve write mode/resources and reject main-only use in ordinary Tasks', async t => {
  const f = await fixture(t)
  await f.commit(tx => addRule(tx, { botId: 'calendar', match: { tool: 'routine_propose' }, effect: 'ask' }))
  const before = await f.commit(async tx => ({ policy: copy(await tx.doc(PolicyRules)), resources: copy((await tx.doc(ToolAccess)).assignments.calendar.resources) }))
  for (const [group, name] of [['tool:todos', 'routine_propose'], ['tool:reports', 'task_status']]) {
    const enabled = await f.toggle('calendar', group, true)
    assert.ok(enabled.toolNames.includes(name))
    const id = (await f.store.mainSessions()).calendar
    assert.ok((await f.store.get(id)).toolSets.displayed.includes(name))
    await f.toggle('calendar', group, false)
    assert.ok(!(await f.store.get(id)).toolSets.displayed.includes(name))
  }
  const after = await f.commit(async tx => ({ policy: copy(await tx.doc(PolicyRules)), resources: copy((await tx.doc(ToolAccess)).assignments.calendar.resources) }))
  assert.deepEqual(after.policy, before.policy)
  assert.deepEqual(after.resources, [...before.resources, 'workspace:local'])
  const ordinary = await f.store.create({ botId: 'calendar' })
  assert.ok(MAIN_TOOLS.every(name => !ordinary.toolSets.authorized.includes(name)))
  assert.ok(!ordinary.toolSets.authorized.includes('automation_pause'))
})

test('R1 legacy effective main rights become explicit once; later revocations, resources and policy survive restart', async t => {
  const f = await fixture(t)
  const id = (await f.store.mainSessions()).calendar
  const before = await f.store.get(id)
  for (const name of [...MAIN_TOOLS, 'automation_pause']) assert.ok(before.toolSets.authorized.includes(name), name)
  await f.commit(async tx => {
    const access = await tx.doc(ToolAccess)
    access.revoked.calendar = [...new Set([...(access.revoked.calendar ?? []), ...MAIN_TOOLS, 'automation_pause'])]
    access.assignments.calendar.tools = access.assignments.calendar.tools.filter(name => !MAIN_TOOLS.includes(name) && name !== 'automation_pause')
    await addRule(tx, { botId: 'calendar', match: { tool: 'calendar_reschedule_event' }, effect: 'ask' })
  })
  const expected = await f.commit(async tx => ({ access: copy(await tx.doc(ToolAccess)), rules: copy(await tx.doc(PolicyRules)) }))
  await f.reopen()
  const current = await f.commit(async tx => ({ access: copy(await tx.doc(ToolAccess)), rules: copy(await tx.doc(PolicyRules)) }))
  assert.deepEqual(current, expected)
  const main = await f.store.get(id)
  assert.ok([...MAIN_TOOLS, 'automation_pause'].every(name => !main.toolSets.authorized.includes(name)))
  assert.ok(main.toolSets.authorized.includes('calendar_read_schedule'), 'unrelated legacy permission remains')
})
