import test from 'node:test'
import assert from 'node:assert/strict'
import { botTabs, readBotTab, botDetailHash, tasksForBot, directoryBots } from './bot-directory.mjs'

test('Bot detail has the seven required tabs; old hashes still open its conversation', () => {
  assert.deepEqual(botTabs.map(tab => tab.id), ['chat', 'rules', 'skills', 'mcp', 'memory', 'settings', 'tasks'])
  assert.equal(botTabs.find(tab => tab.id === 'rules').label, '工具')
  assert.equal(readBotTab('#bot=chief&tab=rules'), 'rules')
  for (const hash of ['#bot=chief', '#bot=chief&tab=unknown', '']) assert.equal(readBotTab(hash), 'chat')
  for (const tab of botTabs) assert.equal(readBotTab(botDetailHash('bot:a & b', tab.id)), tab.id)
  assert.equal(new URLSearchParams(botDetailHash('bot:a & b').slice(1)).get('bot'), 'bot:a & b')
})
test('Bot tasks match immutable bot.id, preserve history and never absorb main or group conversations', () => {
  const tasks = [
    { taskId: 1, bot: { id: 'a', name: 'old' }, archived: true },
    { taskId: 2, bot: { id: 'b', name: 'same' } },
    { taskId: 3, bot: { id: 'a', name: 'same' }, kind: 'group' },
    { taskId: 4, bot: { id: 'a' }, kind: 'main' },
    { taskId: 5, bot: { id: 'a', status: 'inactive' }, kind: 'chat' },
    { taskId: 6 },
  ]
  assert.deepEqual(tasksForBot(tasks, 'a').map(task => task.taskId), [1, 5])
  assert.equal(tasksForBot(tasks, 'a')[0], tasks[0])
  assert.equal(tasks.length, 6)
})
test('Bot directory searches name/duties without hiding inactive Bots or mutating catalog order', () => {
  const bots = [{ id: 'a', name: 'Chief', description: '主管' }, { id: 'b', name: '日程', description: '安排会议', status: 'inactive' }]
  assert.deepEqual(directoryBots(bots, ' chief '), [bots[0]])
  assert.deepEqual(directoryBots(bots, '会议'), [bots[1]])
  assert.deepEqual(directoryBots(bots), bots)
  assert.deepEqual(directoryBots(bots, 'nothing'), [])
})

test('Scoped MCP view includes its inactive Bot and no other client credentials; global view excludes inactive issuers', async () => {
  const { credentialBots, credentialClients } = await import('./bot-directory.mjs')
  const bots = [{ id: 'a', status: 'inactive' }, { id: 'b', status: 'active' }]
  const clients = [{ clientId: 'one', botId: 'a' }, { clientId: 'two', botId: 'b' }]
  assert.deepEqual(credentialBots(bots, 'a'), [bots[0]])
  assert.deepEqual(credentialBots(bots), [bots[1]])
  assert.deepEqual(credentialBots(bots, 'missing'), [])
  assert.deepEqual(credentialClients(clients, 'a'), [clients[0]])
  assert.deepEqual(credentialClients(clients), clients)
})
test('Bot Skills keep every registered item and the real Task dependency failure, never guess availability', async () => {
  const { mergeBotSkills } = await import('./bot-directory.mjs')
  const catalog = [{ id: 'a', available: true }, { id: 'b', available: true }, { id: 'c', available: false, error: { code: 'SKILL_LOAD_FAILED', message: '清单无法读取' } }]
  const error = { code: 'SKILL_DEPENDENCY_MISSING', message: '缺少依赖', missing: ['workspace.list', 'workspace:local'] }
  const merged = mergeBotSkills(catalog, [{ id: 'a', available: false, error }], true)
  assert.deepEqual(merged.map(skill => skill.id), ['a', 'b', 'c'])
  assert.deepEqual(merged[0].error, error)
  assert.equal(merged[1].available, false)
  assert.match(merged[1].error.message, /未返回/)
  assert.equal(merged[2].error.code, 'SKILL_LOAD_FAILED')
  assert.match(mergeBotSkills(catalog, [], false)[0].error.message, /尚无主会话/)
  assert.equal(catalog[0].available, true)
})
test('Current Task availability supersedes stale global Skill errors without carrying a misleading reason', async () => {
  const { mergeBotSkills } = await import('./bot-directory.mjs')
  assert.deepEqual(mergeBotSkills([{ id: 'a', name: '技能', available: false, error: { code: 'OLD', message: '旧错误' } }], [{ id: 'a', available: true }], true), [{ id: 'a', name: '技能', available: true }])
})
