import test from 'node:test'
import assert from 'node:assert/strict'
import { botTabs, readBotTab, botDetailHash, directoryBots } from './bot-directory.mjs'

test('机器人设置只有能力、记忆、设置三栏，默认打开对话', () => {
  assert.deepEqual(botTabs, [
    { id: 'capabilities', label: '能力' },
    { id: 'memory', label: '记忆' },
    { id: 'settings', label: '设置' },
  ])
  for (const tab of botTabs) assert.equal(readBotTab(botDetailHash('chief', tab.id)), tab.id)
  for (const hash of ['#bot=chief', '#bot=chief&tab=rules', '']) assert.equal(readBotTab(hash), 'chat')
  assert.equal(botDetailHash('x'), '#bot=x')
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
