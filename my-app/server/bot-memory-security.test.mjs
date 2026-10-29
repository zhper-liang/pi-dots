import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry, defineDoc, defineTask, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createBotMemoryService } from './bot-memory.mjs'
import { createBotMemoryRuntime, MemoryExtraction, memorySourceAllowed, parseMemoryExtraction } from './bot-memory-runtime.mjs'

const Probe = defineTask({ name: 'pidot.test.memory-security', version: 1, initial: () => ({ phase: 'idle' }), phases: { idle: async () => {} } })
const Authorization = defineDoc({ kind: 'pidot.test.memory-security-authorization', version: 1, scope: 'session', initial: () => ({ allowed: true }) })
const sourceText = '我偏好使用简洁的中文列表回答'
const response = data => ({ reply: { content: JSON.stringify(data) }, execution: { usage: { totalTokens: 17 } } })
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-memory-security-'))
  let harness, worker, secrets = [], reply = async () => response({ memory: [], preferences: [] }), called = 0, opts
  async function open() {
    const registry = createRegistry()
    registry.install({ name: 'memory-security', tasks: [Probe] })
    harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'isolated.sqlite')), { models: createModels(), registry, settings: { documentRetentionMs: 0 } }, context)
  }
  await open()
  t.after(async () => { await worker?.close(); await harness.close(context); await rm(dir, { recursive: true, force: true }) })
  const transaction = fn => harness.commit(fn, context)
  const batch = await transaction(async tx => {
    const root = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const taskId = await tx.createTask(Probe, {}, { conversationId: root.id, ownership: { kind: 'conversation' } })
    const child = await tx.createConversation({ ownership: { kind: 'task', taskId } })
    const entry = await tx.appendEntry(child.id, { kind: 'pidot.user', data: { role: 'user', content: sourceText } })
    return { card: { taskId, conversationId: child.id, kind: 'main', initiatingUser: 'authenticated-user', bot: { id: 'chief' }, parameters: { mode: 'model', tools: ['workspace.prepare_change'], requestTimeoutMs: 5000 } }, entries: [JSON.parse(JSON.stringify(entry))] }
  })
  const ref = { taskId: batch.card.taskId, entryId: batch.entries[0].id }
  const validate = async tx => (await tx.doc(Authorization)).allowed
  const service = createBotMemoryService({ getSecrets: () => secrets, readEntry: async (tx, source, scope) => {
    if (!await validate(tx) || source.taskId !== ref.taskId || source.entryId !== ref.entryId || scope.botId !== 'chief') return null
    return tx.entry(source.entryId)
  } })
  const createWorker = () => createBotMemoryRuntime({ transaction, service, gather: async () => [batch], validate,
    modelReply: async (_message, options) => { called++; opts = options; return reply(options) }, getSecrets: () => secrets, enabled: true })
  worker = createWorker()
  return { transaction, service, batch, ref, dir, get worker() { return worker }, get called() { return called }, get options() { return opts },
    setReply: value => { reply = value }, setSecrets: value => { secrets = value },
    candidate: (patch, expectedVersion = 0, requestId = randomUUID(), kind = 'preferences') => transaction(tx => service.applyCandidate(tx, { botId: 'chief', kind, expectedVersion, requestId, patches: [patch] })),
    edit: (input, kind = 'preferences') => transaction(tx => service.edit(tx, { botId: 'chief', kind, requestId: randomUUID(), ...input })),
    get: async () => transaction(tx => service.get(tx, 'chief')),
    state: async () => transaction(async tx => JSON.parse(JSON.stringify(await tx.doc(MemoryExtraction)))),
    revoke: async () => transaction(async tx => { (await tx.doc(Authorization)).allowed = false }),
    restore: async () => transaction(async tx => { (await tx.doc(Authorization)).allowed = true }),
    restart: async () => { await worker.close(); await harness.close(context); await open(); worker = createWorker() },
    scan: async values => { for (const name of await readdir(dir)) { const bytes = await readFile(join(dir, name)); for (const value of values) assert.equal(bytes.includes(Buffer.from(value)), false, 'sensitive bytes in isolated SQLite/WAL/SHM') } },
  }
}
const patch = (f, id = 'tone', content = sourceText) => ({ action: 'add', id, content, sourceEntries: [f.ref] })
const extracted = f => response({ memory: [], preferences: [{ content: sourceText, sourceEntries: [f.ref] }] })

