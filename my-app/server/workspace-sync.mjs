import { reconcileReminders } from './workspace-reminder-state.mjs'
import { markDirty } from './detector-state.mjs'
import { randomUUID } from 'node:crypto'
import { LOCAL_OWNER, copy, fail, object, payloadHash } from './workspace-schema.mjs'
import { projectWorkspaceRecord } from './workspace-policy.mjs'

const DAY = 86400000, LIMIT = 1000, BACKOFF = [30000, 120000]
const iso = n => new Date(n).toISOString().replace('.000Z', 'Z')
// Read-only system work shares the existing scheduler's wake/close lifecycle.
// SyncState is NOT a business Schedule and never creates Task/Delivery or retries writes.
export function createWorkspaceSync({ repository: repo, authority, permission, readWindow, cache, now = Date.now, boundary = async () => {} }) {
  const owner = randomUUID(); let running, closed = false
  const base = (sourceId, id) => ({ schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id })
  const get = (tx, sourceId, id = 'current') => repo.get(tx, 'SyncState', LOCAL_OWNER, sourceId, id)
  const put = (tx, row) => repo.put(tx, 'SyncState', row)
  const snapshot = p => ({ grantEpoch: p.grantEpoch, resource: p.binding.resource })
  const same = (a, b) => payloadHash(a ?? null) === payloadHash(b ?? null)
  async function pages(tx, type, sourceId) {
    const rows = []; let cursor = 0
    do { const p = await repo.list(tx, type, LOCAL_OWNER, sourceId, { cursor, limit: 100 }); rows.push(...p.items); cursor = p.next; if (rows.length > LIMIT) fail(409, 'WORKSPACE_SYNC_CAPACITY', '同步窗口或关联记录超过1000条预算；保留旧缓存，请缩小窗口。') } while (cursor !== undefined)
    return rows
  }
  async function full(tx, actor, sourceId) {
    const p = await permission(tx, actor, sourceId)
    if (p.readScope !== 'full') fail(403, 'WORKSPACE_SYNC_SCOPE', '同步缓存要求正文权限；忙闲主体只能实时白名单查询。')
    return p
  }
  async function checked(tx, actor, sourceId, c) {
    const p = await full(tx, actor, sourceId)
    if (!c?.enabled || !same(c.authorizationSnapshot, snapshot(p))) fail(403, 'WORKSPACE_SYNC_REVOKED', '同步配置授权已失效，请重新确认。')
    return p
  }
  const defaults = sourceId => ({ ...base(sourceId, 'current'), window: {}, coverage: [], generation: 0, enabled: false, revision: 0, cacheRevision: 0, pastDays: 7, futureDays: 31, refreshSeconds: 300, timezone: 'Asia/Shanghai', runState: 'disabled', attempts: 0 })
  function view(c, windows) {
    return { ...copy(c), windows: windows.map(w => ({ ...copy(w), stale: !c.enabled || c.invalidated || c.runState !== 'idle' || !!w.error || !w.lastSuccessAt || now() - Date.parse(w.lastSuccessAt) >= c.refreshSeconds * 1000 })), mode: 'bounded-window-rescan', notice: '窗口完整成功才发布；离线缓存只读，非外部权威。无增量推送；Outbox待消费不代表通知送达。后端停机不执行。' }
  }
  async function status(actor, input) {
    if (!object(input) || Object.keys(input).some(k => k !== 'sourceId')) fail(400, 'WORKSPACE_SYNC_INPUT', '同步状态参数无效。')
    return repo.transaction(async tx => { const p = await full(tx, actor, input.sourceId); const c = await get(tx, input.sourceId) ?? defaults(input.sourceId); if (c.authorizationSnapshot && !same(c.authorizationSnapshot, snapshot(p))) return view({ ...defaults(input.sourceId), revision: c.revision, runState: 'revoked' }, []); return view(c, (await Promise.all([get(tx, input.sourceId, 'window:0'), get(tx, input.sourceId, 'window:1')])).filter(w => w && w.revision === c.revision && same(w.authorizationSnapshot, c.authorizationSnapshot))) })
  }
  async function configure(actor, input) {
    authority.check(actor)
    if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_SYNC_ACTOR', '仅认证用户可配置后台同步。')
    if (!object(input) || Object.keys(input).some(k => !['sourceId', 'enabled', 'confirmed', 'expectedRevision', 'pastDays', 'futureDays', 'refreshSeconds', 'timezone'].includes(k)) || input.confirmed !== true || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedRevision)) fail(400, 'WORKSPACE_SYNC_INPUT', '请明确确认窗口、频率与当前revision。')
    await repo.transaction(async tx => {
      const p = await full(tx, actor, input.sourceId), c = await get(tx, input.sourceId) ?? defaults(input.sourceId)
      if (c.revision !== input.expectedRevision) fail(409, 'WORKSPACE_SYNC_REVISION', '同步配置已变化，请重新读取。')
      const config = { pastDays: input.pastDays ?? c.pastDays, futureDays: input.futureDays ?? c.futureDays, refreshSeconds: input.refreshSeconds ?? c.refreshSeconds, timezone: input.timezone ?? c.timezone }
      if (!Number.isSafeInteger(config.pastDays) || config.pastDays < 1 || config.pastDays > 31 || !Number.isSafeInteger(config.futureDays) || config.futureDays < 1 || config.futureDays > 31 || !Number.isSafeInteger(config.refreshSeconds) || config.refreshSeconds < 60 || config.refreshSeconds > DAY / 1000) fail(400, 'WORKSPACE_SYNC_INPUT', '每片1–31天，刷新间隔60–86400秒。')
      try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format() } catch { fail(400, 'WORKSPACE_SYNC_INPUT', '时区无效。') }
      await put(tx, { ...c, ...config, enabled: input.enabled, revision: c.revision + 1, generation: c.generation + 1, authorizationSnapshot: snapshot(p), runState: input.enabled ? 'pending' : 'disabled', attempts: 0, claim: null, cursor: null, error: null, retryAt: null, nextDueAt: iso(now()) })
    })
    return status(actor, { sourceId: input.sourceId })
  }
  async function refresh(actor, input) {
    authority.check(actor)
    if (actor.principalKind !== 'user' || !object(input) || Object.keys(input).some(k => !['sourceId', 'confirmed'].includes(k)) || input.confirmed !== true) fail(400, 'WORKSPACE_SYNC_INPUT', '请确认只读窗口重扫。')
    await repo.transaction(async tx => {
      const c = await get(tx, input.sourceId); await checked(tx, actor, input.sourceId, c)
      if (c.runState === 'running' && c.claim?.owner === owner) fail(409, 'WORKSPACE_SYNC_BUSY', '当前窗口正在同步。')
      await put(tx, { ...c, generation: c.generation + 1, attempts: 0, runState: 'pending', claim: null, cursor: null, retryAt: null, error: null, nextDueAt: iso(now()) })
    })
    await tick(input.sourceId)
    return status(actor, { sourceId: input.sourceId })
  }
  async function changed(tx, sourceId, record, kind, key) {
    const id = payloadHash(['external-change', sourceId, record.id, record.remoteVersion, key, kind])
    if (await repo.get(tx, 'Outbox', LOCAL_OWNER, sourceId, id)) return
    await repo.put(tx, 'Outbox', { ...base(sourceId, id), operationId: `sync:${id}`, targetRef: { type: 'Event', id: record.id, remoteId: record.remoteId, instanceKey: record.instanceKey, version: record.version, kind, window: key }, state: 'pending', dedupeKey: id })
    await reconcileReminders(repo, tx, record, 'Event', now())
    await markDirty(tx, { sourceId, type: 'Event', id: record.id })
    for (const r of await pages(tx, 'Reminder', sourceId)) if ((!r.scheduleId || kind === 'missing_in_window') && r.targetRef?.id === record.id) await repo.put(tx, 'Reminder', { ...r, invalidated: true, invalidationReason: kind })
  }
  async function execute(sourceId) {
    const actor = authority.user()
    const job = await repo.transaction(async tx => {
      const c = await get(tx, sourceId)
      if (!c?.enabled || c.runState === 'failed' || (c.runState === 'running' && c.claim?.owner === owner) || Date.parse(c.retryAt ?? c.nextDueAt) > now()) return null
      try { await checked(tx, actor, sourceId, c) } catch { await put(tx, { ...c, enabled: false, runState: 'revoked', error: { code: 'WORKSPACE_SYNC_REVOKED', message: '来源或授权变化；停止未来抓取，旧缓存不可见。' }, claim: null }); return null }
      if (c.attempts >= 3) { await put(tx, { ...c, runState: 'failed', claim: null, error: { code: 'WORKSPACE_SYNC_ATTEMPTS', message: '三次只读尝试已用尽，请显式手动刷新。' } }); return null }
      const resume = c.runState === 'retry_wait' || c.runState === 'running'
      const at = Math.floor(now() / 1000) * 1000, windows = resume && c.windows ? c.windows : [{ start: iso(at - c.pastDays * DAY), end: iso(at), timezone: c.timezone }, { start: iso(at), end: iso(at + c.futureDays * DAY), timezone: c.timezone }]
      const j = { ...c, generation: c.generation + 1, windows, cursor: resume ? c.cursor ?? 0 : 0, attempts: c.attempts + 1, runState: 'running', claim: { owner, id: randomUUID() }, error: null, retryAt: null, lastStartedAt: iso(now()) }
      await put(tx, j); return j
    })
    if (!job) return
    try {
      await boundary('after_claim', copy(job))
      for (let index = job.cursor; index < job.windows.length; index++) {
        const window = job.windows[index], key = `window:${index}`
        const guard = () => repo.transaction(async tx => { const c = await get(tx, sourceId); if (!same(c?.claim, job.claim) || c.revision !== job.revision) fail(409, 'WORKSPACE_SYNC_SUPERSEDED', '同步已被更新配置取代。'); return checked(tx, actor, sourceId, c) })
        const p = await guard(), result = await readWindow(window, p, guard)
        if (!result.complete || result.events.length > LIMIT) fail(502, 'WORKSPACE_SYNC_INCOMPLETE', '窗口不完整（分页/密集片/限流/超时/容量），旧缓存保留。')
        await boundary('before_publish', { sourceId, index })
        await repo.transaction(async tx => {
          const c = await get(tx, sourceId), current = await checked(tx, actor, sourceId, c)
          if (!same(c.claim, job.claim) || c.revision !== job.revision || c.cacheRevision !== job.cacheRevision) fail(409, 'WORKSPACE_SYNC_SUPERSEDED', '读取期间缓存或精确写回执更新，旧generation不发布。')
          const partition = `${sourceId}:window:${index}`, prior = await pages(tx, 'SyncEntry', partition), seen = new Set()
          for (const event of result.events) {
            const record = await cache(tx, actor, sourceId, event, current, true)
            if (!record.id || Date.parse(record.end) <= Date.parse(record.start)) fail(502, 'WORKSPACE_SYNC_INVALID_EVENT', '窗口含无效实例，禁止完整发布。')
            if (Date.parse(record.end) <= Date.parse(window.start) || Date.parse(record.start) >= Date.parse(window.end)) continue
            seen.add(record.id)
            const old = prior.find(r => r.id === record.id)
            const differs = !old || old.present !== !record.deletedAt || old.remoteVersion !== record.remoteVersion
            if (differs) await changed(tx, sourceId, record, record.deletedAt ? 'deleted' : old?.present ? 'updated' : 'appeared', `${key}:${old?.revision ?? 0}`)
            await repo.put(tx, 'SyncEntry', { ...base(partition, record.id), targetId: record.id, present: !record.deletedAt, remoteVersion: record.remoteVersion, generation: job.generation, revision: (old?.revision ?? 0) + (differs ? 1 : 0) })
          }
          for (const old of prior) if (old.present && !seen.has(old.id)) {
            await repo.put(tx, 'SyncEntry', { ...old, present: false, generation: job.generation, revision: (old.revision ?? 0) + 1 })
            const record = await repo.get(tx, 'Event', LOCAL_OWNER, sourceId, old.targetId)
            if (record) await changed(tx, sourceId, record, 'missing_in_window', `${key}:${old.revision ?? 0}`)
          }
          const published = { ...base(sourceId, key), window, coverage: { ...window, complete: true, count: seen.size }, generation: job.generation, revision: c.revision, authorizationSnapshot: c.authorizationSnapshot, lastSuccessAt: iso(now()), error: null }
          await put(tx, published)
          await put(tx, { ...c, cursor: index + 1 })
          await boundary('in_publish', { sourceId, index })
        })
        await boundary('after_publish', { sourceId, index })
      }
      await repo.transaction(async tx => { const c = await get(tx, sourceId); if (same(c?.claim, job.claim)) await put(tx, { ...c, runState: 'idle', invalidated: false, attempts: 0, claim: null, cursor: null, error: null, retryAt: null, lastSuccessAt: iso(now()), nextDueAt: iso(now() + c.refreshSeconds * 1000) }) })
    } catch (error) {
      await repo.transaction(async tx => {
        const c = await get(tx, sourceId)
        if (!same(c?.claim, job.claim)) return
        const revoked = ['WORKSPACE_EXTERNAL_REVOKED', 'WORKSPACE_FORBIDDEN', 'WORKSPACE_SYNC_REVOKED', 'FEISHU_SOURCE_REVOKED'].includes(error.code)
        await put(tx, { ...c, enabled: revoked ? false : c.enabled, claim: null, runState: revoked ? 'revoked' : job.attempts < 3 ? 'retry_wait' : 'failed', error: { code: error.code ?? 'WORKSPACE_SYNC_READ_FAILED', message: '只读同步未完成，旧coverage保留并标stale；无外部写重试。' }, retryAt: !revoked && job.attempts < 3 ? iso(now() + BACKOFF[job.attempts - 1]) : null })
      })
    }
  }
  async function tick(sourceId) {
    if (closed) return
    if (running) return running
    // One configured external source, resolved live by the adapter. Never scan old account sources.
    running = (async () => { if (sourceId) await execute(sourceId) })()
    try { await running } finally { running = undefined }
  }
  async function cached(tx, actor, input, p) {
    if (p.readScope !== 'full') return null // Never load body cache for a busy-only principal.
    const c = await get(tx, input.sourceId)
    if (!c?.enabled || !same(c.authorizationSnapshot, snapshot(p))) return null
    const windows = (await Promise.all([get(tx, input.sourceId, 'window:0'), get(tx, input.sourceId, 'window:1')])).filter(w => w && w.revision === c.revision && same(w.authorizationSnapshot, c.authorizationSnapshot))
    const start = Date.parse(input.start), end = Date.parse(input.end)
    let covered = start
    for (const w of [...windows].sort((a,b) => Date.parse(a.window.start) - Date.parse(b.window.start))) if (Date.parse(w.window.start) <= covered && Date.parse(w.window.end) > covered) covered = Date.parse(w.window.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || covered < end) return null
    const records = new Map()
    for (const w of windows) {
      const index = w.id.split(':')[1]
      for (const entry of await pages(tx, 'SyncEntry', `${input.sourceId}:window:${index}`)) if (entry.present) {
        const r = await repo.get(tx, 'Event', LOCAL_OWNER, input.sourceId, entry.targetId)
        if (r && !r.deletedAt && Date.parse(r.start) < end && Date.parse(r.end) > start && Date.parse(r.start) < Date.parse(w.window.end) && Date.parse(r.end) > Date.parse(w.window.start)) records.set(r.id, projectWorkspaceRecord('Event', r, p))
      }
    }
    const state = view(c, windows)
    return { items: [...records.values()], sourceId: input.sourceId, authority: 'external', provider: 'feishu', complete: true, incompleteReason: null, stale: state.windows.some(w => w.stale), observedAt: c.lastSuccessAt ?? null, coverage: state.windows.map(w => w.coverage), generation: c.generation, error: c.error, capabilities: ['read', 'create', 'update', 'delete'], notice: state.notice, cached: true }
  }
  return { status, configure, refresh, tick, cached, async close() { closed = true; await running } }
}
