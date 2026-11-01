import { defineDoc } from '@earendil-works/pi-durable'
import { createHash } from 'node:crypto'
import { TaskInputError, parseTaskState } from './task-config.mjs'
import { assertBotActive } from './bot-directory.mjs'
import { assertNotCancelled } from './cancellation.mjs'
import { assertSessionVisible } from './session-lifecycle.mjs'
import { MainSessions, TaskDigest } from './main-session.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const signature = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }

export const TaskProgress = defineDoc({ kind: 'pidot.task-progress', version: 1, scope: 'task', initial: () => ({
  schemaVersion: 1, controlVersion: 1, planRevision: 0, goalRevision: 1, steps: [], currentStepId: null,
  evidenceRefs: [], decisionHistory: [], stall: { evaluated: 0, replans: 0 }, retry: null,
  pendingGoalRevision: null, controlIntent: null, finalOutcome: null,
}) })
export const ContinuousOrigin = defineDoc({ kind: 'pidot.continuous-origin', version: 1, scope: 'task', initial: () => ({}) })
export const ContinuousBudget = defineDoc({ kind: 'pidot.continuous-budget', version: 1, scope: 'task', initial: () => ({ schemaVersion: 1, limits: null, deadlineAt: null, attempts: {} }) })
export const ContinuousRequests = defineDoc({ kind: 'pidot.continuous-requests', version: 1, scope: 'session', initial: () => ({ receipts: {} }) })
export const CONTINUOUS_DOCUMENTS = [TaskProgress, ContinuousOrigin, ContinuousBudget]
export const isContinuousTask = card => card?.executionPolicy?.kind === 'continuous'

export function parseContinuousLimits(input) {
  if (!object(input) || Object.keys(input).some(key => !['modelCalls', 'toolCalls', 'totalTokens', 'durationMs'].includes(key)) ||
    !['modelCalls', 'toolCalls', 'totalTokens', 'durationMs'].every(key => Number.isSafeInteger(input[key]) && input[key] > 0) || input.durationMs > 28800000) {
    fail(400, 'CONTINUOUS_LIMITS_REQUIRED', '持续任务须提供正整数 modelCalls、toolCalls、totalTokens 和 durationMs（最长8小时）。')
  }
  return copy(input)
}

