import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotMemoryRuntime, MemoryExtraction } from './bot-memory-runtime.mjs'
import { memoryEvidence, successfulMemoryTool, memoryTaskSourceAllowed } from './memory-evidence.mjs'

const hour = 3600000
function rig({ limits, reply, state = MemoryExtraction.definition.initial() } = {}) {
  let at = Date.parse('2026-11-01T00:00:00Z'), calls = 0, writes = 0
  const batches = []
  const documents = { memory: { version: 0, items: [] }, preferences: { version: 0, items: [] } }
  const tx = { doc: async () => state }
  const service = { get: async () => structuredClone(documents), markPending: async () => {}, applyCandidate: async (_tx, input) => {
    const doc = documents[input.kind]
    for (const patch of input.patches) if (!doc.items.some(item => item.id === patch.id)) { doc.items.push(patch); doc.version++; writes++ }
    return { ok: true, changed: true, version: doc.version }
  } }
  const worker = createBotMemoryRuntime({ enabled: true, limits, now: () => at, transaction: async fn => fn(tx), service, gather: async () => structuredClone(batches), validate: async () => true, getSecrets: async () => [],
    load: async job => { const batch = batches.find(batch => batch.card.taskId === job.sourceTaskId); if (!batch) return null; return { ...structuredClone(batch), entries: batch.entries.filter(entry => job.refs.some(ref => ref.entryId === entry.id)) } },
    modelReply: async (message, options) => { calls++; if (reply) return reply(message, options); const input = JSON.parse(options.context.messages[0].content); return { reply: { content: JSON.stringify({ memory: input.entries.map(entry => ({ content: entry.content, sourceEntries: [{ taskId: entry.taskId, entryId: entry.entryId }] })), preferences: [], skills: [] }) }, execution: { usage: { totalTokens: 8 } } } },
  })
  function session(id) { const batch = { card: { taskId: id, conversationId: id + 100, initiatingUser: 'authenticated-user', kind: 'chat', bot: { id: `bot-${id}` }, parameters: { mode: 'model', model: { id: 'model-current' } } }, entries: [], activityKey: '0', active: false }; batches.push(batch); return batch }
  function add(batch, id, content = `项目路径 /workspace/project-${id}`) { batch.entries.push({ id, conversationId: batch.card.conversationId, byTaskId: batch.card.taskId, kind: 'pidot.user', data: { role: 'user', content } }); batch.activityKey = String(id) }
  return { worker, state, batches, documents, service, session, add, calls: () => calls, writes: () => writes, advance: value => { at += value }, now: () => at }
}

test('M02 each session waits 59m59s and another busy session cannot postpone its one-hour deadline', async t => {
  const r = rig(); t.after(() => r.worker.close())
  const a = r.session(1), b = r.session(2); await r.worker.start()
  r.add(a, 11); r.add(b, 21); await r.worker.tick({ force: false })
  r.advance(hour - 1); b.active = true; b.activityKey = 'busy-22'; await r.worker.tick({ force: false }); assert.equal(r.calls(), 0)
  r.advance(1); await r.worker.tick({ force: false }); assert.equal(r.calls(), 1); assert.equal(r.state.processed['1/11'].at, r.now()); assert.equal(r.state.processed['2/21'], undefined)
  await r.worker.tick({ force: false }); assert.equal(r.calls(), 1)
})

test('M02 restart preserves dueAt and UTC quota, retries failed evidence and does not mark it consumed', async t => {
  const first = rig({ reply: async () => { throw new Error('provider failed') } }); const a = first.session(1)
  first.add(a, 11); await first.worker.tick(); const job = Object.values(first.state.jobs)[0]
  assert.equal(job.state, 'retry-wait'); assert.equal(first.state.processed['1/11'], undefined); const dueAt = job.dueAt, calls = first.state.calls
  await first.worker.close()
  const second = rig({ state: first.state }); t.after(() => second.worker.close()); const b = second.session(1); second.add(b, 11)
  await second.worker.start(); assert.equal(Object.values(second.state.jobs)[0].dueAt, dueAt); assert.equal(second.state.calls, calls)
  await second.worker.tick({ force: false }); assert.equal(second.calls(), 0)
  second.advance(dueAt - second.now()); await second.worker.tick({ force: false }); assert.equal(second.calls(), 1); assert.ok(second.state.processed['1/11'])
})

