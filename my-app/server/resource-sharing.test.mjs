import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createApiServer } from './app.mjs'
import { openTaskStore } from './tasks.mjs'
import { ToolAccess } from './tools.mjs'
import { applyGoogleAccount } from './google-account.mjs'
import { externalSourceId, registerExternalSource } from './workspace-providers.mjs'
import { externalFixture } from './fixtures/workspace-external.mjs'

async function narrowOverHttp(store, botId, resource) {
  const server = createApiServer({ token: 'r4-resources-token', tasks: store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const { bot, assigned } = await store.getBotConfiguration(botId)
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/${botId}/configuration`, {
      method: 'POST', headers: { authorization: 'Bearer r4-resources-token', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r4-narrow-resource', expectedVersion: bot.configRef.version,
        description: bot.description, tools: assigned.tools, resources: assigned.resources.filter(value => value !== resource) }),
    })
    assert.equal(response.status, 200)
    await response.json()
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

test('R4 Feishu binding shares both resource forms; reconnect restores only non-narrowed schedule Bots', async () => externalFixture(async f => {
  const resource = `workspace:${f.sourceId}`, calendar = await f.store.getBotConfiguration('calendar')
  assert.ok(calendar.assigned.resources.includes(resource))
  assert.ok(calendar.assigned.resources.some(value => value.startsWith('feishu:')))
  assert.ok(!(await f.store.getBotConfiguration('todo')).assigned.resources.includes(resource))
  const { bot } = await f.store.createBot({ name: '另一个日程机器人', requestId: 'r4-resource-other', capabilities: ['tool:todos'] })
  await narrowOverHttp(f.store, 'calendar', resource)
  await f.store.feishuCalendar.manage({ action: 'disconnect', confirm: true })
  await f.store.workspace.externalSources({})
  await f.store.feishuCalendar.manage({ action: 'bind', calendarId: 'isolated-calendar', confirm: true })
  await f.store.workspace.externalSources({})
  assert.ok(!(await f.store.getBotConfiguration('calendar')).assigned.resources.includes(resource))
  assert.ok((await f.store.getBotConfiguration(bot.id)).assigned.resources.includes(resource))
  assert.ok(!(await f.store.getBotConfiguration('todo')).assigned.resources.includes(resource))
}))

test('R4 Google discovery and reconnect share sources while preserving per-Bot narrowing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r4-google-sharing-'))
  const store = await openTaskStore({ file: join(dir, 'tasks.sqlite') })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const sourceId = externalSourceId('google-calendar', 'r4-account', 'primary'), resource = `workspace:${sourceId}`
  const { bot } = await store.createBot({ name: 'Google 日程机器人', requestId: 'r4-google-other', capabilities: ['tool:todos'] })
  const discover = () => store.harness.commit(async tx => {
    await applyGoogleAccount(tx, { status: 'connected', accountKey: 'r4-account', services: ['calendar'] }, { ToolAccess })
    await registerExternalSource(tx, { sourceId, title: '我的日历', accountKey: 'r4-account', authEpoch: 1 })
  }, context)
  await discover()
  assert.ok((await store.getBotConfiguration('calendar')).assigned.resources.includes(resource))
  assert.ok((await store.getBotConfiguration(bot.id)).assigned.resources.includes(resource))
  assert.ok(!(await store.getBotConfiguration('todo')).assigned.resources.includes(resource))
  await narrowOverHttp(store, 'calendar', resource)
  await store.harness.commit(tx => applyGoogleAccount(tx, { status: 'disconnected', services: [] }, { ToolAccess }), context)
  await discover()
  assert.ok(!(await store.getBotConfiguration('calendar')).assigned.resources.includes(resource))
  assert.ok((await store.getBotConfiguration(bot.id)).assigned.resources.includes(resource))
})
