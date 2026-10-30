import { constants } from 'node:fs'
import * as nodeFs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { validId } from './bot-memory.mjs'
import { MEMORY_FILE_MAX_BYTES, MEMORY_FILE_NAMES } from './memory-file-format.mjs'

const MESSAGES = { MEMORY_TARGET: '记忆文件目标无效。', MEMORY_FILE_TOO_LONG: '记忆文件过长。', MEMORY_FILE_UNAVAILABLE: '记忆文件不可访问。', MEMORY_FILE_WRITE_FAILED: '记忆文件写入失败。' }
/** Public message is fixed Chinese text; never a path or OS error. `reason` is a closed diagnostic word. */
export class MemoryFileError extends Error {
  constructor(code, reason) { super(MESSAGES[code] ?? '记忆文件操作失败。'); this.name = 'MemoryFileError'; this.code = code; this.reason = reason }
}
const fail = (code, reason) => { throw new MemoryFileError(code, reason) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function classify(error, fallback) {
  if (error instanceof MemoryFileError) return error
  if (['ELOOP', 'EMLINK'].includes(error?.code)) return new MemoryFileError('MEMORY_FILE_UNAVAILABLE', 'symlink')
  if (['ENOSPC', 'EDQUOT'].includes(error?.code)) return new MemoryFileError('MEMORY_FILE_WRITE_FAILED', 'disk-full')
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return new MemoryFileError(fallback, 'permission')
  return new MemoryFileError(fallback, 'io')
}

/**
 * The only filesystem access for R2 memory files. One writer per target is the caller's job (per-target queue).
 * Never follows symlinks (root, every directory, the file); directories 0700, files 0600, tightened on read.
 */
export function createMemoryFileStore({ root, fs = nodeFs, hooks = {} } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('Memory file root is required')
  root = resolve(root)
  const segments = target => {
    const { botId, kind } = target ?? {}
    if (!Object.hasOwn(MEMORY_FILE_NAMES, kind) || kind !== 'preferences' && (!validId(botId) || ['.', '..'].includes(botId))) fail('MEMORY_TARGET', 'target')
    return kind === 'preferences' ? ['shared', MEMORY_FILE_NAMES[kind]] : ['bots', botId, MEMORY_FILE_NAMES[kind]]
  }
  async function directories(parts, create) {
    let path = root
    for (const part of [null, ...parts]) {
      if (part !== null) path = join(path, part)
      let info
      try { info = await fs.lstat(path) }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error
        if (!create) return false
        try { await fs.mkdir(path, { mode: 0o700 }) } catch (inner) { if (inner?.code !== 'EEXIST') throw classify(inner, 'MEMORY_FILE_WRITE_FAILED') }
        info = await fs.lstat(path)
      }
      if (info.isSymbolicLink()) fail('MEMORY_FILE_UNAVAILABLE', 'symlink')
      if (!info.isDirectory()) fail('MEMORY_FILE_UNAVAILABLE', 'not-directory')
      if (info.mode & 0o077) await fs.chmod(path, 0o700)
    }
    return true
  }
  async function read(target) {
    const parts = segments(target)
    try {
      if (!await directories(parts.slice(0, -1), false)) return null
      let handle
      // O_NONBLOCK: a FIFO planted at the path must not hang the reader; it is then rejected as non-file.
      try { handle = await fs.open(join(root, ...parts), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error }
      try {
        const info = await handle.stat()
        if (!info.isFile()) fail('MEMORY_FILE_UNAVAILABLE', 'not-file')
        if (info.size > MEMORY_FILE_MAX_BYTES) fail('MEMORY_FILE_TOO_LONG', 'too-large')
        if (info.mode & 0o077) await handle.chmod(0o600)
        // Bounded read even if the file grows after stat().
        const buffer = Buffer.alloc(MEMORY_FILE_MAX_BYTES + 1)
        let length = 0
        for (;;) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
          if (!bytesRead) break
          length += bytesRead
          if (length > MEMORY_FILE_MAX_BYTES) fail('MEMORY_FILE_TOO_LONG', 'too-large')
        }
        const bytes = Buffer.from(buffer.subarray(0, length))
        return { bytes, hash: digest(bytes), mtimeMs: info.mtimeMs }
      } finally { await handle.close() }
    } catch (error) { throw classify(error, 'MEMORY_FILE_UNAVAILABLE') }
  }
  /** Atomic replace. expectedHash: the bytes the caller merged from (null = must not exist); mismatch → conflict, nothing written. */
  async function write(target, text, { expectedHash } = {}) {
    if (expectedHash !== null && typeof expectedHash !== 'string') throw new TypeError('expectedHash must be a hash or null')
    const parts = segments(target), name = parts.at(-1), directory = join(root, ...parts.slice(0, -1))
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.byteLength > MEMORY_FILE_MAX_BYTES) fail('MEMORY_FILE_TOO_LONG', 'too-large')
    let temporary
    try {
      await directories(parts.slice(0, -1), true)
      // Leftovers of a crash before rename. Only this target's own prefix; its queue is the only writer.
      for (const entry of await fs.readdir(directory)) if (entry.startsWith(`.${name}.`) && entry.endsWith('.tmp')) await fs.rm(join(directory, entry), { force: true })
      temporary = join(directory, `.${name}.${randomUUID()}.tmp`)
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await hooks.beforeRename?.(target)
      // Re-check right before rename: a save that landed after the caller's read must not be overwritten.
      let current
      try { current = await read(target) } catch { return { ok: false, code: 'MEMORY_FILE_CONFLICT' } }
      if ((current?.hash ?? null) !== expectedHash) return { ok: false, code: 'MEMORY_FILE_CONFLICT' }
      await fs.rename(temporary, join(directory, name))
      temporary = undefined
      const handleDirectory = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
      try { await handleDirectory.sync() } finally { await handleDirectory.close() }
      await hooks.afterRename?.(target)
      return { ok: true, hash: digest(bytes) }
    } catch (error) { throw classify(error, 'MEMORY_FILE_WRITE_FAILED') }
    finally { if (temporary) await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
  return { relative: target => segments(target).join('/'), read, write }
}
