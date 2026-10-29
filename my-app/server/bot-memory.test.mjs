import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRegistry, defineTask, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { BOT_MEMORY_LIMITS, createBotMemoryService, applyMemoryCandidateWithRetry, buildMemoryContext } from './bot-memory.mjs'

const ProbeTask = defineTask({ name: 'pidot.test.memory', version: 1, initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} } })
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-memory-'))
  let harness, now = Date.parse('2026-10-29T00:00:00Z'), secrets = [`model-${randomUUID()}`, `api-${randomUUID()}`]
  async function open() {
    const registry = createRegistry()
    registry.install({ name: 'memory-probe', tasks: [ProbeTask] })
    harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'isolated.sqlite')), { models: createModels(), registry, settings: { documentRetentionMs: 0 } }, context)
  }
  await open()
  t.after(async () => { await harness.close(context); await rm(dir, { recursive: true, force: true }) })
  const transaction = fn => harness.commit(fn, context)
  // Real Harness Entries and Task/Conversation ownership, not mocked references.
  const source = await transaction(async tx => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const taskId = await tx.createTask(ProbeTask, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } })
    const entry = await tx.appendEntry(conversation.id, { kind: 'pidot.user', data: { role: 'user', content: '请简短用中文回答；我喜欢清晰的列表。' } })
    return { taskId, entryId: entry.id }
  })
  const service = createBotMemoryService({ getSecrets: () => secrets, now: () => now, ...options })
  return { transaction, service, source, dir, get: botId => transaction(tx => service.get(tx, botId)),
    candidate: input => transaction(tx => service.applyCandidate(tx, { botId: 'chief', kind: 'memory', requestId: randomUUID(), expectedVersion: 0, ...input })),
    edit: input => transaction(tx => service.edit(tx, { botId: 'chief', kind: 'memory', requestId: randomUUID(), expectedVersion: 0, ...input })),
    advance: () => { now += 1000 }, setSecrets: value => { secrets = value }, get secrets() { return secrets },
    restart: async () => { await harness.close(context); await open() },
    scanSecrets: async values => { for (const name of await readdir(dir)) { const bytes = await readFile(join(dir, name)); for (const value of values) assert.equal(bytes.includes(Buffer.from(value)), false, 'credential bytes must not enter SQLite/WAL/SHM') } },
  }
}
const add = (source, id = 'tone', content = '偏好简洁的中文回答') => ({ action: 'add', id, content, sourceEntries: [source] })

test('T11a isolated defaults, user-only personality, per-Bot isolation, globally shared preferences', async t => {
  const f = await fixture(t)
  const before = await f.get('chief')
  assert.equal(before.personality.version, 0)
  assert.equal(before.personality.content, '')
  assert.deepEqual(before.memory.items, [])
  assert.equal(before.preferences.botId, undefined)
  const result = await f.edit({ kind: 'personality', action: 'set', content: '温暖、直接，不替用户越权。' })
  assert.equal(result.ok, true)
  assert.equal(result.version, 1)
  assert.equal(result.document.updatedAt, '2026-10-29T00:00:00.000Z')
  assert.equal((await f.get('todo')).personality.content, '')
  const denied = await f.candidate({ kind: 'personality', patches: [add(f.source)] })
  assert.equal(denied.code, 'MEMORY_PERSONALITY_USER_ONLY')
  assert.equal((await f.get('chief')).personality.content, result.document.content)
  await f.candidate({ kind: 'preferences', patches: [add(f.source)] })
  assert.equal((await f.get('todo')).preferences.items[0].content, '偏好简洁的中文回答')
  await f.candidate({ patches: [add(f.source)] })
  assert.equal((await f.get('todo')).memory.items.length, 0)
})

