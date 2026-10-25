import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { SKILL_DIRECTORY } from './skills.mjs'
import { buildCommands, matchCommands } from '../src/commands.mjs'

// Skills auto-register from the directory; the composer "/" menu picks one for a message.
const skillId = 'calendar-conflict-analysis'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'skill-command-fixture', apiKey: 'never-store-me' }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-skill-cmd-')), directory = join(dir, 'skills'), requests = [], state = { gate: null }
  await cp(SKILL_DIRECTORY, directory, { recursive: true })
  const open = () => openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), skillDirectory: directory,
    modelReply: async (_m, { context: request }) => { requests.push(request); if (state.gate) await state.gate; return { mode: 'model', reply: { content: '按要求处理完成。' }, execution: { usage: { totalTokens: 9 } } } } })
  let store = await open()
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, directory, requests, state, reopen: async () => { await store.close(); store = await open(); return store } }
}
async function settled(store, id) {
  for (let n = 0; n < 400; n++) { const task = await store.get(id); if (task.activeInputId === null && task.queueLength === 0) return task; await delay(10) }
  throw new Error('fixture did not settle')
}
async function addSkill(directory, id, manifest = {}, rules = `# ${id}\n只做测试规则。`) {
  await mkdir(join(directory, id), { recursive: true })
  await writeFile(join(directory, id, 'manifest.json'), JSON.stringify({ id, name: `测试 ${id}`, description: '测试用', version: '0.1.0', applicability: '测试', botIds: ['calendar'], requiredTools: ['calendar_read_schedule'], requiredResources: [], scripts: [], ...manifest }))
  if (rules !== null) await writeFile(join(directory, id, 'SKILL.md'), rules)
}

test('Skills auto-register from the directory without a restart; broken ones are listed unavailable; others are ignored', async (t) => {
  const { store, directory } = await fixture(t)
  assert.deepEqual((await store.skillCatalog()).map(s => s.id), [skillId])
  await addSkill(directory, 'todo-review')
  await addSkill(directory, 'broken-skill', {}, null) // no SKILL.md
  await mkdir(join(directory, 'notes-only')) // no manifest → not a Skill
  await mkdir(join(directory, 'Bad_Name')); await writeFile(join(directory, 'Bad_Name', 'manifest.json'), '{}')
  const catalog = await store.skillCatalog()
  assert.deepEqual(catalog.map(s => [s.id, s.available]), [['broken-skill', false], [skillId, true], ['todo-review', true]])
  const task = await store.create({ botId: 'calendar' })
  assert.deepEqual((await store.taskSkills(task.taskId)).map(s => [s.id, s.available]), [[skillId, true], ['todo-review', true]]) // broken: not loadable, not offered
  // Removing the folder removes the Skill (read on each use).
  await rm(join(directory, 'todo-review'), { recursive: true })
  assert.ok(!(await store.taskSkills(task.taskId)).some(s => s.id === 'todo-review'))
})

test('a "/" Skill handles one message: loaded before the model, audited as user-command, deactivated after', async (t) => {
  const { store, requests, reopen } = await fixture(t)
  const task = await store.create({ botId: 'calendar' })
  const rules = await readFile(join(SKILL_DIRECTORY, skillId, 'SKILL.md'), 'utf8')
  await store.send(task.taskId, '看看 2026-10-20 有没有冲突', undefined, { skillId })
  const done = await settled(store, task.taskId)
  assert.ok(requests[0].systemPrompt.includes(rules)); assert.match(requests[0].systemPrompt, /用户这条消息指定用 Skill「calendar-conflict-analysis」处理/)
  assert.equal(done.skillState.active.length, 0) // the input ended: the Skill is off again
  const events = done.skillState.history.map(e => [e.status, e.source])
  assert.deepEqual(events, [['active', 'user-command'], ['inactive', 'phase-completed']])
  assert.equal(done.messages.find(m => m.role === 'user').skillId, skillId)
  const card = done.messages.find(m => m.systemKind === 'skill')
  assert.deepEqual([card.skillStatus, card.skillSource, card.skillName, card.skillVersion], ['active', 'user-command', '日程冲突分析', '1.1.0']); assert.equal(card.skillRules, rules)
  // The next plain message is not handled by it; reopening never re-activates the old command.
  await store.send(task.taskId, '谢谢'); await settled(store, task.taskId)
  assert.doesNotMatch(requests.at(-1).systemPrompt, /用户这条消息指定用 Skill/)
  const reopened = await reopen()
  assert.equal((await reopened.get(task.taskId)).skillState.history.filter(e => e.source === 'user-command').length, 1)
})

