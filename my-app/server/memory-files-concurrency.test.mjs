import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry, defineTask, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { applyMemoryCandidateWithRetry, buildMemoryContext, createBotMemoryService } from './bot-memory.mjs'
import { parseMemoryFile } from './memory-file-format.mjs'
import { createMemoryFileStore } from './memory-file-store.mjs'
import { MemoryFileLedger, createMemoryFiles } from './memory-files.mjs'

const Probe = defineTask({ name: 'pidot.test.memory-files-race', version: 1, initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} } })
const add = (source, id, content) => ({ action: 'add', id, content, sourceEntries: [source] })
async function fixture(t, { settleMs } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r2-race-')), root = join(dir, 'bot-workspaces'), storeHooks = {}
  let clock = Date.parse('2026-10-30T00:00:00Z')
  const registry = createRegistry(); registry.install({ name: 'memory-files-race', tasks: [Probe] })
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'isolated.sqlite')), { models: createModels(), registry, settings: { documentRetentionMs: 0 } }, context)
  const transaction = fn => harness.commit(fn, context)
  const service = createBotMemoryService({ getSecrets: () => [], now: () => (clock += 1000) })
  const files = createMemoryFiles({ store: createMemoryFileStore({ root, hooks: storeHooks }), service, transaction, snapshot: key => harness.snapshot(MemoryFileLedger, key, context), listBots: async () => ['chief', 'todo'], ...(settleMs === undefined ? {} : { settleMs }) })
  t.after(async () => { await files.close({ reconcile: false }); await harness.close(context); await rm(dir, { recursive: true, force: true }) })
  const source = await transaction(async tx => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const taskId = await tx.createTask(Probe, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } })
    const entry = await tx.appendEntry(conversation.id, { kind: 'pidot.user', data: { role: 'user', content: '证据' } })
    return { taskId, entryId: entry.id }
  })
  const path = (botId = 'chief') => join(root, `bots/${botId}/MEMORY.md`)
  return { files, service, transaction, source, storeHooks, path,
    memory: { botId: 'chief', kind: 'memory' },
    get: (botId = 'chief') => transaction(tx => service.get(tx, botId)),
    items: async (botId = 'chief') => (await transaction(tx => service.get(tx, botId))).memory.items.map(item => item.content).sort(),
    fileItems: async (botId = 'chief') => parseMemoryFile('memory', await readFile(path(botId))).value.items.map(item => item.content).sort(),
    revisions: async () => (await transaction(tx => service.history(tx, { botId: 'chief', kind: 'memory' }))).items,
    candidate: (botId, kind, patches, expectedVersion, requestId = `c-${Math.random()}`) => ({ botId, kind, requestId, expectedVersion, patches }),
  }
}

test('R2-04 UI edit racing a hand edit: reconcile first, stale expectedVersion is a 409 conflict, hand edit survives', async t => {
  const f = await fixture(t)
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [add(f.source, 'tone', '原内容')], 0)))
  await f.files.reconcile(f.memory)
  const uiVersion = (await f.get()).memory.version
  await writeFile(f.path(), '- 手改的内容 <!-- id:tone -->\n')
  await f.files.reconcile(f.memory)
  const stale = await f.transaction(tx => f.service.edit(tx, { botId: 'chief', kind: 'memory', requestId: 'ui-stale', expectedVersion: uiVersion, action: 'update', id: 'tone', content: '界面里的旧草稿' }))
  assert.equal(stale.code, 'MEMORY_VERSION_CONFLICT')
  assert.deepEqual(await f.items(), ['手改的内容'])
  assert.equal(await readFile(f.path(), 'utf8'), '- 手改的内容 <!-- id:tone -->\n')
})

test('R2-04 hand edit and extraction at once: both kept, same id resolves to the user, file shows the merge', async t => {
  const f = await fixture(t)
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [add(f.source, 'a', '甲'), add(f.source, 'b', '乙')], 0)))
  await f.files.reconcile(f.memory)
  // Extraction lands in the ledger while the user is editing the file (no write-back in between).
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [{ ...add(f.source, 'b', '乙（提取改写）'), action: 'update' }, add(f.source, 'c', '丙')], 1)))
  await writeFile(f.path(), '- 甲 <!-- id:a -->\n- 乙（用户改写） <!-- id:b -->\n- 用户新增\n')
  await f.files.reconcile(f.memory)
  assert.deepEqual(await f.items(), ['丙', '用户新增', '甲', '乙（用户改写）'].sort())
  assert.deepEqual(await f.fileItems(), await f.items())
  assert.equal(f.files.status(f.memory).state, 'synced')
})

test('R2-04 a save landing right before write-back rename is merged first, never overwritten; persistent racing is bounded', async t => {
  const f = await fixture(t)
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [add(f.source, 'a', '甲')], 0)))
  await f.files.reconcile(f.memory)
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [add(f.source, 'b', '提取的乙')], 1)))
  let saves = 0
  f.storeHooks.beforeRename = async () => { if (saves++ === 0) await writeFile(f.path(), '- 甲 <!-- id:a -->\n- 刚保存的手写\n') }
  await f.files.reconcile(f.memory)
  assert.deepEqual(await f.fileItems(), ['刚保存的手写', '提取的乙', '甲'].sort())
  assert.deepEqual(await f.items(), await f.fileItems())
  await f.transaction(async tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [add(f.source, 'c', '丙')], (await f.service.ledger(tx, 'chief', 'memory')).version)))
  let n = 0
  f.storeHooks.beforeRename = async () => { await writeFile(f.path(), `- 甲 <!-- id:a -->\n- 一直在改${++n}\n`) }
  await f.files.reconcile(f.memory)
  assert.equal(n, 3, 'mergeAttempts bounds the loop')
  assert.deepEqual({ state: f.files.status(f.memory).state, code: f.files.status(f.memory).code }, { state: 'pending', code: 'MEMORY_FILE_WRITE_FAILED' })
  assert.equal(await readFile(f.path(), 'utf8'), '- 甲 <!-- id:a -->\n- 一直在改3\n', 'the newest user save is on disk')
  delete f.storeHooks.beforeRename
  await f.files.reconcile(f.memory)
  assert.equal(f.files.status(f.memory).state, 'synced')
  assert.ok((await f.items()).includes('一直在改3'))
})