test('T11 security: extraction is read-only; model tool proposals cannot replay original tools or mutate documents', async t => {
  const f = await fixture(t)
  f.setReply(async () => ({ ...extracted(f), toolCalls: [{ name: 'workspace.prepare_change', arguments: { action: 'delete' } }] }))
  await f.worker.tick()
  assert.equal(f.called, 1)
  assert.deepEqual(f.options.parameters.tools, [])
  assert.equal(f.options.purpose, 'memory-extraction')
  assert.equal(f.options.parameters.thinkingLevel, 'off')
  assert.equal(f.options.taskId, f.ref.taskId) // attribution only; no original tools or dispatch callback
  assert.deepEqual((await f.get()).preferences.items, [])
  assert.equal((await f.state()).jobs[String(f.ref.taskId)].state, 'pending')
})

test('T11 security: hidden assistant toolCall cannot bypass read-only extraction envelope', async t => {
  const f = await fixture(t)
  f.setReply(async () => ({ ...extracted(f), assistant: { role: 'assistant', content: [{ type: 'toolCall', id: 'hidden', name: 'workspace.prepare_change', arguments: {} }] } }))
  await f.worker.tick()
  assert.deepEqual((await f.get()).preferences.items, [])
  assert.equal((await f.state()).jobs[String(f.ref.taskId)].state, 'pending')
})

test('T11 security: real source ID is not evidence for an invented factual claim', async t => {
  const f = await fixture(t)
  f.setReply(async () => response({ preferences: [], memory: [{ content: '用户是居住在火星的心脏外科医生', sourceEntries: [f.ref] }] }))
  await f.worker.tick()
  assert.deepEqual((await f.get()).memory.items, [])
  assert.equal((await f.get()).memory.status.state, 'pending')
})

test('T11 security: unauthenticated, assistant/external, directed and forked inputs cannot become shared preferences', () => {
  const card = { taskId: 1, conversationId: 2, kind: 'main', bot: { id: 'chief' }, initiatingUser: 'authenticated-user' }
  const entry = { id: 3, conversationId: 2, kind: 'pidot.user', data: { role: 'user', content: sourceText } }
  assert.equal(memorySourceAllowed(card, entry), true)
  for (const changed of [{ initiatingUser: 'forged-user' }, { initiatingUser: undefined }, { kind: 'group' }, { mainParent: { taskId: 99 } }, { forkSource: { taskId: 99 } }, { origin: 'routine' }]) {
    assert.equal(memorySourceAllowed({ ...card, ...changed }, entry), false, `source card boundary: ${Object.keys(changed).join(',')}`)
  }
  for (const changed of [{ kind: 'pidot.tool-result' }, { data: { role: 'assistant', content: sourceText } }, { data: { role: 'user', content: sourceText, source: 'external' } }, { data: { role: 'user', content: sourceText, targetBotIds: ['todo'] } }]) {
    assert.equal(memorySourceAllowed(card, { ...entry, ...changed }), false, `source entry boundary: ${JSON.stringify(changed)}`)
  }
})

test('T11 security: authorization revoked while extraction is in flight invalidates result before either document write', async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  f.setReply(async () => { entered.release(); await release.promise; return extracted(f) })
  const running = f.worker.tick()
  await entered.promise
  await f.revoke()
  release.release()
  await running
  const docs = await f.get()
  assert.deepEqual(docs.preferences.items, [])
  assert.deepEqual(docs.memory.items, [])
  assert.equal(docs.preferences.version, 0)
  assert.equal((await f.state()).calls, 1)
})