test('M02 more than eight candidates drain in complete bounded batches without losing the tail', async t => {
  const r = rig(); t.after(() => r.worker.close()); const a = r.session(1)
  for (let id = 1; id <= 19; id++) r.add(a, id)
  await r.worker.tick(); assert.equal(r.calls(), 3); assert.equal(r.writes(), 19); assert.equal(Object.keys(r.state.processed).length, 19)
  assert.ok(Object.values(r.state.jobs).every(job => job.refs.length <= 8))
  await r.worker.tick(); assert.equal(r.calls(), 3)
})

test('M02 exhausted budget retains every candidate and a very large entry does not block following evidence', async t => {
  const r = rig({ limits: { calls: 0 } }); t.after(() => r.worker.close()); const a = r.session(1); r.add(a, 1, '很'.repeat(13000)); r.add(a, 2)
  await r.worker.tick(); assert.equal(r.calls(), 0); assert.equal(r.writes(), 0)
  const jobs = Object.values(r.state.jobs); assert.ok(jobs.some(job => job.code === 'MEMORY_INPUT_TOO_LARGE')); assert.ok(jobs.some(job => job.code === 'MEMORY_BUDGET_EXHAUSTED')); assert.equal(Object.keys(r.state.processed).length, 0)
})

test('M02 persisted proposal resumes the same semantic request without another model call', async t => {
  const r = rig(); t.after(() => r.worker.close()); const a = r.session(1); r.add(a, 1)
  const original = r.service.applyCandidate; let first = true
  r.service.applyCandidate = async (...args) => { if (first) { first = false; throw new Error('transient commit interruption') }; return original(...args) }
  await r.worker.tick(); assert.equal(r.calls(), 1); assert.ok(Object.values(r.state.jobs)[0].proposal); assert.equal(r.state.processed['1/1'], undefined)
  await r.worker.tick(); assert.equal(r.calls(), 1); assert.equal(r.writes(), 1); assert.ok(r.state.processed['1/1'])
})

test('M02 foreground abort returns a recoverable job and pause retains evidence', async t => {
  let entered, aborted = false; const ready = new Promise(resolve => { entered = resolve })
  const r = rig({ reply: async (_message, options) => { entered(); await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason) }, { once: true }) }) } }); t.after(() => r.worker.close())
  const a = r.session(1); r.add(a, 1); const run = r.worker.tick(); await ready; r.worker.interrupt('bot-1'); await run
  assert.equal(aborted, true); assert.equal(Object.values(r.state.jobs)[0].state, 'retry-wait'); assert.equal(Object.keys(r.state.processed).length, 0)
  await r.worker.pause('bot-1', true); await r.worker.tick(); assert.equal(r.calls(), 1); assert.equal((await r.worker.status('bot-1')).paused, true)
})

test('M01 success evidence excludes failed, unknown, skipped and assistant assertions, and derived ownership is real', () => {
  const base = { kind: 'pidot.tool-result', data: { toolName: 'native_read', result: { ok: true, data: { content: '稳定事实' } } } }
  assert.equal(successfulMemoryTool(base), true)
  for (const state of ['failed', 'unknown', 'skipped', 'waiting-for-user-approval', 'prepared', 'proposed', 'waiting', 'preview']) for (const field of ['state', 'status']) assert.equal(successfulMemoryTool({ ...base, data: { ...base.data, result: { ok: true, data: { [field]: state } } } }), false)
  assert.equal(successfulMemoryTool({ ...base, kind: 'pidot.model-reply' }), false)
  const card = { taskId: 2, bot: { id: 'a' }, mainParent: { mainTaskId: 1 } }
  assert.equal(memoryTaskSourceAllowed(card, { taskId: 1, kind: 'main', bot: { id: 'a' } }), true)
  assert.equal(memoryTaskSourceAllowed(card, { taskId: 1, kind: 'main', bot: { id: 'b' } }), false)
  assert.equal(memoryEvidence({ ...card, conversationId: 2 }, { ...base, id: 3 })?.kind, 'tool-result')
})

