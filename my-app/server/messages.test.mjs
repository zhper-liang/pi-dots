import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { createTestReply } from './test-reply.mjs'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-messages-'))
  const file = join(dir, 'test.sqlite')
  const stores = []
  async function open(extra = {}) { const store = await openTaskStore({ file, ...options, ...extra }); stores.push(store); return store }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store: await open(), open }
}
async function settled(store, id) {
  for (let i = 0; i < 150; i++) {
    const task = await store.get(id)
    if (!task.activeInputId) return task
    if (task.runtime.status === 'terminal') throw new Error(JSON.stringify(await store.harness.inspect({})))
    await delay(10)
  }
  assert.fail('Reply did not settle')
}

test('two turns use the original Task and conversation, survive reopen and retain frozen config', async (t) => {
  const { store, open } = await fixture(t)
  const task = await store.create({ botId: 'chief' })
  await store.send(task.taskId, '第一条\n你好')
  let result = await settled(store, task.taskId)
  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[1].content, createTestReply('第一条\n你好').reply.content)
  assert.equal(result.messages[1].byTaskId, task.taskId)
  assert.notEqual(result.runtime.status, 'terminal')
  await store.close()
  const reopened = await open()
  assert.deepEqual((await reopened.get(task.taskId)).messages, result.messages)
  await reopened.send(task.taskId, '第二条')
  result = await settled(reopened, task.taskId)
  assert.deepEqual(result.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(result.conversationId, task.conversationId)
  assert.deepEqual(result.configRef, task.configRef)
  assert.deepEqual(result.parameters, task.parameters)
  assert.ok(result.messages.every((m) => m.taskId === task.taskId && m.conversationId === task.conversationId))
})

test('busy input is queued; execution failure is durable, redacted and advances the next turn', async (t) => {
  let release
  let calls = 0
  const { store, open } = await fixture(t, { reply: async (message) => {
    if (++calls === 1) { await new Promise((resolve) => { release = resolve }); throw new Error('secret credential') }
    return createTestReply(message)
  } })
  const task = await store.create({ botId: 'todo' })
  await store.send(task.taskId, 'fail')
  while (!release) await delay(5)
  try {
    assert.equal((await store.send(task.taskId, 'busy')).status, 'queued')
    assert.equal((await store.get(task.taskId)).messages.length, 2)
  } finally { release() }
  let result = await settled(store, task.taskId)
  assert.equal(result.messages.find((m) => m.role === 'error').errorCode, 'TEST_FAILED')
  assert.deepEqual(result.messages.filter((m) => m.role === 'user').map((m) => m.deliveryStatus), ['failed', 'completed'])
  assert.equal(result.runtime.checkpoint.lastOutcome, 'completed')
  assert.ok(!JSON.stringify(result).includes('secret'))
  await store.close()
  const reopened = await open()
  await reopened.send(task.taskId, 'retry')
  result = await settled(reopened, task.taskId)
  assert.equal(result.messages.length, 6)
  assert.equal(result.messages[5].role, 'assistant')
})

test('simultaneous input is serialized without loss, histories are isolated and pagination preserves order', async (t) => {
  const { store } = await fixture(t)
  const a = await store.create({ botId: 'calendar' })
  const b = await store.create({ botId: 'todo' })
  const attempts = await Promise.allSettled([store.send(a.taskId, 'one'), store.send(a.taskId, 'two')])
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 2)
  await settled(store, a.taskId)
  for (let i = 0; i < 50; i++) { await store.send(a.taskId, `round-${i}`); await settled(store, a.taskId) }
  const result = await store.get(a.taskId)
  assert.equal(result.messages.length, 104)
  assert.deepEqual(result.messages.map((m) => m.id), result.messages.map((m) => m.id).sort((a, b) => a - b))
  assert.deepEqual((await store.get(b.taskId)).messages, [])
  assert.equal(result.messages.at(-2).content, 'round-49')
})

test('iss2 preset remains frozen when an old empty chat starts test messaging', async (t) => {
  const { listBots } = await import('./bots.mjs')
  const oldBots = listBots().map((bot) => ({ ...bot, configRef: { botId: bot.id, version: '2026-10-16.v1' }, defaults: { ...bot.defaults, mode: 'empty' } }))
  const { store, open } = await fixture(t, { bots: oldBots })
  const old = await store.create({ botId: 'chief' })
  await store.close()
  const next = await open({ bots: listBots() })
  await next.send(old.taskId, '兼容旧会话')
  const current = await settled(next, old.taskId)
  assert.deepEqual(current.configRef, old.configRef)
  assert.deepEqual(current.parameters, old.parameters)
  assert.equal(current.messages[1].mode, 'test')
  assert.equal((await next.create({ botId: 'chief' })).parameters.mode, 'empty')
})

test('input entry and slot admission roll back together on SQLite failure', async (t) => {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-input-rollback-'))
  const file = join(dir, 'test.sqlite')
  let store = await openTaskStore({ file })
  const db = new DatabaseSync(file)
  t.after(async () => { db.close(); await store.close(); await rm(dir, { recursive: true, force: true }) })
  const task = await store.create({ botId: 'chief' })
  db.exec("CREATE TRIGGER fail_user BEFORE INSERT ON entries WHEN json_extract(NEW.record, '$.kind') = 'pidot.user' BEGIN SELECT RAISE(ABORT, 'disk fail'); END")
  await assert.rejects(store.send(task.taskId, 'not saved'))
  db.exec('DROP TRIGGER fail_user')
  await store.close()
  store = await openTaskStore({ file })
  assert.equal((await store.get(task.taskId)).activeInputId, null)
  assert.deepEqual((await store.get(task.taskId)).messages, [])
  await store.send(task.taskId, 'saved')
  assert.equal((await settled(store, task.taskId)).messages.length, 2)
})