test('T11a strict CAS and persistent request replay; request reuse cannot change payload', async t => {
  const f = await fixture(t)
  const input = { requestId: 'persistent-request', patches: [add(f.source)] }
  const first = await f.candidate(input)
  assert.equal(first.ok, true)
  assert.equal((await f.candidate({ patches: [add(f.source, 'second')] })).code, 'MEMORY_VERSION_CONFLICT')
  await f.restart()
  const replay = await f.candidate(input)
  assert.equal(replay.ok, true)
  assert.equal(replay.replayed, true)
  assert.equal(replay.version, 1)
  const changed = await f.candidate({ ...input, patches: [add(f.source, 'different')] })
  assert.equal(changed.code, 'MEMORY_REQUEST_CONFLICT')
  assert.equal((await f.get('chief')).memory.items.length, 1)
})

test('T11a missing, invented, mismatched and failed Entry resolution leave old content/version/history unchanged', async t => {
  const f = await fixture(t)
  await f.candidate({ patches: [add(f.source)] })
  const old = (await f.get('chief')).memory
  for (const sourceEntries of [undefined, [], [{ taskId: f.source.taskId, entryId: 999999 }], [{ taskId: 999999, entryId: f.source.entryId }], [{ taskId: '1', entryId: f.source.entryId }]]) {
    const result = await f.candidate({ expectedVersion: 1, patches: [{ ...add(f.source, 'new'), sourceEntries }] })
    assert.equal(result.ok, false)
    assert.deepEqual(result.document.items, old.items)
    assert.equal(result.document.version, old.version)
    assert.equal(result.document.status.state, 'pending')
  }
  const broken = createBotMemoryService({ getSecrets: () => [], readEntry: () => { throw new Error('do not persist this sensitive provider message') } })
  const result = await f.transaction(tx => broken.applyCandidate(tx, { botId: 'chief', kind: 'memory', requestId: 'failed-source', expectedVersion: 1, patches: [add(f.source, 'new')] }))
  assert.equal(result.code, 'MEMORY_SOURCE_UNAVAILABLE')
  assert.equal((await f.transaction(tx => f.service.history(tx, { botId: 'chief', kind: 'memory' }))).items.length, 1)
})

test('T11a current secret values and sk-/Bearer shapes are rejected in every candidate field; no database leak', async t => {
  const f = await fixture(t)
  await f.candidate({ patches: [add(f.source)] })
  const secrets = [...f.secrets]
  for (const text of [...secrets, `sk-${randomUUID()}`, `Bearer ${randomUUID()}`, `bEaReR\t${randomUUID()}`]) {
    const result = await f.candidate({ expectedVersion: 1, patches: [add(f.source, 'bad', `不能记住 ${text}`)] })
    assert.equal(result.code, 'MEMORY_CREDENTIAL_REJECTED')
    assert.equal(result.document.version, 1)
    assert.equal(result.document.items.length, 1)
    assert.equal(JSON.stringify(result).includes(text), false)
  }
  for (const key of ['requestId', 'extra']) {
    const result = await f.candidate({ expectedVersion: 1, patches: [add(f.source, 'other')], [key]: secrets[0] })
    assert.equal(result.code, 'MEMORY_CREDENTIAL_REJECTED')
  }
  assert.equal((await f.candidate({ expectedVersion: 1, patches: [{ ...add(f.source), id: secrets[1] }] })).code, 'MEMORY_CREDENTIAL_REJECTED')
  assert.equal((await f.edit({ kind: 'personality', action: 'set', content: secrets[0] })).code, 'MEMORY_CREDENTIAL_REJECTED')
  const rotated = `rotated-${randomUUID()}`
  f.setSecrets([rotated])
  assert.equal((await f.candidate({ expectedVersion: 1, patches: [add(f.source, 'rotated', rotated)] })).code, 'MEMORY_CREDENTIAL_REJECTED')
  await f.scanSecrets([...secrets, rotated])
  await f.restart()
  await f.scanSecrets([...secrets, rotated])
})

test('T11a live credential reader is mandatory and reader failures fail closed with a safe pending code', async t => {
  assert.throws(() => createBotMemoryService(), /credential/)
  const f = await fixture(t, { getSecrets: () => { throw new Error('never expose credential backend errors') } })
  const result = await f.candidate({ patches: [add(f.source)] })
  assert.equal(result.code, 'MEMORY_VALIDATION_UNAVAILABLE')
  assert.equal(result.document.version, 0)
  assert.equal(result.document.status.state, 'pending')
})

