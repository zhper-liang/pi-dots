import { randomUUID } from 'node:crypto'
import { LOCAL_OWNER, copy, fail } from './workspace-schema.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { sourceResource } from './workspace-grants.mjs'

// Minted handles, not serializable bearer claims. Only the authenticated transport/host
// receives this factory; callers cannot make an ActorContext by sending its JSON shape.
export function createActorAuthority({ resolveAgent = async () => null, resolveClient = async () => null } = {}) {
  const issued = new WeakSet()
  const mint = data => { const actor = Object.freeze({ ownerId: LOCAL_OWNER, correlationId: randomUUID(), ...copy(data) }); issued.add(actor); return actor }
  const check = actor => { if (!issued.has(actor)) fail(403, 'WORKSPACE_ACTOR', '业务主体未获可信入口认证。') }
  return {
    user: () => mint({ principalKind: 'user', subjectId: 'authenticated-user', origin: 'authenticated-http' }),
    async agent(taskId, tx) { const binding = await resolveAgent(taskId, tx); if (!binding) fail(403, 'WORKSPACE_ACTOR', 'Agent执行身份无效。'); return mint({ principalKind: 'agent', origin: 'host', taskId, botId: binding.botId, scope: binding.scope }) },
    async client(clientId, tx) { const b = await resolveClient(clientId, tx); if (!b) fail(403, 'WORKSPACE_CLIENT', 'client凭证失效。'); return mint({ principalKind: 'agent', origin: 'local-stdio-client', clientId, botId: b.botId, scope: b.scope }) },
    async background(taskId, schedule) {
      const binding = await resolveAgent(taskId)
      if (!binding || !schedule || schedule.ownerId !== LOCAL_OWNER || schedule.executionPrincipal?.botId !== binding.botId || !schedule.enabled) fail(403, 'WORKSPACE_ACTOR', '后台执行身份无效。')
      return mint({ principalKind: 'background', origin: 'schedule-host', taskId, botId: binding.botId, scope: binding.scope, schedule: { id: schedule.id, revision: schedule.revision, sourceId: schedule.sourceId, actions: schedule.actionSpec.actions ?? [] } })
    },
    check,
    async authorize(repo, tx, actor, sourceId, action) {
      check(actor)
      const source = await repo.get(tx, 'Source', actor.ownerId, sourceId, sourceId)
      const connection = source && await repo.get(tx, 'Connection', actor.ownerId, sourceId, source.connectionId)
      const user = await repo.get(tx, 'Grant', actor.ownerId, sourceId, 'user:authenticated-user')
      if (!source || !connection || connection.status !== 'active' || !source.capabilities.includes(action) || !user?.actions.includes(action)) fail(403, 'WORKSPACE_FORBIDDEN', '来源未授权或能力不可用。')
      let scope = user.readScope
      if (actor.principalKind !== 'user') {
        const current = await (actor.clientId ? resolveClient(actor.clientId, tx) : resolveAgent(actor.taskId, tx))
        const active = (await tx.doc(BotDirectory)).items.some(b => b.id === actor.botId && (b.status ?? 'active') === 'active')
        const { ToolAccess } = await import('./tools.mjs')
        const access = await tx.doc(ToolAccess), assigned = access.assignments?.[actor.botId]
        const required = action === 'read' ? ['workspace.list', 'workspace.get'] : ['workspace.prepare_change']
        if (!active || !current || current.botId !== actor.botId || !assigned?.resources.includes(sourceResource(sourceId)) || required.some(name => !assigned.tools.includes(name) || access.revoked?.[actor.botId]?.includes(name)) || actor.clientId && (!current.scope?.sources?.includes(sourceId) || !current.scope?.actions?.includes(action) || !['none', 'busy', 'full'].includes(current.scope?.readScope)) || actor.schedule && (actor.schedule.sourceId !== sourceId || !actor.schedule.actions.includes(action))) fail(403, 'WORKSPACE_FORBIDDEN', 'Agent当前工具或来源许可不足。')
        if (actor.clientId) { const scopes = ['none', 'busy', 'full']; scope = scopes[Math.min(scopes.indexOf(user.readScope), scopes.indexOf(current.scope.readScope))] }
      }
      if (action === 'read' && !['busy', 'full'].includes(scope)) fail(403, 'WORKSPACE_FORBIDDEN', '来源读取未授权。')
      return { readScope: scope, grantEpoch: user.epoch, source }
    },
  }
}
// Busy is an allowlist projection. Never spread the original record (including links,
// descriptions, provider IDs or receipts); Todo is never readable through busy scope.
export function projectWorkspaceRecord(type, record, permission) {
  if (permission.readScope === 'full') return copy(record)
  if (type !== 'Event' || permission.readScope !== 'busy') fail(403, 'WORKSPACE_BUSY_ONLY', '仅允许读取日历忙闲时段。')
  return { start: copy(record.start), end: copy(record.end), timezone: record.timezone }
}
