import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRegistry, defineDoc, defineTask, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { MainSessions } from './main-session.mjs'
import { TaskCancellation } from './cancellation.mjs'
import { createSessionLifecycle, isDeleted, resolveCurrentMain } from './session-lifecycle.mjs'
import { createRoutineDelivery } from './routine-delivery.mjs'

const Probe = defineTask({ name: 'pidot.test.routine-delivery', version: 1, initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} } })
const State = defineDoc({ kind: 'pidot.test.routine-delivery-state', version: 1, scope: 'session', initial: () => ({ cards: {}, receipts: {}, messages: [], authorized: true }) })
const copy = value => JSON.parse(JSON.stringify(value))
const outcome = state => ({ state, taskId: undefined, text: 'PRIVATE RESULT MUST NOT BE COPIED' })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-routine-delivery-'))
  let harness
  const open = async () => {
    const registry = createRegistry(); registry.install({ name: 'routine-delivery-test', tasks: [Probe] })
    harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'isolated.sqlite')), { models: createModels(), registry }, context)
  }
  await open()
  t.after(async () => { await harness.close(context); await rm(dir, { recursive: true, force: true }) })
  const transaction = work => harness.commit(work, context)
  const create = async (tx, kind = 'main', botId = 'calendar') => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const taskId = await tx.createTask(Probe, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } })
    const card = { taskId, kind, bot: { id: botId }, conversationId: conversation.id, title: '原始运行', ...(kind !== 'main' ? { scheduledWorkflow: { occurrenceId: 'occurrence-1', scheduleId: 'schedule-1', sourceIds: ['local'] } } : {}) }
    ;(await tx.doc(State)).cards[taskId] = card
    return card
  }
  const main = await transaction(async tx => { const card = await create(tx); (await tx.doc(MainSessions)).byBot.calendar = card.taskId; return card })
  const child = await transaction(tx => create(tx, 'task'))
  const readCard = async (tx, taskId) => (await tx.doc(State)).cards[taskId]
  const hooks = {
    readCard,
    canDeliver: async tx => (await tx.doc(State)).authorized,
    readReceipt: async (tx, key) => (await tx.doc(State)).receipts[key],
    writeReceipt: async (tx, key, receipt) => { (await tx.doc(State)).receipts[key] = receipt },
    appendMirror: async (tx, conversationId, data) => {
      const entry = await tx.appendEntry(conversationId, { kind: 'pidot.mirror', data })
      ;(await tx.doc(State)).messages.push({ entryId: entry.id, conversationId, data })
      return entry
    },
    now: () => '2026-10-29T12:00:00.000Z',
  }
  const delivery = createRoutineDelivery(hooks)
  const occurrence = { id: 'occurrence-1', scheduleId: 'schedule-1', taskId: child.taskId }
  const input = (state = 'succeeded', overrides = {}) => ({ botId: 'calendar', occurrence, result: outcome(state), ...overrides })
  const stop = id => transaction(async tx => { (await tx.doc(TaskCancellation, id)).request = { source: 'test-clear', requestedAt: '2026-10-29T12:00:00Z' } })
  const lifecycle = createSessionLifecycle({ transaction, readSession: readCard, stopSession: stop, stopMain: stop,
    createMain: async (tx, old) => (await create(tx, 'main', old.bot.id)).taskId, now: hooks.now })
  return { transaction, main, child, input, hooks, delivery, lifecycle, occurrence, create,
    state: () => transaction(async tx => copy(await tx.doc(State))),
    restart: async () => { await harness.close(context); await open() } }
}

test('R1-07 real 03 clear before result delivers to new current main, never cached mainParent', async t => {
  const f = await fixture(t)
  await f.transaction(async tx => { (await tx.doc(State)).cards[f.child.taskId].mainParent = { mainTaskId: f.main.taskId, mainConversationId: f.main.conversationId } })
  const cleared = await f.lifecycle.clearMainSession(f.main.taskId, { requestId: 'clear-before-result', confirmed: true })
  assert.notEqual(cleared.replacementTaskId, f.main.taskId)
  const receipt = await f.transaction(tx => f.delivery.deliver(tx, f.input()))
  assert.equal(receipt.mainTaskId, cleared.replacementTaskId)
  assert.equal(receipt.delivered, true)
  assert.equal(receipt.userReceived, 'unknown')
  const state = await f.state()
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].conversationId, state.cards[cleared.replacementTaskId].conversationId)
  assert.doesNotMatch(JSON.stringify(state.messages), /PRIVATE RESULT|mainConversationId/)
  assert.equal(state.cards[f.child.taskId].bot.id, 'calendar')
})

test('R1-07 duplicate calls and restart persist one mirror; clearing after delivery never resurrects old result', async t => {
  const f = await fixture(t)
  const first = await f.transaction(tx => f.delivery.deliver(tx, f.input()))
  assert.equal((await f.transaction(tx => f.delivery.deliver(tx, f.input()))).replayed, true)
  await f.restart()
  const delivery = createRoutineDelivery(f.hooks)
  assert.equal((await f.transaction(tx => delivery.deliver(tx, f.input()))).entryId, first.entryId)
  const cleared = await f.lifecycle.clearMainSession(f.main.taskId, { requestId: 'clear-after-result', confirmed: true })
  const after = await f.transaction(tx => delivery.deliver(tx, f.input()))
  assert.equal(after.replayed, true)
  assert.equal(after.mainTaskId, f.main.taskId)
  assert.notEqual(after.mainTaskId, cleared.replacementTaskId)
  assert.equal((await f.state()).messages.length, 1)
})

