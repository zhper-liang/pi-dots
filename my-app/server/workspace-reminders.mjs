import { copy, fail, object, validId, LOCAL_OWNER, payloadHash } from './workspace-schema.mjs'
import { normalizeScheduleRule } from './workspace-schedule-rules.mjs'
import { reminderPages, reminderDue, reminderBase as base, notificationKey } from './workspace-reminder-state.mjs'
const iso = t => new Date(t).toISOString()
const strict = (input, keys) => { if (!object(input) || Object.keys(input).some(k => !keys.includes(k))) fail(400, 'WORKSPACE_REMINDER_INPUT', '提醒参数无效；不接受请求主体。') }
// Pure inbox channel: no model, chat, push, external write or new Task.
export function createWorkspaceReminders({ repository: repo, authority, service, workflows, now = Date.now, boundary = async () => {} }) {
  const get = (tx, type, id, source = 'local') => repo.get(tx, type, LOCAL_OWNER, source, id)
  const user = actor => { authority.check(actor); if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_REMINDER_ACTOR', '提醒与收件箱仅供认证用户。') }
  async function permission(tx, sourceId) {
    const actor = authority.user()
    return sourceId === 'local' ? authority.authorize(repo, tx, actor, sourceId, 'read') : service.reminderExternalPermission(tx, actor, sourceId)
  }
  async function snapshot(tx, sourceId) {
    const p = await permission(tx, sourceId), c = await get(tx, 'Connection', p.source.connectionId, sourceId)
    if (p.readScope !== 'full') fail(403, 'WORKSPACE_REMINDER_SCOPE', '提醒需要目标正文授权；忙闲权限不能读取或缓存通知详情。')
    return { sourceId, userEpoch: p.grantEpoch, connectionEpoch: c.authEpoch }
  }
  const owns = s => s?.actionSpec?.kind === 'deliver_notification'
  async function authorized(tx, s) {
    try { const current = await snapshot(tx, s.actionSpec.sourceId); return payloadHash(current) === payloadHash(s.authorizationSnapshot) && s.executionPrincipal.kind === 'internal' && s.executionPrincipal.subjectId === 'authenticated-user' } catch (e) { if (e.status === 403 || e.statusCode === 403 || /FORBIDDEN|REVOKED|SCOPE/.test(e.code)) return false; throw e }
  }
  async function target(tx, ref) {
    if (!object(ref) || !['Event', 'Todo'].includes(ref.type) || !validId(ref.sourceId) || !validId(ref.id) || ref.sourceId !== 'local' && ref.type !== 'Event' || Object.keys(ref).some(k => !['type', 'sourceId', 'id'].includes(k))) fail(400, 'WORKSPACE_REMINDER_TARGET', '需要精确来源、类型与目标ID。')
    await snapshot(tx, ref.sourceId)
    const t = await get(tx, ref.type, ref.id, ref.sourceId)
    if (!t || t.deletedAt || t.status === 'completed') fail(409, 'WORKSPACE_REMINDER_TARGET', '目标已删除、完成或尚未精确读取。')
    return t
  }
  async function manage(actor, input) {
    user(actor); strict(input, ['requestId', 'command', 'targetRef', 'targetVersion', 'offset', 'at', 'channel', 'confirmed', 'id', 'sourceId', 'expectedVersion'])
    if (!validId(input.requestId) || !['create', 'disable'].includes(input.command) || input.confirmed !== true) fail(400, 'WORKSPACE_REMINDER_CONFIRM', '需明确确认提醒时间/频率与停用范围。')
    if (input.command === 'create' && (input.channel !== 'inbox' || (input.at !== undefined) === (input.offset !== undefined) || input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Math.abs(input.offset) > 31536000) || !Number.isSafeInteger(input.targetVersion))) fail(400, 'WORKSPACE_REMINDER_INPUT', '仅支持收件箱；指定带时区的一次性时间或相对秒数与目标版本。')
    if (input.command === 'disable' && (!validId(input.id) || !validId(input.sourceId) || !Number.isSafeInteger(input.expectedVersion))) fail(400, 'WORKSPACE_REMINDER_INPUT', '停用需要精确提醒ID与版本。')
    const op = await service.commitLocal(actor, { requestId: input.requestId, sourceId: 'local', action: input.command === 'create' ? 'create' : 'update', normalizedArgs: { type: 'Reminder', ...copy(input), targetSourceId: input.targetRef?.sourceId ?? input.sourceId } }, async tx => {
      if (input.command === 'disable') {
        const r = await get(tx, 'Reminder', input.id, input.sourceId)
        await snapshot(tx, input.sourceId)
        if (!r || !r.enabled || r.version !== input.expectedVersion) fail(409, 'WORKSPACE_REMINDER_VERSION', '提醒已变更或已停用；不能复活。')
        const s = await get(tx, 'Schedule', r.scheduleId), at = iso(now())
        const o = s.activeOccurrenceId && await get(tx, 'Occurrence', s.activeOccurrenceId)
        if (o && ['claimed', 'retry_wait'].includes(o.state)) await repo.put(tx, 'Occurrence', { ...o, state: 'cancelled', reason: 'reminder_disabled', finishedAt: at })
        await repo.put(tx, 'Schedule', { ...s, enabled: false, revision: s.revision + 1, status: 'cancelled', updatedAt: at })
        const saved = await repo.put(tx, 'Reminder', { ...r, enabled: false, version: r.version + 1, state: 'cancelled', reason: 'user_disabled', updatedAt: at })
        return { reminder: saved, scheduleId: s.id }
      }
      const t = await target(tx, input.targetRef)
      if (t.version !== input.targetVersion) fail(409, 'WORKSPACE_REMINDER_VERSION', '目标版本已变化，请精确刷新后重提。')
      if (t.remoteId && t.authority !== 'external') fail(403, 'WORKSPACE_REMINDER_TARGET', '外部目标权威标记无效。')
      if (t.due === null || t.due === undefined && input.targetRef.type === 'Todo') fail(400, 'WORKSPACE_REMINDER_BASE', '无截止时间的待办不能设置提醒。')
      const at = input.at === undefined ? undefined : normalizeScheduleRule({ type: 'at', at: input.at }, t.timezone).at
      const id = payloadHash(['reminder', actor.ownerId, input.requestId]), scheduleId = payloadHash(['reminder-schedule', id]), time = iso(now())
      const r = { ...base(t.sourceId, id), targetRef: copy(input.targetRef), targetVersion: t.version, ...(at ? { at } : { offset: input.offset }), channel: 'inbox', enabled: true, version: 1, scheduleId, invalidated: false, state: 'active', reason: null, authorizationSnapshot: await snapshot(tx, t.sourceId), createdAt: time, updatedAt: time }
      const due = reminderDue(r, t)
      if (due === null || !Number.isFinite(due) || due <= now()) fail(400, 'WORKSPACE_REMINDER_BASE', '提醒需要未来瞬间；全天或仅日期目标请明确一次性时刻，不能猜测午夜。')
      const schedules = await reminderPages(repo, tx, 'Schedule')
      if (schedules.length >= 200) fail(409, 'WORKSPACE_SCHEDULE_CAPACITY', '计划含审计达到200条，需容量评审。')
      const s = { ...base('local', scheduleId), title: '关联提醒', executionPrincipal: { kind: 'internal', subjectId: actor.subjectId }, actionSpec: { kind: 'deliver_notification', sourceId: t.sourceId, reminderId: id, reminderVersion: 1 }, timezone: t.timezone ?? 'UTC', rule: { type: 'at', at: iso(due) }, enabled: true, revision: 1, nextDueAt: iso(due), status: 'active', authorizationSnapshot: r.authorizationSnapshot, misfirePolicy: { type: 'grace', graceMs: 900000, overlap: 'coalesce', recoveryBatch: 10 }, retryPolicy: { maxAttempts: 3, backoffMs: [30000, 120000], safeInternalOnly: true }, callLimits: { modelCalls: 0, toolCalls: 0 }, activeOccurrenceId: null, createdAt: time, updatedAt: time }
      await repo.put(tx, 'Reminder', r); await repo.put(tx, 'Schedule', s)
      return { reminder: r, scheduleId, notice: '仅持久应用收件箱，非系统推送；后端需运行，停机不执行。' }
    })
    return op
  }
  async function preflight(row) {
    const data = await repo.transaction(async tx => {
      const s = await get(tx, 'Schedule', row.scheduleId)
      if (!owns(s) || !await authorized(tx, s)) return null
      const r = await get(tx, 'Reminder', s.actionSpec.reminderId, s.actionSpec.sourceId), t = r && await get(tx, r.targetRef.type, r.targetRef.id, r.sourceId)
      return { s, r, t }
    })
    if (!data?.t || data.t.authority !== 'external') return null
    // Every external send does a fresh exact provider read (never cache-success).
    await boundary('before_external_verify', copy(row))
    const result = await service.getExternal(authority.user(), { sourceId: data.t.sourceId, eventId: data.t.remoteId })
    const t = result.items.find(t => t.id === data.t.id && t.instanceKey === data.t.instanceKey)
    if (!t) throw Error('REMINDER_EXTERNAL_INSTANCE_UNVERIFIED')
    return { targetId: t.id, targetVersion: t.version, remoteVersion: t.remoteVersion }
  }
  async function deliver(tx, o, s, verification) {
    const r = await get(tx, 'Reminder', s.actionSpec.reminderId, s.actionSpec.sourceId), t = r && await get(tx, r.targetRef.type, r.targetRef.id, r.sourceId)
    let reason = !r?.enabled ? 'reminder_disabled' : !t || t.deletedAt ? 'target_deleted' : t.status === 'completed' ? 'target_completed' : r.invalidated || r.version !== s.actionSpec.reminderVersion || t.version !== r.targetVersion ? 'target_changed' : reminderDue(r, t) !== Date.parse(o.scheduledFor) ? 'due_changed' : null
    if (!reason && now() - Date.parse(o.scheduledFor) > s.misfirePolicy.graceMs) reason = 'grace_expired'
    if (!reason && t.authority === 'external' && (!verification || verification.targetId !== t.id || verification.targetVersion !== t.version || verification.remoteVersion !== t.remoteVersion)) reason = 'external_unverified'
    if (reason) return { suppressed: true, reason, modelCalls: 0, toolCalls: 0 }
    const id = notificationKey(o, r.version), previous = await get(tx, 'Delivery', id), time = iso(now())
    if (previous) {
      if (previous.status !== 'recorded') return { unknown: true, reason: 'existing_delivery_preserved', deliveryId: previous.id }
      return { deliveryId: id, notificationId: previous.notificationId, recordedAt: previous.recordedAt, notificationDelivered: false, modelCalls: 0, toolCalls: 0 }
    }
    await boundary('in_delivery', copy(o))
    await repo.put(tx, 'Delivery', { ...base('local', id), dedupeKey: id, itemVersion: r.version, status: 'recorded', channel: 'inbox', attempts: o.attempts, attemptedAt: time, recordedAt: time, readAt: null, notificationId: id, occurrenceId: o.id, scheduleId: s.id, result: { kind: 'durable-inbox', systemPush: false, userReceived: 'unknown' } })
    await repo.put(tx, 'Notification', { ...base('local', id), dedupeKey: id, itemVersion: r.version, status: 'unread', channel: 'inbox', targetRef: { ...r.targetRef, version: t.version }, deliveryId: id, occurrenceId: o.id, scheduleId: s.id, recordedAt: time, readAt: null })
    await repo.put(tx, 'Reminder', { ...r, state: 'recorded', reason: null, updatedAt: time })
    return { deliveryId: id, notificationId: id, recordedAt: time, notificationDelivered: false, userReceived: 'unknown', modelCalls: 0, toolCalls: 0, externalEffects: 0 }
  }
  async function project(tx, row, type) {
    if (row.taskId) return workflows ? workflows.projectNotification(tx, row) : { id: row.id, redacted: true }
    const sourceId = row.targetRef?.sourceId ?? row.actionSpec?.sourceId ?? row.sourceId
    let p
    try { p = await permission(tx, sourceId) } catch (e) { if (!/FORBIDDEN|REVOKED|SCOPE/.test(e.code)) throw e }
    if (p?.readScope !== 'full') return { id: row.id, state: row.state ?? row.status, status: row.status, recordedAt: row.recordedAt, readAt: row.readAt, redacted: true, notice: '目标正文权限已失效；历史详情隐藏。' }
    if (type !== 'Notification') return copy(row)
    const t = await get(tx, row.targetRef.type, row.targetRef.id, sourceId)
    return { ...copy(row), title: t && !t.deletedAt ? t.title : '目标已删除', targetDeleted: !!t?.deletedAt, notice: '持久记录成功不代表用户收到；详情为当前授权目标投影。' }
  }
  async function list(actor, input = {}) {
    user(actor); strict(input, ['cursor', 'limit'])
    return repo.transaction(async tx => {
      const schedules = (await reminderPages(repo, tx, 'Schedule')).filter(owns), reminders = [], runs = await reminderPages(repo, tx, 'Occurrence')
      for (const s of schedules) {
        const r = await get(tx, 'Reminder', s.actionSpec.reminderId, s.actionSpec.sourceId)
        if (!r) continue
        const projected = await project(tx, { ...r, targetRef: { ...r.targetRef, sourceId: r.sourceId } }, 'Reminder')
        if (!projected.redacted) { projected.schedule = copy(s); projected.runs = runs.filter(o => o.scheduleId === s.id) }
        reminders.push(projected)
      }
      const page = await repo.list(tx, 'Notification', LOCAL_OWNER, 'local', { cursor: input.cursor ?? 0, limit: input.limit ?? 100 }), items = []
      for (const n of page.items) items.push(await project(tx, n, 'Notification'))
      return { reminders, ...page, items, retryPolicy: { maxAttempts: 3, backoffMs: [30000, 120000] }, notice: '仅持久应用收件箱；无Web Push/闭页系统弹窗；用户已读另记。旧协作blocker保持原Task身份与入口。' }
    })
  }
  async function read(actor, input) {
    user(actor); strict(input, ['id'])
    if (!validId(input.id)) fail(400, 'WORKSPACE_REMINDER_INPUT', '通知ID无效。')
    return repo.transaction(async tx => {
      const n = await get(tx, 'Notification', input.id)
      if (!n) fail(404, 'WORKSPACE_NOTIFICATION', '通知不存在。')
      const time = n.readAt ?? iso(now()), d = await get(tx, 'Delivery', n.deliveryId)
      await repo.put(tx, 'Notification', { ...n, status: 'read', readAt: time })
      if (d?.status === 'recorded') await repo.put(tx, 'Delivery', { ...d, readAt: time })
      return { id: n.id, status: 'read', readAt: time }
    })
  }
  return { manage, list, read, owns, authorized, preflight, deliver }
}