test('T11 security: credential rotation during extraction rejects newly-secret output without saving credentials or provider errors', async t => {
  const f = await fixture(t), entered = gate(), release = gate(), secret = `new-${randomUUID()}`
  f.setReply(async () => { entered.release(); await release.promise; return response({ preferences: [{ content: secret, sourceEntries: [f.ref] }] }) })
  const running = f.worker.tick()
  await entered.promise
  f.setSecrets([secret])
  release.release()
  await running
  assert.deepEqual((await f.get()).preferences.items, [])
  assert.equal((await f.state()).jobs[String(f.ref.taskId)].state, 'pending')
  await f.scan([secret])
})

test('T11 security: a credential-bearing source never reaches the extractor or durable pending-job payload', async t => {
  const f = await fixture(t), secret = `source-${randomUUID()}`
  f.batch.entries[0].data.content = `我的凭证是 ${secret}`
  f.setSecrets([secret])
  await f.worker.tick()
  assert.equal(f.called, 0)
  assert.equal((await f.state()).calls, 0)
  await f.scan([secret])
})

test('T11 security: persisted pending job restart must not charge or invoke the same extraction twice', async t => {
  const f = await fixture(t)
  f.setReply(async () => { throw new Error('simulated transport interrupted') })
  await f.worker.tick()
  const before = await f.state()
  assert.equal(before.calls, 1)
  assert.equal(before.jobs[String(f.ref.taskId)].state, 'pending')
  await f.restart()
  await f.worker.tick()
  const after = await f.state()
  assert.equal(after.calls, before.calls, 'same reserved signature cannot spend a second model call after restart')
  assert.equal(after.reservedTokens, before.reservedTokens)
  assert.equal(f.called, 1)
})

test('T11 security: a crash-boundary persisted running job cannot get a fresh call reservation on restart', async t => {
  const f = await fixture(t)
  f.setReply(async () => { throw new Error('simulated transport interrupted') })
  await f.worker.tick()
  await f.transaction(async tx => { const job = (await tx.doc(MemoryExtraction)).jobs[String(f.ref.taskId)]; job.state = 'running'; job.code = null })
  const before = await f.state()
  await f.restart()
  await f.worker.tick()
  assert.equal((await f.state()).calls, before.calls)
  assert.equal(f.called, 1)
})

test('T11 security: exhausted budget across restart retains pending state without another model call', async t => {
  const f = await fixture(t)
  await f.transaction(async tx => { const state = await tx.doc(MemoryExtraction); state.day = new Date().toISOString().slice(0, 10); state.calls = 20; state.reservedTokens = 120000 })
  await f.worker.tick()
  assert.equal(f.called, 0)
  assert.equal((await f.get()).memory.status.code, 'MEMORY_BUDGET_EXHAUSTED')
  await f.restart()
  await f.worker.tick()
  assert.equal(f.called, 0)
  assert.equal((await f.state()).calls, 20)
})

test('T11 security: fresh request/version/ID cannot resurrect user-deleted facts from the same old Entry, even after restart', async t => {
  const f = await fixture(t)
  assert.equal((await f.candidate(patch(f))).ok, true)
  assert.equal((await f.edit({ expectedVersion: 1, action: 'delete', id: 'tone' })).ok, true)
  await f.restart()
  const stale = await f.candidate(patch(f, 'renamed-fact'), 2)
  assert.equal(stale.ok, false, 'same old evidence must remain suppressed, even under a new item/request ID')
  assert.deepEqual(stale.document.items, [])
})

test('T11 security: user correction cannot be undone by a later candidate rewording the same old evidence', async t => {
  const f = await fixture(t)
  assert.equal((await f.candidate(patch(f))).ok, true)
  await f.edit({ expectedVersion: 1, action: 'update', id: 'tone', content: '用户纠正：改用英文' })
  const stale = await f.candidate(patch(f, 'regenerated-item', '使用简短中文'), 2)
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.document.items.map(item => item.content), ['用户纠正：改用英文'])
})


test('T11 security: revoked source does not block user cleanup and later reauthorization cannot resurrect its deleted fact', async t => {
  const f = await fixture(t)
  await f.candidate(patch(f))
  await f.revoke()
  const rejected = await f.candidate(patch(f, 'unauthorized-new'), 1)
  assert.equal(rejected.ok, false)
  const deleted = await f.edit({ expectedVersion: 1, action: 'delete', id: 'tone' })
  assert.equal(deleted.ok, true, 'user must be able to delete a stored fact whose source is now unavailable')
  await f.restore()
  await f.restart()
  const stale = await f.candidate(patch(f, 'resurrected-after-regrant'), 2)
  assert.equal(stale.code, 'MEMORY_SOURCE_SUPPRESSED')
  assert.deepEqual(stale.document.items, [])
})

