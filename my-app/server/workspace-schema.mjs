import { createHash } from 'node:crypto'
import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable'
import { TaskInputError } from './task-config.mjs'

export const WORKSPACE_VERSION = 1
export const LOCAL_OWNER = 'local-owner'
export const copy = value => JSON.parse(JSON.stringify(value))
export const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
export const object = value => value && typeof value === 'object' && !Array.isArray(value)
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
export const payloadHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const identityKey = (ownerId, sourceId, id) => payloadHash([ownerId, sourceId, id])
export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_.@/-]{0,255}$/.test(value)
const fields = {
  Connection: ['provider', 'accountKey', 'credentialRef', 'authEpoch', 'status'],
  Source: ['connectionId', 'providerContainerId', 'authority', 'capabilities'],
  Grant: ['principalKind', 'subjectId', 'actions', 'readScope', 'epoch', 'tier', 'autoApply', 'allowRules'],
  Event: ['remoteId', 'instanceKey', 'title', 'description', 'start', 'end', 'timezone', 'version', 'remoteVersion', 'authority', 'deletedAt', 'observedAt', 'readOnly', 'providerEvent'],
  Todo: ['title', 'status', 'due', 'timezone', 'version', 'deletedAt'],
  ItemLink: ['todoId', 'eventId', 'relation', 'todoRef', 'eventRef', 'todoVersion', 'eventVersion'],
  Operation: ['requestId', 'actor', 'action', 'normalizedArgs', 'expectedVersion', 'payloadHash', 'grantEpoch', 'state', 'receipt', 'error', 'external', 'confirmation'],
  Outbox: ['operationId', 'targetRef', 'state', 'dedupeKey'],
  Reminder: ['targetRef', 'offset', 'at', 'channel', 'enabled', 'version', 'targetVersion', 'invalidated', 'invalidationReason', 'scheduleId', 'state', 'reason', 'authorizationSnapshot', 'createdAt', 'updatedAt'],
  Schedule: ['executionPrincipal', 'actionSpec', 'timezone', 'rule', 'enabled', 'revision', 'nextDueAt', 'misfirePolicy', 'retryPolicy', 'callLimits', 'authorizationSnapshot', 'status', 'title', 'activeOccurrenceId', 'createdAt', 'updatedAt', 'eventCursor', 'testOccurrenceId'],
  Occurrence: ['scheduleId', 'revision', 'scheduledFor', 'claim', 'attempts', 'operationId', 'taskId', 'deliveryId', 'state', 'startedAt', 'finishedAt', 'error', 'reason', 'result', 'coalescedUntil', 'retryAt', 'trigger', 'test'],
  SyncState: ['window', 'cursor', 'coverage', 'generation', 'lastSuccessAt', 'error', 'retryAt', 'enabled', 'revision', 'cacheRevision', 'pastDays', 'futureDays', 'refreshSeconds', 'timezone', 'runState', 'attempts', 'claim', 'windows', 'nextDueAt', 'lastStartedAt', 'authorizationSnapshot', 'invalidated'],
  SyncEntry: ['targetId', 'present', 'remoteVersion', 'generation', 'revision'],
  Notification: ['taskId', 'sourceIds', 'dedupeKey', 'itemVersion', 'status', 'channel', 'targetRef', 'deliveryId', 'occurrenceId', 'scheduleId', 'recordedAt', 'readAt'],
  Delivery: ['taskId', 'sourceIds', 'dedupeKey', 'itemVersion', 'status', 'channel', 'attempts', 'result', 'notificationId', 'occurrenceId', 'scheduleId', 'attemptedAt', 'recordedAt', 'readAt'],
}
export const WorkspaceMeta = defineDoc({ kind: 'pidot.workspace.meta', scope: 'session', version: 1, initial: () => ({ schemaVersion: 1, initialized: false, migrations: [] }) })
export const WorkspaceIndex = defineDocFamily({ kind: 'pidot.workspace.index', scope: 'session', family: true, version: 1, initial: () => ({ count: 0 }) })
export const WorkspacePage = defineDocFamily({ kind: 'pidot.workspace.page', scope: 'session', family: true, version: 1, initial: () => ({ ids: [] }) })
export const WorkspaceLookup = defineDocFamily({ kind: 'pidot.workspace.lookup', scope: 'session', family: true, version: 1, initial: () => ({ keys: {} }) })
export const WorkspaceUnique = defineDocFamily({ kind: 'pidot.workspace.unique', scope: 'session', family: true, version: 1, initial: () => ({ id: null }) })
export const WorkspaceRecords = Object.fromEntries(Object.keys(fields).map(type => [type, defineDocFamily({ kind: `pidot.workspace.${type}`, scope: 'session', family: true, version: 1, initial: () => ({ record: null }) })]))
export function validateRecord(type, record) {
  if (!fields[type] || !object(record) || Object.keys(record).some(k => !['schemaVersion', 'id', 'ownerId', 'sourceId', ...fields[type]].includes(k)) || record.schemaVersion !== WORKSPACE_VERSION || !['id', 'ownerId', 'sourceId'].every(k => validId(record[k]))) fail(400, 'WORKSPACE_SCHEMA', '业务记录类型、版本或复合身份无效。')
  if (Buffer.byteLength(JSON.stringify(record)) > 32768) fail(413, 'WORKSPACE_RECORD_LIMIT', '业务记录超过大小上限。')
  const required = {
    Connection: ['provider', 'accountKey', 'authEpoch', 'status'], Source: ['connectionId', 'authority', 'capabilities'], Grant: ['principalKind', 'subjectId', 'actions', 'readScope', 'epoch'],
    Event: ['title', 'start', 'end', 'timezone', 'version', 'authority'], Todo: ['title', 'status', 'version'], ItemLink: ['todoId', 'eventId', 'relation'],
    Operation: ['requestId', 'actor', 'action', 'normalizedArgs', 'payloadHash', 'grantEpoch', 'state'], Outbox: ['operationId', 'state', 'dedupeKey'],
    Reminder: ['targetRef', 'channel', 'enabled', 'version', 'targetVersion'], Schedule: ['executionPrincipal', 'actionSpec', 'timezone', 'rule', 'enabled', 'revision', 'nextDueAt', 'misfirePolicy', 'retryPolicy', 'callLimits'],
    Occurrence: ['scheduleId', 'revision', 'scheduledFor', 'attempts', 'state'], SyncState: ['window', 'coverage', 'generation'], SyncEntry: ['targetId', 'present', 'remoteVersion', 'generation', 'revision'],
    Notification: [ 'dedupeKey', 'itemVersion', 'status', 'channel'], Delivery: [ 'dedupeKey', 'itemVersion', 'status', 'channel', 'attempts'],
  }
  if (required[type].some(k => record[k] === undefined)) fail(400, 'WORKSPACE_SCHEMA', '业务记录缺少必需字段。')
  const enums = { authority: ['local', 'external'], principalKind: ['user', 'bot'], readScope: ['none', 'busy', 'full'] }
  for (const [k, values] of Object.entries(enums)) if (record[k] !== undefined && !values.includes(record[k])) fail(400, 'WORKSPACE_SCHEMA', '业务记录枚举无效。')
  for (const k of ['version', 'epoch', 'authEpoch', 'revision', 'generation', 'itemVersion', 'targetVersion', 'attempts']) if (record[k] !== undefined && (!Number.isSafeInteger(record[k]) || record[k] < (['version', 'revision'].includes(k) ? 1 : 0))) fail(400, 'WORKSPACE_SCHEMA', '业务记录版本或计数无效。')
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') fail(400, 'WORKSPACE_SCHEMA', '启用状态无效。')
  for (const k of ['actions', 'capabilities']) if (record[k] !== undefined && (!Array.isArray(record[k]) || record[k].length > 64 || !record[k].every(validId))) fail(400, 'WORKSPACE_SCHEMA', '能力列表无效。')
  if (type === 'Grant' && (record.autoApply !== undefined && typeof record.autoApply !== 'boolean' || record.tier !== undefined && !['none', 'read', 'propose', 'local-write'].includes(record.tier) || record.allowRules !== undefined && (!Array.isArray(record.allowRules) || record.allowRules.length > 32 || !record.allowRules.every(r => object(r) && Object.keys(r).length === 2 && validId(r.tool) && ['create', 'update', 'delete'].includes(r.action))))) fail(400, 'WORKSPACE_SCHEMA', '授权档位或规则无效。')
  if (type === 'Grant' && record.id !== `${record.principalKind}:${record.subjectId}`) fail(400, 'WORKSPACE_SCHEMA', '授权身份与键不匹配。')
  if (type === 'Source' && record.id !== record.sourceId) fail(400, 'WORKSPACE_SCHEMA', '来源复合身份不匹配。')
  if (type === 'Event') {
    const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
    if (!(date(record.start) && date(record.end) || instant(record.start) && instant(record.end)) || Date.parse(record.end) <= Date.parse(record.start) || typeof record.title !== 'string') fail(400, 'WORKSPACE_SCHEMA', '日程时间边界无效。')
    try { new Intl.DateTimeFormat('en', { timeZone: record.timezone }).format() } catch { fail(400, 'WORKSPACE_SCHEMA', '日程时区无效。') }
  }
  if (type === 'ItemLink' && (record.todoRef !== undefined || record.eventRef !== undefined)) {
    for (const [key, type, id] of [['todoRef', 'Todo', record.todoId], ['eventRef', 'Event', record.eventId]]) {
      const ref = record[key]
      if (!object(ref) || Object.keys(ref).some(k => !['type', 'sourceId', 'id'].includes(k)) || ref.type !== type || ref.id !== id || !validId(ref.sourceId) || key === 'todoRef' && ref.sourceId !== record.sourceId) fail(400, 'WORKSPACE_SCHEMA', '关联引用与对象身份不匹配。')
    }
    if (![record.todoVersion, record.eventVersion].every(v => Number.isSafeInteger(v) && v >= 1)) fail(400, 'WORKSPACE_SCHEMA', '关联缺少两端版本证据。')
  }
  // PLAN §8.5: event-triggered routines have no clock due (nextDueAt null).
  if (type === 'Schedule' && ((record.rule?.type === 'event' ? record.nextDueAt !== null : !Number.isFinite(Date.parse(record.nextDueAt))) || !object(record.executionPrincipal) || !object(record.actionSpec) || !object(record.rule))) fail(400, 'WORKSPACE_SCHEMA', '计划定义无效。')
  if (type === 'Todo' && (!['open', 'completed'].includes(record.status) || typeof record.title !== 'string')) fail(400, 'WORKSPACE_SCHEMA', '待办状态或标题无效。')
  if (type === 'Operation' && !['prepared', 'awaiting_confirmation', 'ready', 'dispatching', 'succeeded', 'failed', 'conflict', 'unknown', 'cancelled', 'expired', 'skipped'].includes(record.state)) fail(400, 'WORKSPACE_SCHEMA', '操作状态无效。')
  if (type === 'Occurrence' && (!Number.isFinite(Date.parse(record.scheduledFor)) || !record.scheduledFor.endsWith('Z'))) fail(400, 'WORKSPACE_SCHEMA', '触发点必须为UTC时间。')
  return copy(record)
}

// ADR-011: the single local owner has implicit full access to the local source.
// Stored legacy user-grant records only contribute their epoch (snapshot compatibility);
// actions/readScope cannot be lowered, so no UI consent step is required.
export const OWNER_LOCAL_GRANT_ID = 'user:authenticated-user'
export function ownerLocalGrant(stored) {
  return { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: 'local', id: OWNER_LOCAL_GRANT_ID, principalKind: 'user', subjectId: 'authenticated-user', actions: ['read', 'create', 'update', 'delete'], readScope: 'full', epoch: stored?.epoch ?? 0 }
}
