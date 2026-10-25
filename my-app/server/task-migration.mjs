import { createHash } from 'node:crypto'
import { workspaceUsedResources, workspaceUsedTools } from './workspace-grants.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { TaskInputError } from './task-config.mjs'
import { ToolAccess, CallUsage, toolSets, toolDefinitions } from './tools.mjs'
import { TaskSkills, assertSkillMigrationReady, skillCatalogForTask } from './skills.mjs'
import { TaskApprovals } from './approvals.mjs'
import { TaskBlockers } from './blockers.mjs'
import { assertNotCancelled } from './cancellation.mjs'
import { ChatSteering } from './steering.mjs'
import { ContextCompaction, contextPolicy, contextTokens } from './context-compaction.mjs'
import { buildTaskContext } from './task-context.mjs'

const copy = (x) => JSON.parse(JSON.stringify(x))
const canonical = (x) => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])])) : x
const hash = (x) => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }

// Admission and migration share Harness.commit. No queued migration or second execution lock.
export function migrationApi({ harness, context, TaskCard, ChatInput, ChatQueue, bots, models, get, skillDirectory }) {
  async function prepare(tx, id) {
    const record = await tx.task(id)
    if (!record || record.kind !== 'pidot.chat') fail(404, 'TASK_NOT_FOUND', '会话不存在。')
    await assertNotCancelled(tx, id, record)
    if ((await tx.doc(TaskCard, id)).scheduledWorkflow) fail(409, 'TASK_MIGRATION_BUSY', '定时Task必须保留固定只读快照；新工作须显式新计划。')
    const slot = await tx.doc(ChatInput, id), queue = await tx.doc(ChatQueue, id), steering = await tx.doc(ChatSteering, id)
    const approvals = await tx.doc(TaskApprovals, id), blockers = await tx.doc(TaskBlockers, id)
    const {Collaboration}=await import('./collaboration.mjs')
    if((await tx.doc(Collaboration)).items.some(r=>r.childTaskId===id && r.reviewRequired)) fail(409,'TASK_MIGRATION_BUSY','受管子任务须保留原固定配置；新工作必须新委派。')
    const checkpoint = record.state.checkpoint
    if (!['pending', 'running'].includes(record.state.status) || checkpoint?.phase !== 'awaitInput' ||
      checkpoint.lastOutcome === 'limited' || checkpoint.inFlight || slot.entryId !== null || queue.entryIds.length ||
      steering.pending.length || approvals.activeId !== null || blockers.activeId !== null ||
      approvals.items.some((a) => a.operation && !a.receipt && !['completed', 'retry'].includes(a.operation.resolution?.outcome)) ||
      blockers.items.some((b) => b.status === 'pending')) {
      fail(409, 'TASK_MIGRATION_BUSY', '仅安全空闲会话可迁移；请先处理执行、排队输入、审批、阻塞、限额或结果未知等待。不会排队迁移。')
    }
    const card = await tx.doc(TaskCard, id), conversation = await tx.conversation(card.conversationId)
    if (card.taskId !== id || record.input.botId !== card.bot.id || card.configRef.botId !== card.bot.id || conversation?.owner?.taskId !== id) fail(409, 'TASK_BINDING_MISMATCH', 'Task、Bot和会话关联不一致。')
    const directory = await tx.doc(BotDirectory), access = await tx.doc(ToolAccess)
    const bot = directory.items.find((b) => b.id === card.bot.id)
    const version = directory.configurations?.[card.bot.id]?.find((v) => v.configRef.version === bot?.configRef.version)
    if (!bot || !version || hash(version.defaults) !== hash(bot.defaults) || version.description !== bot.description) fail(409, 'MIGRATION_TARGET_INVALID', '目标配置不存在或不可变快照不一致。')
    if (card.configRef.version === bot.configRef.version) fail(409, 'MIGRATION_NOT_NEEDED', '当前会话已使用该配置版本，无需迁移。')
    const next = copy(card), parameters = copy(bot.defaults), sources = {}
    for (const key of Object.keys(parameters)) {
      const source = card.parameterSources?.[key]
      if (['user-request', 'user-limit-increase'].includes(source?.type) && !['tools', 'toolResources', 'mode', 'contextWindows'].includes(key) && Object.hasOwn(card.parameters, key)) {
        parameters[key] = copy(card.parameters[key]); sources[key] = copy(source)
      } else sources[key] = { type: 'configuration-migration', configRef: copy(bot.configRef) }
    }
    // A model override never carries guessed capacity or a new provider into the target.
    if (parameters.mode !== card.parameters.mode || parameters.mode === 'model' && !models.some((m) => hash(m) === hash(parameters.model))) fail(409, 'MIGRATION_MODEL_UNAVAILABLE', '目标模式或模型未获服务端配置；不能静默切换或丢弃用户覆盖。')
    Object.assign(next, { bot: { id: bot.id, name: bot.name, description: bot.description }, configRef: copy(bot.configRef), parameters,
      parameterSources: sources })
    next.workspaceUsedResources = workspaceUsedResources(card)
    next.workspaceUsedTools = workspaceUsedTools(card)
    next.workspaceUsedReadScopes = card.workspaceUsedReadScopes ?? Object.fromEntries(next.workspaceUsedResources.map(r => [r.slice(10), 'full']))
    delete next.workspaceSnapshot
    const sets = toolSets(next, bots, access)
    if (parameters.tools.some((n) => !sets.authorized.includes(n)) || parameters.toolResources.some((n) => !sets.resources.includes(n))) fail(409, 'MIGRATION_PERMISSION_DENIED', '目标工具/资源未分配或已撤销；请修正配置后重新比较。')
    await assertSkillMigrationReady(tx, next, bots, access)
    let capacity = null
    if (parameters.mode === 'model') {
      const policy = contextPolicy(parameters)
      if (!policy || policy.triggerTokens <= 0) fail(409, 'MIGRATION_CAPACITY_UNKNOWN', '目标模型容量未明确配置或输出预留无效；请先配置已核实容量，不会猜测或丢弃规则。')
      const ctx = await buildTaskContext(tx, next, Number.MAX_SAFE_INTEGER, { preview: true })
      const skillCatalog = sets.authorized.includes('skill_activate') ? await skillCatalogForTask(tx, next, bots, skillDirectory) : []
      const estimatedTokens = contextTokens({ systemPrompt: ctx.systemPrompt, tools: toolDefinitions(sets.authorized), messages: ctx.messages, skillCatalog }) + (skillCatalog.length ? 512 : 0)
      // Conservative preflight, no migration-time compaction or extra model call.
      if (estimatedTokens + 4096 > policy.triggerTokens) fail(409, 'MIGRATION_CAPACITY_EXCEEDED', '现有历史、任务要求和固定Skill超出目标容量安全余量；未压缩或丢弃内容，请选择容量充足的模型。')
      capacity = { ...policy, estimatedTokens, nextInputReserveTokens: 4096 }
    }
    const usage = copy(await tx.doc(CallUsage, id)), skills = copy(await tx.doc(TaskSkills, id))
    const changes = []
    for (const [key, before, after] of [['bot.description', card.bot.description, next.bot.description], ...[...new Set([...Object.keys(card.parameters), ...Object.keys(parameters)])].map((k) => [`parameters.${k}`, card.parameters[k] ?? null, parameters[k] ?? null])]) {
      if (hash(before) !== hash(after)) changes.push({ field: key, previous: before, next: after })
    }
    const preview = { taskId: id, conversationId: card.conversationId, previous: copy(card.configRef), next: copy(next.configRef), changes, capacity,
      retainedOverrides: Object.keys(sources).filter((k) => ['user-request', 'user-limit-increase'].includes(sources[k].type)),
      activeSkills: skills.active.map((s) => copy(s.ref)), usage, source: 'authenticated-user' }
    const previewToken = hash({ preview, card: copy(card), access: copy(access), skills, checkpoint, compaction: copy(await tx.doc(ContextCompaction, id)) })
    return { preview: { ...preview, previewToken }, next, directory }
  }
  return {
    // Materialize draft-backed diff values before the transaction revokes its proxies.
    previewMigration: (id) => harness.commit(async (tx) => copy((await prepare(tx, id)).preview), context),
    async migrateConfiguration(id, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['requestId', 'expectedVersion', 'targetVersion', 'previewToken', 'confirm'].includes(k)) ||
        typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) ||
        typeof input.expectedVersion !== 'string' || typeof input.targetVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewToken) || input.confirm !== true) fail(400, 'INVALID_MIGRATION', '请先查看差异并明确确认；仅接受requestId、前后版本与预览凭据，不接受参数或权限覆盖。')
      const migration = await harness.commit(async (tx) => {
        const directory = await tx.doc(BotDirectory), key = `migration:${id}:${input.requestId}`, signature = hash(input)
        const prior = directory.managementRequests[key]
        if (prior) {
          if (prior.signature !== signature) fail(409, 'MIGRATION_REQUEST_CONFLICT', '同一requestId不能用于不同迁移。')
          return copy(prior.result)
        }
        const { preview, next } = await prepare(tx, id)
        if (input.expectedVersion !== preview.previous.version || input.targetVersion !== preview.next.version || input.previewToken !== preview.previewToken) fail(409, 'MIGRATION_PREVIEW_STALE', '配置、任务或实时授权已变化；请重新查看差异并确认。')
        const createdAt = new Date().toISOString()
        const entry = await tx.appendEntry(next.conversationId, { kind: 'pidot.configuration-migrated', data: { ...preview, requestId: input.requestId, createdAt } })
        Object.assign(await tx.doc(TaskCard, id), next)
        const result = { entryId: entry.id, taskId: id, conversationId: next.conversationId, previous: preview.previous, next: preview.next, source: 'authenticated-user', createdAt }
        directory.managementAudit.push({ id: directory.managementAudit.length + 1, botId: next.bot.id, type: 'task-configuration-migrated', ...result, requestId: input.requestId })
        directory.managementRequests[key] = { signature, result: copy(result) }
        return result
      }, context)
      return { migration, task: await get(id) }
    },
  }
}