test('T11 security: source suppression survives memory/preference reclassification but allows a genuinely new user Entry', async t => {
  const f = await fixture(t)
  await f.candidate(patch(f))
  await f.edit({ expectedVersion: 1, action: 'delete', id: 'tone' })
  const moved = await f.candidate(patch(f, 'moved-to-memory'), 0, randomUUID(), 'memory')
  assert.equal(moved.code, 'MEMORY_SOURCE_SUPPRESSED')
  // Direct authenticated user input remains editable; only background reuse is suppressed.
  const deliberate = await f.edit({ expectedVersion: 2, action: 'add', id: 'explicit-user-restore', content: sourceText, sourceEntries: [f.ref] })
  assert.equal(deliberate.ok, true)
  const newRef = await f.transaction(async tx => {
    const entry = await tx.appendEntry(f.batch.card.conversationId, { kind: 'pidot.user', data: { role: 'user', content: '新确认：' + sourceText } })
    return { taskId: f.ref.taskId, entryId: entry.id }
  })
  const service = createBotMemoryService({ getSecrets: () => [] })
  const fresh = await f.transaction(tx => service.applyCandidate(tx, { botId: 'chief', kind: 'memory', requestId: 'fresh-authorized-entry', expectedVersion: 0, patches: [{ ...patch(f, 'fresh-fact'), sourceEntries: [newRef] }] }))
  assert.equal(fresh.ok, true)
})

test('T11 security: rejected user correction cannot poison a previously valid source with a deletion tombstone', async t => {
  const f = await fixture(t)
  await f.candidate(patch(f))
  const failed = await f.edit({ expectedVersion: 1, action: 'update', id: 'tone', content: 'x'.repeat(2049) })
  assert.equal(failed.ok, false)
  const valid = await f.candidate(patch(f, 'valid-still-allowed'), 1)
  assert.equal(valid.ok, true, 'validation failure must not commit suppression side effects')
})

test('T11 security: extraction parser requires every cited identity to be the original numeric Entry/Task, not coercible strings', () => {
  const sources = [{ taskId: 1, entryId: 2, content: sourceText }]
  const result = refs => response({ preferences: [{ content: sourceText, sourceEntries: refs }] })
  assert.throws(() => parseMemoryExtraction(result([{ taskId: '1', entryId: '2' }]), sources))
})

async function storeFixture(t) {
  const { openTaskStore, TaskCard } = await import('./tasks.mjs')
  const { listBots } = await import('./bots.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-memory-security-store-')), file = join(dir, 'isolated.sqlite'), calls = []
  const config = { baseUrl: 'http://127.0.0.1:1/v1', model: 'security-scripted', apiKey: `fixture-${randomUUID()}` }
  let store
  const open = async () => {
    store = await openTaskStore({ file, bots: listBots(config), memoryOptions: { enabled: true, idleMs: 1000000 }, detectorOptions: { enabled: false },
      readModelSettings: async () => config, modelReply: async (_message, options) => {
        calls.push(JSON.parse(JSON.stringify({ purpose: options.purpose ?? 'reply', taskId: options.taskId, systemPrompt: options.context?.systemPrompt, messages: options.context?.messages })))
        if (options.purpose === 'memory-extraction') {
          const entries = JSON.parse(options.context.messages[0].content).entries
          return response({ preferences: entries.map(({ taskId, entryId, content }) => ({ content, sourceEntries: [{ taskId, entryId }] })) })
        }
        return { mode: 'model', reply: { content: '原回复正常' }, execution: { usage: { totalTokens: 7 } } }
      } })
  }
  await open()
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const wait = async id => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const task = await store.get(id)
      if (task.activeInputId === null && task.messages.some(message => message.role === 'assistant')) return task
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail('scripted security Task did not finish its ordinary reply')
  }
  return { get store() { return store }, TaskCard, calls, wait,
    send: async (botId, content) => { const { taskId } = await store.create({ botId }); await store.send(taskId, content); await wait(taskId); return taskId },
    restart: async () => { await store.close(); await open() },
  }
}