export function createContinuousTaskService({ TaskCard, ChatInput, createTask, enabled = true, now = Date.now }) {
  return {
    async start(tx, input) {
      if (!object(input) || Object.keys(input).some(key => !['requestId', 'origin', 'goal', 'completionCriteria', 'constraints', 'title', 'limits'].includes(key)) ||
        typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(input.requestId) || !object(input.origin) ||
        Object.keys(input.origin).some(key => !['kind', 'taskId', 'sourceMessageId'].includes(key)) || !['main', 'group'].includes(input.origin.kind) ||
        !Number.isSafeInteger(input.origin.taskId) || input.origin.taskId < 1 || input.origin.sourceMessageId !== undefined && (!Number.isSafeInteger(input.origin.sourceMessageId) || input.origin.sourceMessageId < 1)) {
        fail(400, 'INVALID_CONTINUOUS_TASK', '持续任务须绑定有效主会话或群聊入口和唯一 requestId。')
      }
      const state = parseTaskState({ goal: input.goal, completionCriteria: input.completionCriteria, constraints: input.constraints ?? [] })
      if (!state.completionCriteria.length) fail(400, 'CONTINUOUS_CRITERIA_REQUIRED', '持续目标至少需要一项完成标准。')
      const limits = parseContinuousLimits(input.limits)
      if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100)) fail(400, 'INVALID_CONTINUOUS_TASK', '标题须为1–100字符。')
      const requests = await tx.doc(ContinuousRequests), hash = signature(input), prior = requests.receipts[input.requestId]
      if (prior) {
        if (prior.signature !== hash) fail(409, 'CONTINUOUS_REQUEST_CONFLICT', '同一 requestId 不能更换持续目标内容。')
        return { ...copy(prior.result), replayed: true }
      }
      if (!enabled) fail(409, 'CONTINUOUS_DISABLED', '当前实例未启用持续任务；已存在的目标仍可查看或取消。')
      await assertSessionVisible(tx, input.origin.taskId)
      const record = await tx.task(input.origin.taskId)
      if (!record || record.kind !== 'pidot.chat') fail(404, 'TASK_NOT_FOUND', '来源会话不存在。')
      await assertNotCancelled(tx, input.origin.taskId, record)
      const origin = await tx.doc(TaskCard, input.origin.taskId), mains = await tx.doc(MainSessions)
      if (origin.kind !== input.origin.kind || record.input.botId !== origin.bot?.id || origin.configRef.botId !== origin.bot?.id || origin.initiatingUser !== 'authenticated-user' ||
        (await tx.conversation(origin.conversationId))?.owner?.taskId !== origin.taskId) fail(403, 'CONTINUOUS_ORIGIN_DENIED', '只能从有效的本人会话启动持续目标。')
      let group = null
      if (origin.kind === 'main') {
        if (mains.byBot[origin.bot.id] !== origin.taskId) fail(403, 'CONTINUOUS_ORIGIN_DENIED', '只能从当前主会话启动持续目标。')
      } else {
        const { assertGroupTask } = await import('./groups.mjs')
        group = await assertGroupTask(tx, origin)
        if (!group?.memberBotIds.includes(origin.bot.id)) fail(403, 'CONTINUOUS_ORIGIN_DENIED', '群协调机器人须为当前群成员。')
      }
      await assertBotActive(tx, origin.bot.id)
      if (origin.parameters?.mode !== 'model') fail(409, 'CONTINUOUS_MODEL_REQUIRED', '请先为当前机器人配置模型，再启动持续目标。')
      const { ToolAccess, toolSets } = await import('./tools.mjs'), { BotDirectory } = await import('./bot-directory.mjs')
      const { workspaceHistoryAllowed } = await import('./workspace-grants.mjs'), { feishuTaskAllowed } = await import('./feishu-calendar.mjs')
      const sets = toolSets(origin, (await tx.doc(BotDirectory)).items, await tx.doc(ToolAccess))
      if (!await workspaceHistoryAllowed(tx, origin, sets) || !await feishuTaskAllowed(tx, origin, sets)) fail(403, 'CONTINUOUS_ORIGIN_DENIED', '入口会话依赖的来源当前不可用。')
      if (input.origin.sourceMessageId !== undefined) {
        const source = await tx.entry(input.origin.sourceMessageId)
        if (source?.kind !== 'pidot.user' || source.conversationId !== origin.conversationId) fail(403, 'CONTINUOUS_ORIGIN_DENIED', '来源消息不属于指定入口会话。')
      }
      const rootTaskId = await createTask(tx, { botId: origin.bot.id, title: input.title ?? state.goal.slice(0, 100), taskState: state,
        parameters: { callLimits: Object.fromEntries(['modelCalls', 'toolCalls', 'totalTokens'].map(key => [key, limits[key]])) } }, record.conversationId)
      const card = await tx.doc(TaskCard, rootTaskId), createdAt = new Date(now()).toISOString()
      const brief = await tx.appendEntry(card.conversationId, { kind: 'pidot.user', data: { role: 'user', content: state.goal, source: 'continuous-start', createdAt } })
      card.executionPolicy = { kind: 'continuous', rootTaskId, rootInputId: brief.id }
      card.taskState.goalRevision = 1
      card.origin = 'user'
      if (!group) card.mainParent = { mainTaskId: origin.taskId, mainConversationId: origin.conversationId, entryId: input.origin.sourceMessageId ?? null, operationId: input.requestId, briefEntryId: brief.id }
      ;(await tx.doc(ChatInput, rootTaskId)).entryId = brief.id
      await tx.doc(TaskProgress, rootTaskId)
      Object.assign(await tx.doc(ContinuousOrigin, rootTaskId), { originKind: origin.kind, originTaskId: origin.taskId,
        ...(group ? { groupId: group.groupId } : {}), sourceMessageId: input.origin.sourceMessageId ?? null,
        rootTaskId, rootInputId: brief.id, coordinatorBotId: origin.bot.id, deliveryTaskId: origin.taskId, deliveries: [] })
      Object.assign(await tx.doc(ContinuousBudget, rootTaskId), { rootTaskId, limits, startedAt: createdAt, deadlineAt: new Date(now() + limits.durationMs).toISOString() })
      if (!group) {
        mains.children[rootTaskId] = { mainTaskId: origin.taskId, botId: origin.bot.id, title: card.title, state: 'running', outcome: null, createdAt, overAt: null, result: null }
        ;((await tx.doc(TaskDigest)).byMain[origin.taskId] ??= []).push({ taskId: rootTaskId, summary: state.goal.slice(0, 80), createdAt, state: 'running', overAt: null, outcome: null })
      }
      const result = { rootTaskId, href: `/#bot=${encodeURIComponent(card.bot.id)}&task=${rootTaskId}`, version: 1, replayed: false }
      requests.receipts[input.requestId] = { signature: hash, result: copy(result) }
      await tx.appendEntry(origin.conversationId, { kind: 'pidot.continuous-started', data: { ...result, goal: state.goal, createdAt } })
      return result
    },
  }
}

