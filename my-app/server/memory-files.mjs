import { createHash } from 'node:crypto'
import { defineDocFamily } from '@earendil-works/pi-durable'
import { BOT_MEMORY_LIMITS, target as ledgerKey, validId } from './bot-memory.mjs'
import { TaskInputError } from './task-config.mjs'
import { diffMemoryFile, parseMemoryFile, renderMemoryFile, sameMemoryContent } from './memory-file-format.mjs'
import { MemoryFileError } from './memory-file-store.mjs'

// Additive R2 bookkeeping, one per memory target and keyed like pidot.bot-memory.document. Older code ignores it.
export const MemoryFileLedger = defineDocFamily({ kind: 'pidot.bot-memory.file', scope: 'session', family: true, version: 1,
  initial: () => ({ renderedVersion: 0, renderedHash: null, syncedAt: null, state: 'synced', code: null, rejectedHash: null }) })
export const MEMORY_FILE_CODES = Object.freeze(['MEMORY_FILE_TOO_LONG', 'MEMORY_FILE_INVALID', 'MEMORY_FILE_UNAVAILABLE', 'MEMORY_FILE_WRITE_FAILED'])
const SHARED = 'chief' // preferences are global; the ledger key ignores botId, so any valid placeholder works
const LIMIT_CODES = ['MEMORY_CONTENT_LIMIT', 'MEMORY_DOCUMENT_LIMIT', 'MEMORY_PATCH_LIMIT']
const sha = value => createHash('sha256').update(value).digest('hex')
const copy = value => value === undefined || value === null ? value : JSON.parse(JSON.stringify(value))
export const memoryFileTargets = botId => [{ botId, kind: 'personality' }, { botId, kind: 'memory' }]
const normalize = t => t.kind === 'preferences' ? { botId: SHARED, kind: 'preferences' } : { botId: t.botId, kind: t.kind }

/**
 * The single place where memory files and the ledger meet (README §4.1, CONTRACTS §7). One serial queue per target.
 * transaction(fn) = harness.commit; snapshot(key) = harness.snapshot(MemoryFileLedger, key) outside any transaction;
 * listBots() → current BotDirectory ids. `write: false` is the rollback mode: import unsynced hand edits only.
 */
