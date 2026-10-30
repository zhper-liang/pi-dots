import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry, defineDoc, defineTask, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { MainSessions } from './main-session.mjs'
import { TaskCancellation } from './cancellation.mjs'
import { createSessionLifecycle, isDeleted, assertSessionVisible, SessionLifecycle } from './session-lifecycle.mjs'

const Probe = defineTask({ name: 'pidot.test.session-lifecycle', version: 1, initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} } })
const Cards = defineDoc({ kind: 'pidot.test.session-cards', version: 1, scope: 'session', initial: () => ({ items: {} }) })
const input = requestId => ({ requestId, confirmed: true })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-session-lifecycle-'))
  let harness, stopCalls = 0, stopBehavior
  const transaction = fn => harness.commit(fn, context)
  const open = async () => {
    const registry = createRegistry()
    registry.install({ name: 'lifecycle-test', tasks: [Probe] })
    harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'isolated.sqlite')), { models: createModels(), registry }, context)
  }
  await open()
  t.after(async () => { await harness.close(context); await rm(dir, { recursive: true, force: true }) })
  const create = async (tx, kind = 'task', botId = 'chief') => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const taskId = await tx.createTask(Probe, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } })
    const card = { taskId, kind, bot: { id: botId }, conversationId: conversation.id }
    ;(await tx.doc(Cards)).items[taskId] = card
    return card
  }
  const normal = await transaction(tx => create(tx))
  const group = await transaction(tx => create(tx, 'group'))
  const main = await transaction(async tx => {
    const card = await create(tx, 'main')
    ;(await tx.doc(MainSessions)).byBot.chief = card.taskId
    return card
  })
  const child = await transaction(async tx => {
    const card = await create(tx)
    ;(await tx.doc(MainSessions)).children[card.taskId] = { mainTaskId: main.taskId }
    return card
  })
  const stop = async id => {
    stopCalls++
    if (stopBehavior) return stopBehavior(id)
    await transaction(async tx => { (await tx.doc(TaskCancellation, id)).request = { source: 'test-cancel', requestedAt: '2026-10-29T00:00:00Z' } })
    return { ok: true }
  }
  const service = createSessionLifecycle({ transaction, readSession: async (tx, id) => (await tx.doc(Cards)).items[id] ?? null,
    stopSession: stop, stopMain: stop, createMain: async (tx, old) => (await create(tx, 'main', old.bot.id)).taskId,
    now: () => '2026-10-29T00:00:00.000Z' })
  return { service, transaction, normal, group, main, child, create, get stopCalls() { return stopCalls },
    setStop: fn => { stopBehavior = fn },
    markStopped: id => transaction(async tx => { (await tx.doc(TaskCancellation, id)).request = { source: 'test-cancel' } }),
    restart: async () => { await harness.close(context); await open() } }
}

test('ordinary running session is durably stopped before delete; records and audit remain', async t => {
  const f = await fixture(t), result = await f.service.deleteSession(f.normal.taskId, input('delete-normal'))
  assert.equal(result.deleted, true)
  assert.equal(f.stopCalls, 1)
  assert.equal(await f.service.isDeleted(f.normal.taskId), true)
  await assert.rejects(f.transaction(tx => assertSessionVisible(tx, f.normal.taskId)), { code: 'SESSION_DELETED', status: 410 })
  await f.transaction(async tx => {
    assert.ok(await tx.task(f.normal.taskId))
    assert.ok((await tx.doc(Cards)).items[f.normal.taskId])
    assert.ok((await tx.doc(TaskCancellation, f.normal.taskId)).request)
  })
})

test('same request, distinct repeat, concurrent repeat and restart preserve the original receipt', async t => {
  const f = await fixture(t), id = f.normal.taskId
  const [a, b] = await Promise.all([f.service.deleteSession(id, input('delete-repeat')), f.service.deleteSession(id, input('delete-repeat'))])
  assert.equal(a.deletedAt, b.deletedAt)
  assert.equal(b.replayed, true)
  assert.equal(f.stopCalls, 1)
  await f.restart()
  assert.equal(await f.service.isDeleted(id), true)
  assert.equal((await f.service.deleteSession(id, input('delete-repeat'))).replayed, true)
  assert.equal((await f.service.deleteSession(id, input('delete-again'))).deletedAt, a.deletedAt)
  assert.equal(f.stopCalls, 1)
  assert.equal((await f.service.requestStatus('delete-repeat')).state, 'succeeded')
})

test('failed stop keeps session visible and preserves the actual failure', async t => {
  const f = await fixture(t), failure = Object.assign(new Error('adapter failed'), { code: 'STOP_ADAPTER_FAILED' })
  f.setStop(() => { throw failure })
  await assert.rejects(f.service.deleteSession(f.normal.taskId, input('stop-failed')), error => error === failure)
  assert.equal(await f.service.isDeleted(f.normal.taskId), false)
  assert.equal((await f.service.requestStatus('stop-failed')).code, failure.code)
})

