import { randomBytes, createHash } from 'node:crypto'
import { LOCAL_OWNER, copy, fail, object, validId, payloadHash } from './workspace-schema.mjs'
import { workspaceTools, WORKSPACE_TOOLS, validWorkspaceArgs, workspaceToolAction } from './workspace-tools.mjs'
import { WorkspaceClients, sourceResource, workspaceUsedResources, workspaceUsedTools } from './workspace-grants.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { ToolAccess } from './tools.mjs'
import { createMcpSession, createMcpClient } from './workspace-mcp-protocol.mjs'
import { decide, unattended, addRule, removeRules, listRules, localMatch } from './policy.mjs'
import { summarizeAutoApplied, summarizeOperation } from './inbox.mjs'
import { markDirty } from './detector-state.mjs'
const ATTENDED_EXPIRY_MS = 300000
const strict = (v, fields) => { if (!object(v) || Object.keys(v).some(k => !fields.includes(k))) fail(400, 'WORKSPACE_INPUT', '参数无效；不接受主体覆盖。') }
const full = p => { if (p.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '正文或变更需要完整许可。') }
const digest = s => createHash('sha256').update(s).digest('hex')

// taskInput(tx, taskId) → { entryId, origin, conversationId, botName } | null; injected by the
// host so the auto-applied card and unattended decision bind to the current input.
export function createWorkspaceMcpBusiness({ repository: repo, authority, service, resolveTask, TaskCard, prepareSchedule, taskInput = async () => null, now = Date.now }) {
  const user = actor => { authority.check(actor); if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_FORBIDDEN', '仅认证用户可管理。') }
  async function allowed(actor, name, args) {
    if (args?.sourceId !== 'local') { const active = await (service.externalSources?.(authority.user(), {}) ?? { sources: [] }); if (!active.sources.some(s => s.id === args?.sourceId)) fail(403, 'WORKSPACE_EXTERNAL_REVOKED', '外部来源已断开或切换。') }
    if (!validWorkspaceArgs(name, args)) fail(400, 'WORKSPACE_INPUT', '业务工具参数无效。')
    const binding = actor.clientId ? await resolveClient(actor.clientId) : await resolveTask(actor.taskId)
    if (!binding?.scope?.tools?.includes(name)) fail(403, 'WORKSPACE_FORBIDDEN', '工具当前未授权。')
    return repo.transaction(tx => authority.authorize(repo, tx, actor, args.sourceId, workspaceToolAction(name, args)))
  }
  async function resolveClient(clientId, tx) {
    const get = async t => {
      const c = (await t.doc(WorkspaceClients)).items[clientId]
      if (!c || c.revoked || c.expiresAt <= now()) return null
      const b = (await t.doc(BotDirectory)).items.find(b => b.id === c.botId)
      if (!b || (b.status ?? 'active') !== 'active') return null
      const access = await t.doc(ToolAccess), assigned = access.assignments?.[c.botId]
      if (!assigned) return null
      return { botId: c.botId, scope: { ...copy(c.scope), tools: assigned.tools.filter(name => WORKSPACE_TOOLS.includes(name) && !access.revoked?.[c.botId]?.includes(name)) } }
    }
    return tx ? get(tx) : repo.transaction(get)
  }
  async function operation(actor, input, tx) {
    const op = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', payloadHash([LOCAL_OWNER, input.requestId]))
    if (!op || op.normalizedArgs.sourceId !== input.sourceId) fail(404, 'WORKSPACE_OPERATION', '操作不存在。')
    full(await authority.authorize(repo, tx, actor, input.sourceId, 'read'))
    if (actor.principalKind !== 'user' && payloadHash(op.actor) !== payloadHash(actorRef(actor))) fail(403, 'WORKSPACE_FORBIDDEN', '无权读取其他主体操作。')
    if (op.normalizedArgs.type === 'ItemLink') await service.authorizeItemLink(tx, actor, op.normalizedArgs.data, input.sourceId)
    return op
  }
  const actorRef = a => ({ principalKind: a.principalKind, subjectId: a.subjectId ?? a.botId, ...(a.taskId ? { taskId: a.taskId } : {}), ...(a.clientId ? { clientId: a.clientId } : {}) })
  async function origin(op, tx) {
    const a = op.actor.clientId ? await authority.client(op.actor.clientId, tx) : await authority.agent(op.actor.taskId, tx)
    if (a.botId !== op.actor.subjectId) fail(403, 'WORKSPACE_FORBIDDEN', '原建议主体已变化。')
    return a
  }
  async function localPrepare(actor, input) {
    const change = input.change
    strict(change, ['type', 'id', 'expectedVersion', 'data'])
    if (!['Event', 'Todo'].includes(change.type) || input.sourceId !== 'local') fail(400, 'WORKSPACE_INPUT', '仅支持普通本地事项。')
    const data = service.normalizeLocalChange(change.type, change.data, input.action)
    if (input.action === 'create' ? change.id !== undefined || change.expectedVersion !== undefined : !validId(change.id) || !Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1) fail(400, 'WORKSPACE_VERSION', '修改/删除需要精确对象版本。')
    return repo.transaction(async tx => {
      const p = await authority.authorize(repo, tx, actor, input.sourceId, input.action); full(p); full(await authority.authorize(repo, tx, actor, input.sourceId, 'read'))
      const normalizedArgs = { sourceId: input.sourceId, type: change.type, data, ...(change.id ? { id: change.id, expectedVersion: change.expectedVersion } : {}) }, who = actorRef(actor), signature = payloadHash({ input, normalizedArgs, actor: who }), id = payloadHash([LOCAL_OWNER, input.requestId])
      const old = await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', id)
      if (old) { if (old.payloadHash !== signature) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '同requestId参数冲突。'); return old }
      let before = null
      if (input.action !== 'create') { before = await repo.get(tx, change.type, LOCAL_OWNER, input.sourceId, change.id); if (!before || before.deletedAt || before.version !== change.expectedVersion) fail(409, 'WORKSPACE_VERSION_CONFLICT', '请先重新读取对象。') }
      // The same validator/version check and requestId protect direct and confirmed writes.
      const bound = actor.principalKind === 'agent' && !actor.clientId && actor.taskId ? await taskInput(tx, actor.taskId) : null
      const verdict = await decide(tx, { botId: actor.botId, tool: 'workspace.prepare_change', action: input.action, sourceId: input.sourceId, type: change.type, origin: bound?.origin ?? 'user' })
      if (verdict.effect === 'deny') fail(403, 'POLICY_DENIED', '规则禁止该动作。')
      const skip = verdict.effect === 'ask' && unattended(bound?.origin)
      const op = await repo.put(tx, 'Operation', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: 'operations', id, requestId: input.requestId, actor: who, action: input.action, normalizedArgs, payloadHash: signature, grantEpoch: p.grantEpoch, state: skip ? 'skipped' : 'awaiting_confirmation', ...(skip ? { receipt: { reason: verdict.reason, notice: '已跳过：这一步需要你来做。' } } : { confirmation: { expiresAt: now() + ATTENDED_EXPIRY_MS, createdAt: new Date(now()).toISOString(), before, reason: verdict.reason, allowAlways: verdict.allowAlways } }) })
      if (skip) return op
      if (verdict.effect !== 'allow') {
        await markDirty(tx, { sourceId: 'local', type: 'Proposal', id: op.requestId })
        if (bound?.mirror) await bound.mirror({ mirrorKind: 'proposal', requestId: op.requestId, sourceId: input.sourceId, payloadHash: op.payloadHash, allowAlways: verdict.allowAlways, summary: summarizeOperation(bound.botName, op) })
        return op
      }
      const command = { requestId: op.requestId, action: op.action, ...copy(normalizedArgs) }
      if (op.action === 'delete') { delete command.data; command.confirmedDelete = true }
      const receipt = await service.applyLocalConfirmed(tx, authority.user(), command, op.id)
      const done = await repo.put(tx, 'Operation', { ...op, state: 'succeeded', receipt: { ...receipt, autoApplied: verdict.reason } })
      // I-13: every automatic write leaves an undoable system card. It never wakes the model (I-08).
      if (bound?.conversationId) await tx.appendEntry(bound.conversationId, { kind: 'pidot.auto-applied', data: { requestId: op.requestId, operationId: op.id, taskId: actor.taskId, botId: actor.botId, action: op.action, type: change.type, target: copy(receipt.target), version: receipt.version, reason: done.receipt.autoApplied, summary: summarizeAutoApplied(bound.botName, done), undoable: true, createdAt: new Date(now()).toISOString() } })
      if (bound?.mirror) await bound.mirror({ mirrorKind: 'auto-applied', requestId: op.requestId, operationId: op.id, summary: summarizeAutoApplied(bound.botName, done) })
      return done
    })
  }
  // Apply the same policy to local and external writes.
  async function policyGate(actor, tool, args, sourceAuthority) {
    const verdict = await repo.transaction(async tx => decide(tx, { botId: actor.botId, tool, action: args.action, sourceId: args.sourceId, type: args.change?.type ?? args.type, sourceAuthority, origin: actor.taskId ? (await taskInput(tx, actor.taskId))?.origin ?? 'user' : 'user' }))
    if (verdict.effect === 'deny') fail(403, 'POLICY_DENIED', '规则禁止该动作。')
    return verdict
  }
  async function call(actor, name, args, { signal } = {}) {
    signal?.throwIfAborted(); const p = await allowed(actor, name, args)
    let result
    if (name === 'workspace.prepare_schedule') {
      full(p)
      if (!prepareSchedule) fail(403, 'WORKSPACE_SCHEDULE_DISABLED', '计划草案入口未开放。')
      await policyGate(actor, name, args, p.source.authority)
      result = await prepareSchedule(actor, args)
    } else if (name === 'workspace.operation_status') result = p.source.authority === 'external' ? await service.getExternalOperation(actor, { requestId: args.requestId }) : await repo.transaction(tx => operation(actor, args, tx))
    else if (name === 'workspace.prepare_change') {
      full(p)
      if (p.source.authority === 'local') result = await localPrepare(actor, args)
      else {
        strict(args.change, ['arguments', 'expectedVersion'])
        const verdict = await policyGate(actor, name, args, p.source.authority)
        const origin = actor.taskId ? await repo.transaction(async tx => (await taskInput(tx, actor.taskId))?.origin) : null
        result = await service.prepareExternal(actor, { sourceId: args.sourceId, requestId: args.requestId, action: args.action, ...args.change },
          { expiresInMs: ATTENDED_EXPIRY_MS, autoApprove: verdict.effect === 'allow', skipReason: verdict.effect === 'ask' && unattended(origin) ? verdict.reason : null })
        if (result.state === 'ready') result = await service.executeExternal(actor, { requestId: args.requestId })
      }
    } else if (p.source.authority === 'local') {
      const { sourceId, type, ...rest } = args
      result = await (name === 'workspace.list' ? service.query(actor, { sourceId, type, limit: rest.limit ?? 10, ...(rest.cursor === undefined ? {} : { cursor: rest.cursor }) }) : service.getLocalItem(actor, { sourceId, type, id: rest.id }))
    } else {
      if (args.type !== 'Event') fail(400, 'WORKSPACE_INPUT', '外部来源只支持日程。')
      const { sourceId, type: _type, limit = 10, cursor = 0, ...rest } = args
      result = await (name === 'workspace.list' ? service.queryExternal(actor, { sourceId, ...rest }) : service.getExternal(actor, { sourceId, eventId: rest.eventId }))
      if (name === 'workspace.list') result = { ...result, items: result.items.slice(cursor, cursor + limit), ...(cursor + limit < result.items.length ? { next: cursor + limit } : {}) }
    }
    signal?.throwIfAborted(); const latest = await allowed(actor, name, args)
    if (p.readScope === 'full' && latest.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '来源正文许可已降低。')
    if (TaskCard && actor.taskId) await repo.transaction(async tx => {
      const card = await tx.doc(TaskCard, actor.taskId)
      if (card.bot.id !== actor.botId) fail(403, 'WORKSPACE_FORBIDDEN', 'Task与Bot身份不匹配。')
      card.workspaceUsedResources = [...new Set([...workspaceUsedResources(card), sourceResource(args.sourceId)])]
      card.workspaceUsedTools = [...new Set([...workspaceUsedTools(card), name])]
      card.workspaceUsedReadScopes ??= {}
      card.workspaceUsedReadScopes[args.sourceId] = card.workspaceUsedReadScopes[args.sourceId] === 'full' || latest.readScope === 'full' ? 'full' : 'busy'
    })
    return result
  }
  async function tools(actor) {
    const active = await (service.externalSources?.(authority.user(), {}) ?? { sources: [] })
    const binding = actor.clientId ? await resolveClient(actor.clientId) : await resolveTask(actor.taskId)
    if (!binding) fail(403, 'WORKSPACE_FORBIDDEN', '执行主体失效。')
    const names = new Set()
    for (const sourceId of binding.scope.sources.filter(s => s === 'local' || active.sources.some(a => a.id === s))) for (const action of binding.scope.actions) {
      try { const p = await repo.transaction(tx => authority.authorize(repo, tx, actor, sourceId, action)); for (const t of workspaceTools) if (binding.scope.tools.includes(t.name) && (['workspace.prepare_change', 'workspace.prepare_schedule'].includes(t.name) ? action !== 'read' && p.readScope === 'full' : action === 'read')) names.add(t.name) } catch (e) { if (!e.status) throw e }
    }
    return workspaceTools.filter(t => names.has(t.name)).map(({ parameters, ...t }) => ({ ...t, inputSchema: parameters, annotations: { readOnlyHint: !['workspace.prepare_change', 'workspace.prepare_schedule'].includes(t.name), destructiveHint: false, idempotentHint: true, openWorldHint: false } }))
  }
  function session(actor) { return createMcpSession({ listTools: () => tools(actor), callTool: (n, a, o) => call(actor, n, a, o), authorize: async () => { const b = actor.clientId ? await resolveClient(actor.clientId) : await resolveTask(actor.taskId); if (!b) fail(403, 'WORKSPACE_FORBIDDEN', '会话失效。') } }) }
  return {
    resolveClient, tools, call, session,
    async invoke(taskId, name, args, options) { const c = createMcpClient(session(await authority.agent(taskId))); try { await c.initialize(); return name === null ? await c.listTools() : await c.callTool(name, args, options) } finally { c.close() } },
    // 以后同类直接同意 → an origin='user' allow rule in the rule table (ADR-012). Live-read on every
    // decide (removal is immediate); no epoch bump because it never adds capability.
    async manageAllowRule(actor, input) {
      user(actor); strict(input, ['botId', 'tool', 'action', 'enabled', 'confirmed'])
      if (input.confirmed !== true || typeof input.enabled !== 'boolean' || input.tool !== 'workspace.prepare_change' || !['create', 'update', 'delete'].includes(input.action) || !validId(input.botId)) fail(400, 'WORKSPACE_GRANT', '仅支持本地 workspace.prepare_change 的精确动作规则。')
      return repo.transaction(async tx => {
        const bot = (await tx.doc(BotDirectory)).items.find(b => b.id === input.botId)
        const access = await tx.doc(ToolAccess), assigned = access.assignments?.[input.botId]
        if (input.enabled && (!bot || (bot.status ?? 'active') !== 'active' || !assigned?.tools.includes(input.tool) || !assigned.resources.includes('workspace:local') || access.revoked?.[input.botId]?.includes(input.tool))) fail(409, 'WORKSPACE_GRANT', 'Bot 当前未分配本地工作区写工具与资源。')
        const match = localMatch(input.tool, input.action)
        await removeRules(tx, r => r.botId === input.botId && r.origin === 'user' && JSON.stringify(r.match) === JSON.stringify(match))
        if (input.enabled) await addRule(tx, { botId: input.botId, match, effect: 'allow', origin: 'user' })
        return { botId: input.botId, rules: await listRules(tx, input.botId) }
      })
    },
    // Undo an automatic local write (I-13). User-initiated only; commitLocal keyed by undo:<op>.
    async undoAuto(actor, input) {
      user(actor); strict(input, ['requestId', 'confirmed'])
      if (input.confirmed !== true || !validId(input.requestId)) fail(400, 'WORKSPACE_INPUT', '撤销须明确确认原自动操作。')
      const op = await repo.transaction(tx => repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', payloadHash([LOCAL_OWNER, input.requestId])))
      if (!op || op.actor.principalKind !== 'agent' || op.state !== 'succeeded' || !op.receipt?.autoApplied) fail(404, 'WORKSPACE_UNDO_UNAVAILABLE', '只能撤销已自动执行的本地改动。')
      if (op.normalizedArgs.sourceId !== 'local' || !['Event', 'Todo'].includes(op.normalizedArgs.type)) fail(400, 'WORKSPACE_UNDO_UNAVAILABLE', '对外写入已发送，无法撤销。')
      return service.undoLocal(actor, op)
    },
    // Recent automatic writes for the inbox record, newest first, with undo state.
    async autoApplied(actor) {
      user(actor)
      return repo.transaction(async tx => {
        full(await authority.authorize(repo, tx, actor, 'local', 'read'))
        const rows = []
        let cursor = 0
        do {
          const page = await repo.list(tx, 'Operation', LOCAL_OWNER, 'operations', { cursor, limit: 100 })
          for (const op of page.items) if (op.actor.principalKind === 'agent' && op.state === 'succeeded' && op.receipt?.autoApplied && op.normalizedArgs.sourceId === 'local') rows.push(op)
          cursor = page.next
        } while (cursor !== undefined)
        rows.sort((a, b) => String(b.confirmation?.createdAt ?? '').localeCompare(String(a.confirmation?.createdAt ?? '')))
        const items = []
        for (const op of rows.slice(0, 20)) items.push({ op: copy(op), undone: !!await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', payloadHash([LOCAL_OWNER, `undo:${op.id}`])) })
        return items
      })
    },
    async issueClient(actor, input) {
      user(actor); strict(input, ['botId', 'sourceId', 'actions', 'readScope', 'ttlSeconds', 'confirmed'])
      if (input.confirmed !== true || !validId(input.botId) || !validId(input.sourceId) || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 3600 || !['busy', 'full'].includes(input.readScope) || !Array.isArray(input.actions) || !input.actions.length || new Set(input.actions).size !== input.actions.length || input.actions.some(a => !['read', 'create', 'update', 'delete'].includes(a)) || input.actions.some(a => a !== 'read') && input.readScope !== 'full') fail(400, 'WORKSPACE_GRANT', '受限client许可无效。')
      const token = randomBytes(32).toString('base64url'), id = digest(token)
      return repo.transaction(async tx => {
        const bot = (await tx.doc(BotDirectory)).items.find(b => b.id === input.botId)
        const access = await tx.doc(ToolAccess), assigned = access.assignments?.[input.botId]
        const required = input.actions.includes('read') ? ['workspace.list', 'workspace.get'] : []
        if (input.actions.some(a => a !== 'read')) required.push('workspace.prepare_change')
        if (!bot || (bot.status ?? 'active') !== 'active' || !assigned?.resources.includes(sourceResource(input.sourceId)) || required.some(name => !assigned.tools.includes(name) || access.revoked?.[input.botId]?.includes(name))) fail(403, 'WORKSPACE_FORBIDDEN', 'client不能超出Bot当前工具和资源分配。')
        for (const action of input.actions) { const permission = await authority.authorize(repo, tx, actor, input.sourceId, action); if (input.readScope === 'full') full(permission) }
        const scope = { sources: [input.sourceId], actions: copy(input.actions), readScope: input.readScope }
        const doc = await tx.doc(WorkspaceClients)
        if (Object.keys(doc.items).length >= 100) fail(409, 'WORKSPACE_CAPACITY', 'client审计容量需评审。')
        doc.items[id] = { botId: input.botId, scope, expiresAt: now() + input.ttlSeconds * 1000, revoked: false }
        return { token, clientId: id, expiresAt: doc.items[id].expiresAt, notice: '一次性显示；仅本机桥使用，不放入模型或命令行参数。' }
      })
    },
    async listClients(actor, input) {
      user(actor); strict(input, [])
      return repo.transaction(async tx => {
        const clients = await tx.doc(WorkspaceClients)
        return { items: Object.entries(clients.items).map(([clientId, c]) => ({ clientId, botId: c.botId, scope: copy(c.scope), expiresAt: c.expiresAt, revoked: c.revoked, expired: c.expiresAt <= now() })) }
      })
    },
    async revokeClient(actor, input) { user(actor); strict(input, ['clientId', 'confirmed']); if (input.confirmed !== true) fail(400, 'WORKSPACE_GRANT', '撤销需要确认。'); return repo.transaction(async tx => { const c = (await tx.doc(WorkspaceClients)).items[input.clientId]; if (!c) fail(404, 'WORKSPACE_CLIENT', 'client不存在。'); c.revoked = true; return { clientId: input.clientId, revoked: true } }) },
    async authenticateClient(token) { if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(403, 'WORKSPACE_CLIENT', 'client凭证无效。'); return authority.client(digest(token)) },
    async operationStatus(actor, input) { user(actor); strict(input, ['requestId', 'sourceId']); return input.sourceId !== 'local' ? service.getExternalOperation(actor, { requestId: input.requestId }) : repo.transaction(tx => operation(actor, input, tx)) },
    async pending(actor, input) {
      user(actor); strict(input, ['cursor']); const active = await (service.externalSources?.(actor, {}) ?? { sources: [] }); return repo.transaction(async tx => { const page = await repo.list(tx, 'Operation', LOCAL_OWNER, 'operations', { cursor: input.cursor ?? 0, limit: 20 }); const items = []; for (const op of page.items) if (op.actor.principalKind === 'agent' && (op.normalizedArgs.sourceId === 'local' || active.sources.some(s => s.id === op.normalizedArgs.sourceId))) { try { full(await authority.authorize(repo, tx, actor, op.normalizedArgs.sourceId, 'read')); items.push(op) } catch (e) { if (!e.status) throw e } } return { items, ...(page.next === undefined ? {} : { next: page.next }) } })
    },
    async confirmLocal(actor, input) {
      user(actor); strict(input, ['requestId', 'sourceId', 'payloadHash', 'confirmed', 'cancel', 'always'])
      if (input.cancel !== undefined && typeof input.cancel !== 'boolean') fail(400, 'WORKSPACE_INPUT', '取消字段无效。')
      if (input.always !== undefined && (input.always !== true || input.cancel === true)) fail(400, 'WORKSPACE_INPUT', '“总是”只用于同意。')
      if (input.confirmed !== true) fail(400, 'WORKSPACE_CONFIRMATION_REQUIRED', '须明确确认。')
      // Reuse the existing local validator, version checks, mutation and outbox within
      // the same transaction. No nested commit and no synthetic Task or second DB.
      return repo.transaction(async tx => {
        const op = await operation(actor, input, tx)
        if (op.external || !op.confirmation) fail(400, 'WORKSPACE_OPERATION', '不是本地建议。')
        if (op.payloadHash !== input.payloadHash) fail(409, 'WORKSPACE_VERSION_CONFLICT', '参数已变化。')
        if (['succeeded', 'cancelled'].includes(op.state)) return op
        if (op.state !== 'awaiting_confirmation' || op.confirmation.expiresAt <= now()) fail(409, 'WORKSPACE_OPERATION_STATE', '确认已失效，需重新提案。')
        if (input.cancel === true) return repo.put(tx, 'Operation', { ...op, state: 'cancelled' })
        if (input.always && op.confirmation.allowAlways === false) fail(400, 'POLICY_RULE_HARD', '这次改动必须逐条确认，不能设为总是允许。')
        const a = await origin(op, tx)
        full(await authority.authorize(repo, tx, a, input.sourceId, op.action)); full(await authority.authorize(repo, tx, a, input.sourceId, 'read'))
        const command = { requestId: op.requestId, action: op.action, ...copy(op.normalizedArgs) }
        if (op.action === 'delete') { delete command.data; command.confirmedDelete = true }
        const receipt = await service.applyLocalConfirmed(tx, actor, command, op.id)
        // "以后直接做" applies to this exact tool, action, source and type.
        if (input.always) await addRule(tx, { botId: op.actor.subjectId, match: { tool: 'workspace.prepare_change', action: op.action, sourceId: op.normalizedArgs.sourceId, type: op.normalizedArgs.type }, effect: 'allow', origin: 'user' })
        return repo.put(tx, 'Operation', { ...op, state: 'succeeded', receipt })
      })
    },
  }
}
