import { reconcileReminders } from './workspace-reminder-state.mjs'
import { createWorkspaceSync } from './workspace-sync.mjs'
import { randomUUID } from 'node:crypto'
import { LOCAL_OWNER, copy, fail, object, validId, payloadHash } from './workspace-schema.mjs'
import { FEISHU_TOOLS, validFeishuArgs } from './feishu-calendar.mjs'
import { FEISHU_CREATE_TOOL, normalizeFeishuCreate, feishuCreateHash, dispatchFeishuCreate } from './feishu-write.mjs'
import { FEISHU_UPDATE_TOOL, FEISHU_DELETE_TOOL, normalizeFeishuMutation, feishuMutationHash, feishuBeforeHash, supportedFeishuTarget, dispatchFeishuMutation } from './feishu-mutation.mjs'
import { projectWorkspaceRecord } from './workspace-policy.mjs'

const actions = ['read', 'create', 'update', 'delete']
const tools = { create: FEISHU_CREATE_TOOL, update: FEISHU_UPDATE_TOOL, delete: FEISHU_DELETE_TOOL }
const notice = '仅本地串行、写前比较和写后核验；供应商无原子CAS，外部写者仍存在竞态，非exactly-once。'
const opKey = requestId => payloadHash([LOCAL_OWNER, requestId])
const strict = (input, keys) => { if (!object(input) || Object.keys(input).some(k => !keys.includes(k))) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '外部命令包含无效字段。') }