test('"/" Skill refusals: unknown, Bot without Skill tools, group, bad id; a queued Skill message cannot become an insert', async (t) => {
  const { store, state } = await fixture(t)
  const task = await store.create({ botId: 'calendar' })
  await assert.rejects(store.send(task.taskId, '分析', undefined, { skillId: 'no-such-skill' }), { code: 'SKILL_UNAVAILABLE' })
  await assert.rejects(store.send(task.taskId, '分析', undefined, { skillId: '../etc' }), { code: 'INVALID_SKILL' })
  // This Skill's manifest names the calendar Bot only: Chief is not offered it.
  const chief = await store.create({ botId: 'chief' })
  assert.deepEqual(await store.taskSkills(chief.taskId), [])
  // A queued message sent with a Skill stays its own input.
  let release; state.gate = new Promise(r => { release = r })
  await store.send(task.taskId, '先做这个')
  const queued = await store.send(task.taskId, '再按 Skill 分析', undefined, { skillId })
  assert.equal(queued.status, 'queued')
  await assert.rejects(store.steer(task.taskId, { messageId: queued.messageId }), { code: 'SKILL_COMMAND_NOT_STEERABLE' })
  state.gate = null; release(); await settled(store, task.taskId)
  // Without the Skill tools from the pool the Skill is listed with the reason and refused (auto-registered ≠ authorized).
  await store.updateToolAccess('calendar', { revoked: ['skill_activate'] })
  const revokedTask = await store.create({ botId: 'calendar' })
  const listed = await store.taskSkills(revokedTask.taskId)
  assert.deepEqual(listed.map(s => [s.available, s.error?.code]), [[false, 'SKILL_TOOLS_NOT_GRANTED']])
  await assert.rejects(store.send(revokedTask.taskId, '分析', undefined, { skillId }), { code: 'SKILL_UNAVAILABLE' })
})

test('a main session offers and loads the Skill by the Bot\'s current tools, not its snapshot from before the grant', async (t) => {
  const { store, requests } = await fixture(t)
  const mainId = (await store.mainSessions()).calendar // created before the fixture granted the pool (stale snapshot)
  assert.deepEqual((await store.taskSkills(mainId)).map(s => [s.id, s.available]), [[skillId, true]])
  await store.send(mainId, '看看 2026-10-20 有没有冲突', undefined, { skillId })
  const done = await settled(store, mainId)
  assert.ok(requests.at(-1).systemPrompt.includes('活动 Skill（固定完整版本）'))
  assert.equal(done.messages.find(m => m.systemKind === 'skill').skillStatus, 'active')
  assert.ok(done.toolSets.authorized.includes('calendar_reschedule_event')) // S1: main sessions use the Bot's current assignment
})

test('HTTP: messages accept {message, skillId}; task Skills are listed for the "/" menu', async (t) => {
  const { store } = await fixture(t)
  const server = createApiServer({ token: 'skill-command-token', tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)) })
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: 'Bearer skill-command-token', 'Content-Type': 'application/json' }
  const task = await store.create({ botId: 'calendar' })
  const path = `${base}/api/bots/calendar/tasks/${task.taskId}`
  assert.equal((await fetch(`${path}/skills`)).status, 401)
  assert.deepEqual((await (await fetch(`${path}/skills`, { headers })).json()).skills.map(s => s.id), [skillId])
  assert.equal((await fetch(`${path}/messages`, { method: 'POST', headers, body: JSON.stringify({ message: '分析', skillId }) })).status, 202)
  await settled(store, task.taskId)
  for (const body of [{ message: '分析', skillId: 3 }, { message: '分析', skillId, extra: 1 }, { skillId }]) assert.equal((await fetch(`${path}/messages`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400)
  assert.equal((await fetch(`${path}/messages`, { method: 'POST', headers, body: JSON.stringify({ message: '分析', skillId: 'nope-skill' }) })).status, 409)
})

test('the "/" menu: Skills plus existing actions, filtered by what is typed', () => {
  const skills = [{ id: skillId, name: '日程冲突分析', description: '核对冲突', available: true }, { id: 'todo-review', name: '待办复盘', description: '', available: false, error: { message: '缺少工具' } }]
  const all = buildCommands({ skills, group: false, paused: false })
  assert.deepEqual(all.map(c => c.id), [`skill:${skillId}`, 'skill:todo-review', 'new-task', 'pane', 'pause', 'new-bot', 'details'])
  assert.equal(all.find(c => c.id === `skill:${skillId}`).disabled, null)
  assert.equal(all.find(c => c.id === 'skill:todo-review').disabled, '缺少工具')
  assert.deepEqual(buildCommands({ skills, group: true, paused: false }).map(c => c.id), ['pane', 'pause', 'new-bot', 'details']) // groups: no Skills, no per-Bot new task
  assert.ok(!buildCommands({ skills: [], group: false, paused: true }).some(c => c.id === 'pause')) // resume lives in Settings only
  assert.deepEqual(matchCommands(all, '/').length, all.length)
  assert.deepEqual(matchCommands(all, '/冲突').map(c => c.id), [`skill:${skillId}`])
  assert.deepEqual(matchCommands(all, '/时间线').map(c => c.id), ['pane'])
  assert.deepEqual(matchCommands(all, '/pause').map(c => c.id), ['pause'])
  assert.deepEqual(matchCommands([...all, { id: 'skill:x', kind: 'skill', label: '另一个', hint: '查看详情', disabled: null }], '/详情').map(c => c.id), ['details', 'skill:x']) // a name match ranks first
  assert.deepEqual(matchCommands(all, '你好'), []) // only a leading "/" opens the menu
  assert.deepEqual(matchCommands(all, '/ 有空格'), [])
})
