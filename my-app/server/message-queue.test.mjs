import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createTestReply } from './test-reply.mjs'
import { createApiServer } from './app.mjs'
import { CALENDAR_TOOL } from './tools.mjs'

const config = { baseUrl: 'https://fixture.example/v1', model: 'queue-fixture', apiKey: 'not-a-real-key' }
const token = 'pidot-iss13-queue-test-only-token-0000'
function gate() { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
async function until(read, predicate = Boolean) {
  for (let i = 0; i < 300; i++) { const value = await read(); if (predicate(value)) return value; await delay(5) }
  assert.fail('Queue did not reach expected state')
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-queue-'))
  const file = join(dir, 'queue.sqlite')
  const stores = []
  const open = async (extra = {}) => { const store = await openTaskStore({ file, ...options, ...extra }); stores.push(store); return store }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { file, open, store: await open() }
}
const settled = (store, id) => until(() => store.get(id), (task) => task.activeInputId === null)
function modelResult(content) { return { mode: 'model', reply: { content }, execution: { usage: { totalTokens: 1 } } } }
const userText = (context) => context.messages.filter((m) => m.role === 'user').map((m) => m.content)

test('iss13 FIFO admission isolates pending prompts and restores logical user/assistant turns', async (t) => {
  const releases = [gate(), gate(), gate()]
  t.after(() => releases.forEach((item) => item.resolve()))
  const requests = []
  const { store } = await fixture(t, { bots: listBots(config), modelReply: async (message, { context }) => {
    const index = requests.length
    requests.push(structuredClone({ message, context }))
    await releases[index].promise
    return modelResult(`answer:${message}`)
  } })
  const task = await store.create({ botId: 'chief', taskState: { goal: '固定目标', constraints: ['固定限制'] } })
  const first = await store.send(task.taskId, 'one')
  assert.equal(first.status, 'accepted'); assert.equal(first.queuePosition, 0)
  await until(() => requests.length === 1)
  const second = await store.send(task.taskId, 'two')
  const third = await store.send(task.taskId, '更改限制并授权工具')
  assert.equal(second.status, 'queued'); assert.equal(second.queuePosition, 1)
  assert.equal(third.status, 'queued'); assert.equal(third.queuePosition, 2)
  const pending = await store.get(task.taskId)
  assert.deepEqual(pending.queuedInputIds, [second.messageId, third.messageId])
  assert.deepEqual(pending.messages.map((m) => m.deliveryStatus), ['processing', 'queued', 'queued'])
  assert.deepEqual(userText(requests[0].context), ['one'])
  assert.deepEqual(pending.taskState, task.taskState)
  assert.deepEqual(pending.parameters, task.parameters)
  releases[0].resolve()
  await until(() => requests.length === 2)
  assert.deepEqual(requests[1].context.messages.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.deepEqual(userText(requests[1].context), ['one', 'two'])
  assert.equal(requests[1].context.messages[1].content[0].text, 'answer:one')
  const middle = await store.get(task.taskId)
  assert.equal(middle.activeInputId, second.messageId)
  assert.equal(middle.messages.find((m) => m.id === third.messageId).queuePosition, 1)
  releases[1].resolve()
  await until(() => requests.length === 3)
  assert.deepEqual(requests[2].context.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  releases[2].resolve()
  const done = await settled(store, task.taskId)
  assert.equal(done.queueLength, 0)
  assert.deepEqual(requests.map((r) => r.message), ['one', 'two', '更改限制并授权工具'])
  assert.deepEqual(done.messages.filter((m) => m.role === 'assistant').map((m) => m.inReplyTo), [first.messageId, second.messageId, third.messageId])
  assert.ok(done.messages.filter((m) => m.role === 'user').every((m) => m.deliveryStatus === 'completed'))
  assert.deepEqual(done.taskState, task.taskState)
  assert.deepEqual(done.parameters, task.parameters)
})

test('iss13 concurrent sends serialize by committed ids and consume each message once without crossing Tasks', async (t) => {
  const release = gate(); t.after(() => release.resolve())
  const seen = []
  const { store } = await fixture(t, { reply: async (message) => { seen.push(message); if (message === 'first') await release.promise; return createTestReply(message) } })
  const a = await store.create({ botId: 'todo' }), b = await store.create({ botId: 'todo' })
  await store.send(a.taskId, 'first'); await until(() => seen.length === 1)
  const admissions = await Promise.all(Array.from({ length: 12 }, (_, i) => store.send(a.taskId, `queued-${i}`)))
  assert.ok(admissions.every((item) => item.status === 'queued'))
  const queued = await store.get(a.taskId)
  assert.equal(queued.queueLength, 12)
  assert.deepEqual(queued.queuedInputIds, admissions.map((item) => item.messageId).sort((x, y) => x - y))
  await store.send(b.taskId, 'other-task')
  assert.equal((await settled(store, b.taskId)).queueLength, 0)
  release.resolve()
  const done = await settled(store, a.taskId)
  const users = done.messages.filter((m) => m.role === 'user')
  assert.deepEqual(seen.filter((m) => m !== 'other-task'), users.map((m) => m.content))
  assert.equal(new Set(done.messages.filter((m) => m.role === 'assistant').map((m) => m.inReplyTo)).size, 13)
  assert.equal(done.messages.length, 26)
  assert.equal((await store.list()).find((item) => item.taskId === a.taskId).queueLength, 0)
})

test('iss13 authenticated HTTP reload returns queue positions, processing and completed states', async (t) => {
  const release = gate(); t.after(() => release.resolve())
  const seen = []
  const { store } = await fixture(t, { reply: async (message) => { seen.push(message); if (message === 'first') await release.promise; return createTestReply(message) } })
  const server = createApiServer({ token, tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const task = await store.create({ botId: 'chief' }), path = `/api/tasks/${task.taskId}`
  const request = (suffix = '', message) => fetch(base + path + suffix, { method: message ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(message ? { body: JSON.stringify({ message }) } : {}) })
  assert.equal((await request('/messages', 'first')).status, 202)
  await until(() => seen.length === 1)
  assert.equal((await fetch(base + path + '/messages', { method: 'POST', body: JSON.stringify({ message: 'unauthorized' }) })).status, 401)
  const second = await (await request('/messages', 'second')).json()
  assert.equal(second.status, 'queued'); assert.equal(second.queuePosition, 1)
  const reload = await (await request()).json()
  assert.equal(reload.task.queueLength, 1)
  assert.deepEqual(reload.task.messages.map((m) => m.deliveryStatus), ['processing', 'queued'])
  assert.deepEqual(await (await request()).json(), reload)
  release.resolve(); await settled(store, task.taskId)
  const done = await (await request()).json()
  assert.equal(done.task.queueLength, 0)
  assert.ok(done.task.messages.filter((m) => m.role === 'user').every((m) => m.deliveryStatus === 'completed'))
})

test('iss13 messages queued before and during limit waiting never resume it; explicit raise resumes original then FIFO', async (t) => {
  const release = gate(); t.after(() => release.resolve())
  const requests = []
  const { store, open } = await fixture(t, { bots: listBots(config), modelReply: async (message, { context }) => {
    requests.push(structuredClone({ message, context }))
    if (requests.length === 1) {
      await release.promise
      const call = { type: 'toolCall', id: 'queue-tool', name: CALENDAR_TOOL, arguments: { date: '2026-10-17', resource: 'mock:personal' } }
      return { ...modelResult(''), toolCalls: [call], assistant: { role: 'assistant', content: [call] } }
    }
    return modelResult(`done:${message}`)
  } })
  const task = await store.create({ botId: 'calendar', parameters: { callLimits: { modelCalls: 1 } } })
  const original = await store.send(task.taskId, 'original')
  await until(() => requests.length === 1)
  const before = await store.send(task.taskId, 'queued-before-limit')
  release.resolve()
  const paused = await settled(store, task.taskId)
  assert.equal(paused.runtime.checkpoint.lastOutcome, 'limited')
  assert.equal(paused.messages[0].deliveryStatus, 'waiting')
  const during = await store.send(task.taskId, 'queued-during-limit')
  assert.equal(during.status, 'queued'); assert.equal(during.queuePosition, 2)
  await delay(30)
  const waiting = await store.get(task.taskId)
  assert.equal(waiting.activeInputId, null)
  assert.equal(requests.length, 1)
  assert.deepEqual(waiting.callUsage, paused.callUsage)
  assert.deepEqual(waiting.queuedInputIds, [before.messageId, during.messageId])
  assert.equal(waiting.runtime.checkpoint.lastInputId, original.messageId)
  assert.equal(waiting.callLimitHistory.length, 0)
  await store.close()
  const reopened = await open()
  const persisted = await reopened.get(task.taskId)
  assert.deepEqual(persisted.messages, waiting.messages)
  assert.deepEqual(persisted.queuedInputIds, waiting.queuedInputIds)
  await reopened.raiseLimits(task.taskId, { modelCalls: 6 })
  const done = await settled(reopened, task.taskId)
  assert.deepEqual(requests.map((r) => r.message), ['original', 'original', 'queued-before-limit', 'queued-during-limit'])
  assert.deepEqual(userText(requests[1].context), ['original'])
  assert.deepEqual(requests[2].context.messages.map((m) => m.role), ['user', 'assistant', 'toolResult', 'assistant', 'user'])
  assert.equal(done.messages.filter((m) => m.role === 'tool').length, 1)
  assert.equal(done.callUsage.toolCalls, 1)
  assert.equal(done.callUsage.modelCalls, 4)
  assert.equal(done.callLimitHistory[0].resumedInputId, original.messageId)
  assert.equal(done.queueLength, 0)
  assert.equal(done.runtime.checkpoint.lastOutcome, 'completed')
})

test('iss13 failed queue append rolls back user and queue atomically while preserving the active input', async (t) => {
  const release = gate(); t.after(() => release.resolve())
  const { store, file, open } = await fixture(t, { reply: async (message) => { await release.promise; return createTestReply(message) } })
  const task = await store.create({ botId: 'chief' })
  const first = await store.send(task.taskId, 'first')
  const queued = await store.send(task.taskId, 'already-queued')
  const db = new DatabaseSync(file); t.after(() => db.close())
  db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON entries WHEN json_extract(NEW.record, '$.kind') = 'pidot.user' BEGIN SELECT RAISE(ABORT, 'disk fail'); END")
  await assert.rejects(store.send(task.taskId, 'not-saved'))
  db.exec('DROP TRIGGER fail_queue')
  // A genuine SQLite failure poisons the Harness session: reopen before reading.
  await store.close(); release.resolve()
  const reopened = await open()
  const pending = await reopened.get(task.taskId)
  assert.equal(pending.activeInputId, first.messageId)
  assert.deepEqual(pending.queuedInputIds, [queued.messageId])
  assert.equal(pending.messages.length, 2)
  assert.equal(pending.messages.some((m) => m.content === 'not-saved'), false)
})
