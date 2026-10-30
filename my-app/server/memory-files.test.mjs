import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry, defineTask, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { buildMemoryContext, createBotMemoryService } from './bot-memory.mjs'
import { MEMORY_FILE_HEADER, fileItemId, parseMemoryFile } from './memory-file-format.mjs'
import { createMemoryFileStore } from './memory-file-store.mjs'
import { MemoryFileLedger, createMemoryFiles } from './memory-files.mjs'

const Probe = defineTask({ name: 'pidot.test.memory-files', version: 1, initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} } })
const FILES = { personality: 'bots/chief/PROFILE.md', memory: 'bots/chief/MEMORY.md', preferences: 'shared/USER.md' }
const add = (source, id, content) => ({ action: 'add', id, content, sourceEntries: [source] })
async function fixture(t, { limits, auto = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r2-files-')), root = join(dir, 'bot-workspaces'), hooks = {}, storeHooks = {}
  const now = Date.parse('2026-10-30T00:00:00Z'), secrets = [`model-key-${Date.now()}-r2`]
  const registry = createRegistry(); registry.install({ name: 'memory-files-probe', tasks: [Probe] })
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'isolated.sqlite')), { models: createModels(), registry, settings: { documentRetentionMs: 0 } }, context)
  let commits = 0
  harness.subscribeCommits(() => { commits++ })
  const transaction = fn => harness.commit(fn, context)
  const service = createBotMemoryService({ getSecrets: () => secrets, now: () => now, ...(limits ? { limits } : {}) })
  let files
  const make = () => {
    files = createMemoryFiles({ store: createMemoryFileStore({ root, hooks: storeHooks }), service, transaction, snapshot: key => harness.snapshot(MemoryFileLedger, key, context), listBots: async () => ['chief', 'todo'], now: () => now, hooks })
    if (auto) files.start(schedule => harness.subscribeCommits(({ changes }) => { for (const c of changes) if (c.type === 'document' && c.record?.kind === 'pidot.bot-memory.revision' && c.value?.record) schedule({ botId: c.value.record.botId, kind: c.value.record.kind }) }))
    return files
  }
  make()
  t.after(async () => { await files.close({ reconcile: false }); await harness.close(context); await rm(dir, { recursive: true, force: true }) })
  const source = await transaction(async tx => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const taskId = await tx.createTask(Probe, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } })
    const entry = await tx.appendEntry(conversation.id, { kind: 'pidot.user', data: { role: 'user', content: '我在杭州工作，偏好简洁回答' } })
    return { taskId, entryId: entry.id }
  })
  const target = (kind, botId = 'chief') => ({ botId, kind })
  const path = kind => join(root, FILES[kind])
  const get = (botId = 'chief') => transaction(tx => service.get(tx, botId))
  return { dir, root, hooks, storeHooks, service, transaction, source, secrets, target, path, get, get files() { return files }, restart: async () => { await files.close({ reconcile: false }); return make() },
    commits: () => commits,
    read: kind => readFile(path(kind), 'utf8'),
    write: (kind, text) => writeFile(path(kind), text),
    exists: async relative => Boolean(await lstat(join(root, relative)).catch(() => null)),
    history: kind => transaction(tx => service.history(tx, { botId: 'chief', kind })),
    raw: kind => transaction(tx => service.ledger(tx, 'chief', kind)),
    candidate: (kind, patches, expectedVersion = 0) => transaction(tx => service.applyCandidate(tx, { botId: 'chief', kind, requestId: `c-${Math.random()}`, expectedVersion, patches })),
    edit: input => transaction(tx => service.edit(tx, { botId: 'chief', kind: 'memory', requestId: `u-${Math.random()}`, expectedVersion: 0, ...input })),
    context: async (botId = 'chief') => buildMemoryContext(files.attach(await get(botId), botId), { secrets }),
  }
}

