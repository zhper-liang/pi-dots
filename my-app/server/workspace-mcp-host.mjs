import { LOCAL_OWNER, fail, payloadHash } from './workspace-schema.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { rawWorkspaceRecord, workspaceUsedResources, workspaceUsedTools } from './workspace-grants.mjs'

// Runtime dependencies are injected, preserving one Harness and existing guards.
export function workspaceTaskResolver({ repository: repo, TaskCard, ToolAccess, toolSets, bots, assertActive, assertLive, guard, syncExternal }) {
  return async function resolveTask(taskId, transaction) {
    const read = async tx => {
      if (!Number.isSafeInteger(taskId)) return null
      const record = await tx.task(taskId)
      if (!record || record.state.status === 'terminal') return null
      const card = await tx.doc(TaskCard, taskId)
      if (!card.taskId || card.taskId !== taskId || record?.input?.botId !== card.bot.id || (await tx.conversation(card.conversationId))?.owner?.taskId !== taskId) return null
      await assertActive(tx, card.bot.id); await assertLive(tx, taskId, record); await guard(tx, taskId); const external = await syncExternal(tx)
      if (card.scheduledWorkflow) { const s = await repo.get(tx, 'Schedule', LOCAL_OWNER, 'local', card.scheduledWorkflow.scheduleId); if (!s?.enabled || s.revision !== card.scheduledWorkflow.revision || s.actionSpec?.botId !== card.bot.id) return null }
      const sets = toolSets(card, bots, await tx.doc(ToolAccess)), tools = sets.authorized.filter(n => WORKSPACE_TOOLS.includes(n))
      const sources = [], actions = new Set(); let readScope = 'full'
      for (const resource of sets.resources.filter(r => r.startsWith('workspace:'))) {
        const sourceId = resource.slice(10)
        if (sourceId !== 'local' && (!external.binding || sourceId !== `feishu:${payloadHash([external.binding.connectionId, external.binding.calendarId])}`)) continue
        const user = await rawWorkspaceRecord(tx, 'Grant', sourceId, 'user:authenticated-user'), source = await rawWorkspaceRecord(tx, 'Source', sourceId, sourceId), connection = source && await rawWorkspaceRecord(tx, 'Connection', sourceId, source.connectionId)
        if (!source?.capabilities.includes('read') || !user?.actions.includes('read') || connection?.status !== 'active' || !['busy', 'full'].includes(user.readScope)) continue
        sources.push(sourceId)
        for (const a of user.actions) if (source.capabilities.includes(a)) actions.add(a)
        if (user.readScope === 'busy') readScope = 'busy'
      }
      if (!tools.length || !sources.length) return null
      return { botId: card.bot.id, scope: { tools, sources, actions: [...actions], readScope } }
    }
    try { return transaction ? await read(transaction) : await repo.transaction(read) } catch (e) { if (e.status || /cancel/i.test(e.code ?? '')) return null; throw e }
  }
}

export async function validateWorkspaceHistory(tx, card, resolveTask) {
  const names = workspaceUsedTools(card), keys = workspaceUsedResources(card).map(r => r.slice(10))
  if (!names.length && !keys.length) return
  const b = await resolveTask(card.taskId, tx)
  if (!b) fail(403, 'WORKSPACE_FORBIDDEN', '当前工作区许可不足，禁止复用历史正文。')
  // Every historical source must remain authorized; a surviving second source may
  // not let a model consume revoked first-source text from conversation history.
  if (!keys.length || keys.some(s => !b.scope.sources.includes(s)) || names.some(t => !b.scope.tools.includes(t))) fail(403, 'WORKSPACE_FORBIDDEN', '历史工作区来源已撤权。')
  return LOCAL_OWNER
}
