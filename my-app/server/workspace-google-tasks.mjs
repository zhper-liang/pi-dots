import { randomUUID } from 'node:crypto'
import { defineDoc } from '@earendil-works/pi-durable'
import { reconcileReminders } from './workspace-reminder-state.mjs'
import { createWorkspaceSync } from './workspace-sync.mjs'
import { LOCAL_OWNER, copy, fail, object, validId, payloadHash } from './workspace-schema.mjs'
import { ExternalSourceIndex, externalSourceId, registerExternalSource, dropExternalSources, removeResourcesByPrefix } from './workspace-providers.mjs'
import { validRemoteTaskId } from './workspace-tools.mjs'
import { seedSourceGrant } from './workspace-grants.mjs'
import { TaskInputError } from './task-config.mjs' // GoogleError extends it; messages are fixed Chinese text.

// Google Tasks adapter (R3-04, CONTRACTS.md §1–§2.3). Each task list is a Source; tasks are cached as
// external Todo records. `due` is date-only (Google drops the time of day), so a task is an all-day
// deadline and never a time slot (D8). Subtasks are flat and read-only. Writes use the Feishu-shaped
// prepare → (confirm) → execute path; the caller's tool-group verdict decides autoApprove (D4).
// Consistency: compare the etag before every update/delete, send If-Match, read back after the write.
// Create has no client id: an unknown result succeeds only when exactly one new same-title task shows
// up in that list; otherwise it stays unknown and Pidot never creates it again.
const PROVIDER = 'google-tasks', PREFIX = 'google-tasks:', ACTIONS = ['read', 'create', 'update', 'delete']
const MAX_LISTS = 200, MAX_TASKS = 1000, MAX_CACHED = 5000, CREATE_SKEW_MS = 120000, CREATE_LOCK_MS = 600000, DISCOVERY_MS = 300000, DISCOVERY_RETRY_MS = 30000
const notice = '写前比对etag、写后回读；Google任务没有服务端原子CAS，外部写者仍有竞态。截止只有日期，不占时段。新建没有客户端ID：结果不明时只按标题查找，找不到记为未知，不会重建。'
const opKey = requestId => payloadHash([LOCAL_OWNER, requestId])
const strict = (input, keys) => { if (!object(input) || Object.keys(input).some(k => !keys.includes(k))) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '外部命令包含无效字段。') }
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const validZone = z => { try { return typeof z === 'string' && !!new Intl.DateTimeFormat('en', { timeZone: z }).format() } catch { return false } }
const dayOf = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
const clip = (v, n) => typeof v === 'string' ? [...v].slice(0, n).join('') : ''
// Same normalisation as registerExternalSource, so an unchanged title is not rewritten every discovery.
const label = v => typeof v === 'string' ? [...v].map(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c).join('').trim().slice(0, 200) : ''
const taskPath = (listId, taskId) => `/lists/${encodeURIComponent(listId)}/tasks${taskId === undefined ? '' : `/${encodeURIComponent(taskId)}`}`
const statusOf = t => t.status === 'completed' ? 'completed' : 'open'
const dueOf = t => typeof t.due === 'string' && validDate(t.due.slice(0, 10)) ? t.due.slice(0, 10) : null
const slim = t => ({ id: t.id, status: t.status === 'completed' ? 'completed' : 'needsAction', ...(typeof t.due === 'string' ? { due: t.due.slice(0, 40) } : {}), ...(typeof t.notes === 'string' && t.notes ? { notes: clip(t.notes, 4000) } : {}),
  ...(typeof t.parent === 'string' && t.parent ? { parent: t.parent.slice(0, 256) } : {}), ...(typeof t.updated === 'string' ? { updated: t.updated.slice(0, 40) } : {}), ...(typeof t.completed === 'string' ? { completed: t.completed.slice(0, 40) } : {}) })
// remoteVersion is the etag; a missing etag falls back to a content hash, which is never sent as If-Match.
const versionOf = t => typeof t.etag === 'string' && t.etag && t.etag.length <= 1024 ? t.etag : `hash:${payloadHash(slim(t))}`
const toWire = a => ({ ...(a.title !== undefined ? { title: a.title } : {}), ...(a.due !== undefined ? { due: a.due === null ? null : `${a.due}T00:00:00.000Z` } : {}), ...(a.notes !== undefined ? { notes: a.notes } : {}),
  ...(a.status === 'completed' ? { status: 'completed' } : a.status === 'open' ? { status: 'needsAction', completed: null } : {}) })
const applied = (a, t) => (a.title === undefined || t.title === a.title) && (a.status === undefined || statusOf(t) === a.status) && (a.due === undefined || dueOf(t) === a.due) && (a.notes === undefined || (t.notes || null) === (a.notes || null))
const created = (a, t, knownIds, from) => object(t) && !t.deleted && !t.parent && t.title === a.title && !knownIds.includes(t.id) && (a.due === undefined || dueOf(t) === a.due) && Date.parse(t.updated) >= from
const CONFLICT = { gone: 'Google 中这项任务已不存在，没有写入。', changed: 'Google 中的任务已被修改，已刷新到最新版本；请重新读取后再改，没有覆盖。' }

// Write leases: per list+title for create, per task for update/delete. Only an unknown create keeps
// its lease after dispatch; a complete scan that finds the task resolves it, otherwise it lapses
// after CREATE_LOCK_MS. The Operation stays unknown either way; nothing is ever re-sent.
export const GoogleTasksLeases = defineDoc({ kind: 'pidot.workspace.google-tasks-leases', version: 1, scope: 'session', initial: () => ({ items: {} }) })
const leaseKey = (sourceId, action, a) => payloadHash([sourceId, action === 'create' ? ['create', a.title] : ['task', a.taskId]])