test('R2-04 ledger content is written back; empty targets create nothing; repeated reconcile writes and commits nothing', async t => {
  const f = await fixture(t, { auto: false })
  await f.edit({ kind: 'personality', action: 'set', content: '温暖、直接' })
  await f.candidate('memory', [add(f.source, 'tone', '偏好简洁的中文回答')])
  await f.files.reconcileAll()
  assert.equal(await f.read('personality'), '温暖、直接\n')
  assert.equal(await f.read('memory'), `${MEMORY_FILE_HEADER}\n- 偏好简洁的中文回答 <!-- id:tone -->\n`)
  assert.deepEqual(parseMemoryFile('memory', await f.read('memory')).value.items, [{ id: 'tone', content: '偏好简洁的中文回答' }])
  assert.equal(await f.exists('shared'), false)
  assert.equal(await f.exists('bots/todo'), false, 'empty Bot gets no directory')
  assert.equal((await stat(f.path('memory'))).mode & 0o777, 0o600)
  assert.deepEqual(f.files.status(f.target('memory')), { path: 'bot-workspaces/bots/chief/MEMORY.md', state: 'synced', code: null, syncedAt: '2026-10-30T00:00:00.000Z' })
  assert.deepEqual(f.files.status(f.target('memory', 'todo')), { path: 'bot-workspaces/bots/todo/MEMORY.md', state: 'synced', code: null, syncedAt: null })
  assert.deepEqual(f.files.status(f.target('preferences', 'todo')).path, 'bot-workspaces/shared/USER.md')
  await f.files.reconcileAll()
  const mtimes = [(await stat(f.path('memory'))).mtimeMs, (await stat(f.path('personality'))).mtimeMs], commits = f.commits()
  await f.files.reconcileAll()
  assert.deepEqual([(await stat(f.path('memory'))).mtimeMs, (await stat(f.path('personality'))).mtimeMs], mtimes)
  assert.equal(f.commits(), commits, 'a no-op reconcile must not commit')
  assert.deepEqual(f.files.summary(), { targets: 5, synced: 5, rejected: 0, pending: 0 })
})

test('R2-04 hand modify/add/delete → one actor:file revision; rewrites keep sources, new lines are hand-written; no tombstone; no reformat', async t => {
  const f = await fixture(t)
  await f.candidate('memory', [add(f.source, 'tone', '偏好简洁的中文回答'), add(f.source, 'city', '我在杭州工作')])
  await f.files.settled()
  const text = '# 我的记忆\n- 偏好简洁、先给结论 <!-- id:tone -->\n- 这是我手写的一条\n'
  await f.write('memory', text)
  await f.files.reconcile(f.target('memory'))
  const doc = (await f.get()).memory, hand = fileItemId('这是我手写的一条')
  assert.equal(doc.version, 2)
  assert.deepEqual(doc.items.map(item => [item.id, item.content, item.sourceEntries]), [['tone', '偏好简洁、先给结论', [f.source]], [hand, '这是我手写的一条', []]])
  assert.equal(await f.read('memory'), text, 'a fully absorbed hand edit is not reformatted')
  const [revision] = (await f.history('memory')).items
  assert.equal(revision.actor, 'file')
  assert.deepEqual(revision.changes.map(change => `${change.action}:${change.id}`), ['update:tone', 'delete:city', `add:${hand}`])
  // Q5: deleting in the file writes no SuppressedSources; the same old evidence may be extracted again.
  const again = await f.candidate('memory', [add(f.source, 'city-again', '我在杭州工作')], 2)
  assert.equal(again.ok, true, JSON.stringify(again.code))
  await f.files.settled()
  const written = parseMemoryFile('memory', await f.read('memory')).value.items.map(item => item.content)
  assert.deepEqual(written.sort(), ['偏好简洁、先给结论', '这是我手写的一条', '我在杭州工作'].sort(), 'extraction after a hand edit appears in the file')
  assert.equal((await f.read('memory')).startsWith(MEMORY_FILE_HEADER), true)
})

test('R2-04 PROFILE.md hand edit sets personality with user rights; an emptied file clears it', async t => {
  const f = await fixture(t)
  await f.edit({ kind: 'personality', action: 'set', content: '旧人格' })
  await f.files.settled()
  await f.write('personality', '\n新的人格\n第二行\n\n')
  await f.files.reconcile(f.target('personality'))
  assert.equal((await f.get()).personality.content, '新的人格\n第二行')
  assert.equal((await f.history('personality')).items[0].actor, 'file')
  await f.write('personality', '')
  await f.files.reconcile(f.target('personality'))
  const cleared = (await f.get()).personality
  assert.equal(cleared.content, '')
  assert.equal(cleared.version, 3)
  assert.equal(await f.read('personality'), '')
})

test('R2-04 a key in a hand-edited file is imported (Q7): reads redact, injection skips it, write-back keeps the raw text', async t => {
  const f = await fixture(t, { auto: false })
  await f.candidate('memory', [add(f.source, 'x', '旧事实')])
  await f.files.reconcile(f.target('memory'))
  await f.candidate('memory', [add(f.source, 'y', '后来提取的')], 1)
  const key = f.secrets[0]
  await f.write('memory', `- 旧事实 <!-- id:x -->\n- 测试用的 key 是 ${key}\n- 普通手写\n`)
  await f.files.reconcile(f.target('memory'))
  assert.equal(f.files.status(f.target('memory')).state, 'synced')
  assert.ok((await f.raw('memory')).items.some(item => item.content.includes(key)))
  assert.equal(JSON.stringify(await f.get()).includes(key), false, 'projections stay redacted')
  const context = await f.context()
  assert.equal(context.text.includes(key), false)
  assert.ok(context.text.includes('Bot记忆：普通手写 [手写]'))
  assert.ok((await f.read('memory')).includes(`测试用的 key 是 ${key}`), 'write-back renders raw ledger text, never the redaction marker')
  assert.ok((await f.read('memory')).includes('后来提取的'))
  // A stored key no longer blocks further candidate/UI writes; only new input is scanned (ADR-019).
  const later = await f.candidate('memory', [add(f.source, 'z', '再提取')], 3)
  assert.equal(later.code, null)
  assert.equal(JSON.stringify(later).includes(key), false)
})

