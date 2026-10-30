import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { googleError } from './google-client.mjs'

// <db dir>/google/credentials.json: 0700 directory, 0600 file, atomic replace, O_NOFOLLOW reads.
// Same discipline as external-mcp/credentials.json and model-settings.json. Never in SQLite.
const MAX_BYTES = 64 * 1024
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const control = value => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !control(value)
export const emptyGoogleCredentials = () => ({ version: 1, client: null, account: null })
export function validGoogleClient(value) {
  return plain(value) && Object.keys(value).every(key => ['clientId', 'clientSecret'].includes(key)) &&
    text(value.clientId, 512) && /^[A-Za-z0-9._-]+$/.test(value.clientId) && text(value.clientSecret, 512)
}
function validAccount(value) {
  if (!plain(value) || Object.keys(value).some(key => !['status', 'sub', 'email', 'accountKey', 'scopes', 'refreshToken', 'clientKey', 'connectedAt', 'requested'].includes(key))) return false
  if (value.requested !== undefined && (!Array.isArray(value.requested) || value.requested.length > 16 || !value.requested.every(item => typeof item === 'string' && /^[a-z]{1,32}$/.test(item)))) return false
  if (!['connected', 'needs_auth'].includes(value.status) || !text(value.sub, 255) || !text(value.accountKey, 64) || !/^[a-f0-9]{64}$/.test(value.accountKey) || !text(value.clientKey, 64)) return false
  if (value.email !== null && !text(value.email, 320)) return false
  if (!Array.isArray(value.scopes) || value.scopes.length > 64 || !value.scopes.every(scope => text(scope, 300))) return false
  if (value.status === 'connected' ? !text(value.refreshToken, 4096) : value.refreshToken !== null) return false
  return typeof value.connectedAt === 'string' && Number.isFinite(Date.parse(value.connectedAt))
}
function validState(value) {
  return plain(value) && value.version === 1 && Object.keys(value).every(key => ['version', 'client', 'account'].includes(key)) &&
    (value.client === null || validGoogleClient(value.client)) && (value.account === null || validAccount(value.account))
}

export async function openGoogleCredentials({ dataDirectory }) {
  if (typeof dataDirectory !== 'string' || !dataDirectory) throw new Error('Google credential directory is required')
  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
    const info = await lstat(dataDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe')
    await chmod(dataDirectory, 0o700)
  } catch { throw googleError('GOOGLE_STORAGE_FAILED') }
  const file = join(dataDirectory, 'credentials.json')
  async function read() {
    let handle
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o077)) throw new Error('unsafe')
      const value = JSON.parse(await handle.readFile('utf8'))
      if (!validState(value)) throw new Error('invalid')
      return value
    } catch (error) { if (error.code === 'ENOENT') return emptyGoogleCredentials(); throw googleError('GOOGLE_STORAGE_FAILED') }
    finally { await handle?.close().catch(() => {}) }
  }
  let state = await read(), queue = Promise.resolve()
  async function persist(next) {
    if (!validState(next)) throw googleError('GOOGLE_STORAGE_FAILED')
    const encoded = JSON.stringify(next)
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw googleError('GOOGLE_STORAGE_FAILED')
    const temporary = join(dataDirectory, `.google-${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
      await rename(temporary, file)
      const directory = await open(dataDirectory, constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    } catch { throw googleError('GOOGLE_STORAGE_FAILED') }
    finally { await rm(temporary, { force: true }).catch(() => {}) }
    state = next
  }
  return {
    // Copies only: callers never mutate the persisted snapshot in place.
    get: () => structuredClone(state),
    /** Serialized read-modify-write; `change(current)` returns the next whole state. */
    update(change) {
      const operation = queue.then(async () => { const next = await change(structuredClone(state)); await persist(next); return structuredClone(next) })
      queue = operation.catch(() => {})
      return operation
    },
  }
}