for (const response of [{ status: 'unknown' }, { ok: false }, undefined, { ok: true }]) {
  test(`unconfirmed stop ${JSON.stringify(response)} never becomes successful deletion`, async t => {
    const f = await fixture(t)
    f.setStop(() => response)
    await assert.rejects(f.service.deleteSession(f.normal.taskId, input('unconfirmed')), { code: response?.ok === false ? 'SESSION_STOP_FAILED' : 'SESSION_STOP_UNKNOWN' })
    assert.equal(await f.service.isDeleted(f.normal.taskId), false)
  })
}

test('unknown after durable stop stays visible until same-request verification, including restart', async t => {
  const f = await fixture(t), id = f.normal.taskId
  f.setStop(async taskId => { await f.markStopped(taskId); return { status: 'unknown' } })
  await assert.rejects(f.service.deleteSession(id, input('lost-stop')), { code: 'SESSION_STOP_UNKNOWN' })
  assert.equal(await f.service.isDeleted(id), false)
  assert.equal((await f.service.requestStatus('lost-stop')).state, 'unknown')
  await f.restart()
  assert.equal((await f.service.deleteSession(id, input('lost-stop'))).deleted, true)
  assert.equal(f.stopCalls, 1)
})

test('late results remain audit-only and cannot restore deleted state or allow memory extraction', async t => {
  const f = await fixture(t), id = f.normal.taskId
  await f.service.deleteSession(id, input('late-result'))
  await f.transaction(async tx => {
    await tx.appendEntry(f.normal.conversationId, { kind: 'pidot.test.late-receipt', data: { text: 'audit only' } })
    ;(await tx.doc(Cards)).items[id].lateResult = true
  })
  await f.restart()
  assert.equal(await f.transaction(tx => isDeleted(tx, id)), true)
  await assert.rejects(f.transaction(tx => assertSessionVisible(tx, id)), { code: 'SESSION_DELETED' })
})

test('main clear atomically replaces reference and context without deleting Bot/child records', async t => {
  const f = await fixture(t), id = f.main.taskId
  const result = await f.service.clearMainSession(id, input('clear-main'))
  assert.notEqual(result.replacementTaskId, id)
  assert.equal(await f.service.resolveCurrentMain('chief'), result.replacementTaskId)
  assert.equal(await f.service.isDeleted(id), true)
  assert.equal(await f.service.isDeleted(f.child.taskId), false)
  await f.transaction(async tx => {
    const cards = (await tx.doc(Cards)).items
    assert.equal(cards[result.replacementTaskId].bot.id, cards[id].bot.id)
    assert.notEqual(cards[result.replacementTaskId].conversationId, cards[id].conversationId)
    assert.ok(await tx.task(f.child.taskId))
    assert.ok((await tx.doc(MainSessions)).children[f.child.taskId])
  })
  await f.restart()
  assert.equal((await f.service.clearMainSession(id, input('clear-main'))).replacementTaskId, result.replacementTaskId)
  assert.equal(f.stopCalls, 1)
})

test('group deletion does not delete its child; wrong action, missing ID and request reuse are rejected', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.deleteSession(f.main.taskId, input('wrong-main')), { code: 'SESSION_ACTION_CONFLICT' })
  await assert.rejects(f.service.clearMainSession(f.normal.taskId, input('wrong-normal')), { code: 'SESSION_ACTION_CONFLICT' })
  await assert.rejects(f.service.deleteSession(999999, input('missing')), { code: 'TASK_NOT_FOUND' })
  await f.service.deleteSession(f.group.taskId, input('group-delete'))
  assert.equal(await f.service.isDeleted(f.child.taskId), false)
  await assert.rejects(f.service.deleteSession(f.normal.taskId, input('group-delete')), { code: 'SESSION_REQUEST_CONFLICT' })
})

test('unconfirmed inputs and prototype-shaped request IDs cannot bypass idempotency', async t => {
  const f = await fixture(t)
  for (const body of [{}, { requestId: 'x', confirmed: false }, { ...input('x'), extra: true }]) {
    await assert.rejects(f.service.deleteSession(f.normal.taskId, body), { code: 'INVALID_SESSION_DELETE' })
  }
  assert.equal((await f.service.deleteSession(f.normal.taskId, input('__proto__'))).deleted, true)
})

test('failed main creation rolls back replacement and deletion, preserves retryable request', async t => {
  const f = await fixture(t), id = f.main.taskId
  const broken = createSessionLifecycle({ transaction: f.transaction, readSession: async (tx, key) => (await tx.doc(Cards)).items[key],
    stopMain: f.markStopped, createMain: async () => id })
  await assert.rejects(broken.clearMainSession(id, input('invalid-replacement')), { code: 'INVALID_MAIN_REPLACEMENT' })
  assert.equal(await f.service.isDeleted(id), false)
  assert.equal(await f.service.resolveCurrentMain('chief'), id)
  await f.transaction(async tx => { assert.equal((await tx.doc(SessionLifecycle)).requests['request:invalid-replacement'].state, 'failed') })
})