// A single adapter over the existing calendar service/dispatchers. No new HTTP client,
// credentials, Task, approval state machine or database is introduced here.
export function createFeishuWorkspaceService({ repository: repo, authority, calendar, client, legacyUnresolved = async () => false, now = Date.now, syncOptions = {} }) {
  const user = actor => { authority.check(actor); if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_CONFIRMATION_REQUIRED', '只有认证用户可以批准或执行外部操作。') }
  async function sync(tx) {
    const d = await calendar.sync(tx), b = d.binding
    if (!b) return null
    // Stable object identity must NOT depend on the legacy authorization resource.
    const sourceId = `feishu:${payloadHash([b.connectionId, b.calendarId])}`, connectionId = `feishu:${b.connectionId}`
    const old = await repo.get(tx, 'Connection', LOCAL_OWNER, sourceId, connectionId)
    if (!old || old.authEpoch !== b.authorizationVersion) {
      await repo.put(tx, 'Connection', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: connectionId, provider: 'feishu', accountKey: b.connectionId, authEpoch: b.authorizationVersion, status: 'active' })
      await repo.put(tx, 'Source', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: sourceId, connectionId, providerContainerId: b.calendarId, authority: 'external', capabilities: actions })
      const grant = await repo.get(tx, 'Grant', LOCAL_OWNER, sourceId, 'user:authenticated-user')
      await repo.put(tx, 'Grant', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId, id: 'user:authenticated-user', principalKind: 'user', subjectId: 'authenticated-user', actions: [], readScope: 'none', epoch: (grant?.epoch ?? 0) + 1 })
    }
    return { sourceId, binding: copy(b) }
  }
  async function permission(tx, actor, sourceId, action = 'read', full = false) {
    const active = await sync(tx)
    if (!active || active.sourceId !== sourceId) fail(403, 'WORKSPACE_EXTERNAL_REVOKED', '外部来源已切换或断开，历史缓存不可见。')
    const p = await authority.authorize(repo, tx, actor, sourceId, action)
    if (full && p.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '此操作需要正文权限。')
    return { ...p, binding: active.binding }
  }
  const authorize = (actor, sourceId, action, full) => repo.transaction(tx => permission(tx, actor, sourceId, action, full))
  async function cache(tx, actor, sourceId, event, p, fromSync = false) {
    // Busy-only reads do not leave titles/descriptions in a new cache record.
    if (p.readScope !== 'full') return projectWorkspaceRecord('Event', { start: event.start, end: event.end, timezone: event.start.timezone }, p)
    const instanceKey = event.recurrence || event.recurringEventId || event.isException ? event.instanceId : event.eventId
    const id = payloadHash([sourceId, event.eventId, instanceKey]), old = await repo.get(tx, 'Event', actor.ownerId, sourceId, id), remoteVersion = feishuBeforeHash(event)
    const time = t => t.date ?? new Date(Number(t.timestamp) * 1000).toISOString()
    const record = { schemaVersion: 1, ownerId: actor.ownerId, sourceId, id, remoteId: event.eventId, instanceKey, title: event.title, description: event.description, start: time(event.start), end: time(event.end), timezone: event.start.timezone, version: (old?.version ?? 0) + (old?.remoteVersion === remoteVersion ? 0 : 1), remoteVersion, authority: 'external', deletedAt: event.status === 'cancelled' ? old?.deletedAt ?? new Date(now()).toISOString() : null, observedAt: new Date(now()).toISOString(), readOnly: !supportedFeishuTarget(event, p.binding.calendarId), providerEvent: event }
    // Malformed zero-length provider events are returned as read-only, not made writable.
    if (Date.parse(record.end) <= Date.parse(record.start)) return { ...record, readOnly: true }
    if (!fromSync) await bumpCache(tx, sourceId)
    const stored = await repo.put(tx, 'Event', record)
    if (!fromSync) await reconcileReminders(repo, tx, stored, 'Event', now())
    return stored
  }
  async function bumpCache(tx, sourceId) {
    const c = await repo.get(tx, 'SyncState', LOCAL_OWNER, sourceId, 'current')
    if (c) await repo.put(tx, 'SyncState', { ...c, cacheRevision: c.cacheRevision + 1, invalidated: true, nextDueAt: new Date(now()).toISOString() })
  }
  const synchronizer = createWorkspaceSync({ repository: repo, authority, permission,
    readWindow: (window, p, guard) => calendar.read(FEISHU_TOOLS[0], { resource: p.binding.resource, ...window }, { guard }), cache, now, ...syncOptions })
  async function read(actor, input, detail) {
    strict(input, detail ? ['sourceId', 'eventId'] : ['sourceId', 'start', 'end', 'timezone'])
    if (!detail && [input.start, input.end].some(v => typeof v !== 'string' || /\.\d+(?:Z|[+-]\d\d:\d\d)$/.test(v))) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '飞书窗口须使用整秒带偏移时间。')
    if (!detail) {
      const cached = await repo.transaction(async tx => { const p = await permission(tx, actor, input.sourceId); if (!validFeishuArgs(FEISHU_TOOLS[0], { resource: p.binding.resource, start: input.start, end: input.end, timezone: input.timezone })) fail(400, 'FEISHU_INVALID_ARGUMENTS', '窗口或时区无效。'); return synchronizer.cached(tx, actor, input, p) })
      if (cached) return cached
    }
    const p = await authorize(actor, input.sourceId, 'read'), args = { resource: p.binding.resource, ...(detail ? { eventId: input.eventId } : { start: input.start, end: input.end, timezone: input.timezone }) }
    const result = await calendar.read(FEISHU_TOOLS[detail ? 1 : 0], args, { guard: () => authorize(actor, input.sourceId, 'read') })
    return repo.transaction(async tx => {
      const current = await permission(tx, actor, input.sourceId)
      if (current.grantEpoch !== p.grantEpoch || current.binding.resource !== p.binding.resource) fail(409, 'WORKSPACE_EXTERNAL_REVOKED', '查询期间授权已变化。')
      const items = []
      for (const event of detail ? [result.event] : result.events) items.push(await cache(tx, actor, input.sourceId, event, current))
      return { items, authority: 'external', sourceId: input.sourceId, provider: 'feishu', complete: detail || result.complete, incompleteReason: result.incompleteReason ?? null, observedAt: new Date(now()).toISOString(), stale: false, capabilities: current.readScope === 'full' ? actions : ['read'], notice }
    })
  }
  async function operation(tx, actor, requestId, full = true) {
    authority.check(actor)
    if (!validId(requestId)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '请求标识无效。')
    const op = await repo.get(tx, 'Operation', actor.ownerId, 'operations', opKey(requestId))
    if (!op || !op.external) fail(404, 'WORKSPACE_OPERATION', '外部操作不存在。')
    await permission(tx, actor, op.normalizedArgs.sourceId, 'read', full)
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
  async function save(tx, op, patch) { return repo.put(tx, 'Operation', { ...op, ...patch }) }
  function leaseKey(op) { return `${op.external.binding.connectionId}:${op.external.binding.calendarId}:${op.external.arguments.eventId ?? 'create'}` }
  async function lock(tx, op) {
    const d = await calendar.sync(tx), key = leaseKey(op)
    d.eventLeases ??= {}
    const createKey = `${op.external.binding.connectionId}:${op.external.binding.calendarId}:create`
    if (d.eventLeases[createKey] && d.eventLeases[createKey].operationId !== op.id || d.eventLeases[key] && d.eventLeases[key].operationId !== op.id || await legacyUnresolved(tx, op.external.binding, op.external.arguments.eventId)) fail(409, 'WORKSPACE_EXTERNAL_LOCKED', '存在旧路径或新入口的未决/未知操作，禁止交叉重发。')
    return { d, key }
  }
  async function recover() {
    if (!repo.enabled) return
    await repo.transaction(async tx => {
      let cursor
      do {
        const page = await repo.list(tx, 'Operation', LOCAL_OWNER, 'operations', { cursor: cursor ?? 0 })
        for (const op of page.items) if (op.external && op.state === 'dispatching') await save(tx, op, { state: 'unknown', error: { code: 'WORKSPACE_RESTART_UNKNOWN', message: '派发中进程中断，不能证明未发送；不会自动重试。' } })
        cursor = page.next
      } while (cursor !== undefined)
    })
  }
  return {
    reminderExternalPermission: permission,
    recoverExternal: recover,
    syncStatus: synchronizer.status, configureSync: synchronizer.configure, refreshSync: synchronizer.refresh,
    async tickExternalSync() { const a = await repo.transaction(tx => sync(tx)); if (a) await synchronizer.tick(a.sourceId) },
    closeExternalSync: synchronizer.close,
    async externalSources(actor) {
      user(actor)
      return repo.transaction(async tx => {
        const a = await sync(tx)
        if (!a) return { sources: [], notice: '请先在现有连接管理中明确绑定专用应用日历。' }
        const grant = await repo.get(tx, 'Grant', actor.ownerId, a.sourceId, 'user:authenticated-user')
        return { sources: [{ id: a.sourceId, provider: 'feishu', calendarId: a.binding.calendarId, authority: 'external', capabilities: actions, epoch: grant.epoch, authorized: grant.actions.includes('read'), readScope: grant.readScope }], notice }
      })
    },
    async grantExternal(actor, input) {
      user(actor); strict(input, ['sourceId', 'expectedEpoch', 'confirmed', 'enabled', 'readScope'])
      if (input.confirmed !== true || typeof input.enabled !== 'boolean' || !['busy', 'full'].includes(input.readScope)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '来源授权须明确确认权限范围。')
      return repo.transaction(async tx => {
        const a = await sync(tx)
        if (a?.sourceId !== input.sourceId) fail(403, 'WORKSPACE_EXTERNAL_REVOKED', '来源不可用。')
        const old = await repo.get(tx, 'Grant', actor.ownerId, a.sourceId, 'user:authenticated-user')
        if (old.epoch !== input.expectedEpoch) fail(409, 'WORKSPACE_VERSION_CONFLICT', '授权版本已变化。')
        const grant = await repo.put(tx, 'Grant', { ...old, actions: input.enabled ? input.readScope === 'full' ? actions : ['read'] : [], readScope: input.enabled ? input.readScope : 'none', epoch: old.epoch + 1 })
        const requestId = randomUUID()
        await repo.put(tx, 'Operation', { schemaVersion: 1, ownerId: actor.ownerId, sourceId: 'operations', id: opKey(requestId), requestId, actor: { principalKind: 'user', subjectId: actor.subjectId }, action: 'update', normalizedArgs: { sourceId: a.sourceId, grant: true, enabled: input.enabled, readScope: input.readScope }, payloadHash: payloadHash(input), grantEpoch: grant.epoch, state: 'succeeded', receipt: { epoch: grant.epoch } })
        return { epoch: grant.epoch }
      })
    },
    queryExternal: (actor, input) => read(actor, input, false),
    getExternal: (actor, input) => read(actor, input, true),
    async prepareExternal(actor, input, { expiresInMs = 300000, autoApprove = false, skipReason = null } = {}) {
      authority.check(actor); strict(input, ['sourceId', 'requestId', 'action', 'arguments', 'expectedVersion'])
      if (!validId(input.requestId) || !tools[input.action] || !object(input.arguments) || Buffer.byteLength(JSON.stringify(input)) > 16000) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '外部命令参数无效。')
      const p = await authorize(actor, input.sourceId, input.action, true)
      if (Object.hasOwn(input.arguments, 'resource')) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '来源由服务绑定，不接受资源替换。')
      const args = { ...input.arguments, resource: p.binding.resource }, toolName = tools[input.action]
      const normalized = input.action === 'create' ? normalizeFeishuCreate(args) : normalizeFeishuMutation(toolName, args)
      if (!normalized || input.action !== 'create' && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) fail(400, 'WORKSPACE_EXTERNAL_INPUT', '仅支持普通定时事件；更新/删除需要精确读取的版本与beforeHash。')
      const parametersHash = input.action === 'create' ? feishuCreateHash(args) : feishuMutationHash(toolName, args)
      return repo.transaction(async tx => {
        const current = await permission(tx, actor, input.sourceId, input.action, true)
        if (current.binding.resource !== p.binding.resource || current.grantEpoch !== p.grantEpoch) fail(409, 'WORKSPACE_EXTERNAL_REVOKED', '准备期间授权变化。')
        const actorRef = { principalKind: actor.principalKind, subjectId: actor.subjectId ?? actor.botId, ...(actor.taskId ? { taskId: actor.taskId } : {}), ...(actor.clientId ? { clientId: actor.clientId } : {}) }, signature = payloadHash({ ...input, arguments: normalized, actor: actorRef })
        const prior = await repo.get(tx, 'Operation', actor.ownerId, 'operations', opKey(input.requestId))
        if (prior) { if (prior.payloadHash !== signature) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '请求标识已绑定其他参数。'); return prior }
        let before = null
        if (input.action !== 'create') {
          const page = await repo.list(tx, 'Event', actor.ownerId, input.sourceId)
          let candidates = page.items, cursor = page.next
          while (cursor !== undefined) { const more = await repo.list(tx, 'Event', actor.ownerId, input.sourceId, { cursor }); candidates = candidates.concat(more.items); cursor = more.next }
          const found = candidates.find(e => e.remoteId === args.eventId && e.version === input.expectedVersion && e.remoteVersion === args.beforeHash && !e.readOnly)
          if (!found) fail(409, 'WORKSPACE_VERSION_CONFLICT', '请先读取精确事件并使用当前版本。')
          before = found.providerEvent
        }
        const op = { schemaVersion: 1, ownerId: actor.ownerId, sourceId: 'operations', id: opKey(input.requestId), requestId: input.requestId, actor: actorRef, action: input.action, normalizedArgs: { sourceId: input.sourceId, arguments: copy(args) }, ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}), payloadHash: signature, grantEpoch: p.grantEpoch, state: skipReason ? 'skipped' : autoApprove ? 'ready' : 'awaiting_confirmation', ...(skipReason ? { receipt: { reason: skipReason, notice: '已跳过：这一步需要你来做。' } } : {}), external: { ...(actor.principalKind === 'user' ? {} : { originScope: payloadHash(actor.scope) }), ...(autoApprove ? { autoApproved: true } : {}), id: randomUUID(), toolName, arguments: args, parametersHash, binding: p.binding, before, expiresAt: new Date(now() + expiresInMs).toISOString(), notice } }
        if (!skipReason) await lock(tx, op)
        return repo.put(tx, 'Operation', op)
      })
    },
    async confirmExternal(actor, input) {
      user(actor); strict(input, ['requestId', 'payloadHash', 'confirmed'])
      if (input.confirmed !== true) fail(400, 'WORKSPACE_CONFIRMATION_REQUIRED', '必须明确批准精确预览。')
      return repo.transaction(async tx => {
        const op = await operation(tx, actor, input.requestId), p = await permission(tx, actor, op.normalizedArgs.sourceId, op.action, true)
        await verifyOrigin(tx, op)
        if (op.payloadHash !== input.payloadHash || op.grantEpoch !== p.grantEpoch || op.external.binding.resource !== p.binding.resource || now() >= Date.parse(op.external.expiresAt)) fail(409, 'WORKSPACE_CONFIRMATION_STALE', '参数、版本、授权或确认有效期已变化，请新建预览。')
        if (op.state !== 'awaiting_confirmation') fail(409, 'WORKSPACE_OPERATION_STATE', '此操作不再等待批准。')
        return save(tx, op, { state: 'ready' })
      })
    },
    async cancelExternal(actor, input) {
      user(actor); strict(input, ['requestId'])
      return repo.transaction(async tx => { const op = await operation(tx, actor, input.requestId); if (!['awaiting_confirmation', 'ready'].includes(op.state)) fail(409, 'WORKSPACE_OPERATION_STATE', '已派发或未知操作不能取消/清账。'); return save(tx, op, { state: 'cancelled' }) })
    },
    async getExternalOperation(actor, input) { strict(input, ['requestId']); return repo.transaction(tx => operation(tx, actor, input.requestId)) },
    async executeExternal(actor, input) {
      authority.check(actor); strict(input, ['requestId'])
      let op = await repo.transaction(async tx => {
        const current = await operation(tx, actor, input.requestId), p = await permission(tx, actor, current.normalizedArgs.sourceId, current.action, true)
        if (actor.principalKind !== 'user' && !current.external.autoApproved) fail(403, 'WORKSPACE_CONFIRMATION_REQUIRED', '仅已由策略直接许可的操作可以自动执行。')
        if (current.state !== 'ready') return current // Never redispatch, including concurrent calls.
        await verifyOrigin(tx, current)
        if (current.grantEpoch !== p.grantEpoch || current.external.binding.resource !== p.binding.resource || now() >= Date.parse(current.external.expiresAt)) fail(409, 'WORKSPACE_CONFIRMATION_STALE', '批准已失效。')
        const { d, key } = await lock(tx, current)
        d.eventLeases[key] = { operationId: current.id, workspace: true, createdAt: new Date(now()).toISOString() }
        return save(tx, current, { state: 'dispatching' })
      })
      // Only this invocation owns the state transition. A local token is intentionally
      // not reconstructed after restart; dispatching is recovered as unknown.
      if (op.state !== 'dispatching') return op
      const invocation = randomUUID()
      const owned = await repo.transaction(async tx => {
        const current = await operation(tx, actor, input.requestId)
        if (current.state !== 'dispatching' || current.external.invocation) return false
        op = await save(tx, current, { external: { ...current.external, invocation } }); return true
      })
      if (!owned) return repo.transaction(tx => operation(tx, actor, input.requestId))
      const guard = async () => repo.transaction(async tx => {
        const current = await operation(tx, actor, input.requestId), p = await permission(tx, actor, op.normalizedArgs.sourceId, op.action, true)
        await verifyOrigin(tx, current)
        if (current.state !== 'dispatching' || current.external.invocation !== invocation || p.grantEpoch !== op.grantEpoch || p.binding.resource !== op.external.binding.resource || now() >= Date.parse(op.external.expiresAt)) fail(409, 'WORKSPACE_CONFIRMATION_STALE', '派发前授权或操作版本已变化。')
        await lock(tx, current)
      })
      const persist = (providerReceipt, result) => repo.transaction(async tx => {
        // A late receipt is audit evidence even after revocation; do not use a read
        // permission gate here and do not revive a cancelled Task.
        const current = await repo.get(tx, 'Operation', actor.ownerId, 'operations', op.id)
        if (current.external.invocation !== invocation) throw Error('External receipt ownership mismatch')
        await save(tx, current, { ...(providerReceipt ? { receipt: { providerReceipt } } : {}), ...(result ? { state: result.ok ? 'succeeded' : 'conflict', receipt: { ...current.receipt, result } } : {}) })
        if (result) {
          const d = await calendar.sync(tx), key = leaseKey(op)
          if (result.ok) {
            const data = result.data
            const event = op.action === 'create' ? data.providerEvent : data.event
            if (event) await cache(tx, actor, op.normalizedArgs.sourceId, event, { readScope: 'full', binding: op.external.binding })
            else if (op.action === 'delete') {
              const before = op.external.before, id = payloadHash([op.normalizedArgs.sourceId, before.eventId, before.recurrence || before.recurringEventId || before.isException ? before.instanceId : before.eventId]), old = await repo.get(tx, 'Event', actor.ownerId, op.normalizedArgs.sourceId, id)
              if (old) { await bumpCache(tx, op.normalizedArgs.sourceId); await repo.put(tx, 'Event', { ...old, version: old.version + 1, deletedAt: new Date(now()).toISOString() }) }
            }
            await repo.put(tx, 'Outbox', { schemaVersion: 1, ownerId: actor.ownerId, sourceId: op.normalizedArgs.sourceId, id: op.id, operationId: op.id, targetRef: { type: 'Event', remoteId: data.eventId }, state: 'pending', dedupeKey: op.id })
          }
          if (d.eventLeases?.[key]?.operationId === op.id) delete d.eventLeases[key]
        }
      })
      try {
        const external = op.external, dispatch = op.action === 'create' ? dispatchFeishuCreate : dispatchFeishuMutation
        await dispatch({ client, operation: { id: external.id, idempotencyKey: external.id, toolName: external.toolName, arguments: external.arguments, parametersHash: external.parametersHash, source: external.binding, before: external.before }, guard, persist })
      } catch {
        await repo.transaction(async tx => { const current = await repo.get(tx, 'Operation', actor.ownerId, 'operations', op.id); if (current.state === 'dispatching') await save(tx, current, { state: 'unknown', error: { code: 'WORKSPACE_EXTERNAL_UNKNOWN', message: '未取得完整核验回执；可能已发送，禁止重试，请保留原请求核查。' } }) })
      }
      return repo.transaction(tx => operation(tx, actor, input.requestId))
    },
  }
}