test('R2-04 hand-written items: injected as [手写]; UI may correct them keeping no sources; UI still cannot add unsourced items', async t => {
  const f = await fixture(t)
  await f.edit({ kind: 'personality', action: 'set', content: '人格' })
  await f.files.settled()
  await f.write('memory', '- 手写一条\n')
  await f.files.reconcile(f.target('memory'))
  assert.ok((await f.context()).text.includes('Bot记忆：手写一条 [手写]'))
  const id = fileItemId('手写一条')
  const corrected = await f.edit({ expectedVersion: 1, action: 'update', id, content: '手写一条（已改）', sourceEntries: [] })
  assert.equal(corrected.ok, true, corrected.code)
  assert.deepEqual(corrected.document.items[0].sourceEntries, [])
  assert.equal((await f.edit({ expectedVersion: 2, action: 'add', id: 'ui-new', content: '界面新增', sourceEntries: [] })).code, 'MEMORY_SOURCE_REQUIRED')
  await f.files.settled()
  assert.ok((await f.read('memory')).includes(`- 手写一条（已改） <!-- id:${id} -->`), 'id is kept once content no longer derives it')
})

test('R2-04 too long / invalid / unavailable: file and ledger untouched, exactly one notice line, no content, same bytes not re-validated, auto recovery', async t => {
  const f = await fixture(t)
  await f.candidate('memory', [add(f.source, 'tone', '旧的台账内容')])
  await f.files.settled()
  const tooLong = Array.from({ length: 65 }, (_, i) => `- 新内容标记${i}`).join('\n')
  await f.write('memory', tooLong)
  await f.files.reconcile(f.target('memory'))
  assert.deepEqual({ ...f.files.status(f.target('memory')), syncedAt: undefined }, { path: 'bot-workspaces/bots/chief/MEMORY.md', state: 'rejected', code: 'MEMORY_FILE_TOO_LONG', syncedAt: undefined })
  assert.equal(await f.read('memory'), tooLong)
  assert.equal((await f.get()).memory.version, 1)
  const context = await f.context()
  assert.deepEqual(context.text.split('\n').slice(1), ['文件提示：MEMORY.md（Bot 记忆）过长，本次未提供，请让用户精简。'])
  assert.equal(context.text.includes('旧的台账内容') || context.text.includes('新内容标记'), false, 'no new and no old content')
  const commits = f.commits()
  await f.files.reconcile(f.target('memory'))
  assert.equal(f.commits(), commits, 'the same rejected bytes are not validated again')
  await f.candidate('memory', [add(f.source, 'later', '拒绝期间提取的')], 1)
  await f.files.settled()
  assert.equal(await f.read('memory'), tooLong, 'a rejected file is never overwritten')
  await f.write('memory', '- 改好了 <!-- id:tone -->\n- 新手写\n')
  await f.files.reconcile(f.target('memory'))
  assert.equal(f.files.status(f.target('memory')).state, 'synced')
  assert.deepEqual((await f.get()).memory.items.map(item => item.content), ['改好了', '拒绝期间提取的', '新手写'])
  assert.ok((await f.read('memory')).includes('拒绝期间提取的'))
  await f.write('memory', Buffer.from([0x2d, 0x20, 0xc3, 0x28, 0x0a]))
  await f.files.reconcile(f.target('memory'))
  assert.equal(f.files.status(f.target('memory')).code, 'MEMORY_FILE_INVALID')
  assert.deepEqual((await f.context()).text.split('\n').slice(1), ['文件提示：MEMORY.md（Bot 记忆）无法读取，本次未提供，请让用户检查文件。'])
  const outside = join(f.dir, 'outside.md')
  await writeFile(outside, '- 外部\n'); await rm(f.path('memory')); await symlink(outside, f.path('memory'))
  await f.files.reconcile(f.target('memory'))
  assert.equal(f.files.status(f.target('memory')).code, 'MEMORY_FILE_UNAVAILABLE')
  assert.equal(await readFile(outside, 'utf8'), '- 外部\n')
  await rm(f.path('memory'))
  await f.files.reconcile(f.target('memory'))
  assert.equal(f.files.status(f.target('memory')).state, 'synced', 'a removed file is recreated from the ledger')
  assert.ok((await f.read('memory')).includes('改好了'))
})