test('T11a patch/document bounds, atomic validation and closed patch fields preserve old document', async t => {
  const f = await fixture(t, { limits: { contentChars: 20, documentChars: 25, items: 2, patches: 2 } })
  for (const patches of [[], [add(f.source, 'long', 'x'.repeat(21))], [add(f.source, 'a', 'x'.repeat(20)), add(f.source, 'b', 'y'.repeat(20))], [add(f.source), add(f.source, 'b'), add(f.source, 'c')], [add(f.source), add(f.source)], [{ ...add(f.source), type: 'event' }], [add(f.source), { action: 'update', id: 'missing', content: 'x', sourceEntries: [f.source] }]]) {
    const result = await f.candidate({ patches })
    assert.equal(result.ok, false)
    assert.equal(result.document.version, 0)
    assert.deepEqual(result.document.items, [])
  }
  assert.equal((await f.candidate({ patches: [add(f.source, 'one')] })).ok, true)
  assert.equal((await f.candidate({ expectedVersion: 1, patches: [add(f.source, 'two', 'second')] })).ok, true)
  assert.equal((await f.candidate({ expectedVersion: 2, patches: [add(f.source, 'three', 'third')] })).code, 'MEMORY_DOCUMENT_LIMIT')
})

test('T11a user correction/deletion increments versions, retains sources and exposes paginated immutable history', async t => {
  const f = await fixture(t)
  await f.candidate({ patches: [add(f.source)] })
  f.advance()
  const changed = await f.edit({ expectedVersion: 1, action: 'update', id: 'tone', content: '改为英文' })
  assert.equal(changed.ok, true)
  assert.equal(changed.version, 2)
  assert.deepEqual(changed.document.items[0].sourceEntries, [f.source])
  assert.equal(changed.document.items[0].createdAt, '2026-10-29T00:00:00.000Z')
  assert.equal(changed.document.items[0].updatedAt, '2026-10-29T00:00:01.000Z')
  f.advance()
  const deleted = await f.edit({ expectedVersion: 2, action: 'delete', id: 'tone' })
  assert.equal(deleted.version, 3)
  assert.deepEqual(deleted.document.items, [])
  assert.deepEqual(deleted.document.sourceEntries, [])
  const history = await f.transaction(tx => f.service.history(tx, { botId: 'chief', kind: 'memory', limit: 2 }))
  assert.deepEqual(history.items.map(item => item.version), [3, 2])
  assert.equal(history.items[0].actor, 'user')
  assert.deepEqual(history.items[0].changes, [{ action: 'delete', id: 'tone', sourceEntries: [f.source] }])
  assert.equal(history.items[1].items[0].content, '改为英文')
  const page = await f.transaction(tx => f.service.history(tx, { botId: 'chief', kind: 'memory', beforeVersion: history.nextBeforeVersion }))
  assert.equal(page.items[0].items[0].content, '偏好简洁的中文回答')
  assert.equal(page.nextBeforeVersion, null)
  await f.restart()
  assert.equal((await f.get('chief')).memory.version, 3)
  assert.equal((await f.transaction(tx => f.service.history(tx, { botId: 'chief', kind: 'memory' }))).items.length, 3)
})

test('T11a unchanged user edits are idempotent without manufacturing history; personality can be cleared', async t => {
  const f = await fixture(t)
  await f.edit({ kind: 'personality', action: 'set', content: '直接回答' })
  f.advance()
  const noop = await f.edit({ kind: 'personality', expectedVersion: 1, action: 'set', content: '直接回答' })
  assert.equal(noop.version, 1)
  assert.equal(noop.changed, false)
  assert.equal(noop.document.updatedAt, '2026-10-29T00:00:00.000Z')
  const cleared = await f.edit({ kind: 'personality', expectedVersion: 1, action: 'set', content: '' })
  assert.equal(cleared.version, 2)
  assert.equal(cleared.document.content, '')
  await f.candidate({ patches: [add(f.source)] })
  f.advance()
  const same = await f.edit({ expectedVersion: 1, action: 'update', id: 'tone', content: '偏好简洁的中文回答' })
  assert.equal(same.version, 1)
  assert.equal(same.changed, false)
})

