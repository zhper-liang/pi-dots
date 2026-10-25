import { WorkspaceMeta, WorkspaceLookup, WorkspaceUnique, WorkspaceIndex, WorkspacePage, WorkspaceRecords, WORKSPACE_VERSION, LOCAL_OWNER, identityKey, ownerLocalGrant, OWNER_LOCAL_GRANT_ID, validId, validateRecord, copy, fail } from './workspace-schema.mjs'

export const PAGE_SIZE = 100
export const MAX_RECORDS_PER_PARTITION = 100000
// Append-only per owner/source/type index. One mutation touches only a head + <=100 IDs,
// never the full historical collection. Cursor is an offset, not a security principal.
export function createWorkspaceRepository({ harness, context, enabled = true }) {
  const commit = fn => harness.commit(fn, context)
  const partition = (type, ownerId, sourceId) => {
    if (!WorkspaceRecords[type] || !validId(ownerId) || !validId(sourceId)) fail(400, 'WORKSPACE_KEY', '业务键无效。')
    return identityKey(ownerId, sourceId, type)
  }
  async function get(tx, type, ownerId, sourceId, id) {
    if (type === 'Grant' && ownerId === LOCAL_OWNER && sourceId === 'local' && id === OWNER_LOCAL_GRANT_ID) return ownerLocalGrant(await stored(tx, type, ownerId, sourceId, id))
    return stored(tx, type, ownerId, sourceId, id)
  }
  async function stored(tx, type, ownerId, sourceId, id) {
    partition(type, ownerId, sourceId)
    if (!validId(id)) fail(400, 'WORKSPACE_KEY', '业务键无效。')
    const recordKey = identityKey(ownerId, sourceId, id), part = partition(type, ownerId, sourceId)
    const lookup = await tx.doc(WorkspaceLookup, `${part}:${recordKey.slice(0, 2)}`, null)
    if (!lookup.keys[recordKey]) return null
    const doc = await tx.doc(WorkspaceRecords[type], recordKey, null)
    if (doc.record === null) return null
    const result = validateRecord(type, doc.record)
    if (result.ownerId !== ownerId || result.sourceId !== sourceId || result.id !== id) fail(409, 'WORKSPACE_IDENTITY', '业务记录身份不匹配。')
    return result
  }
  async function put(tx, type, value) {
    const r = validateRecord(type, value), key = partition(type, r.ownerId, r.sourceId)
    if (type === 'Occurrence') {
      const unique = await tx.doc(WorkspaceUnique, identityKey(r.ownerId, r.sourceId, JSON.stringify([r.scheduleId, r.revision, new Date(r.scheduledFor).toISOString()])), null)
      if (unique.id !== null && unique.id !== r.id) fail(409, 'WORKSPACE_OCCURRENCE_CONFLICT', '同一计划版本与UTC触发点已有执行记录。')
      unique.id = r.id
    }
    const recordKey = identityKey(r.ownerId, r.sourceId, r.id)
    const lookup = await tx.doc(WorkspaceLookup, `${key}:${recordKey.slice(0, 2)}`, null)
    const doc = await tx.doc(WorkspaceRecords[type], recordKey, null)
    if (type === 'Occurrence' && doc.record !== null && ['scheduleId', 'revision', 'scheduledFor'].some(k => doc.record[k] !== r[k])) fail(409, 'WORKSPACE_OCCURRENCE_CONFLICT', '已记录触发身份不可改写。')
    if (doc.record === null) {
      if (Object.keys(lookup.keys).length >= 1000) fail(409, 'WORKSPACE_CAPACITY', '业务键索引分片达到上限，需要容量评审。')
      lookup.keys[recordKey] = true
      const index = await tx.doc(WorkspaceIndex, key, null)
      if (index.count >= MAX_RECORDS_PER_PARTITION) fail(409, 'WORKSPACE_CAPACITY', '业务分区达到上限，需要归档评审。')
      const page = await tx.doc(WorkspacePage, `${key}:${Math.floor(index.count / PAGE_SIZE)}`, null)
      page.ids.push(r.id); index.count++
    }
    doc.record = r
    return copy(r)
  }
  async function list(tx, type, ownerId, sourceId, { cursor = 0, limit = PAGE_SIZE } = {}) {
    const key = partition(type, ownerId, sourceId)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) fail(400, 'WORKSPACE_PAGE', '业务分页参数无效。')
    const index = await tx.doc(WorkspaceIndex, key, null), end = Math.min(index.count, cursor + limit), items = []
    let loadedPage = -1, page
    for (let n = cursor; n < end; n++) {
      const p = Math.floor(n / PAGE_SIZE)
      if (p !== loadedPage) { page = await tx.doc(WorkspacePage, `${key}:${p}`, null); loadedPage = p }
      items.push(await get(tx, type, ownerId, sourceId, page.ids[n % PAGE_SIZE]))
    }
    return { items, ...(end < index.count ? { next: end } : {}) }
  }
  async function initialize({ migration } = {}) {
    if (!enabled) return
    await commit(async tx => {
      const meta = await tx.doc(WorkspaceMeta)
      if (meta.schemaVersion !== WORKSPACE_VERSION) {
        if (meta.schemaVersion !== 0 || meta.initialized || migration !== 'v0-to-v1') fail(409, 'WORKSPACE_MIGRATION_REQUIRED', '业务存储需要显式迁移；旧任务保持不变。')
        meta.migrations.push({ from: 0, to: 1, at: new Date().toISOString(), scope: 'workspace-only' }); meta.schemaVersion = 1
      }
      if (!meta.initialized) {
        await put(tx, 'Connection', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: 'local', id: 'local', provider: 'local', accountKey: LOCAL_OWNER, authEpoch: 0, status: 'active' })
        await put(tx, 'Source', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: 'local', id: 'local', connectionId: 'local', authority: 'local', capabilities: ['read', 'create', 'update', 'delete'] })
        // Creating a source is NOT granting consent to users or existing Bots.
        meta.initialized = true
      }
    })
  }
  async function within(tx, fn) {
    if (!enabled) fail(503, 'WORKSPACE_DISABLED', '业务入口已禁用；审计和旧任务保留。')
    const m = await tx.doc(WorkspaceMeta); if (!m.initialized || m.schemaVersion !== WORKSPACE_VERSION) fail(409, 'WORKSPACE_MIGRATION_REQUIRED', '业务存储尚未就绪。')
    return fn(tx)
  }
  async function transaction(fn) { return enabled ? commit(tx => within(tx, fn)) : within(null, fn) }
  return { get, put, list, initialize, transaction, within, enabled, async metadata() { return commit(async tx => copy(await tx.doc(WorkspaceMeta))) } }
}
