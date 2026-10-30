import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_FILE_MAX_BYTES } from './memory-file-format.mjs'
import { MemoryFileError, createMemoryFileStore } from './memory-file-store.mjs'

const memory = { botId: 'chief', kind: 'memory' }, shared = { botId: 'chief', kind: 'preferences' }
const sha = text => createHash('sha256').update(text).digest('hex')
const mode = async path => (await fs.stat(path)).mode & 0o777
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pidot-r2-store-')), root = join(dir, 'bot-workspaces')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return { dir, root, store: createMemoryFileStore({ root, ...options }) }
}
const rejects = (promise, code, reason) => assert.rejects(promise, error => error instanceof MemoryFileError && error.code === code && (!reason || error.reason === reason) && !error.message.includes('/'))
const leftovers = async directory => (await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))

test('R2-03 read/write: lazy 0700 directories, 0600 files, relative paths, hashes, missing file is null', async t => {
  const f = await fixture(t)
  assert.equal(await f.store.read(memory), null)
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' }, 'reads never create directories')
  assert.equal(f.store.relative(memory), 'bots/chief/MEMORY.md')
  assert.equal(f.store.relative({ botId: 'chief', kind: 'personality' }), 'bots/chief/PROFILE.md')
  assert.equal(f.store.relative(shared), 'shared/USER.md')
  const written = await f.store.write(memory, '- 中文\n', { expectedHash: null })
  assert.deepEqual(written, { ok: true, hash: sha('- 中文\n') })
  for (const path of [f.root, join(f.root, 'bots'), join(f.root, 'bots/chief')]) assert.equal(await mode(path), 0o700)
  assert.equal(await mode(join(f.root, 'bots/chief/MEMORY.md')), 0o600)
  const read = await f.store.read(memory)
  assert.equal(read.bytes.toString(), '- 中文\n')
  assert.equal(read.hash, written.hash)
  assert.equal((await f.store.write(memory, '- 二\n', { expectedHash: written.hash })).ok, true)
  assert.equal((await f.store.read(memory)).bytes.toString(), '- 二\n')
  assert.deepEqual(await leftovers(join(f.root, 'bots/chief')), [])
})

test('R2-03 expectedHash mismatch never overwrites, including a save that lands just before rename', async t => {
  const f = await fixture(t)
  const first = await f.store.write(memory, 'v1\n', { expectedHash: null })
  assert.deepEqual(await f.store.write(memory, 'stale\n', { expectedHash: sha('other') }), { ok: false, code: 'MEMORY_FILE_CONFLICT' })
  assert.deepEqual(await f.store.write(memory, 'new\n', { expectedHash: null }), { ok: false, code: 'MEMORY_FILE_CONFLICT' }, 'null means the file must not exist')
  const path = join(f.root, 'bots/chief/MEMORY.md')
  const racing = createMemoryFileStore({ root: f.root, hooks: { beforeRename: () => fs.writeFile(path, '用户刚保存\n') } })
  assert.deepEqual(await racing.write(memory, 'pidot\n', { expectedHash: first.hash }), { ok: false, code: 'MEMORY_FILE_CONFLICT' })
  assert.equal(await fs.readFile(path, 'utf8'), '用户刚保存\n')
  assert.deepEqual(await leftovers(join(f.root, 'bots/chief')), [], 'aborted write leaves no temporary file')
})

test('R2-03 invalid targets, traversal and symlinks (file, bot dir, parent, root) are rejected with diagnosable codes', async t => {
  const f = await fixture(t)
  for (const botId of ['..', '.', '../x', 'a/b', '', 'x'.repeat(200), null]) {
    await rejects(f.store.read({ botId, kind: 'memory' }), 'MEMORY_TARGET', 'target')
    await rejects(f.store.write({ botId, kind: 'memory' }, 'x', { expectedHash: null }), 'MEMORY_TARGET', 'target')
  }
  await rejects(f.store.read({ botId: 'chief', kind: 'notes' }), 'MEMORY_TARGET')
  const outside = join(f.dir, 'outside.md')
  await fs.writeFile(outside, '外部文件\n')
  await f.store.write(memory, 'x\n', { expectedHash: null })
  const path = join(f.root, 'bots/chief/MEMORY.md')
  await fs.rm(path); await fs.symlink(outside, path)
  await rejects(f.store.read(memory), 'MEMORY_FILE_UNAVAILABLE', 'symlink')
  assert.deepEqual(await f.store.write(memory, 'y\n', { expectedHash: null }), { ok: false, code: 'MEMORY_FILE_CONFLICT' })
  assert.equal(await fs.readFile(outside, 'utf8'), '外部文件\n')
  const elsewhere = join(f.dir, 'elsewhere')
  await fs.mkdir(elsewhere, { mode: 0o700 }); await fs.writeFile(join(elsewhere, 'MEMORY.md'), '别处\n')
  await fs.symlink(elsewhere, join(f.root, 'bots/todo'))
  await rejects(f.store.read({ botId: 'todo', kind: 'memory' }), 'MEMORY_FILE_UNAVAILABLE', 'symlink')
  await rejects(f.store.write({ botId: 'todo', kind: 'memory' }, 'z\n', { expectedHash: null }), 'MEMORY_FILE_UNAVAILABLE', 'symlink')
  assert.deepEqual(await fs.readdir(elsewhere), ['MEMORY.md'])
  await fs.symlink(elsewhere, join(f.root, 'shared'))
  await rejects(f.store.read(shared), 'MEMORY_FILE_UNAVAILABLE', 'symlink')
  const linkedRoot = join(f.dir, 'linked-root')
  await fs.symlink(f.root, linkedRoot)
  await rejects(createMemoryFileStore({ root: linkedRoot }).read(memory), 'MEMORY_FILE_UNAVAILABLE', 'symlink')
})