test('T11a two Bots race shared preferences: bounded retry re-reads and merges without dropping either entry', async t => {
  const f = await fixture(t)
  const candidates = ['chief', 'todo'].map(botId => ({ botId, kind: 'preferences', requestId: `pref-${botId}`, expectedVersion: 0, patches: [add(f.source, botId, `${botId}的偏好`)] }))
  const results = await Promise.all(candidates.map(candidate => applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate })))
  assert.equal(results.every(result => result.ok), true)
  assert.deepEqual(results.map(result => result.attempts).sort(), [1, 2])
  const prefs = (await f.get('todo')).preferences
  assert.equal(prefs.version, 2)
  assert.deepEqual(prefs.items.map(item => item.id).sort(), ['chief', 'todo'])
  for (const candidate of candidates) {
    const replay = await applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate })
    assert.equal(replay.ok, true)
    assert.equal(replay.replayed, true)
    assert.equal(replay.document.version, 2)
  }
})

test('T11a preference retry never overwrites concurrent correction/deletion and is bounded under continuous conflicts', async t => {
  const f = await fixture(t)
  await f.candidate({ kind: 'preferences', patches: [add(f.source)] })
  await f.edit({ kind: 'preferences', expectedVersion: 1, action: 'update', id: 'tone', content: '用户刚纠正' })
  const candidate = { botId: 'todo', kind: 'preferences', requestId: 'stale-correction', expectedVersion: 1, patches: [{ ...add(f.source), action: 'update', content: '旧提取覆盖' }] }
  const blocked = await applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate })
  assert.equal(blocked.code, 'MEMORY_VERSION_CONFLICT')
  assert.equal(blocked.attempts, 1)
  assert.equal(blocked.document.items[0].content, '用户刚纠正')
  await f.edit({ kind: 'preferences', expectedVersion: 2, action: 'delete', id: 'tone' })
  const deleted = await applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate: { ...candidate, expectedVersion: 2, requestId: 'stale-delete' } })
  assert.equal(deleted.ok, false)
  assert.equal(deleted.document.items.length, 0)
  let calls = 0
  const limited = await applyMemoryCandidateWithRetry({ transaction: async fn => fn({}), service: { applyCandidate: () => { calls++; return { ok: false, code: 'MEMORY_VERSION_CONFLICT' } }, rebaseCandidate: () => candidate }, candidate, maxAttempts: 2 })
  assert.equal(calls, 2)
  assert.equal(limited.attempts, 2)
})

test('T11a pending extraction/budget statuses contain no candidate text and do not touch content or history', async t => {
  const f = await fixture(t)
  await f.candidate({ patches: [add(f.source)] })
  const before = (await f.get('chief')).memory
  const result = await f.transaction(tx => f.service.markPending(tx, { botId: 'chief', kind: 'memory', reason: 'MEMORY_BUDGET_EXHAUSTED' }))
  assert.equal(result.version, before.version)
  assert.deepEqual(result.items, before.items)
  assert.equal(result.status.code, 'MEMORY_BUDGET_EXHAUSTED')
  await assert.rejects(f.transaction(tx => f.service.markPending(tx, { botId: 'chief', kind: 'memory', reason: f.secrets[0] })))
  await f.scanSecrets(f.secrets)
})