test('R2-04 extraction racing a hand edit of MEMORY.md rebases disjoint items; touched ids are not rebased (ABA safe)', async t => {
  const f = await fixture(t)
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [add(f.source, 'a', '甲')], 0)))
  await f.files.reconcile(f.memory)
  await writeFile(f.path(), '- 甲 <!-- id:a -->\n- 手写\n')
  await f.files.reconcile(f.memory)
  const disjoint = await applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate: f.candidate('chief', 'memory', [add(f.source, 'new', '新提取')], 1, 'extract-disjoint') })
  assert.equal(disjoint.ok, true)
  assert.equal(disjoint.attempts, 2)
  await writeFile(f.path(), '- 甲改 <!-- id:a -->\n- 手写\n- 新提取 <!-- id:new -->\n')
  await f.files.reconcile(f.memory)
  const touched = await applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate: f.candidate('chief', 'memory', [{ ...add(f.source, 'a', '旧提取覆盖'), action: 'update' }], 1, 'extract-touched') })
  assert.equal(touched.ok, false)
  assert.ok((await f.items()).includes('甲改'))
})

test('R2-04 per-target queue: concurrent reconciles of one hand edit produce exactly one file revision', async t => {
  const f = await fixture(t)
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [add(f.source, 'a', '甲')], 0)))
  await f.files.reconcile(f.memory)
  await writeFile(f.path(), '- 甲 <!-- id:a -->\n- 并发手写\n')
  await Promise.all([...Array.from({ length: 5 }, () => f.files.reconcile(f.memory)), f.files.schedule(f.memory), f.files.reconcileBot('chief'), f.files.reconcileAll()])
  await f.files.settled()
  assert.equal((await f.revisions()).filter(item => item.actor === 'file').length, 1)
  assert.deepEqual(await f.items(), ['并发手写', '甲'])
})

test('R2-04 shared USER.md: two Bots extracting and a hand edit all survive; Bot A memory never reaches Bot B', async t => {
  const f = await fixture(t)
  const prefs = { botId: 'chief', kind: 'preferences' }
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'preferences', [add(f.source, 'p1', '偏好一')], 0)))
  await f.files.reconcile(prefs)
  const shared = join(f.path().replace('bots/chief/MEMORY.md', 'shared/USER.md'))
  await writeFile(shared, (await readFile(shared, 'utf8')) + '- 手写偏好\n')
  await Promise.all([
    applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate: f.candidate('chief', 'preferences', [add(f.source, 'p2', '偏好二')], 1) }),
    applyMemoryCandidateWithRetry({ transaction: f.transaction, service: f.service, candidate: f.candidate('todo', 'preferences', [add(f.source, 'p3', '偏好三')], 1) }),
    f.files.reconcile({ botId: 'todo', kind: 'preferences' }),
  ])
  await f.files.reconcile(prefs)
  const items = (await f.get('todo')).preferences.items.map(item => item.content).sort()
  assert.deepEqual(items, ['偏好一', '偏好三', '偏好二', '手写偏好'].sort())
  assert.deepEqual(parseMemoryFile('preferences', await readFile(shared)).value.items.map(item => item.content).sort(), items)
  await f.files.reconcile({ botId: 'todo', kind: 'memory' })
  await mkdir(join(f.path(), '..'), { recursive: true, mode: 0o700 })
  await writeFile(f.path(), '- 只属于 chief 的私有记忆\n')
  await f.files.reconcileBot('chief')
  await f.files.reconcileBot('todo')
  const todo = buildMemoryContext(f.files.attach(await f.get('todo'), 'todo'))
  assert.equal(todo.text.includes('只属于 chief 的私有记忆'), false)
  assert.ok(buildMemoryContext(f.files.attach(await f.get('chief'), 'chief')).text.includes('只属于 chief 的私有记忆'))
})

test('R2-04 an in-place save caught mid-write (file truncated, bytes not yet written) is not imported as deletions', async t => {
  // Without settling (settleMs: 0) this imports the empty file and deletes both items; verified when written.
  const f = await fixture(t, { settleMs: 300 })
  await f.transaction(tx => f.service.applyCandidate(tx, f.candidate('chief', 'memory', [add(f.source, 'a', '甲'), add(f.source, 'b', '乙')], 0)))
  await f.files.reconcile(f.memory)
  const { open } = await import('node:fs/promises')
  const handle = await open(f.path(), 'w')
  const running = f.files.reconcile(f.memory)
  await new Promise(resolve => setTimeout(resolve, 30))
  await handle.writeFile('- 甲 <!-- id:a -->\n- 乙 <!-- id:b -->\n- 保存完成后新增\n'); await handle.close()
  await running
  assert.deepEqual(await f.items(), ['乙', '保存完成后新增', '甲'].sort())
  const revisions = (await f.revisions()).filter(item => item.actor === 'file')
  assert.equal(revisions.length, 1)
  assert.equal(revisions[0].changes.some(change => change.action === 'delete'), false)
})