test('R2-04 rejected PROFILE.md and USER.md give their own single notices; other documents still inject', async t => {
  const f = await fixture(t)
  await f.edit({ kind: 'personality', action: 'set', content: '旧人格' })
  await f.candidate('memory', [add(f.source, 'tone', '仍然注入的记忆')])
  await f.files.settled()
  await f.write('personality', '人'.repeat(8193))
  await f.files.reconcile(f.target('personality'))
  await mkdir(join(f.root, 'shared'), { mode: 0o700 }); await writeFile(join(f.root, 'shared/USER.md'), Buffer.from([0xff]))
  await f.files.reconcile(f.target('preferences'))
  const lines = (await f.context()).text.split('\n')
  assert.deepEqual(lines.slice(1, 3), ['文件提示：PROFILE.md（人格）过长，本次未提供，请让用户精简。', '文件提示：USER.md（共享偏好）无法读取，本次未提供，请让用户检查文件。'])
  assert.equal(lines.some(line => line.startsWith('人格：')), false)
  assert.ok(lines.includes(`Bot记忆：仍然注入的记忆 [${f.source.taskId}/${f.source.entryId}]`))
})

test('R2-04 ledger + file over the limit is rejected without changes and retried once space is freed (no file patch cap)', async t => {
  const f = await fixture(t, { limits: { items: 3 }, auto: false })
  await f.candidate('memory', [add(f.source, 'a', '甲'), add(f.source, 'b', '乙')])
  await f.files.reconcile(f.target('memory'))
  await f.candidate('memory', [add(f.source, 'c', '丙')], 1)
  const text = '- 甲 <!-- id:a -->\n- 乙 <!-- id:b -->\n- 丁\n'
  await f.write('memory', text)
  await f.files.reconcile(f.target('memory'))
  assert.equal(f.files.status(f.target('memory')).code, 'MEMORY_FILE_TOO_LONG')
  assert.equal((await f.get()).memory.version, 2)
  assert.equal((await f.get()).memory.status.state, 'ready', 'a rolled-back file import writes no pending status')
  assert.equal(await f.read('memory'), text)
  await f.edit({ expectedVersion: 2, action: 'delete', id: 'c' })
  await f.files.reconcile(f.target('memory'))
  assert.equal(f.files.status(f.target('memory')).state, 'synced')
  assert.deepEqual((await f.get()).memory.items.map(item => item.content), ['甲', '乙', '丁'])
})

test('R2-04 crash points at unit level: import replay, failed write before rename, rename without bookkeeping — no duplicate revisions', async t => {
  const f = await fixture(t, { auto: false })
  const fileRevisions = async () => (await f.history('memory')).items.filter(item => item.actor === 'file').length
  await f.candidate('memory', [add(f.source, 'x', '原有')])
  await f.files.reconcile(f.target('memory'))
  await f.candidate('memory', [add(f.source, 'y', '提取')], 1)
  await f.write('memory', '- 原有 <!-- id:x -->\n- 手写\n')
  f.hooks.afterImport = () => { throw new Error('crash after import commit') }
  await assert.rejects(f.files.reconcile(f.target('memory')))
  delete f.hooks.afterImport
  assert.equal(await fileRevisions(), 1)
  await (await f.restart()).reconcile(f.target('memory'))
  assert.equal(await fileRevisions(), 1, 'same requestId replays the receipt')
  assert.deepEqual(parseMemoryFile('memory', await f.read('memory')).value.items.map(item => item.content).sort(), ['原有', '提取', '手写'].sort())
  await f.candidate('memory', [add(f.source, 'z', '再提取')], 3)
  const before = await f.read('memory')
  f.storeHooks.beforeRename = () => { throw new Error('crash before rename') }
  await f.files.reconcile(f.target('memory'))
  assert.deepEqual(f.files.status(f.target('memory')).state, 'pending')
  assert.equal(await f.read('memory'), before)
  delete f.storeHooks.beforeRename
  f.storeHooks.afterRename = () => { throw new Error('crash after rename') }
  await f.files.reconcile(f.target('memory'))
  delete f.storeHooks.afterRename
  assert.ok((await f.read('memory')).includes('再提取'))
  const version = (await f.get()).memory.version
  await (await f.restart()).reconcile(f.target('memory'))
  assert.equal((await f.get()).memory.version, version, 'the rendered file is recognised, not re-imported')
  assert.equal(await fileRevisions(), 1)
  assert.equal(f.files.status(f.target('memory')).state, 'synced')
})