test('T11 security integration: gather excludes real unconsumed future Entries and group-private sources before provider input', async t => {
  const f = await storeFixture(t)
  const privateMarker = `group-private-${randomUUID()}`, futureMarker = `future-private-${randomUUID()}`
  const validId = await f.send('chief', sourceText)
  const groupId = await f.send('todo', privateMarker)
  await f.store.harness.commit(async tx => {
    const card = await tx.doc(f.TaskCard, groupId)
    card.kind = 'group'
    const validCard = await tx.doc(f.TaskCard, validId)
    await tx.appendEntry(validCard.conversationId, { kind: 'pidot.user', data: { role: 'user', content: futureMarker } })
  }, context)
  await f.store.memoryWorker.tick()
  const extractions = f.calls.filter(call => call.purpose === 'memory-extraction')
  assert.equal(extractions.length, 1)
  const input = JSON.stringify(extractions[0].messages)
  assert.ok(input.includes(sourceText))
  assert.equal(input.includes(privateMarker), false)
  assert.equal(input.includes(futureMarker), false)
  assert.deepEqual((await f.store.getPreferences()).items.map(item => item.content), [sourceText])
})

test('T11 security integration: deactivated source stops cross-Bot live injection; user deletion and restart never re-extract old evidence', async t => {
  const f = await storeFixture(t), text = '我偏好每次先列出三个清晰的结论'
  await f.send('calendar', text)
  await f.store.memoryWorker.tick()
  const preferences = await f.store.getPreferences()
  assert.equal(preferences.items[0].content, text)
  const beforeId = await f.send('todo', '请继续')
  assert.ok(f.calls.findLast(call => call.taskId === beforeId && call.purpose === 'reply').systemPrompt.includes(text))
  await f.store.deactivateBot('calendar', { confirm: true })
  const afterId = await f.send('todo', '现在继续')
  assert.equal(f.calls.findLast(call => call.taskId === afterId && call.purpose === 'reply').systemPrompt.includes(text), false)
  await f.store.editPreferences({ expectedVersion: preferences.version, requestId: 'delete-revoked-source', action: 'delete', id: preferences.items[0].id })
  assert.deepEqual((await f.store.getPreferences()).items, [])
  await f.restart()
  await f.store.memoryWorker.tick()
  const after = await f.store.getPreferences()
  assert.equal(after.items.some(item => item.content === text), false)
})

test('T11 security: adding an unrelated preference citation cannot launder a private factual source into shared preferences', () => {
  const sources = [
    { taskId: 1, entryId: 2, content: '我偏好使用简洁的中文回答' },
    { taskId: 1, entryId: 3, content: '我的私人病历编号是 PERSONAL-RECORD-ONLY' },
  ]
  const result = response({ preferences: [{ content: '我的私人病历编号是 PERSONAL-RECORD-ONLY', sourceEntries: [{ taskId: 1, entryId: 2 }, { taskId: 1, entryId: 3 }] }] })
  assert.throws(() => parseMemoryExtraction(result, sources), 'preference intent must be attached to the supporting evidence, not any cited text')
})


test('T11 security: delayed extraction cannot resurrect a user-deleted preference through CAS rebase and a generated fresh ID', async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  await f.candidate(patch(f, 'user-visible', '我偏好中文回答'))
  f.setReply(async () => { entered.release(); await release.promise; return extracted(f) })
  const running = f.worker.tick()
  await entered.promise
  await f.edit({ expectedVersion: 1, action: 'delete', id: 'user-visible' })
  release.release()
  await running
  assert.deepEqual((await f.get()).preferences.items, [])
  assert.equal((await f.get()).preferences.version, 2)
  assert.equal((await f.state()).jobs[String(f.ref.taskId)].state, 'pending')
  assert.equal(f.called, 1)
})
