import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore, TaskCard } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { createBotMemoryService } from './bot-memory.mjs'
import { parseMemoryFile, renderMemoryFile } from './memory-file-format.mjs'

const OLD_KINDS = ['pidot.bot-memory.document', 'pidot.bot-memory.status', 'pidot.bot-memory.revision', 'pidot.bot-memory.request', 'pidot.bot-memory.suppressed-source', 'pidot.memory-extraction']
const reply = (_message, options) => { calls.push(options.context?.systemPrompt ?? ''); return { mode: 'model', reply: { content: '好的' }, execution: { usage: { totalTokens: 3 } } } }
let calls = []
const config = { baseUrl: 'http://127.0.0.1:1/v1', model: 'r2-migration-model', apiKey: 'r2-migration-private-key' }
async function fixture(t, prefix = 'pidot-r2-migrate-') {
  const dir = await mkdtemp(join(tmpdir(), prefix)), file = join(dir, 'isolated.sqlite'), root = join(dir, 'bot-workspaces')
  let store
  t.after(async () => { await store?.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const open = async enabled => { await store?.close(); store = await openTaskStore({ file, bots: listBots(config), modelReply: reply, detectorOptions: { enabled: false }, memoryFiles: { enabled } }); return store }
  const close = async () => { await store?.close(); store = undefined }
  // Raw SQLite rows of the pre-R2 kinds: identity, value and every revision, byte for byte.
  const snapshot = () => {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const rows = db.prepare(`select d.id, d.kind, d.key_value, d.record, r.seq, r.kind as rk, r.version, r.content from documents d left join document_revisions r on r.document_id = d.id where json_extract(d.kind, '$') in (${OLD_KINDS.map(() => '?').join(',')}) order by d.id, r.seq`).all(...OLD_KINDS)
      const files = db.prepare(`select count(*) as n from documents where json_extract(kind, '$') = 'pidot.bot-memory.file'`).get().n
      return { rows: JSON.stringify(rows), count: rows.length, files }
    } finally { db.close() }
  }
  const source = async () => { const taskId = (await store.mainSessions()).chief; return store.harness.commit(async tx => {
    const card = await tx.doc(TaskCard, taskId)
    const entry = await tx.appendEntry(card.conversationId, { kind: 'pidot.user', data: { role: 'user', content: '迁移证据' } })
    return { taskId, entryId: entry.id }
  }, context) }
  const candidate = (ref, kind, id, content, expectedVersion) => store.harness.commit(tx => createBotMemoryService({ getSecrets: () => [] }).applyCandidate(tx, { botId: 'chief', kind, requestId: `m-${kind}-${id}`, expectedVersion, patches: [{ action: 'add', id, content, sourceEntries: [ref] }] }), context)
  const path = relative => join(root, relative)
  return { dir, file, root, open, close, snapshot, source, candidate, path, get store() { return store },
    exists: async relative => Boolean(await lstat(path(relative)).catch(() => null)),
    read: relative => readFile(path(relative), 'utf8'),
    mtimes: async () => Object.fromEntries(await Promise.all(['bots/chief/PROFILE.md', 'bots/chief/MEMORY.md', 'shared/USER.md'].map(async relative => [relative, (await stat(path(relative))).mtimeMs]))),
  }
}
async function seed(f) {
  const s = await f.open(false)
  const ref = await f.source()
  const memory = await s.getBotMemory('chief')
  await s.editBotMemory('chief', { kind: 'personality', action: 'set', content: '迁移前的人格', expectedVersion: memory.personality.version, requestId: 'seed-personality' })
  await f.candidate(ref, 'memory', 'fact', '迁移前的记忆', 0)
  await f.candidate(ref, 'preferences', 'pref', '偏好中文', 0)
  await f.candidate(ref, 'memory', 'gone', '将被删除', 1)
  // The UI delete writes a SuppressedSources tombstone: the snapshot must cover that family too.
  await s.editBotMemory('chief', { kind: 'memory', action: 'delete', id: 'gone', expectedVersion: 2, requestId: 'seed-delete' })
  return ref
}

test('R2-05 migration only adds files and file ledgers: pre-R2 documents byte-identical, files equal the ledger, second start writes nothing', async t => {
  const f = await fixture(t)
  await seed(f)
  await f.close()
  const before = f.snapshot()
  assert.equal(before.files, 0)
  assert.equal(await f.exists(''), false, 'Document mode creates no directory')
  let s = await f.open(true)
  const ledger = await s.getBotMemory('chief')
  await f.close()
  const after = f.snapshot()
  assert.equal(after.rows, before.rows, 'old Documents/Status/Revisions/Requests/SuppressedSources/extraction untouched')
  assert.ok(after.files >= 3)
  assert.equal(await f.read('bots/chief/PROFILE.md'), '迁移前的人格\n')
  for (const [relative, kind, doc] of [['bots/chief/MEMORY.md', 'memory', ledger.memory], ['shared/USER.md', 'preferences', ledger.preferences]]) {
    assert.deepEqual(parseMemoryFile(kind, await f.read(relative)).value.items, doc.items.map(({ id, content }) => ({ id, content })))
    assert.equal(await f.read(relative), renderMemoryFile(kind, doc))
    assert.equal(doc.file.state, 'synced')
  }
  assert.deepEqual(Object.keys(ledger.personality.file), ['path', 'state', 'code', 'syncedAt'])
  assert.equal(await f.exists('bots/todo/MEMORY.md'), false, 'empty memory of other Bots produces no file')
  const mtimes = await f.mtimes(), files = f.snapshot()
  s = await f.open(true)
  await s.getBotMemory('chief'); await s.getPreferences()
  await f.close()
  assert.deepEqual(await f.mtimes(), mtimes, 'repeated start does not touch files')
  assert.deepEqual(f.snapshot(), files, 'repeated start writes no ledger or document change')
})

test('R2-05 a file created before first enable is imported against an empty base: only additions, ledger items never deleted', async t => {
  const f = await fixture(t)
  await seed(f)
  await f.close()
  const { mkdir } = await import('node:fs/promises')
  await mkdir(f.path('bots/chief'), { recursive: true, mode: 0o700 })
  await writeFile(f.path('bots/chief/MEMORY.md'), '- 提前手建的一条\n')
  const s = await f.open(true)
  const memory = (await s.getBotMemory('chief')).memory
  assert.deepEqual(memory.items.map(item => item.content).sort(), ['提前手建的一条', '迁移前的记忆'].sort())
  assert.equal(memory.items.find(item => item.content === '迁移前的记忆').sourceEntries.length, 1)
  assert.equal(memory.file.state, 'synced')
  assert.ok((await f.read('bots/chief/MEMORY.md')).includes('迁移前的记忆'))
})

test('R2-05 on → write → hand edit → off → read → on: nothing lost; off behaves like Document mode; re-enable merges three-way', async t => {
  const f = await fixture(t)
  let s = await f.open(true)
  const ref = await f.source()
  await f.candidate(ref, 'memory', 'fact', '开启时写入', 0)
  await s.memoryFiles.settled()
  await f.close()
  // Hand edit while the service is stopped, then roll back with the switch.
  await writeFile(f.path('bots/chief/MEMORY.md'), '- 开启时写入 <!-- id:fact -->\n- 关闭前手写\n')
  s = await f.open(false)
  assert.equal(s.memoryFiles, null)
  let view = await s.getBotMemory('chief')
  assert.deepEqual(view.memory.items.map(item => item.content).sort(), ['关闭前手写', '开启时写入'].sort(), 'unsynced hand edit is imported once at rollback')
  assert.equal(view.memory.file, null)
  assert.equal(view.personality.file, null)
  const fileBytes = await f.read('bots/chief/MEMORY.md')
  // Off: UI edits only touch the ledger; files stay as they are.
  await s.editBotMemory('chief', { kind: 'memory', action: 'delete', id: 'fact', expectedVersion: view.memory.version, requestId: 'off-delete' })
  calls = []
  const { taskId } = await s.create({ botId: 'chief' })
  await s.send(taskId, '关闭前手写 有来源的记忆')
  for (let i = 0; i < 300 && !calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(calls[0].includes('Bot记忆：关闭前手写 [手写]'))
  assert.equal(calls[0].includes('开启时写入'), false)
  assert.equal(await f.read('bots/chief/MEMORY.md'), fileBytes)
  await f.close()
  s = await f.open(false)
  assert.equal((await s.getBotMemory('chief')).memory.version, view.memory.version + 1, 'second rollback start replays nothing')
  await f.close()
  // While off, the user also edits the file again; re-enable must keep both sides.
  await writeFile(f.path('bots/chief/MEMORY.md'), '- 开启时写入 <!-- id:fact -->\n- 关闭前手写\n- 关闭期间又手写\n')
  s = await f.open(true)
  view = await s.getBotMemory('chief')
  const contents = view.memory.items.map(item => item.content).sort()
  assert.deepEqual(contents, ['关闭前手写', '关闭期间又手写'].sort(), 'UI deletion while off and the later hand addition both survive')
  assert.deepEqual(parseMemoryFile('memory', await f.read('bots/chief/MEMORY.md')).value.items.map(item => item.content).sort(), contents)
  assert.equal(view.memory.file.state, 'synced')
})

test('R2-05 Document mode on a fresh store: no files, no file ledgers, file:null, pre-R2 provenance format', async t => {
  const f = await fixture(t)
  const s = await f.open(false)
  const ref = await f.source()
  await f.candidate(ref, 'memory', 'fact', '有来源的记忆', 0)
  const view = await s.getBotMemory('chief'), prefs = await s.getPreferences()
  assert.equal(view.memory.file, null); assert.equal(prefs.file, null)
  calls = []
  const { taskId } = await s.create({ botId: 'chief' })
  await s.send(taskId, '关闭前手写 有来源的记忆')
  for (let i = 0; i < 300 && !calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(calls[0].includes(`Bot记忆：有来源的记忆 [${ref.taskId}/${ref.entryId}]`))
  assert.equal(calls[0].includes('文件提示'), false)
  await f.close()
  assert.equal(f.snapshot().files, 0)
  assert.equal(await f.exists(''), false)
})

for (const mode of ['after-import', 'before-rename', 'after-rename']) {
  test(`R2-05 SIGKILL at ${mode}: restart leaves file and ledger consistent, no duplicate revision, no half file`, async t => {
    const f = await fixture(t, 'pidot-r2-crash-')
    const child = spawn(process.execPath, ['server/fixtures/memory-files-process.mjs', f.file, mode], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stderr.on('data', data => { errors += data })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`crash worker timeout ${errors}`)), 15000)
        child.stdout.on('data', data => { output += data; if (output.includes('"point"')) { clearTimeout(timer); resolve() } })
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`worker exited ${code}: ${errors}`)) })
      })
      assert.equal(JSON.parse(output.trim().split('\n').at(-1)).point, mode)
      child.kill('SIGKILL'); const [, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL')
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
    const killed = await readdir(f.path('bots/chief'))
    assert.equal(killed.some(name => name.endsWith('.tmp')), mode === 'before-rename', 'only a kill before rename leaves a temporary file behind')
    assert.equal(parseMemoryFile('memory', await f.read('bots/chief/MEMORY.md')).ok, true, 'the target file is whole at every crash point')
    const s = await f.open(true)
    const view = await s.getBotMemory('chief')
    const items = view.memory.items.map(item => item.content).sort()
    assert.deepEqual(items, ['原有条目', '崩溃前手写', '提取条目'].sort())
    assert.equal(view.memory.version, 3, 'a(1) + c(2) + one file import(3)')
    assert.equal(view.history.memory.filter(item => item.actor === 'file').length, 1)
    assert.deepEqual(parseMemoryFile('memory', await f.read('bots/chief/MEMORY.md')).value.items.map(item => item.content).sort(), items)
    assert.equal(view.memory.file.state, 'synced')
    assert.deepEqual((await readdir(f.path('bots/chief'))).filter(name => name.endsWith('.tmp')), [], 'no leftover temporary file')
    await f.close()
    const again = await f.open(true)
    assert.equal((await again.getBotMemory('chief')).memory.version, 3)
  })
}