test('R1-07 current authorization revoked before delivery or replay denies with no new mirror', async t => {
  const f = await fixture(t)
  await f.transaction(async tx => { (await tx.doc(State)).authorized = false })
  assert.deepEqual(await f.transaction(tx => f.delivery.deliver(tx, f.input())), { delivered: false, state: 'suppressed', reason: 'authorization_revoked' })
  assert.equal((await f.state()).messages.length, 0)
  await f.transaction(async tx => { (await tx.doc(State)).authorized = true })
  await f.transaction(tx => f.delivery.deliver(tx, f.input()))
  await f.transaction(async tx => { (await tx.doc(State)).authorized = false })
  assert.equal((await f.transaction(tx => f.delivery.deliver(tx, f.input()))).delivered, false)
  assert.equal((await f.state()).messages.length, 1)
})

test('R1-07 original run Bot binding is immutable even if edited plan targets another Bot', async t => {
  const f = await fixture(t)
  await assert.rejects(f.transaction(tx => f.delivery.deliver(tx, f.input('succeeded', { botId: 'todo' }))), { code: 'ROUTINE_DELIVERY_BINDING' })
  await assert.rejects(f.transaction(tx => f.delivery.deliver(tx, f.input('succeeded', { occurrence: { ...f.occurrence, scheduleId: 'changed-plan' } }))), { code: 'ROUTINE_DELIVERY_BINDING' })
  assert.equal((await f.state()).messages.length, 0)
  assert.equal((await f.transaction(tx => f.delivery.deliver(tx, f.input()))).botId, 'calendar')
})

test('R1-07 deleted source and absent/deleted current main suppress; no fake success receipt', async t => {
  const f = await fixture(t)
  await f.transaction(async tx => { delete (await tx.doc(MainSessions)).byBot.calendar })
  assert.equal((await f.transaction(tx => f.delivery.deliver(tx, f.input()))).reason, 'current_main_unavailable')
  await f.transaction(async tx => { (await tx.doc(MainSessions)).byBot.calendar = f.main.taskId })
  await f.lifecycle.deleteSession(f.child.taskId, { requestId: 'delete-run-source', confirmed: true })
  assert.equal(await f.transaction(tx => isDeleted(tx, f.child.taskId)), true)
  assert.equal((await f.transaction(tx => f.delivery.deliver(tx, f.input()))).reason, 'source_deleted')
  assert.equal((await f.state()).messages.length, 0)
  assert.deepEqual((await f.state()).receipts, {})
})

test('R1-07 waiting/ask and unknown are truthful non-success mirrors; final settlement has separate state dedupe', async t => {
  const f = await fixture(t)
  for (const state of ['waiting', 'unknown', 'succeeded']) {
    await f.transaction(tx => f.delivery.deliver(tx, f.input(state)))
    await f.transaction(tx => f.delivery.deliver(tx, f.input(state)))
  }
  const messages = (await f.state()).messages
  assert.equal(messages.length, 3)
  assert.deepEqual(messages.map(item => item.data.outcome), ['limited', 'unknown', 'succeeded'])
  assert.match(messages[0].data.summary, /尚未完成/)
  assert.match(messages[1].data.summary, /结果未知/)
  assert.ok(messages.every(item => !item.data.result && !item.data.approvalId))
})

test('R1-07 test runs and second live permission check never emit unauthorized mirror', async t => {
  const f = await fixture(t)
  assert.equal((await f.transaction(tx => f.delivery.deliver(tx, f.input('succeeded', { occurrence: { ...f.occurrence, test: true } })))).reason, 'test_run')
  let checks = 0
  const delivery = createRoutineDelivery({ ...f.hooks, canDeliver: async () => ++checks === 1 })
  assert.equal((await f.transaction(tx => delivery.deliver(tx, f.input()))).reason, 'authorization_revoked')
  assert.equal((await f.state()).messages.length, 0)
})

test('R1-07 a main mapping change during preflight refuses stale destination', async t => {
  const f = await fixture(t)
  let reads = 0
  const delivery = createRoutineDelivery({ ...f.hooks, currentMain: async (tx, botId) => ++reads === 1 ? resolveCurrentMain(tx, botId) : null })
  assert.equal((await f.transaction(tx => delivery.deliver(tx, f.input()))).reason, 'session_changed')
  assert.equal((await f.state()).messages.length, 0)
})

test('R1-07 atomic receipt failure rolls back append; retry creates exactly one durable mirror', async t => {
  const f = await fixture(t)
  const broken = createRoutineDelivery({ ...f.hooks, writeReceipt: async () => { throw new Error('receipt failed') } })
  await assert.rejects(f.transaction(tx => broken.deliver(tx, f.input())), /receipt failed/)
  assert.equal((await f.state()).messages.length, 0)
  await f.transaction(tx => f.delivery.deliver(tx, f.input()))
  assert.equal((await f.state()).messages.length, 1)
})
