import { rawWorkspaceRecord, workspaceSourceReadable } from './workspace-grants.mjs'
import { reconcileReminders } from './workspace-reminder-state.mjs'
import { randomUUID } from 'node:crypto'
import { copy, fail, object, validId, payloadHash } from './workspace-schema.mjs'
import { projectWorkspaceRecord } from './workspace-policy.mjs'
import { markDirty } from './detector-state.mjs'

const keys = (value, allowed) => {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(400, 'WORKSPACE_INPUT', '业务参数含不支持的字段。')
}
const zone = value => {
  if (typeof value !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) fail(400, 'WORKSPACE_TIMEZONE', '请使用IANA时区。')
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format() } catch { fail(400, 'WORKSPACE_TIMEZONE', '请使用有效IANA时区。') }
  return value
}
const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'WORKSPACE_DATE', '时间须为有效的带偏移ISO时间。')
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail(400, 'WORKSPACE_DATE', '日期或时间超出范围。')
  return new Date(value).toISOString()
}
const dueDate = value => {
  if (value === null) return null
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(400, 'WORKSPACE_DATE', '截止日期无效。')
    return value
  }
  return instant(value)
}
export function normalizeLocalChange(type, data, action) {
  if (action === 'delete') { if (data !== undefined) fail(400, 'WORKSPACE_INPUT', '删除不接受新正文。'); return {} }
  const allowed = type === 'Event' ? ['title', 'description', 'start', 'end', 'timezone'] : ['title', 'status', 'due', 'timezone']
  keys(data, allowed)
  if (!Object.keys(data).length) fail(400, 'WORKSPACE_INPUT', '修改内容不能为空。')
  const result = copy(data)
  if (data.title !== undefined && (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 500)) fail(400, 'WORKSPACE_TITLE', '标题须为1–500字符。')
  if (data.title !== undefined) result.title = data.title.trim()
  if (data.description !== undefined && (typeof data.description !== 'string' || data.description.length > 4000)) fail(400, 'WORKSPACE_INPUT', '描述不能超过4000字符。')
  if (data.timezone !== undefined) result.timezone = zone(data.timezone)
  if (type === 'Event') {
    for (const k of ['start', 'end']) if (data[k] !== undefined) result[k] = instant(data[k])
    if (action === 'create' && ['title', 'start', 'end', 'timezone'].some(k => result[k] === undefined)) fail(400, 'WORKSPACE_INPUT', '日程缺少标题、时间或时区。')
  } else {
    if (data.due !== undefined) result.due = dueDate(data.due)
    if (data.status !== undefined && !['open', 'completed'].includes(data.status)) fail(400, 'WORKSPACE_INPUT', '待办状态无效。')
    if (action === 'create') {
      if (!result.title) fail(400, 'WORKSPACE_TITLE', '待办须有标题。')
      result.status ??= 'open'; result.due ??= null; result.timezone ??= 'Asia/Shanghai'
    }
  }
  return result
}

