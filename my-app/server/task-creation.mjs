import { TaskInputError, taskParameters, parseTaskState } from './task-config.mjs'
import { BotDirectory, assertBotActive } from './bot-directory.mjs'
import { ToolAccess } from './tools.mjs'
import { isCancelled } from './cancellation.mjs'
import { TaskBlockers, BLOCKER_TOOL } from './blockers.mjs'
import { TaskApprovals } from './approvals.mjs'
import { MANAGEMENT_TOOLS } from './management-tools.mjs'

function parseInput(input, bots) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !['botId', 'title', 'parameters', 'taskState'].includes(key)) ||
    typeof input.botId !== 'string' ||
    (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100))) {
    throw new TaskInputError(400, 'INVALID_TASK', '请提供 botId；可选 title 须为 1–100 个字符的非空字符串。身份、接口和工具授权不能覆盖。')
  }
  const bot = bots.find((item) => item.id === input.botId)
  if (!bot) throw new TaskInputError(404, 'BOT_NOT_FOUND', '指定的 Bot 不存在，请重新选择。')
  return { bot, title: input.title?.trim() ?? `与 ${bot.name} 的会话`,
    parameters: taskParameters(input.parameters, bot.defaults),
    state: input.taskState === undefined ? {} : parseTaskState(input.taskState) }
}

/** Shared atomic creation: identity, immutable permissions, input documents and provenance. */
export async function createChatTask(tx, input, { ChatTask, TaskCard, ChatInput, ChatQueue, configuredModels, beforeCommit, creationConversationId, forkSource }) {
  const directory = await tx.doc(BotDirectory), access = await tx.doc(ToolAccess)
  const { bot, title, parameters, state } = parseInput(input, JSON.parse(JSON.stringify(directory.items)))
  await assertBotActive(tx, bot.id)
  if (input.parameters?.model && parameters.mode === 'model' && !configuredModels.some((m) => JSON.stringify(m) === JSON.stringify(parameters.model))) throw new TaskInputError(400, 'MODEL_NOT_CONFIGURED', '仅可选择服务端已配置模型。')
  parameters.tools = [...access.assignments[bot.id].tools]
  parameters.toolResources = [...access.assignments[bot.id].resources]
  const taskId = await tx.createTask(ChatTask, { botId: bot.id }, { ownership: { kind: 'conversation' }, ...(creationConversationId === undefined ? {} : { conversationId: creationConversationId, forkSource }) })
  const conversation = forkSource ? await tx.forkConversation(forkSource.conversationId, forkSource.at, { ownership: { kind: 'task', taskId } }) : await tx.createConversation({ ownership: { kind: 'task', taskId } })
  await tx.doc(TaskBlockers, taskId)
  await tx.doc(TaskApprovals, taskId)
  await tx.doc(ChatInput, taskId)
  await tx.doc(ChatQueue, taskId)
  const card = await tx.doc(TaskCard, taskId)
  Object.assign(card, {
    taskId, conversationId: conversation.id, kind: 'chat', title,
    initiatingUser: 'authenticated-user', managementTools: bot.id === 'chief' ? [...MANAGEMENT_TOOLS, BLOCKER_TOOL] : [],
    createdAt: new Date().toISOString(),
    bot: { id: bot.id, name: bot.name, description: bot.description },
    configRef: JSON.parse(JSON.stringify(bot.configRef)),
    workspaceUsedResources: [], workspaceUsedTools: [], workspaceUsedReadScopes: {},
    feishuUsedResources: [], feishuUsedTools: [],
    parameters,
    parameterSources: Object.fromEntries(Object.keys(bot.defaults).map((key) => [key, {
      type: Object.hasOwn(input.parameters ?? {}, key) ? 'user-request' : 'bot-default', configRef: bot.configRef,
    }])),
    titleSource: input.title === undefined ? 'bot-default' : 'user-request',
  })
  card.taskState = { goal: title, completionCriteria: [], constraints: [], ...state }
  const source = await tx.appendEntry(conversation.id, {
    kind: 'pidot.task-state', data: { changes: JSON.parse(JSON.stringify(card.taskState)), createdAt: card.createdAt, source: 'task-creation' },
  })
  card.taskStateSources = Object.fromEntries(Object.keys(card.taskState).map((key) => [key, {
    type: Object.hasOwn(state, key) || (key === 'goal' && input.title !== undefined) ? 'user-request' : 'bot-default',
    entryId: source.id, configRef: bot.configRef,
  }]))
  if (beforeCommit) await beforeCommit({ taskId, conversationId: conversation.id })
  return taskId
}

export async function admitNextInput(tx, taskId, slot, { TaskCard, ChatQueue }) {
  const card = await tx.doc(TaskCard, taskId)
  if ((await tx.doc(BotDirectory)).items.find(b => b.id === card.bot.id)?.status === 'inactive') return
  const queue = await tx.doc(ChatQueue, taskId)
  if (!await isCancelled(tx, taskId) && (await tx.doc(TaskBlockers, taskId)).activeId === null && (await tx.doc(TaskApprovals, taskId)).activeId === null && slot.entryId === null && queue.entryIds.length) slot.entryId = queue.entryIds.shift()
}