test('R2-03 non-regular files and oversized files are rejected without reading them', async t => {
  const f = await fixture(t)
  await fs.mkdir(join(f.root, 'bots/chief/MEMORY.md'), { recursive: true })
  await rejects(f.store.read(memory), 'MEMORY_FILE_UNAVAILABLE', 'not-file')
  const fifo = join(f.root, 'bots/chief/PROFILE.md')
  execFileSync('mkfifo', [fifo])
  await rejects(f.store.read({ botId: 'chief', kind: 'personality' }), 'MEMORY_FILE_UNAVAILABLE', 'not-file')
  await fs.mkdir(join(f.root, 'shared'), { mode: 0o700 })
  await fs.writeFile(join(f.root, 'shared/USER.md'), Buffer.alloc(MEMORY_FILE_MAX_BYTES + 1, 0x61), { mode: 0o600 })
  await rejects(f.store.read(shared), 'MEMORY_FILE_TOO_LONG', 'too-large')
  await rejects(f.store.write(shared, 'a'.repeat(MEMORY_FILE_MAX_BYTES + 1), { expectedHash: null }), 'MEMORY_FILE_TOO_LONG')
  await fs.writeFile(join(f.root, 'bots/x'), 'not a directory')
  await rejects(f.store.read({ botId: 'x', kind: 'memory' }), 'MEMORY_FILE_UNAVAILABLE', 'not-directory')
})

test('R2-03 too-wide permissions are tightened to 0700/0600 on read; unreadable files are diagnosable', async t => {
  const f = await fixture(t)
  await f.store.write(memory, 'x\n', { expectedHash: null })
  const path = join(f.root, 'bots/chief/MEMORY.md')
  await fs.chmod(path, 0o644); await fs.chmod(join(f.root, 'bots/chief'), 0o755); await fs.chmod(f.root, 0o777)
  assert.equal((await f.store.read(memory)).bytes.toString(), 'x\n')
  assert.equal(await mode(path), 0o600)
  assert.equal(await mode(join(f.root, 'bots/chief')), 0o700)
  assert.equal(await mode(f.root), 0o700)
  if (process.getuid?.() !== 0) {
    await fs.chmod(path, 0o000)
    await rejects(f.store.read(memory), 'MEMORY_FILE_UNAVAILABLE', 'permission')
    await fs.chmod(path, 0o600)
  }
})

test('R2-03 simulated disk full mid-write leaves the old file intact and no half-written file; next write sweeps crash leftovers', async t => {
  let full = true
  const faulty = { ...fs, open: async (path, flags, perm) => {
    const handle = await fs.open(path, flags, perm)
    if (!String(path).endsWith('.tmp') || !full) return handle
    return Object.assign(Object.create(handle), { writeFile: async bytes => { await handle.writeFile(bytes.subarray(0, 3)); throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) }, sync: () => handle.sync(), close: () => handle.close() })
  } }
  const f = await fixture(t, { fs: faulty })
  full = false
  const first = await f.store.write(memory, '- 原内容\n', { expectedHash: null })
  full = true
  await rejects(f.store.write(memory, '- 新内容很长很长\n', { expectedHash: first.hash }), 'MEMORY_FILE_WRITE_FAILED', 'disk-full')
  const directory = join(f.root, 'bots/chief')
  assert.equal(await fs.readFile(join(directory, 'MEMORY.md'), 'utf8'), '- 原内容\n')
  assert.deepEqual(await leftovers(directory), [])
  await fs.writeFile(join(directory, '.MEMORY.md.crashed.tmp'), 'half')
  await fs.writeFile(join(directory, '.PROFILE.md.other.tmp'), 'not mine')
  full = false
  assert.equal((await f.store.write(memory, '- 恢复\n', { expectedHash: first.hash })).ok, true)
  assert.deepEqual(await leftovers(directory), ['.PROFILE.md.other.tmp'], 'sweep only touches this target')
})
