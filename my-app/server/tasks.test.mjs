import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { listBots } from './bots.mjs'
import { TaskCard } from './tasks.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-task-test-'))
  const file = join(dir, 'test.sqlite')
  const stores = []
  t.after(async () => {
    for (const store of stores) await store.close()
    await rm(dir, { recursive: true, force: true })
  })
  async function open(extra = {}) {
    const store = await openTaskStore({ file, ...options, ...extra })
    stores.push(store)
    return store
  }
  return { store: await open(), file, open }
}

async function records(harness) {
  return harness.commit(async (tx) => ({
    tasks: (await tx.scanTasks({}, 100)).items,
    conversations: (await tx.scanConversations({}, 100)).items,
  }), context)
}

test('native Task, owned conversation and task-scoped card publish in one commit', async (t) => {
  const { store, file } = await fixture(t)
  const commits = []
  const unsubscribe = store.harness.subscribeCommits((publication) => commits.push(publication))
  t.after(unsubscribe)
  const task = await store.create({ botId: 'chief', title: '本周安排' })
  assert.equal(typeof task.taskId, 'number')
  assert.notEqual(task.taskId, task.conversationId)
  const record = await store.harness.getTask(task.taskId, context)
  assert.equal(record.kind, 'pidot.chat')
  assert.deepEqual(record.state, { status: 'pending', checkpoint: { phase: 'awaitInput' } })
  const card = await store.harness.snapshot(TaskCard, task.taskId, context)
  assert.equal(card.taskId, task.taskId)
  assert.equal(card.conversationId, task.conversationId)
  const created = commits.find((commit) => commit.changes.some((change) => change.type === 'task' && change.value.id === task.taskId))
  assert.ok(created)
  assert.ok(created.changes.some((change) => change.type === 'conversation' && change.value.id === task.conversationId))
  assert.ok(created.changes.some((change) => change.record?.kind === 'pidot.task-card' && change.record.scope.taskId === task.taskId))
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(task.parameters.tools, ['report_blocker'])
  assert.equal(task.parameters.model, null)
  for (const key of Object.keys(task.parameters)) {
    assert.deepEqual(task.parameterSources[key], { type: 'bot-default', configRef: task.configRef })
  }
  assert.equal(task.titleSource, 'user-request')
  assert.equal(task.title, '本周安排')
})

test('a callback failure rolls back Task, card and conversation and permits the next create', async (t) => {
  let fail = true
  let attempted
  const { store } = await fixture(t, { beforeCommit: (ids) => { attempted = ids; if (fail) throw new Error('simulated failure') } })
  const before = await records(store.harness)
  await assert.rejects(store.create({ botId: 'calendar' }), /simulated failure/)
  assert.deepEqual(await records(store.harness), before)
  assert.equal(await store.harness.snapshot(TaskCard, attempted.taskId, context), undefined)
  assert.deepEqual(await store.list(), [])
  fail = false
  assert.equal((await store.create({ botId: 'calendar' })).bot.id, 'calendar')
})

test('SQLite failure inside the commit leaves no partial initial state after reopen', async (t) => {
  const { store, file, open } = await fixture(t)
  const first = await store.create({ botId: 'chief' })
  const before = await records(store.harness)
  const db = new DatabaseSync(file)
  // Fail at the task-card write, after task/conversation writes were staged.
  db.exec("CREATE TRIGGER fail_task_card BEFORE INSERT ON documents WHEN json_extract(NEW.record, '$.kind') = 'pidot.task-card' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END")
  await assert.rejects(store.create({ botId: 'todo' }))
  await store.close()
  db.exec('DROP TRIGGER fail_task_card'); db.close()
  const reopened = await open()
  assert.deepEqual(await records(reopened.harness), before)
  assert.deepEqual((await reopened.list()).map((task) => task.taskId), [first.taskId])
  assert.equal((await reopened.create({ botId: 'todo' })).bot.id, 'todo')
})

test('normal restart preserves directory identity, empty conversation and frozen configuration even when seeds change', async (t) => {
  const { store, open } = await fixture(t)
  const task = await store.create({ botId: 'todo' })
  await store.close()
  const bots = listBots()
  bots[2].configRef.version = 'future-version'
  bots[2].defaults.thinkingLevel = 'high'
  const reopened = await open({ bots })
  assert.deepEqual(await reopened.get(task.taskId), task)
  const entries = await reopened.harness.commit((tx) => tx.scanEntries({ conversationId: task.conversationId }, 100), context)
  assert.equal(entries.items.length, 1)
  assert.equal(entries.items[0].kind, 'pidot.task-state')
  assert.deepEqual(task.messages, [])
  const newer = await reopened.create({ botId: 'todo' })
  assert.equal(newer.configRef.version, task.configRef.version)
  assert.equal(newer.parameters.thinkingLevel, task.parameters.thinkingLevel)
  assert.deepEqual(await reopened.get(task.taskId), task)
  const detached = await reopened.get(task.taskId)
  detached.parameters.model = 'mutated'
  assert.equal((await reopened.get(task.taskId)).parameters.model, null)
})

test('invalid Bot, title or client configuration never creates partial records', async (t) => {
  const { store } = await fixture(t)
  const before = await records(store.harness) // root + one main session per Bot (PLAN §8.1)
  for (const input of [null, [], {}, { botId: 1 }, { botId: 'chief', title: '' }, { botId: 'chief', title: ' ' }, { botId: 'chief', title: 'a'.repeat(101) }, { botId: 'chief', configRef: {} }, { botId: 'chief', taskId: 1 }]) {
    await assert.rejects(store.create(input), { code: 'INVALID_TASK' })
  }
  await assert.rejects(store.create({ botId: 'missing' }), { code: 'BOT_NOT_FOUND' })
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await records(store.harness), before)
  assert.equal(await store.get(123456), undefined)
})

test('concurrent creation and listing beyond one page preserve all distinct Task ids', async (t) => {
  const { store } = await fixture(t)
  const created = await Promise.all(Array.from({ length: 105 }, (_, i) => store.create({ botId: 'chief', title: `会话 ${i}` })))
  const tasks = await store.list()
  assert.equal(tasks.length, 105)
  assert.equal(new Set(tasks.map((task) => task.taskId)).size, 105)
  assert.equal(new Set(tasks.map((task) => task.conversationId)).size, 105)
  assert.deepEqual(tasks.map((task) => task.taskId), created.map((task) => task.taskId).sort((a, b) => b - a))
})

test('enabling Harness scheduling does not complete the long-lived chat or spin and shutdown releases it', { timeout: 5000 }, async (t) => {
  const { store, open } = await fixture(t)
  const task = await store.create({ botId: 'chief' })
  const running = new Promise((resolve) => {
    const off = store.harness.subscribeCommits(({ changes }) => {
      if (changes.some((change) => change.type === 'task' && change.value.id === task.taskId && change.value.state.status === 'running')) { off(); resolve() }
    })
  })
  store.harness.resume()
  await running
  const record = await store.harness.getTask(task.taskId, context)
  assert.equal(record.state.status, 'running')
  await store.close()
  const reopened = await open()
  const restored = await reopened.get(task.taskId)
  assert.equal(restored.taskId, task.taskId)
  assert.notEqual(restored.runtime.status, 'terminal')
  assert.deepEqual(restored.runtime.checkpoint, { phase: 'awaitInput' })
})