test('M02 legacy v1 jobs migrate idempotently without poisoning new timers or losing failed refs and quota', async t => {
  const state = { jobs: { '1': { state: 'pending', cursor: 19, refs: [{ taskId: 1, entryId: 11 }], updatedAt: '2026-11-01T00:00:00Z' } }, day: '2026-11-01', calls: 7, reservedTokens: 5000 }
  const r = rig({ state }); t.after(() => r.worker.close()); const a = r.session(1)
  r.add(a, 10, '旧已消费事实'); r.add(a, 11, '旧失败来源 /workspace/retry'); r.add(a, 19, '启用前其他历史')
  await r.worker.start()
  assert.equal(state.calls, 7); assert.equal(state.reservedTokens, 5000); assert.equal(state.jobs['1'], undefined); assert.ok(state.legacyJobs['1'].migratedAt)
  await r.worker.tick({ force: false }); assert.equal(r.calls(), 1); assert.equal(state.calls, 8)
  assert.deepEqual(Object.keys(state.processed), ['1/11']); assert.equal(r.documents.memory.items[0].content, '旧失败来源 /workspace/retry')
  await r.worker.tick({ force: false }); assert.equal(r.calls(), 1)
})

test('M02 a proposal resumed across a UTC boundary never refunds yesterday reservation into today budget', async t => {
  const r = rig(); t.after(() => r.worker.close()); const a = r.session(1); r.add(a, 1)
  const original = r.service.applyCandidate; let interrupted = true
  r.service.applyCandidate = async (...args) => { if (interrupted) { interrupted = false; throw new Error('commit unavailable') }; return original(...args) }
  await r.worker.tick(); const job = Object.values(r.state.jobs)[0], reserved = job.reservedTokens
  assert.ok(reserved > 0); assert.equal(job.reservationDay, '2026-11-01'); assert.ok(job.proposal)
  r.advance(86400000); await r.worker.tick()
  assert.equal(r.calls(), 1, 'the persisted proposal does not call the model again')
  assert.equal(r.state.day, '2026-11-02'); assert.equal(r.state.calls, 0); assert.equal(r.state.reservedTokens, 0)
  assert.equal(job.usage.reservedTokens, reserved); assert.equal(job.usage.totalTokens, 8); assert.ok(r.state.processed['1/1'])
})


test('M01 incompatible facts with the same explicit subject preserve the user version and require review', async t => {
  const r = rig(); t.after(() => r.worker.close()); const a = r.session(1)
  r.documents.memory.items.push({ id: 'user-path', content: '项目根目录是 /workspace/old', sourceEntries: [] }); r.documents.memory.version = 1
  r.add(a, 1, '项目根目录是 /workspace/new'); await r.worker.tick()
  assert.equal(r.writes(), 0); assert.equal(r.documents.memory.items[0].content, '项目根目录是 /workspace/old')
  const job = Object.values(r.state.jobs)[0]; assert.equal(job.state, 'blocked'); assert.equal(job.code, 'MEMORY_CONFLICT_NEEDS_REVIEW'); assert.equal(r.state.processed['1/1'], undefined)
})

test('M02 a foreground commit arriving during a scan requests another scan instead of being lost', async t => {
  const state = MemoryExtraction.definition.initial(), tx = { doc: async () => state }
  let schedule, scans = 0, release, entered
  const gate = new Promise(resolve => { release = resolve }), pending = new Promise(resolve => { entered = resolve })
  const card = { taskId: 1, conversationId: 2, kind: 'chat', initiatingUser: 'authenticated-user', bot: { id: 'b' }, parameters: { mode: 'model', model: { id: 'test' } } }
  const worker = createBotMemoryRuntime({ enabled: true, transaction: async fn => fn(tx), subscribe: callback => { schedule = callback; return () => {} },
    gather: async () => { scans++; if (scans === 1) return []; if (scans === 2) { entered(); await gate; return [] }; return [{ card, activityKey: 'last-reply', active: false, entries: [{ id: 3, conversationId: 2, kind: 'pidot.user', data: { role: 'user', content: '项目路径 /workspace/current' } }] }] },
  })
  t.after(() => worker.close())
  await worker.start(); schedule(); await pending; schedule(); release()
  for (let i = 0; i < 20 && scans < 3; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(scans >= 3)
  assert.ok(Object.values(state.jobs).some(job => job.refs.some(ref => ref.entryId === 3)), 'the final reply source must get its own durable deadline')
})