export function createMemoryFiles({ store, service, transaction, snapshot, listBots, displayRoot = 'bot-workspaces', now = () => Date.now(), hooks = {}, write = true, settleMs = 50 }) {
  if (!store || !service || typeof transaction !== 'function' || typeof snapshot !== 'function' || typeof listBots !== 'function') throw new Error('Memory files require store, ledger service and transactions')
  const queues = new Map(), waiting = new Map(), cache = new Map(), pending = new Set()
  let closed = false, unsubscribe
  const at = () => new Date(now()).toISOString()
  const view = (t, record) => ({ path: `${displayRoot}/${store.relative(t)}`, state: record?.state ?? 'synced', code: record?.code ?? null, syncedAt: record?.syncedAt ?? null })
  const remember = (key, record) => { if (record) cache.set(key, copy(record)) }
  const known = async botId => (await listBots()).includes(botId)

  async function record(key, change) {
    const saved = await transaction(async tx => {
      const doc = await tx.doc(MemoryFileLedger, key, null)
      // Assign only real differences: an unchanged ledger must not manufacture commits on every model call.
      for (const [field, value] of Object.entries(change)) if (doc[field] !== value) doc[field] = value
      return copy(doc)
    })
    remember(key, saved)
    return saved
  }
  async function reject(key, ledger, code, rejectedHash = null) {
    if (ledger?.state === 'rejected' && ledger.code === code && ledger.rejectedHash === rejectedHash) return remember(key, ledger)
    await record(key, { state: 'rejected', code, rejectedHash })
  }
  // One import commit: base = the version last absorbed from/into the file; the file wins on its own diff.
  async function absorb(t, key, file, parsed) {
    return transaction(async tx => {
      const doc = await tx.doc(MemoryFileLedger, key, null), current = await service.ledger(tx, t.botId, t.kind)
      // Crash after rename, before bookkeeping: the file already IS a later ledger version's rendering.
      for (let version = Math.max(doc.renderedVersion + 1, current.version - BOT_MEMORY_LIMITS.history); version <= current.version; version++) {
        const rendered = await service.ledger(tx, t.botId, t.kind, version)
        if (rendered && sha(renderMemoryFile(t.kind, rendered)) === file.hash) {
          Object.assign(doc, { renderedVersion: version, renderedHash: file.hash, syncedAt: at(), state: 'synced', code: null, rejectedHash: null })
          return { record: copy(doc), equivalent: version === current.version }
        }
      }
      const base = await service.ledger(tx, t.botId, t.kind, doc.renderedVersion) ?? { content: '', items: [] }
      const patches = diffMemoryFile(t.kind, base, parsed)
      if (patches.length) {
        const requestId = `file-${sha(JSON.stringify([key, doc.renderedVersion, file.hash])).slice(0, 59)}`
        const body = t.kind === 'personality' ? { action: 'set', content: patches[0].content } : { patches }
        await service.importFile(tx, { botId: t.botId, kind: t.kind, requestId, expectedVersion: current.version, ...body })
      }
      const after = await service.ledger(tx, t.botId, t.kind)
      const equivalent = sameMemoryContent(t.kind, parsed, after)
      // Absorbed completely: remember the user's own bytes as rendered, so the file is not rewritten.
      if (equivalent) Object.assign(doc, { renderedVersion: after.version, renderedHash: file.hash, syncedAt: at(), state: 'synced', code: null, rejectedHash: null })
      return { record: copy(doc), equivalent }
    })
  }

  // Editors that save in place (truncate, then write) expose an empty or partial file for a moment. A changed file
  // whose mtime is that fresh is re-read until two reads agree, so a half-saved file is never imported as deletions.
  async function settle(t, file) {
    for (let attempt = 0; file && attempt < 5 && Date.now() - file.mtimeMs < settleMs; attempt++) {
      await new Promise(resolve => setTimeout(resolve, settleMs))
      const again = await store.read(t)
      if (again?.hash === file.hash) return again
      file = again
    }
    return file
  }
  async function run(t, { importOnly = false } = {}) {
    const key = ledgerKey(t.botId, t.kind)
    if (t.kind !== 'preferences' && !await known(t.botId)) return
    for (let attempt = 1; attempt <= BOT_MEMORY_LIMITS.mergeAttempts; attempt++) {
      let ledger = copy(await snapshot(key)) ?? null
      remember(key, ledger)
      if (importOnly && !ledger) return
      let file
      try { file = await store.read(t); if (file && file.hash !== (ledger?.renderedHash ?? null)) file = await settle(t, file) }
      catch (error) {
        if (!(error instanceof MemoryFileError)) throw error
        if (!importOnly) await reject(key, ledger, error.code === 'MEMORY_FILE_TOO_LONG' ? 'MEMORY_FILE_TOO_LONG' : 'MEMORY_FILE_UNAVAILABLE')
        return
      }
      if (file && file.hash !== (ledger?.renderedHash ?? null)) {
        if (ledger?.state === 'rejected' && ledger.rejectedHash === file.hash) return
        const parsed = parseMemoryFile(t.kind, file.bytes)
        if (!parsed.ok) { if (!importOnly) await reject(key, ledger, parsed.code, file.hash); return }
        let outcome
        try { outcome = await absorb(t, key, file, parsed.value) }
        catch (error) {
          if (!(error instanceof TaskInputError)) throw error
          // Ledger + file over the limits: nothing changes; retried on the next reconcile once space is freed.
          if (!importOnly) await reject(key, ledger, LIMIT_CODES.includes(error.code) ? 'MEMORY_FILE_TOO_LONG' : 'MEMORY_FILE_INVALID')
          return
        }
        remember(key, outcome.record)
        await hooks.afterImport?.(t)
        if (importOnly) return
        ledger = outcome.record
      }
      if (importOnly) return
      const current = await transaction(tx => service.ledger(tx, t.botId, t.kind))
      const hash = file?.hash ?? null
      if (!file && current.version === 0) return
      if (file && hash === ledger?.renderedHash && current.version === ledger.renderedVersion) {
        if (ledger.state !== 'synced') await record(key, { state: 'synced', code: null, rejectedHash: null })
        return
      }
      const text = renderMemoryFile(t.kind, current), rendered = sha(text)
      if (rendered === hash) { await record(key, { renderedVersion: current.version, renderedHash: hash, syncedAt: at(), state: 'synced', code: null, rejectedHash: null }); return }
      let result
      try { result = await store.write(t, text, { expectedHash: hash }) }
      catch (error) {
        if (!(error instanceof MemoryFileError)) throw error
        await record(key, { state: 'pending', code: 'MEMORY_FILE_WRITE_FAILED' })
        return
      }
      // A save landed between our read and rename: start over and merge it first.
      if (!result.ok) continue
      await record(key, { renderedVersion: current.version, renderedHash: result.hash, syncedAt: at(), state: 'synced', code: null, rejectedHash: null })
      return
    }
    await record(key, { state: 'pending', code: 'MEMORY_FILE_WRITE_FAILED' })
  }

  function enqueue(t, options, final = false) {
    if (closed && !final) return Promise.resolve()
    t = normalize(t)
    if (t.kind !== 'preferences' && (!validId(t.botId) || ['.', '..'].includes(t.botId))) return Promise.resolve()
    const key = ledgerKey(t.botId, t.kind)
    const next = (queues.get(key) ?? Promise.resolve()).then(() => run(t, options))
    const tail = next.catch(() => {})
    queues.set(key, tail)
    pending.add(tail)
    tail.finally(() => { pending.delete(tail); if (queues.get(key) === tail) queues.delete(key) })
    return next
  }
  const targets = async () => [...(await listBots()).filter(id => validId(id)).flatMap(memoryFileTargets), { botId: SHARED, kind: 'preferences' }]
  let lastTargets = []
  async function all(options, final) {
    lastTargets = await targets()
    for (const t of lastTargets) await enqueue(t, options, final)
    return summary()
  }
  const status = t => { t = normalize(t); return view(t, cache.get(ledgerKey(t.botId, t.kind))) }
  /** Startup log material only: counts, never paths or content. */
  function summary() {
    const counts = { targets: lastTargets.length, synced: 0, rejected: 0, pending: 0 }
    for (const t of lastTargets) counts[status(t).state]++
    return counts
  }
  /** Coalesced write-back after a ledger commit; returns the run's promise. Never throws. */
  function schedule(t) {
    if (closed) return Promise.resolve()
    t = normalize(t)
    const key = ledgerKey(t.botId, t.kind)
    if (waiting.has(key)) return waiting.get(key)
    // Defer past the commit listener: Session APIs must not be called synchronously from it.
    const promise = new Promise(resolve => setImmediate(resolve)).then(() => { waiting.delete(key); return enqueue(t) }).catch(() => {})
    waiting.set(key, promise)
    return promise
  }
  async function settled() { while (pending.size || waiting.size) await Promise.allSettled([...pending, ...waiting.values()]) }
  return {
    reconcile: (t, options) => enqueue(t, options),
    reconcileBot: async botId => { await Promise.all([...memoryFileTargets(botId), { botId: SHARED, kind: 'preferences' }].map(t => enqueue(t))) },
    reconcileAll: () => all(),
    importPending: () => all({ importOnly: true }),
    schedule, status, settled, summary,
    /** Adds `file` to each projected document (personality/memory/preferences) of one Bot. */
    attach(documents, botId) {
      for (const kind of ['personality', 'memory', 'preferences']) if (documents?.[kind]) documents[kind].file = status({ botId, kind })
      return documents
    },
    start(subscribe) { if (!closed && !unsubscribe && typeof subscribe === 'function') unsubscribe = subscribe(schedule) },
    async close({ reconcile = write } = {}) {
      if (closed) return
      closed = true
      unsubscribe?.()
      await settled()
      if (reconcile) await all(undefined, true).catch(() => {})
    },
  }
}
