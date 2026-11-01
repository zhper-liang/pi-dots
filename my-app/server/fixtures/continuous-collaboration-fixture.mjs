import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, defineTask } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { TaskCard, ChatInput, ChatQueue } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
import { BotDirectory } from '../bot-directory.mjs'
import { ToolAccess, CallUsage } from '../tools.mjs'
import { createChatTask } from '../task-creation.mjs'
import { createGroup } from '../groups.mjs'
import { createMainSession } from '../main-session.mjs'
import { TaskProgress, ContinuousOrigin, ContinuousBudget } from '../continuous-task.mjs'
import { collaborationService, publishChildResult, Collaboration } from '../collaboration.mjs'
const copy=value=>JSON.parse(JSON.stringify(value))

// The real Session transaction line and SQLite, with no scheduler or external calls. Scoped writes
// are the same host attribution used by runtime.commit; receipts are synthetic service responses.
const Probe = defineTask({ name: 'pidot.test.continuous-collaboration', version: 1, initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} } })
const tools = ['collaborators_list','task_assign','task_review','shared_publish','shared_link','shared_read','calendar_read_schedule']

export async function continuousCollaborationFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-continuous-collab-')), file = join(dir, 'isolated.sqlite')
  let session = createSession(await openNodeSqliteStorage(file))
  t.after(async () => { await session.close(context); await rm(dir, { recursive: true, force: true }) })
  const tx = (fn, taskId) => session.commitWith(async scoped => { const value = await fn(scoped); return value === undefined ? undefined : copy(value) }, context, taskId ? { taskId } : {})
  const bots = listBots({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-only' })
  const outer = await tx(async tx => {
    ;(await tx.doc(BotDirectory)).items = copy(bots)
    const access = await tx.doc(ToolAccess)
    for (const bot of bots) access.assignments[bot.id] = { tools: [...tools], resources: ['mock:personal'] }
    return (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
  })
  const createTask = (tx, input, creationConversationId = outer, forkSource) => createChatTask(tx, input, {
    ChatTask: Probe, TaskCard, ChatInput, ChatQueue, creationConversationId, forkSource, configuredModels: [],
  })
  const services = { TaskCard, ChatInput, bots }
  const collaboration = collaborationService({ ...services, createTask })
  const group = await tx(tx => createGroup(tx, { requestId: 'continuous-collab-group', title: '持续目标群', adminBotId: 'todo', memberBotIds: ['todo','calendar','chief'] }, createTask, TaskCard))
  const mainTaskId = await tx(tx => createMainSession(tx, 'todo', { createTask, TaskCard, rootConversationId: outer }))
  let sequence = 0
  const root = (originKind = 'group') => tx(async tx => {
    const originTaskId = originKind === 'group' ? group.group.taskId : mainTaskId
    const source = await tx.doc(TaskCard, originTaskId)
    const taskId = await createTask(tx, { botId: 'todo', title: `目标${++sequence}`, taskState: { goal: '核对来源并提交', completionCriteria: ['真实回执及评审'], constraints: [] } })
    const card = await tx.doc(TaskCard, taskId)
    const input = await tx.appendEntry(card.conversationId, { kind: 'pidot.user', data: { content: '持续目标', source: 'continuous-start' } })
    card.executionPolicy = { kind: 'continuous', rootTaskId: taskId, rootInputId: input.id }
    card.taskState.goalRevision = 1
    ;(await tx.doc(ChatInput, taskId)).entryId = input.id
    Object.assign(await tx.doc(ContinuousOrigin, taskId), { originKind, originTaskId, rootTaskId: taskId, rootInputId: input.id,
      coordinatorBotId: 'todo', sourceMessageId: null, ...(originKind === 'group' ? { groupId: group.group.groupId } : {}), deliveries: [] })
    Object.assign(await tx.doc(ContinuousBudget, taskId), { rootTaskId: taskId, limits: { modelCalls: 20, toolCalls: 40, totalTokens: 1000000 },
      startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString() })
    Object.assign(await tx.doc(TaskProgress, taskId), { planRevision: 1, currentStepId: 'step-1', steps: [{ stepId: 'step-1', kind: 'execute', status: 'active', goalRevision: 1,
      planRevision: 1, submissionRevision: 0, dependsOn: [], evidenceRefs: [], criteriaIndices: [0] }] })
    if (originKind === 'main') card.mainParent = { mainTaskId: source.taskId, mainConversationId: source.conversationId, botId: 'todo', briefEntryId: input.id }
    return copy(card)
  })
  const assign = (root, operationId = 'one-child', botId = 'calendar') => tx(async tx => collaboration.execute(tx, await tx.doc(TaskCard, root.taskId), {
    name: 'task_assign', arguments: { operationId, botId, goal: '核对模拟日程来源', completionCriteria: ['引用模拟来源'] },
  }, root.executionPolicy.rootInputId))
  const publish = async (child, { evidence = true, status = 'submitted' } = {}) => {
    if (evidence) await tx(async tx => {
      const card = await tx.doc(TaskCard, child.childTaskId), relation = (await tx.doc(Collaboration)).items.find(row => row.childTaskId === child.childTaskId)
      const usage = await tx.doc(CallUsage, child.childTaskId)
      usage.toolCalls += 1
      await tx.appendEntry(card.conversationId, { kind: 'pidot.tool-result', data: { toolName: 'calendar_read_schedule', callId: 'source-read', turnId: child.childInputId,
        inReplyTo: child.childInputId, continuousBinding: copy(relation.continuousBinding), arguments: { date: '2026-11-02', resource: 'mock:personal' },
        result: { ok: true, data: { simulated: true, source: 'fixture', events: [] } } } })
    }, child.childTaskId)
    await tx(async tx => {
      ;(await tx.doc(ChatInput, child.childTaskId)).entryId = null
      await publishChildResult(tx, child.childTaskId, child.childInputId, { status, content: '已核对的模拟来源结果' })
    }, child.childTaskId)
    return tx(async tx => copy((await tx.doc(Collaboration)).items.find(row => row.childTaskId === child.childTaskId)))
  }
  const review = (root, relation, patch = {}) => tx(async tx => collaboration.review(tx, await tx.doc(TaskCard, root.taskId), { name: 'task_review', arguments: {
    operationId: `review-${relation.result.revision}`, childTaskId: relation.childTaskId, rootWorkId: relation.rootWorkId, revision: relation.result.revision,
    expectedState: 'submitted', decision: 'accept', reason: '已按真实成功回执核对模拟来源', continuousBinding: relation.continuousBinding, ...patch,
  } }, root.executionPolicy.rootInputId))
  return { tx, root, assign, publish, review, group: group.group, mainTaskId, services, collaboration, createTask,
    restart: async () => { await session.close(context); session = createSession(await openNodeSqliteStorage(file)) },
  }
}