export function projectContinuousTask(card, progress, origin, budget, record, usage, cancellation = null, { sourceVisible = true, automationPaused = false, enabled = true, deliveryTaskId, budgetBlockReason = null } = {}) {
  if (!isContinuousTask(card)) return null
  const checkpoint = record.state.checkpoint ?? {}
  const manualPause = progress.controlIntent?.action === 'pause'
  const deadlineExceeded = !progress.finalOutcome && Date.now() >= Date.parse(budget.deadlineAt)
  const state = cancellation ? 'cancelled' : progress.finalOutcome?.status ?? (
    deadlineExceeded ? 'limited' : manualPause ? usage.inFlight > 0 ? 'pausing' : 'paused' :
      progress.pendingGoalRevision ? 'revising' :
        automationPaused || !enabled ? 'paused' :
          progress.stall?.lastAction === 'blocked' ? 'blocked' :
            budgetBlockReason || checkpoint.lastOutcome === 'limited' ? 'limited' :
              checkpoint.phase === 'continuousRetry' ? 'retrying' :
                ['awaitApproval', 'awaitBlocker', 'awaitChildren', 'continuousWait'].includes(checkpoint.phase) ? 'waiting' : 'running')
  const availableActions = []
  if (!cancellation && !progress.finalOutcome) {
    availableActions.push('cancel', 'raise-limits')
    if (!progress.pendingGoalRevision) availableActions.push('revise-goal')
    if (manualPause || progress.stall?.lastAction === 'blocked') availableActions.push('resume')
    else availableActions.push('pause')
  }
  return copy({ rootTaskId: card.executionPolicy.rootTaskId, rootInputId: card.executionPolicy.rootInputId,
    version: progress.controlVersion, goalRevision: card.taskState.goalRevision, planRevision: progress.planRevision,
    state, phase: checkpoint.phase, goal: card.taskState.goal, completionCriteria: card.taskState.completionCriteria,
    constraints: card.taskState.constraints, origin: { ...Object.fromEntries(Object.entries(origin).filter(([key]) => sourceVisible || key !== 'deliveries')), ...(deliveryTaskId ? { deliveryTaskId } : {}) }, visibility: sourceVisible ? 'visible' : 'permission-denied',
    ...(sourceVisible && progress.pendingGoalRevision ? { pendingGoalRevision: progress.pendingGoalRevision } : {}),
    ...(sourceVisible ? { steps: progress.steps, currentStepId: progress.currentStepId, evidenceRefs: progress.evidenceRefs } : { currentStepId: null }), finalOutcome: sourceVisible && progress.finalOutcome ? Object.fromEntries(Object.entries(progress.finalOutcome).filter(([key]) => key !== 'content')) : null,
    waitingReason: deadlineExceeded ? 'deadline' : manualPause ? 'user-paused' : !enabled ? 'feature-disabled' : automationPaused ? 'global-paused' : progress.pendingGoalRevision ? 'goal-revision-pending' : budgetBlockReason ?? checkpoint.waitingReason ?? null,
    limits: budget.limits, deadlineAt: budget.deadlineAt, usage,
    availableActions })
}