// Local authority only. HTTP/MCP may call these methods, never supply transaction effects.
export function createLocalWorkspaceService({ repository: repo, authority, commitLocal, authorizeReminderSource, links: linkService }) {
  const user = actor => { authority.check(actor); if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_CONFIRMATION_REQUIRED', '此入口仅供认证用户明确提交。') }
  async function permission(tx, actor, sourceId, action = 'read', full = false) {
    const p = await authority.authorize(repo, tx, actor, sourceId, action)
    if (p.source.authority !== 'local') fail(403, 'WORKSPACE_LOCAL_ONLY', '此入口仅处理本地权威来源。')
    if (full && p.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '正文权限不足。')
    return p
  }
  const envelope = (items, p, next) => ({ items, ...(next !== undefined ? { next } : {}), authority: p.source.authority, capabilities: p.source.capabilities, observedAt: new Date().toISOString(), complete: next === undefined, stale: false })
  async function links(tx, actor, sourceId, options) {
    const page = await repo.list(tx, 'ItemLink', actor.ownerId, sourceId, options)
    const items = []
    for (const link of page.items) {
      let pair
      try { pair = await linkService.permitted(tx, actor, link, sourceId) }
      catch (e) { if (e.status === 403 || e.statusCode === 403) continue; throw e }
      const todo = await repo.get(tx, 'Todo', actor.ownerId, pair.todoRef.sourceId, pair.todoRef.id)
      const event = await repo.get(tx, 'Event', actor.ownerId, pair.eventRef.sourceId, pair.eventRef.id)
      items.push({ ...link, ...pair, todoState: !todo ? 'unavailable' : todo.deletedAt ? 'deleted' : todo.status, eventState: !event ? 'unavailable' : event.deletedAt ? 'deleted' : 'active' })
    }
    return { ...page, items }
  }
  return {
    async manageLocalGrant(actor, input) {
      user(actor); keys(input, ['requestId', 'sourceId', 'enabled', 'expectedEpoch', 'confirmed'])
      if (input.sourceId !== 'local' || !validId(input.requestId) || typeof input.enabled !== 'boolean' || input.confirmed !== true || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0) fail(400, 'WORKSPACE_GRANT', '须明确确认本地用户来源许可与当前版本。')
      // ADR-011: owner access to the local source is implicit and cannot be switched off.
      // enabled:true stays accepted (epoch bump keeps legacy explicit-rotation semantics).
      if (input.enabled !== true) fail(400, 'WORKSPACE_OWNER_IMPLICIT', '本机所有者对本地工作区始终拥有完整权限；请调整Bot工具与来源勾选。')
      return repo.transaction(async tx => {
        const id = payloadHash([actor.ownerId, input.requestId]), signature = payloadHash({ kind: 'local-grant', input, subject: actor.subjectId })
        const old = await repo.get(tx, 'Operation', actor.ownerId, 'operations', id)
        if (old) { if (old.payloadHash !== signature) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '请求标识参数冲突。'); return old }
        const source = await repo.get(tx, 'Source', actor.ownerId, 'local', 'local')
        if (source?.authority !== 'local') fail(403, 'WORKSPACE_FORBIDDEN', '本地来源不可用。')
        const grant = await repo.get(tx, 'Grant', actor.ownerId, 'local', 'user:authenticated-user')
        if ((grant?.epoch ?? 0) !== input.expectedEpoch) fail(409, 'WORKSPACE_VERSION_CONFLICT', '来源许可已改变，请刷新。')
        const epoch = input.expectedEpoch + 1
        await repo.put(tx, 'Grant', { schemaVersion: 1, ownerId: actor.ownerId, sourceId: 'local', id: 'user:authenticated-user', principalKind: 'user', subjectId: actor.subjectId, actions: input.enabled ? ['read', 'create', 'update', 'delete'] : [], readScope: input.enabled ? 'full' : 'none', epoch })
        return repo.put(tx, 'Operation', { schemaVersion: 1, ownerId: actor.ownerId, sourceId: 'operations', id, requestId: input.requestId, actor: { principalKind: 'user', subjectId: actor.subjectId }, action: 'manageGrant', normalizedArgs: copy(input), payloadHash: signature, grantEpoch: epoch, state: 'succeeded', receipt: { sourceId: 'local', enabled: input.enabled, epoch } })
      })
    },
    async query(actor, input) {
      authority.check(actor); keys(input, ['type', 'sourceId', 'cursor', 'limit'])
      return repo.transaction(async tx => {
        const p = await permission(tx, actor, input.sourceId)
        if (!['Todo', 'Event', 'ItemLink'].includes(input.type)) fail(400, 'WORKSPACE_INPUT', '业务类型无效。')
        if (p.readScope !== 'full' && input.type !== 'Event') fail(403, 'WORKSPACE_FORBIDDEN', '正文权限不足。')
        const page = input.type === 'ItemLink' ? await links(tx, actor, input.sourceId, input) : await repo.list(tx, input.type, actor.ownerId, input.sourceId, input)
        return envelope(page.items.map(r => input.type === 'ItemLink' ? r : projectWorkspaceRecord(input.type, r, p)), p, page.next)
      })
    },
    async getLocalItem(actor, input) {
      authority.check(actor); keys(input, ['type', 'sourceId', 'id'])
      return repo.transaction(async tx => {
        const p = await permission(tx, actor, input.sourceId)
        if (!['Todo', 'Event'].includes(input.type)) fail(400, 'WORKSPACE_INPUT', '业务类型无效。')
        if (p.readScope !== 'full' && input.type !== 'Event') fail(403, 'WORKSPACE_FORBIDDEN', '正文权限不足。')
        const r = await repo.get(tx, input.type, actor.ownerId, input.sourceId, input.id)
        return envelope(r ? [projectWorkspaceRecord(input.type, r, p)] : [], p)
      })
    },
    async getLocalOperation(actor, input) {
      user(actor); keys(input, ['requestId', 'sourceId'])
      return repo.transaction(async tx => {
        await permission(tx, actor, input.sourceId, 'read', true)
        if (!validId(input.requestId)) fail(400, 'WORKSPACE_INPUT', '请求标识无效。')
        const op = await repo.get(tx, 'Operation', actor.ownerId, 'operations', payloadHash([actor.ownerId, input.requestId]))
        if (!op || op.actor.subjectId !== actor.subjectId || op.normalizedArgs.sourceId !== input.sourceId) return null
        if (op.normalizedArgs.type === 'Schedule') {
          const schedule = op.normalizedArgs.id ? await rawWorkspaceRecord(tx, 'Schedule', 'local', op.normalizedArgs.id) : null
          for (const id of (op.normalizedArgs.actionSpec?.sourceIds ?? schedule?.actionSpec?.sourceIds ?? [])) {
            if (!await workspaceSourceReadable(tx, op.normalizedArgs.actionSpec?.botId ?? schedule?.actionSpec?.botId, id)) fail(403, 'WORKSPACE_FORBIDDEN', '工作流来源许可已失效，历史管理回执不可读。')
          }
        }
        if (op.normalizedArgs.type === 'Reminder') {
          const ref = op.normalizedArgs.targetSourceId ?? op.normalizedArgs.targetRef?.sourceId ?? op.normalizedArgs.sourceId
          const targetPermission = await authorizeReminderSource(tx, actor, ref)
          if (targetPermission.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '提醒历史回执需要当前目标正文权限。')
        }
        if (op.normalizedArgs.type === 'ItemLink') await linkService.permitted(tx, actor, op.normalizedArgs.data, input.sourceId)
        return op
      })
    },
    async executeLocal(actor, input) {
      user(actor); keys(input, ['requestId', 'sourceId', 'type', 'action', 'id', 'expectedVersion', 'data', 'confirmedDelete'])
      if (!['Event', 'Todo', 'ItemLink'].includes(input.type) || !['create', 'update', 'delete'].includes(input.action) || !validId(input.sourceId) || !validId(input.requestId)) fail(400, 'WORKSPACE_COMMAND', '本地命令无效。')
      if (input.action === 'create' ? input.id !== undefined || input.expectedVersion !== undefined : !validId(input.id) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail(400, 'WORKSPACE_VERSION', '修改/删除须提供精确对象和expectedVersion。')
      if (input.action === 'delete' && (input.confirmedDelete !== true || input.data !== undefined)) fail(400, 'WORKSPACE_CONFIRMATION_REQUIRED', '删除须明确确认精确对象与版本。')
      if (input.action !== 'delete' && input.confirmedDelete !== undefined) fail(400, 'WORKSPACE_COMMAND', '确认字段不适用于此操作。')
      let data
      if (input.type === 'ItemLink') {
        if (input.action !== 'create') fail(400, 'WORKSPACE_UNSUPPORTED', '关联记录为保留历史的显式关系，不支持修改或删除。')
        data = linkService.normalize(input.data, input.sourceId)
      } else data = input.action === 'delete' ? {} : normalizeLocalChange(input.type, input.data, input.action)
      const normalizedArgs = { type: input.type, data, ...(input.id ? { id: input.id, expectedVersion: input.expectedVersion } : {}), ...(input.action === 'delete' ? { confirmedDelete: true } : {}) }
      return commitLocal(actor, { requestId: input.requestId, sourceId: input.sourceId, action: input.action, normalizedArgs }, (tx, { operationId }) => applyLocalConfirmed(tx, actor, input, operationId, data))
    },
    normalizeLocalChange,
    applyLocalConfirmed,
    // Undo of one automatic local write (I-13). Deterministic requestId undo:<operationId> and
    // args, so commitLocal makes repeats idempotent. Refused if the object changed since.
    async undoLocal(actor, op) {
      user(actor)
      const action = op.action === 'create' ? 'delete' : 'update'
      const normalizedArgs = { type: op.normalizedArgs.type, undoOf: op.id, id: op.receipt.target.id, expectedVersion: op.receipt.version }
      return commitLocal(actor, { requestId: `undo:${op.id}`, sourceId: 'local', action, normalizedArgs }, (tx, { operationId }) => applyUndo(tx, actor, op, operationId))
    },
  }
  async function applyUndo(tx, actor, op, operationId) {
    const type = op.normalizedArgs.type, sourceId = 'local'
    await permission(tx, actor, sourceId, op.action === 'create' ? 'delete' : 'update', true)
    const current = await repo.get(tx, type, actor.ownerId, sourceId, op.receipt.target.id)
    if (!current || current.version !== op.receipt.version) fail(409, 'WORKSPACE_UNDO_CONFLICT', '已被修改，不能撤销。')
    let record
    if (op.action === 'create') record = { ...current, version: current.version + 1, deletedAt: new Date().toISOString() }
    else if (op.action === 'delete') record = { ...current, version: current.version + 1, deletedAt: null }
    else {
      const before = op.confirmation?.before
      if (!before) fail(409, 'WORKSPACE_UNDO_CONFLICT', '缺少修改前快照，不能撤销。')
      const restored = Object.fromEntries(Object.keys(op.normalizedArgs.data ?? {}).filter(k => before[k] !== undefined).map(k => [k, copy(before[k])]))
      record = { ...current, ...restored, version: current.version + 1 }
    }
    if (type === 'Event' && Date.parse(record.start) >= Date.parse(record.end)) fail(400, 'WORKSPACE_DATE', '日程结束必须晚于开始。')
    await repo.put(tx, type, record)
    // D-14: undoing an automatic change must not re-trigger the routine that made it.
    await markDirty(tx, { sourceId, type, id: record.id, trigger: false })
    await reconcileReminders(repo, tx, record, type)
    const receipt = { target: { type, id: record.id, sourceId }, version: record.version, deletedAt: record.deletedAt ?? null, undoOf: op.requestId, ...(record.status ? { status: record.status } : {}) }
    await repo.put(tx, 'Outbox', { schemaVersion: 1, ownerId: actor.ownerId, sourceId, id: operationId, operationId, targetRef: { ...receipt.target, version: receipt.version }, state: 'pending', dedupeKey: operationId })
    return receipt
  }
  async function applyLocalConfirmed(tx, actor, input, operationId, normalizedData) {
    user(actor)
    const data = normalizedData ?? normalizeLocalChange(input.type, input.data, input.action)
    await permission(tx, actor, input.sourceId, input.action, true)
        await permission(tx, actor, input.sourceId, 'read', true)
        const base = { schemaVersion: 1, ownerId: actor.ownerId, sourceId: input.sourceId }
        let record
        if (input.type === 'ItemLink') {
          record = await linkService.create(tx, actor, data, input.sourceId)
        } else if (input.action === 'create') record = { ...base, id: randomUUID(), ...data, ...(input.type === 'Event' ? { authority: 'local', description: data.description ?? '' } : {}), version: 1, deletedAt: null }
        else {
          const old = await repo.get(tx, input.type, actor.ownerId, input.sourceId, input.id)
          if (!old || old.deletedAt || old.version !== input.expectedVersion) fail(409, 'WORKSPACE_VERSION_CONFLICT', '对象已变更或删除，请刷新后重新提交；原值未覆盖。')
          record = { ...old, ...data, version: old.version + 1, ...(input.action === 'delete' ? { deletedAt: new Date().toISOString() } : {}) }
        }
        if (input.type === 'Event' && Date.parse(record.start) >= Date.parse(record.end)) fail(400, 'WORKSPACE_DATE', '日程结束必须晚于开始。')
        await repo.put(tx, input.type, record)
        await markDirty(tx, { sourceId: input.sourceId, type: input.type, id: record.id })
        if (['Event', 'Todo'].includes(input.type)) await reconcileReminders(repo, tx, record, input.type)
        const receipt = { target: { type: input.type, id: record.id, sourceId: input.sourceId }, ...(input.type === 'ItemLink' ? { ...linkService.refs(record, input.sourceId), todoVersion: record.todoVersion ?? null, eventVersion: record.eventVersion ?? null } : {}), version: record.version ?? null, deletedAt: record.deletedAt ?? null, ...(record.status ? { status: record.status } : {}) }
        await repo.put(tx, 'Outbox', { ...base, id: operationId, operationId, targetRef: { ...receipt.target, version: receipt.version }, state: 'pending', dedupeKey: operationId })
        return receipt
  }
}