export function createGoogleTasksWorkspaceService({ repository: repo, authority, google, now = Date.now, syncOptions = {} }) {
  const clock = syncOptions.now ?? now, iso = () => new Date(clock()).toISOString()
  const user = actor => { authority.check(actor); if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_CONFIRMATION_REQUIRED', '只有认证用户可以批准或执行外部操作。') }
  const account = async tx => { const a = google?.available ? await google.current(tx) : null; return a?.status === 'connected' && a.services?.includes('tasks') && typeof a.accountKey === 'string' ? a : null }
  // ---- Todo records ----
  function shape(sourceId, task, old) {
    const remoteVersion = versionOf(task), deleted = !!task.deleted
    const base = { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: payloadHash([sourceId, task.id]), remoteId: task.id, title: clip(task.title, 1000), status: statusOf(task), due: dueOf(task), timezone: 'UTC',
      remoteVersion, authority: 'external', readOnly: typeof task.parent === 'string' && !!task.parent, observedAt: iso(), providerTask: slim(task) }
    const material = !old || old.remoteVersion !== remoteVersion || !!old.deletedAt !== deleted
    return { material, record: { ...base, version: (old?.version ?? 0) + (material ? 1 : 0), deletedAt: deleted ? old?.deletedAt ?? iso() : null } }
  }
  // Writes only on a material change, so repeated reads neither churn versions nor wake reminders.
  async function cacheOne(tx, sourceId, task, known) {
    const old = known === undefined ? await repo.get(tx, 'Todo', LOCAL_OWNER, sourceId, payloadHash([sourceId, task.id])) : known
    const { material, record } = shape(sourceId, task, old)
    if (!material) return { record: old, changed: false }
    const stored = await repo.put(tx, 'Todo', record)
    await reconcileReminders(repo, tx, stored, 'Todo', clock())
    return { record: stored, changed: true }
  }
  async function tombstone(tx, old) {
    if (!old || old.deletedAt) return { record: old, changed: false }
    const stored = await repo.put(tx, 'Todo', { ...old, version: old.version + 1, deletedAt: iso(), observedAt: iso() })
    await reconcileReminders(repo, tx, stored, 'Todo', clock())
    return { record: stored, changed: true }
  }
  async function cachedTodos(tx, sourceId) {
    const rows = []; let cursor = 0
    do { const page = await repo.list(tx, 'Todo', LOCAL_OWNER, sourceId, { cursor, limit: 100 }); rows.push(...page.items); cursor = page.next; if (rows.length > MAX_CACHED) fail(409, 'WORKSPACE_SYNC_CAPACITY', '任务缓存超过容量预算，请清理已完成任务后重试。') } while (cursor !== undefined)
    return rows
  }
  async function bumpCache(tx, sourceId) {
    const c = await repo.get(tx, 'SyncState', LOCAL_OWNER, sourceId, 'current')
    if (c) await repo.put(tx, 'SyncState', { ...c, cacheRevision: c.cacheRevision + 1, invalidated: true, nextDueAt: iso() })
  }
  // Merge one scan into the cache. Only a complete scan may tombstone tasks it did not return.
  async function absorb(tx, sourceId, { tasks, complete }) {
    const cached = new Map((await cachedTodos(tx, sourceId)).map(r => [r.remoteId, r])), records = [], seen = new Set()
    let changed = false
    for (const task of tasks) { seen.add(task.id); const r = await cacheOne(tx, sourceId, task, cached.get(task.id) ?? null); changed ||= r.changed; records.push(r.record) }
    if (complete) for (const [remoteId, old] of cached) if (!seen.has(remoteId)) { const r = await tombstone(tx, old); changed ||= r.changed }
    if (changed) await bumpCache(tx, sourceId)
    if (complete) await resolvePending(tx, sourceId, tasks)
    return records
  }

  // ---- Google reads (outside transactions) ----
  async function scan(listId) {
    const tasks = [], ids = new Set(); let pageToken, pages = 0
    do {
      const { data } = await google.api('tasks', taskPath(listId), { query: { maxResults: 100, showCompleted: true, showHidden: true, pageToken } })
      if (data?.items !== undefined && !Array.isArray(data.items)) return { tasks, complete: false }
      for (const t of data?.items ?? []) { if (!object(t) || !validRemoteTaskId(t.id)) return { tasks, complete: false }; if (!ids.has(t.id)) { ids.add(t.id); tasks.push(t) } }
      pageToken = typeof data?.nextPageToken === 'string' && data.nextPageToken.length <= 2048 ? data.nextPageToken : undefined
      if (tasks.length > MAX_TASKS || pageToken && ++pages >= MAX_TASKS / 100) return { tasks: tasks.slice(0, MAX_TASKS), complete: false }
    } while (pageToken)
    return { tasks, complete: true }
  }
  async function lists() {
    const items = []; let pageToken, complete = true
    do {
      const { data } = await google.api('tasks', '/users/@me/lists', { query: { maxResults: 100, pageToken } })
      for (const l of Array.isArray(data?.items) ? data.items : []) { if (object(l) && validRemoteTaskId(l.id) && items.length < MAX_LISTS) items.push({ id: l.id, title: l.title }); else complete = false }
      pageToken = typeof data?.nextPageToken === 'string' && data.nextPageToken.length <= 2048 ? data.nextPageToken : undefined
      if (pageToken && items.length >= MAX_LISTS) { complete = false; break }
    } while (pageToken)
    return { items, complete }
  }
  async function getTask(listId, taskId) {
    try { const { data } = await google.api('tasks', taskPath(listId, taskId)); return object(data) && data.id === taskId && !data.deleted ? data : null }
    catch (error) { if (error.code === 'GOOGLE_NOT_FOUND' || error.code === 'GOOGLE_GONE') return null; throw error }
  }

  // ---- Discovery: task lists → Sources, usable on connect (D14) ----
  let closed = false
  const discovery = { key: null, at: -Infinity, ok: false, promise: null }
  async function discover() {
    if (closed || !google?.available || !repo.enabled) return
    const a = await repo.transaction(account)
    if (!a) return
    const key = `${a.accountKey}:${a.authEpoch}`
    if (discovery.key === key && clock() - discovery.at < (discovery.ok ? DISCOVERY_MS : DISCOVERY_RETRY_MS)) return
    if (discovery.promise?.key === key) return discovery.promise
    const promise = (async () => {
      try { const found = await lists(); await repo.transaction(tx => upsert(tx, a, found)); Object.assign(discovery, { key, at: clock(), ok: true }) }
      catch { Object.assign(discovery, { key, at: clock(), ok: false }) } // Stale sources stay; the account mirror handles re-auth.
      finally { if (discovery.promise === promise) discovery.promise = null }
    })()
    promise.key = key; discovery.promise = promise
    return promise
  }
  async function upsert(tx, a, found) {
    const current = await account(tx)
    if (!current || current.accountKey !== a.accountKey || current.authEpoch !== a.authEpoch) return // Account changed mid-read.
    const ids = new Set()
    for (const list of found.items) { const sourceId = externalSourceId(PROVIDER, a.accountKey, list.id); ids.add(sourceId); await stamp(tx, current, sourceId, list) }
    if (!found.complete) return
    for (const [sourceId, entry] of Object.entries((await tx.doc(ExternalSourceIndex)).items)) if (entry.provider === PROVIDER && entry.accountKey === a.accountKey && !ids.has(sourceId)) await retire(tx, sourceId)
  }
  async function stamp(tx, a, sourceId, list) {
    const connectionId = `google:${a.accountKey.slice(0, 16)}`, old = await repo.get(tx, 'Connection', LOCAL_OWNER, sourceId, connectionId)
    if (!old || old.authEpoch !== a.authEpoch || old.accountKey !== a.accountKey || old.status !== 'active') {
      await repo.put(tx, 'Connection', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: connectionId, provider: 'google', accountKey: a.accountKey, credentialRef: 'google', authEpoch: a.authEpoch, status: 'active' })
      await repo.put(tx, 'Source', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: sourceId, connectionId, providerContainerId: list.id, authority: 'external', capabilities: ACTIONS })
      // D14 (CONTRACTS §8 ADR draft): full read/write on discovery and on every new authEpoch, no consent step.
      await seedSourceGrant(repo, tx, { sourceId, capabilities: ACTIONS })
    }
    const entry = (await tx.doc(ExternalSourceIndex)).items[sourceId]
    if (!entry || entry.title !== label(list.title) || entry.authEpoch !== a.authEpoch || entry.accountKey !== a.accountKey) await registerExternalSource(tx, { sourceId, title: list.title, accountKey: a.accountKey, authEpoch: a.authEpoch, readOnly: false })
  }
  // A list deleted in Google: the Source goes dead and leaves every Bot, as on disconnect (ADR-014 §1).
  async function retire(tx, sourceId) {
    const source = await repo.get(tx, 'Source', LOCAL_OWNER, sourceId, sourceId), connection = source && await repo.get(tx, 'Connection', LOCAL_OWNER, sourceId, source.connectionId)
    if (connection?.status === 'active') await repo.put(tx, 'Connection', { ...connection, status: 'revoked' })
    await dropExternalSources(tx, id => id === sourceId)
    const { ToolAccess } = await import('./tools.mjs')
    removeResourcesByPrefix(await tx.doc(ToolAccess), [sourceId])
  }
  // ---- Liveness and permission (CONTRACTS §1.3): account connected, tasks granted, same accountKey/authEpoch ----
  async function live(tx, sourceId) {
    const source = await repo.get(tx, 'Source', LOCAL_OWNER, sourceId, sourceId), connection = source && await repo.get(tx, 'Connection', LOCAL_OWNER, sourceId, source.connectionId), a = await account(tx)
    return source && connection?.status === 'active' && a && connection.accountKey === a.accountKey && connection.authEpoch === a.authEpoch ? { source, connection } : null
  }
  async function permission(tx, actor, sourceId, action = 'read', full = false) {
    authority.check(actor)
    const found = typeof sourceId === 'string' && sourceId.startsWith(PREFIX) && validId(sourceId) ? await live(tx, sourceId) : null
    if (!found) fail(403, 'WORKSPACE_EXTERNAL_REVOKED', 'Google 任务来源已断开、撤权或删除，历史缓存不可见。')
    const p = await authority.authorize(repo, tx, actor, sourceId, action)
    if (full && p.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '此操作需要正文权限。')
    return { ...p, binding: { resource: `${sourceId}@${found.connection.authEpoch}`, listId: found.source.providerContainerId } }
  }
  const authorize = (actor, sourceId, action, full) => repo.transaction(tx => permission(tx, actor, sourceId, action, full))

  async function externalSources(actor) {
    user(actor)
    await discover()
    return repo.transaction(async tx => {
      const a = await account(tx)
      if (!a) return { sources: [], notice: '' }
      const sources = []
      for (const [id, entry] of Object.entries((await tx.doc(ExternalSourceIndex)).items)) {
        if (entry.provider !== PROVIDER || entry.accountKey !== a.accountKey || entry.authEpoch !== a.authEpoch || !await live(tx, id)) continue
        const grant = await repo.get(tx, 'Grant', LOCAL_OWNER, id, 'user:authenticated-user')
        sources.push({ id, provider: PROVIDER, authority: 'external', capabilities: ACTIONS, epoch: grant?.epoch ?? 0, authorized: !!grant?.actions.includes('read'), readScope: grant?.readScope ?? 'none', itemType: 'Todo', title: entry.title, readOnly: false })
      }
      return { sources: sources.sort((x, y) => x.title.localeCompare(y.title, 'zh-CN') || x.id.localeCompare(y.id)), notice }
    })
  }

  // Window semantics (CONTRACTS §2.3): due day inside [start, end), every overdue open task, every undated open task.
  async function query(actor, input) {
    authority.check(actor); strict(input, ['sourceId', 'start', 'end', 'timezone'])
    const start = Date.parse(input.start), end = Date.parse(input.end)
    if (![input.start, input.end].every(v => typeof v === 'string' && INSTANT.test(v)) || !(end > start) || end - start > 366 * 86400000 || !validZone(input.timezone)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '任务窗口须为带偏移的起止时间与有效时区。')
    const p = await authorize(actor, input.sourceId, 'read', true), result = await scan(p.binding.listId)
    return repo.transaction(async tx => {
      const current = await permission(tx, actor, input.sourceId, 'read', true)
      if (current.grantEpoch !== p.grantEpoch || current.binding.resource !== p.binding.resource) fail(409, 'WORKSPACE_EXTERNAL_REVOKED', '查询期间授权已变化。')
      const records = await absorb(tx, input.sourceId, result), first = dayOf(start, input.timezone), last = dayOf(end - 1, input.timezone), today = dayOf(clock(), input.timezone)
      const items = records.filter(r => !r.deletedAt && (r.due ? r.due >= first && r.due <= last || r.status === 'open' && r.due < today : r.status === 'open')).map(copy)
      return { items, authority: 'external', sourceId: input.sourceId, provider: PROVIDER, complete: result.complete, incompleteReason: result.complete ? null : 'page_limit', observedAt: iso(), stale: false, capabilities: ACTIONS, notice }
    })
  }
  // Exact read. A task gone from Google is tombstoned and returned deleted, so reminders suppress it.
  async function detail(actor, input) {
    authority.check(actor); strict(input, ['sourceId', 'taskId'])
    if (!validRemoteTaskId(input.taskId)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '任务ID无效。')
    const p = await authorize(actor, input.sourceId, 'read', true), task = await getTask(p.binding.listId, input.taskId)
    return repo.transaction(async tx => {
      const current = await permission(tx, actor, input.sourceId, 'read', true)
      if (current.grantEpoch !== p.grantEpoch || current.binding.resource !== p.binding.resource) fail(409, 'WORKSPACE_EXTERNAL_REVOKED', '查询期间授权已变化。')
      const old = await repo.get(tx, 'Todo', LOCAL_OWNER, input.sourceId, payloadHash([input.sourceId, input.taskId]))
      const { record, changed } = task ? await cacheOne(tx, input.sourceId, task, old) : await tombstone(tx, old)
      if (!record) fail(404, 'WORKSPACE_EXTERNAL_NOT_FOUND', 'Google 中没有找到这项任务。')
      if (changed) await bumpCache(tx, input.sourceId)
      return { items: [copy(record)], authority: 'external', sourceId: input.sourceId, provider: PROVIDER, complete: true, incompleteReason: null, observedAt: iso(), stale: false, capabilities: ACTIONS, notice }
    })
  }

  // ---- Writes ----
  function normalize(action, args) {
    const allowed = { create: ['title', 'due', 'notes', 'status'], update: ['taskId', 'title', 'due', 'notes', 'status'], delete: ['taskId'] }[action]
    if (!object(args) || Object.keys(args).some(k => !allowed.includes(k))) fail(400, 'WORKSPACE_EXTERNAL_INPUT', 'Google 任务参数只接受 title、due、notes、status，修改和删除另需 taskId。')
    const out = {}
    if (action !== 'create') { if (!validRemoteTaskId(args.taskId)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '修改和删除需要读取得到的 taskId。'); out.taskId = args.taskId }
    if (args.title !== undefined || action === 'create') { const title = typeof args.title === 'string' ? args.title.trim() : ''; if (!title || [...title].length > 1000) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '任务标题须为1–1000字。'); out.title = title }
    if (args.due !== undefined) { if (args.due !== null && !validDate(args.due)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', 'Google 任务只记截止日期，请用 YYYY-MM-DD，不能带时刻。'); out.due = args.due }
    if (args.notes !== undefined) { if (args.notes !== null && (typeof args.notes !== 'string' || [...args.notes].length > 4000)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '备注最多4000字。'); out.notes = args.notes }
    if (args.status !== undefined) { if (!['open', 'completed'].includes(args.status)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '状态只能是 open 或 completed。'); out.status = args.status }
    if (action === 'update' && Object.keys(out).length === 1) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '修改至少要给出一个字段。')
    return out
  }
  async function lock(tx, op) {
    const leases = (await tx.doc(GoogleTasksLeases)).items, key = leaseKey(op.normalizedArgs.sourceId, op.action, op.normalizedArgs.arguments), held = leases[key]
    if (held && held.operationId !== op.id) {
      const other = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', held.operationId)
      if (other?.state === 'dispatching' || other?.state === 'unknown' && other.action === 'create' && clock() - Date.parse(held.createdAt) < CREATE_LOCK_MS) fail(409, 'WORKSPACE_EXTERNAL_LOCKED', '同一任务（或同标题新建）还有未决或结果未知的写入，禁止交叉重发；请按原请求查询。')
      delete leases[key]
    }
    return { leases, key }
  }
  async function prepare(actor, input, { expiresInMs = 300000, autoApprove = false, skipReason = null } = {}) {
    authority.check(actor); strict(input, ['sourceId', 'requestId', 'action', 'arguments', 'expectedVersion'])
    if (!validId(input.requestId) || !['create', 'update', 'delete'].includes(input.action) || !object(input.arguments) || Buffer.byteLength(JSON.stringify(input)) > 16000) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '外部命令参数无效。')
    const args = normalize(input.action, input.arguments)
    if (input.action === 'create' ? input.expectedVersion !== undefined : !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '新建不带版本；修改和删除需要先读取得到的 expectedVersion。')
    return repo.transaction(async tx => {
      const p = await permission(tx, actor, input.sourceId, input.action, true)
      const actorRef = { principalKind: actor.principalKind, subjectId: actor.subjectId ?? actor.botId, ...(actor.taskId ? { taskId: actor.taskId } : {}), ...(actor.clientId ? { clientId: actor.clientId } : {}) }
      const signature = payloadHash({ ...input, arguments: args, actor: actorRef }), prior = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', opKey(input.requestId))
      if (prior) { if (prior.payloadHash !== signature) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '请求标识已绑定其他参数。'); return prior }
      let before = null, knownIds = []
      if (input.action === 'create') knownIds = (await cachedTodos(tx, input.sourceId)).filter(r => r.title === args.title).map(r => r.remoteId).slice(-50)
      else {
        const old = await repo.get(tx, 'Todo', LOCAL_OWNER, input.sourceId, payloadHash([input.sourceId, args.taskId]))
        if (!old || old.deletedAt || old.version !== input.expectedVersion) fail(409, 'WORKSPACE_VERSION_CONFLICT', '请先读取这项任务并使用当前版本。')
        if (old.readOnly) fail(409, 'WORKSPACE_EXTERNAL_READ_ONLY', '子任务第一版只读，不能修改或删除。')
        before = { id: old.id, remoteId: old.remoteId, title: old.title, status: old.status, due: old.due, version: old.version, remoteVersion: old.remoteVersion }
      }
      const op = { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: 'operations', id: opKey(input.requestId), requestId: input.requestId, actor: actorRef, action: input.action,
        normalizedArgs: { sourceId: input.sourceId, type: 'Todo', arguments: copy(args), ...(args.title || before ? { data: { title: args.title ?? before.title } } : {}) }, ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
        payloadHash: signature, grantEpoch: p.grantEpoch, state: skipReason ? 'skipped' : autoApprove ? 'ready' : 'awaiting_confirmation', ...(skipReason ? { receipt: { reason: skipReason, notice: '已跳过：这一步需要你来做。' } } : {}),
        external: { ...(actor.principalKind === 'user' ? {} : { originScope: payloadHash(actor.scope) }), ...(autoApprove ? { autoApproved: true } : {}), id: randomUUID(), provider: PROVIDER, binding: p.binding, before, knownIds, expiresAt: new Date(clock() + expiresInMs).toISOString(), notice } }
      if (!skipReason) await lock(tx, op)
      return repo.put(tx, 'Operation', op)
    })
  }
  const save = (tx, op, patch) => repo.put(tx, 'Operation', { ...op, ...patch })
  const stale = (op, p) => op.grantEpoch !== p.grantEpoch || op.external.binding.resource !== p.binding.resource || clock() >= Date.parse(op.external.expiresAt)
  async function operation(tx, actor, requestId) {
    authority.check(actor)
    if (!validId(requestId)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '请求标识无效。')
    const op = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', opKey(requestId))
    if (!op?.external || !op.normalizedArgs?.sourceId?.startsWith(PREFIX)) fail(404, 'WORKSPACE_OPERATION', '外部操作不存在。')
    await permission(tx, actor, op.normalizedArgs.sourceId, 'read', true)
    if (actor.principalKind !== 'user' && payloadHash(op.actor) !== payloadHash({ principalKind: actor.principalKind, subjectId: actor.botId, ...(actor.taskId ? { taskId: actor.taskId } : {}), ...(actor.clientId ? { clientId: actor.clientId } : {}) })) fail(403, 'WORKSPACE_FORBIDDEN', '不能读取其他主体操作。')
    return op
  }
  async function verifyOrigin(tx, op) {
    if (op.actor.principalKind === 'user') return
    if (op.actor.principalKind !== 'agent') fail(403, 'WORKSPACE_FORBIDDEN', '后台外部写入未开放。')
    const origin = op.actor.clientId ? await authority.client(op.actor.clientId, tx) : await authority.agent(op.actor.taskId, tx)
    if (payloadHash(origin.scope) !== op.external.originScope) fail(403, 'WORKSPACE_FORBIDDEN', '原Agent授权已变化，旧建议不可复活。')
    if (origin.botId !== op.actor.subjectId) fail(403, 'WORKSPACE_FORBIDDEN', '原Agent主体已变化。')
    await permission(tx, origin, op.normalizedArgs.sourceId, op.action, true)
  }
  async function execute(actor, input) {
    authority.check(actor); strict(input, ['requestId'])
    const invocation = randomUUID()
    const op = await repo.transaction(async tx => {
      const current = await operation(tx, actor, input.requestId), p = await permission(tx, actor, current.normalizedArgs.sourceId, current.action, true)
      if (actor.principalKind !== 'user' && !current.external.autoApproved) fail(403, 'WORKSPACE_CONFIRMATION_REQUIRED', '仅已由策略直接许可的操作可以自动执行。')
      if (current.state !== 'ready') return current // Never redispatch, including concurrent calls.
      await verifyOrigin(tx, current)
      if (stale(current, p)) fail(409, 'WORKSPACE_CONFIRMATION_STALE', '批准已失效。')
      const { leases, key } = await lock(tx, current)
      leases[key] = { operationId: current.id, createdAt: iso() }
      return save(tx, current, { state: 'dispatching', external: { ...current.external, invocation, dispatchedAt: iso() } })
    })
    if (op.state === 'dispatching' && op.external.invocation === invocation) await dispatch(actor, op, invocation)
    return repo.transaction(tx => operation(tx, actor, input.requestId))
  }
  // Pre-read + etag compare → write (If-Match) → read back. `sent` separates "nothing reached Google" from "unknown".
  async function dispatch(actor, op, invocation) {
    const a = op.normalizedArgs.arguments, sourceId = op.normalizedArgs.sourceId, listId = op.external.binding.listId
    const guard = () => repo.transaction(async tx => {
      const current = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', op.id), p = await permission(tx, actor, sourceId, op.action, true)
      await verifyOrigin(tx, current)
      if (current.state !== 'dispatching' || current.external.invocation !== invocation || stale(current, p)) fail(409, 'WORKSPACE_CONFIRMATION_STALE', '派发前授权或操作版本已变化。')
    })
    let sent = false, outcome
    try {
      await guard()
      if (op.action !== 'create') {
        const fresh = await getTask(listId, a.taskId)
        if (!fresh) outcome = { state: 'conflict', gone: true, reason: 'gone' }
        else if (versionOf(fresh) !== op.external.before.remoteVersion) outcome = { state: 'conflict', task: fresh, reason: 'changed' }
        else if (fresh.parent) outcome = { state: 'conflict', task: fresh, reason: 'changed' }
      }
      if (!outcome) {
        await guard()
        const etag = op.external.before?.remoteVersion, headers = etag && !etag.startsWith('hash:') ? { 'If-Match': etag } : {}
        sent = true
        const response = await google.api('tasks', taskPath(listId, op.action === 'create' ? undefined : a.taskId), { method: { create: 'POST', update: 'PATCH', delete: 'DELETE' }[op.action], headers, ...(op.action === 'delete' ? {} : { body: toWire(a) }) })
        if (op.action === 'delete') { const left = await getTask(listId, a.taskId).catch(() => undefined); outcome = { state: 'succeeded', gone: true, verified: left === null } }
        else {
          const id = op.action === 'create' ? response.data?.id : a.taskId
          if (!validRemoteTaskId(id)) outcome = await resolve(op, null)
          else { const back = await getTask(listId, id).catch(() => undefined); outcome = back ? { state: 'succeeded', task: back, verified: true } : object(response.data) && response.data.id === id ? { state: 'succeeded', task: response.data, verified: false } : await resolve(op, null) }
        }
      }
    } catch (error) {
      const code = error instanceof TaskInputError ? error.code : 'WORKSPACE_EXTERNAL_UNKNOWN'
      if (sent && ['GOOGLE_PRECONDITION', 'GOOGLE_NOT_FOUND', 'GOOGLE_GONE', 'GOOGLE_CONFLICT'].includes(code)) {
        const gone = op.action !== 'create' && ['GOOGLE_NOT_FOUND', 'GOOGLE_GONE'].includes(code), task = op.action === 'create' || gone ? undefined : await getTask(listId, a.taskId).catch(() => undefined)
        outcome = { state: 'conflict', gone: gone || task === null, task: task ?? undefined, reason: gone || task === null ? 'gone' : 'changed', code }
      } else if (!sent || error instanceof TaskInputError && !error.outcomeUnknown && error.status < 500) outcome = { state: 'failed', code, message: error instanceof TaskInputError ? error.message : '写入前出错，没有发送到 Google。' }
      else outcome = await resolve(op, code)
    }
    await persist(op, invocation, outcome)
  }
  // Unknown result: never re-send. Create looks for exactly one new same-title task in the list.
  async function resolve(op, code) {
    const a = op.normalizedArgs.arguments, listId = op.external.binding.listId
    try {
      if (op.action === 'create') {
        const { tasks } = await scan(listId), from = Date.parse(op.external.dispatchedAt) - CREATE_SKEW_MS, hits = tasks.filter(t => created(a, t, op.external.knownIds, from))
        if (hits.length === 1) return { state: 'succeeded', task: hits[0], verified: true, resolvedBy: 'lookup' }
        return { state: 'unknown', code, candidates: hits.length }
      }
      const fresh = await getTask(listId, a.taskId)
      if (op.action === 'delete' && fresh === null) return { state: 'succeeded', gone: true, verified: true, resolvedBy: 'lookup' }
      if (op.action === 'update' && fresh && versionOf(fresh) !== op.external.before.remoteVersion && applied(a, fresh)) return { state: 'succeeded', task: fresh, verified: true, resolvedBy: 'lookup' }
    } catch { /* still unknown */ }
    return { state: 'unknown', code }
  }
  async function persist(op, invocation, outcome) {
    await repo.transaction(async tx => {
      // A late receipt is audit evidence even after revocation: no read gate here.
      const current = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', op.id)
      if (current?.state !== 'dispatching' || current.external.invocation !== invocation) return
      const sourceId = op.normalizedArgs.sourceId, taskId = outcome.task?.id ?? op.normalizedArgs.arguments.taskId
      let record = null
      if (outcome.task) record = (await cacheOne(tx, sourceId, outcome.task)).record
      else if (outcome.gone && taskId) record = (await tombstone(tx, await repo.get(tx, 'Todo', LOCAL_OWNER, sourceId, payloadHash([sourceId, taskId])))).record
      if (record) await bumpCache(tx, sourceId)
      const receipt = { result: { ok: outcome.state === 'succeeded', ...(taskId ? { taskId } : {}), ...(record ? { todoId: record.id, version: record.version, remoteVersion: record.remoteVersion } : {}), ...(outcome.verified !== undefined ? { verified: outcome.verified } : {}), ...(outcome.resolvedBy ? { resolvedBy: outcome.resolvedBy } : {}), ...(outcome.candidates !== undefined ? { candidates: outcome.candidates } : {}) } }
      const error = outcome.state === 'conflict' ? { code: outcome.code ?? 'WORKSPACE_VERSION_CONFLICT', message: CONFLICT[outcome.reason] } : outcome.state === 'failed' ? { code: outcome.code, message: outcome.message }
        : outcome.state === 'unknown' ? { code: 'WORKSPACE_EXTERNAL_UNKNOWN', message: op.action === 'create' ? '没有取得完整回执，Google 中也没有找到唯一的新任务；可能已创建，不会自动重建，请保留原请求核查。' : '没有取得完整回执；可能已写入，禁止重试，请重新读取后核对。' } : undefined
      await save(tx, current, { state: outcome.state, receipt, ...(error ? { error } : {}) })
      if (outcome.state === 'succeeded') await repo.put(tx, 'Outbox', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: op.id, operationId: op.id, targetRef: { type: 'Todo', remoteId: taskId ?? null }, state: 'pending', dedupeKey: op.id })
      const leases = (await tx.doc(GoogleTasksLeases)).items, key = leaseKey(sourceId, op.action, op.normalizedArgs.arguments)
      if (leases[key]?.operationId === op.id && !(outcome.state === 'unknown' && op.action === 'create')) delete leases[key]
    })
  }
  // A later complete scan settles an unknown create when exactly one matching new task exists.
  async function resolvePending(tx, sourceId, tasks) {
    const leases = (await tx.doc(GoogleTasksLeases)).items
    for (const [key, lease] of Object.entries(leases)) {
      const op = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', lease.operationId)
      if (op?.state !== 'unknown' || op.action !== 'create' || op.normalizedArgs.sourceId !== sourceId) continue
      const hits = tasks.filter(t => created(op.normalizedArgs.arguments, t, op.external.knownIds ?? [], Date.parse(op.external.dispatchedAt) - CREATE_SKEW_MS))
      if (hits.length !== 1) continue
      const { error: _old, ...rest } = op, record = (await cacheOne(tx, sourceId, hits[0])).record
      await repo.put(tx, 'Operation', { ...rest, state: 'succeeded', receipt: { result: { ok: true, taskId: hits[0].id, todoId: record.id, version: record.version, remoteVersion: record.remoteVersion, verified: true, resolvedBy: 'later-scan' } } })
      await repo.put(tx, 'Outbox', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: op.id, operationId: op.id, targetRef: { type: 'Todo', remoteId: hits[0].id }, state: 'pending', dedupeKey: op.id })
      delete leases[key]
    }
  }
  // Restart: an interrupted dispatch is unknown (never re-sent); only an unknown create keeps its lease.
  async function recover() {
    if (!repo.enabled) return
    await repo.transaction(async tx => {
      let cursor
      do {
        const page = await repo.list(tx, 'Operation', LOCAL_OWNER, 'operations', { cursor: cursor ?? 0 })
        for (const op of page.items) if (op.external && op.state === 'dispatching' && op.normalizedArgs?.sourceId?.startsWith(PREFIX)) await save(tx, op, { state: 'unknown', error: { code: 'WORKSPACE_RESTART_UNKNOWN', message: '派发中进程中断，不能证明未写入 Google；不会自动重试。' } })
        cursor = page.next
      } while (cursor !== undefined)
      const leases = (await tx.doc(GoogleTasksLeases)).items
      for (const [key, lease] of Object.entries(leases)) { const op = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', lease.operationId); if (!(op?.state === 'unknown' && op.action === 'create')) delete leases[key] }
    })
  }
  // ---- Background rescan (createWorkspaceSync, same claim/backoff/revocation rules as Feishu) ----
  // A window tracks tasks whose anchor day is in [day(start), day(end)): the due day, or today for an
  // undated open task. Cached tasks a complete scan no longer returns come back as tombstones.
  const synchronizer = createWorkspaceSync({ repository: repo, authority, permission, now: clock, ...syncOptions,
    async readWindow(window, p, guard) {
      const sourceId = p.source.id, result = await scan(p.binding.listId)
      await guard()
      const first = dayOf(Date.parse(window.start), window.timezone), last = dayOf(Date.parse(window.end), window.timezone), today = dayOf(clock(), window.timezone)
      const inside = (due, status) => { const d = due ?? (status === 'open' ? today : null); return d !== null && d >= first && d < last }
      const events = result.tasks.filter(t => inside(dueOf(t), statusOf(t)))
      if (result.complete) {
        const seen = new Set(result.tasks.map(t => t.id))
        for (const r of await repo.transaction(tx => cachedTodos(tx, sourceId))) if (!r.deletedAt && !seen.has(r.remoteId) && inside(r.due, r.status)) events.push({ id: r.remoteId, deleted: true })
      }
      return { events, complete: result.complete }
    },
    async cache(tx, _actor, sourceId, task) {
      if (!task.deleted) return (await cacheOne(tx, sourceId, task)).record
      return (await tombstone(tx, await repo.get(tx, 'Todo', LOCAL_OWNER, sourceId, payloadHash([sourceId, task.id])))).record ?? { id: null }
    } })
  async function tick() {
    if (closed || !google?.available || !repo.enabled) return
    const due = await repo.transaction(async tx => {
      const a = await account(tx), ids = []
      if (!a) return ids
      for (const [id, entry] of Object.entries((await tx.doc(ExternalSourceIndex)).items)) {
        if (entry.provider !== PROVIDER || entry.accountKey !== a.accountKey || entry.authEpoch !== a.authEpoch) continue
        const c = await repo.get(tx, 'SyncState', LOCAL_OWNER, id, 'current')
        if (c?.enabled && !['failed', 'revoked'].includes(c.runState) && Date.parse(c.retryAt ?? c.nextDueAt) <= clock()) ids.push(id)
      }
      return ids
    })
    for (const id of due) await synchronizer.tick(id)
  }
  // Optional narrowing by the user. Tasks have no busy-only projection, so the only scope is full.
  async function grant(actor, input) {
    user(actor); strict(input, ['sourceId', 'expectedEpoch', 'confirmed', 'enabled', 'readScope'])
    if (input.confirmed !== true || typeof input.enabled !== 'boolean' || input.readScope !== 'full') fail(400, 'WORKSPACE_EXTERNAL_INPUT', '任务来源只有完整读写一种范围，须明确确认。')
    return repo.transaction(async tx => {
      if (typeof input.sourceId !== 'string' || !input.sourceId.startsWith(PREFIX) || !validId(input.sourceId) || !await live(tx, input.sourceId)) fail(403, 'WORKSPACE_EXTERNAL_REVOKED', '来源不可用。')
      const old = await repo.get(tx, 'Grant', LOCAL_OWNER, input.sourceId, 'user:authenticated-user')
      if (!old || old.epoch !== input.expectedEpoch) fail(409, 'WORKSPACE_VERSION_CONFLICT', '授权版本已变化。')
      return { epoch: (await repo.put(tx, 'Grant', { ...old, actions: input.enabled ? ACTIONS : [], readScope: input.enabled ? 'full' : 'none', epoch: old.epoch + 1 })).epoch }
    })
  }

  return {
    reminderExternalPermission: (tx, actor, sourceId) => permission(tx, actor, sourceId),
    recoverExternal: recover, tickExternalSync: tick,
    async closeExternalSync() { closed = true; await discovery.promise; await synchronizer.close() },
    syncStatus: synchronizer.status, configureSync: synchronizer.configure, refreshSync: synchronizer.refresh,
    externalSources, grantExternal: grant, queryExternal: query, getExternal: detail, prepareExternal: prepare, executeExternal: execute,
    async confirmExternal(actor, input) {
      user(actor); strict(input, ['requestId', 'payloadHash', 'confirmed'])
      if (input.confirmed !== true) fail(400, 'WORKSPACE_CONFIRMATION_REQUIRED', '必须明确批准精确预览。')
      return repo.transaction(async tx => {
        const op = await operation(tx, actor, input.requestId), p = await permission(tx, actor, op.normalizedArgs.sourceId, op.action, true)
        await verifyOrigin(tx, op)
        if (op.payloadHash !== input.payloadHash || stale(op, p)) fail(409, 'WORKSPACE_CONFIRMATION_STALE', '参数、版本、授权或确认有效期已变化，请新建预览。')
        if (op.state !== 'awaiting_confirmation') fail(409, 'WORKSPACE_OPERATION_STATE', '此操作不再等待批准。')
        return save(tx, op, { state: 'ready' })
      })
    },
    async cancelExternal(actor, input) {
      user(actor); strict(input, ['requestId'])
      return repo.transaction(async tx => { const op = await operation(tx, actor, input.requestId); if (!['awaiting_confirmation', 'ready'].includes(op.state)) fail(409, 'WORKSPACE_OPERATION_STATE', '已派发或未知操作不能取消/清账。'); return save(tx, op, { state: 'cancelled' }) })
    },
    async getExternalOperation(actor, input) { strict(input, ['requestId']); return repo.transaction(tx => operation(tx, actor, input.requestId)) },
  }
}