test('T11a optional live context is bounded, contains provenance, drops old entries and filters rotated keys', async t => {
  const f = await fixture(t)
  await f.edit({ kind: 'personality', action: 'set', content: '温暖' })
  await f.candidate({ patches: [add(f.source, 'old', '旧条目')] })
  f.advance()
  await f.candidate({ expectedVersion: 1, patches: [add(f.source, 'new', '新条目')] })
  const full = await f.transaction(tx => f.service.memoryContext(tx, 'chief'))
  assert.ok(full.text.includes(`${f.source.taskId}/${f.source.entryId}`))
  assert.ok(full.text.indexOf('新条目') < full.text.indexOf('旧条目'))
  const bounded = buildMemoryContext(await f.get('chief'), { maxChars: full.text.indexOf('Bot记忆：旧条目') - 1 })
  assert.ok(bounded.text.includes('新条目'))
  assert.equal(bounded.text.includes('旧条目'), false)
  assert.equal(bounded.truncated, true)
  assert.equal(buildMemoryContext(await f.get('chief'), { maxChars: 0 }).text, '')
  f.setSecrets(['新条目'])
  const safe = await f.transaction(tx => f.service.memoryContext(tx, 'chief', { maxChars: 200 }))
  assert.equal(safe.text.includes('新条目'), false)
  assert.ok(safe.chars <= 200)
  assert.equal(safe.versions.memory, 2)
  assert.equal(BOT_MEMORY_LIMITS.mergeAttempts, 3)
})

test('T11a real openTaskStore TaskCard child conversation differs from TaskRecord root; its actual Entry is valid', async t => {
  const { openTaskStore, TaskCard } = await import('./tasks.mjs')
  const { listBots } = await import('./bots.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-memory-task-card-'))
  const store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots: listBots(), detectorOptions: { enabled: false } })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const taskId = (await store.mainSessions()).chief
  const source = await store.harness.commit(async tx => {
    const record = await tx.task(taskId), card = await tx.doc(TaskCard, taskId)
    assert.notEqual(record.conversationId, card.conversationId)
    const conversation = await tx.conversation(card.conversationId)
    assert.equal(conversation.owner.taskId, taskId)
    const entry = await tx.appendEntry(card.conversationId, { kind: 'pidot.user', data: { role: 'user', content: '请简短回答' } })
    return { taskId, entryId: entry.id }
  }, context)
  const service = createBotMemoryService({ getSecrets: () => [] })
  const saved = await store.harness.commit(tx => service.applyCandidate(tx, { botId: 'chief', kind: 'preferences', requestId: 'real-task-card-entry', expectedVersion: 0, patches: [add(source)] }), context)
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(saved.document.items[0].sourceEntries, [source])
  const foreignTask = (await store.mainSessions()).todo
  const denied = await store.harness.commit(tx => service.applyCandidate(tx, { botId: 'chief', kind: 'preferences', requestId: 'foreign-task-card-entry', expectedVersion: 1, patches: [add({ ...source, taskId: foreignTask }, 'wrong-task')] }), context)
  assert.equal(denied.code, 'MEMORY_SOURCE_NOT_FOUND')
})

test('T11a authorization reader receives target/actor scope and rejects other Bot, group, external and unconsumed Entries', async t => {
  const f = await fixture(t)
  const scopeSeen = []
  const entries = await f.transaction(async tx => {
    const task = await tx.task(f.source.taskId), refs = []
    for (const label of ['other-bot', 'group', 'external', 'future', 'private-consumed']) {
      const entry = await tx.appendEntry(task.conversationId, { kind: 'pidot.user', data: { role: 'user', label } })
      refs.push({ taskId: f.source.taskId, entryId: entry.id })
    }
    return refs
  })
  const service = createBotMemoryService({ getSecrets: () => [], readEntry: async (tx, ref, scope) => {
    scopeSeen.push(scope)
    const entry = await tx.entry(ref.entryId)
    return scope.botId === 'chief' && entry?.data?.label === 'private-consumed' ? entry : null
  } })
  for (const ref of entries.slice(0, 4)) {
    const result = await f.transaction(tx => service.applyCandidate(tx, { botId: 'chief', kind: 'preferences', requestId: `auth-${ref.entryId}`, expectedVersion: 0, patches: [add(ref)] }))
    assert.equal(result.code, 'MEMORY_SOURCE_NOT_FOUND')
    assert.equal(result.document.version, 0)
  }
  const accepted = await f.transaction(tx => service.applyCandidate(tx, { botId: 'chief', kind: 'preferences', requestId: 'auth-valid', expectedVersion: 0, patches: [add(entries[4])] }))
  assert.equal(accepted.ok, true)
  assert.deepEqual(scopeSeen, entries.map(() => ({ botId: 'chief', kind: 'preferences', actor: 'candidate' })))
})

