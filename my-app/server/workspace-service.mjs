import { createWorkspaceLinks } from './workspace-links.mjs'
import { rawWorkspaceRecord, workspaceSourceReadable } from './workspace-grants.mjs'
import { createFeishuWorkspaceService } from './workspace-feishu.mjs'
import { createLocalWorkspaceService } from './workspace-local.mjs'
import { LOCAL_OWNER, payloadHash, copy, fail, object, validId } from './workspace-schema.mjs'
import { projectWorkspaceRecord } from './workspace-policy.mjs'

// Shared workspace boundary: local commands reuse the foundation transaction/authority.
export function createWorkspaceService({ repository: repo, authority, external }) {
  const links = createWorkspaceLinks({ repo, authorize: (tx, actor, sourceId) => sourceId === 'local' ? authority.authorize(repo, tx, actor, sourceId, 'read') : service.reminderExternalPermission ? service.reminderExternalPermission(tx, actor, sourceId) : fail(403, 'WORKSPACE_FORBIDDEN', '外部来源不可用。') })
  const service = {
    authorizeItemLink: links.permitted,
    async diagnostics(actor) {
      authority.check(actor)
      if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_FORBIDDEN', '仅认证用户可查看存储诊断。')
      if (!repo.enabled) return { enabled: false, schemaVersion: null, sources: [], notice: '业务入口禁用；旧Task与审计保留。' }
      return repo.transaction(async tx => {
        const sources = await repo.list(tx, 'Source', actor.ownerId, 'local')
        const result = []
        for (const source of sources.items) {
          let authorized = false
          try { await authority.authorize(repo, tx, actor, source.id, 'read'); authorized = true } catch (error) { if (error.code !== 'WORKSPACE_FORBIDDEN') throw error }
          const grant = await repo.get(tx, 'Grant', actor.ownerId, source.id, 'user:authenticated-user')
          result.push({ id: source.id, authority: source.authority, authorized, grantEpoch: grant?.epoch ?? 0 })
        }
        return { enabled: true, schemaVersion: 1, sources: result, notice: '本地日程/待办不调用模型；本机所有者对本地来源默认拥有完整权限，外部来源仍需授权。Bot通过当前工具与来源勾选使用。' }
      })
    },
    async get(actor, type, sourceId, id) {
      return repo.transaction(async tx => {
        const permission = await authority.authorize(repo, tx, actor, sourceId, 'read')
        if (permission.source.authority === 'external') fail(403, 'WORKSPACE_EXTERNAL_READ_REQUIRED', '外部对象必须通过实时授权校验的adapter读取。')
        if (!['Event', 'Todo'].includes(type)) fail(403, 'WORKSPACE_FORBIDDEN', '此业务类型不开放读取。')
        const record = await repo.get(tx, type, actor.ownerId, sourceId, id)
        return record && projectWorkspaceRecord(type, record, permission)
      })
    },
    async prepareCommand(actor, input) {
      authority.check(actor)
      if (!object(input) || Object.keys(input).some(k => !['requestId', 'sourceId', 'action', 'normalizedArgs', 'expectedVersion'].includes(k)) || !validId(input.requestId) || !validId(input.sourceId) || !['create', 'update', 'delete'].includes(input.action) || !object(input.normalizedArgs) || JSON.stringify(input).length > 16384 || input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) fail(400, 'WORKSPACE_COMMAND', '业务命令参数无效；主体不可由请求指定。')
      return repo.transaction(async tx => {
        const permission = await authority.authorize(repo, tx, actor, input.sourceId, input.action)
        const actorRef = { principalKind: actor.principalKind, subjectId: actor.subjectId ?? actor.botId, ...(actor.taskId ? { taskId: actor.taskId } : {}) }
        const signature = payloadHash({ ...input, actor: actorRef }), id = payloadHash([actor.ownerId, input.requestId])
        // Request IDs are owner scoped, including cross-source conflicts.
        const previous = await repo.get(tx, 'Operation', actor.ownerId, 'operations', id)
        if (previous) {
          if (previous.payloadHash !== signature) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '同一请求标识已绑定其他参数。')
          return { operation: previous, created: false }
        }
        const operation = await repo.put(tx, 'Operation', { schemaVersion: 1, ownerId: actor.ownerId, sourceId: 'operations', id, requestId: input.requestId, actor: actorRef, action: input.action, normalizedArgs: { ...copy(input.normalizedArgs), sourceId: input.sourceId }, ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}), payloadHash: signature, grantEpoch: permission.grantEpoch, state: 'prepared' })
        return { operation, created: true }
      })
    },
    // Supplied effects run within the SAME Harness commit. This is an internal seam
    // for 02/03/05; it is not an HTTP arbitrary-command or external network hook.
    // outer: an already-open Harness commit (an approved H card); otherwise a commit of its own.
    async commitLocal(actor, { requestId, sourceId, action, normalizedArgs }, apply, outer = null) {
      authority.check(actor)
      if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_CONFIRMATION_REQUIRED', 'Agent变更必须经过精确确认；基础票不开放执行。')
      if (!validId(requestId) || !['create', 'update', 'delete'].includes(action) || !object(normalizedArgs)) fail(400, 'WORKSPACE_COMMAND', '业务命令无效。')
      return (outer ? fn => repo.within(outer, fn) : repo.transaction)(async tx => {
        const permission = await authority.authorize(repo, tx, actor, sourceId, action)
        if (permission.source.authority !== 'local') fail(403, 'WORKSPACE_LOCAL_ONLY', '本地事务不能代替外部派发。')
        const readable = await authority.authorize(repo, tx, actor, sourceId, 'read')
        if (readable.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '本地写入与回执需要正文权限。')
        if (normalizedArgs.type === 'Schedule' && !['pause', 'cancel'].includes(normalizedArgs.command)) {
          const schedule = normalizedArgs.id ? await rawWorkspaceRecord(tx, 'Schedule', 'local', normalizedArgs.id) : null
          for (const id of (normalizedArgs.actionSpec?.sourceIds ?? schedule?.actionSpec?.sourceIds ?? [])) {
            if (!await workspaceSourceReadable(tx, normalizedArgs.actionSpec?.botId ?? schedule?.actionSpec?.botId, id)) fail(403, 'WORKSPACE_FORBIDDEN', '工作流来源许可已失效，历史管理回执不可读。')
          }
        }
        if (normalizedArgs.type === 'Reminder') {
          const targetSource = normalizedArgs.targetSourceId ?? normalizedArgs.targetRef?.sourceId ?? normalizedArgs.sourceId
          const targetPermission = targetSource === 'local' ? await authority.authorize(repo, tx, actor, targetSource, 'read') : await service.reminderExternalPermission(tx, actor, targetSource)
          if (targetPermission.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '提醒回执需要当前目标正文权限。')
        }
        if (normalizedArgs.type === 'ItemLink') await links.permitted(tx, actor, normalizedArgs.data, sourceId)
        const id = payloadHash([actor.ownerId, requestId]), signature = payloadHash({ sourceId, action, normalizedArgs, actor: actor.subjectId })
        const prior = await repo.get(tx, 'Operation', actor.ownerId, 'operations', id)
        if (prior) { if (prior.payloadHash !== signature) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '请求标识参数冲突。'); return prior }
        const receipt = await apply(tx, { operationId: id })
        return repo.put(tx, 'Operation', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: 'operations', id, requestId, actor: { principalKind: 'user', subjectId: actor.subjectId }, action, normalizedArgs: { ...copy(normalizedArgs), sourceId }, payloadHash: signature, grantEpoch: permission.grantEpoch, state: 'succeeded', receipt: copy(receipt) })
      })
    },
  }
  if (external) Object.assign(service, createFeishuWorkspaceService({ repository: repo, authority, ...external }))
  return Object.assign(service, createLocalWorkspaceService({ repository: repo, authority, links, authorizeReminderSource: (tx, actor, sourceId) => sourceId === 'local' ? authority.authorize(repo, tx, actor, sourceId, 'read') : service.reminderExternalPermission(tx, actor, sourceId), commitLocal: (...args) => service.commitLocal(...args) }))
}