test('T11a get/history/edit/context projections never reveal stored text matching a newly rotated credential', async t => {
  const f = await fixture(t)
  const laterSecret = `later-key-${randomUUID()}`
  await f.edit({ kind: 'personality', action: 'set', content: `保持温暖 ${laterSecret}` })
  await f.candidate({ kind: 'preferences', patches: [add(f.source, 'pref', `简短 ${laterSecret}`)] })
  await f.candidate({ patches: [add(f.source, 'fact', `事实 ${laterSecret}`)] })
  f.setSecrets([laterSecret])
  assert.equal(JSON.stringify(await f.get('chief')).includes(laterSecret), false)
  for (const kind of ['personality', 'preferences', 'memory']) {
    const history = await f.transaction(tx => f.service.history(tx, { botId: 'chief', kind }))
    assert.equal(JSON.stringify(history).includes(laterSecret), false)
    assert.ok(JSON.stringify(history).includes('已过滤敏感内容'))
  }
  const rejected = await f.candidate({ expectedVersion: 1, patches: [add(f.source, 'another', laterSecret)] })
  assert.equal(rejected.code, 'MEMORY_CREDENTIAL_REJECTED')
  assert.equal(JSON.stringify(rejected).includes(laterSecret), false)
  const unchanged = await f.candidate({ expectedVersion: 1, patches: [add(f.source, 'safe')] })
  assert.equal(unchanged.code, 'MEMORY_CREDENTIAL_REJECTED')
  const text = await f.transaction(tx => f.service.memoryContext(tx, 'chief'))
  assert.equal(JSON.stringify(text).includes(laterSecret), false)
  // Redaction is projection-only and never silently rewrites user history.
  f.setSecrets([])
  assert.ok((await f.get('chief')).memory.items[0].content.includes(laterSecret))
})

test('T11a rejected candidates never persist raw text, IDs, requestId, unknown fields or reader exception details', async t => {
  const f = await fixture(t)
  const rejectedText = `untrusted-${randomUUID()}`, rejectedId = `id-${randomUUID()}`, rejectedRequest = `req-${randomUUID()}`
  const result = await f.candidate({ requestId: rejectedRequest, patches: [{ action: 'add', id: rejectedId, content: rejectedText, sourceEntries: [] }] })
  assert.equal(result.ok, false)
  await f.scanSecrets([rejectedText, rejectedId, rejectedRequest])
  const secretWithQuotes = `value-"\\${randomUUID()}`
  f.setSecrets([secretWithQuotes])
  assert.equal((await f.candidate({ patches: [add(f.source, 'escaped', secretWithQuotes)] })).code, 'MEMORY_CREDENTIAL_REJECTED')
  await f.scanSecrets([secretWithQuotes])
})


test('T11a bounded preference rebase catches add/delete ABA and never resurrects user-deleted entries', async t => {
  const f = await fixture(t)
  const candidate = { botId: 'todo', kind: 'preferences', requestId: 'stale-aba-add', expectedVersion: 0, patches: [add(f.source)] }
  await f.candidate({ kind: 'preferences', patches: [add(f.source)] })
  await f.edit({ kind: 'preferences', expectedVersion: 1, action: 'delete', id: 'tone' })
  const result = await applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate })
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.document.items, [])
  const bounded = createBotMemoryService({ getSecrets: () => [], limits: { history: 1 } })
  const disjoint = { ...candidate, patches: [add(f.source, 'different')] }
  assert.equal(await f.transaction(tx => bounded.rebaseCandidate(tx, disjoint)), null)
})
