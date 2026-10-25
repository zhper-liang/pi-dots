import { randomUUID } from 'node:crypto'
import { defineDoc } from '@earendil-works/pi-durable'
import { BotDirectory, assertBotActive } from './bot-directory.mjs'
import { TaskInputError } from './task-config.mjs'

// Identity/membership only. Scheduling, input, usage and recovery remain ChatTask's.
export const GroupDirectory = defineDoc({ kind: 'pidot.groups', version: 1, scope: 'session', initial: () => ({ items: [] }) })
const copy = x => JSON.parse(JSON.stringify(x))
export function assertGroupMessage(card, message) {
  // Only explicit addressing syntax is rejected; email, quotes and fenced code are data.
  if (card.kind !== 'group' || typeof message !== 'string') return
  let fenced = false
  for (const line of message.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    const prose = line.replace(/`[^`]*`/g, '').replace(/"[^"]*"|“[^”]*”/g, '')
    if (!fenced && !/^\s*>/.test(line) && /(?:^|\s)[@＠][^\s@]+/u.test(prose)) throw new TaskInputError(400, 'GROUP_MENTION_UNSUPPORTED', '本票仅支持管理员普通群聊；定向@尚未开放，请勿通过正文派发。')
  }
}
function parse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['requestId', 'title', 'adminBotId', 'memberBotIds', 'parameters'].includes(k)) ||
    typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId) ||
    typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100 ||
    typeof input.adminBotId !== 'string' || !Array.isArray(input.memberBotIds) || input.memberBotIds.length < 2 || input.memberBotIds.length > 50 ||
    input.memberBotIds.some(id => typeof id !== 'string') || new Set(input.memberBotIds).size !== input.memberBotIds.length || !input.memberBotIds.includes(input.adminBotId)) {
    throw new TaskInputError(400, 'INVALID_GROUP', '群聊须有名称、稳定requestId、管理员及至少两个不同的已有活跃Bot；管理员必须是成员。成员创建后固定。')
  }
  return { requestId: input.requestId, title: input.title.trim(), adminBotId: input.adminBotId, memberBotIds: [...input.memberBotIds].sort(), ...(input.parameters === undefined ? {} : { parameters: input.parameters }) }
}
// Stable object-key order also covers optional task parameter objects.
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
export async function assertGroupTask(tx, card) {
  if (card.kind !== 'group') return null
  const group = (await tx.doc(GroupDirectory)).items.find(g => g.groupId === card.groupId && g.taskId === card.taskId && g.conversationId === card.conversationId && g.adminBotId === card.bot.id && g.initiatingUser === 'authenticated-user')
  if (!group || card.initiatingUser !== 'authenticated-user') throw new TaskInputError(404, 'GROUP_NOT_FOUND', '此身份没有该群聊。')
  return group
}
export async function groupMembers(tx, group) {
  const directory = await tx.doc(BotDirectory)
  return group.memberBotIds.map(id => { const b = directory.items.find(b => b.id === id); return { id, name: b?.name ?? id, status: b?.status ?? 'active' } })
}
export async function createGroup(tx, input, createTask, TaskCard) {
  const parsed = parse(input), signature = JSON.stringify(canonical(parsed))
  const groups = await tx.doc(GroupDirectory)
  const prior = groups.items.find(g => g.requestId === parsed.requestId && g.initiatingUser === 'authenticated-user')
  if (prior) {
    if (prior.signature !== signature) throw new TaskInputError(409, 'GROUP_REQUEST_CONFLICT', '同一创建标识不能改变群参数。')
    return { group: copy(prior), created: false }
  }
  const directory = await tx.doc(BotDirectory)
  for (const id of parsed.memberBotIds) {
    if (!directory.items.some(b => b.id === id)) throw new TaskInputError(404, 'BOT_NOT_FOUND', '群成员Bot不存在。')
    await assertBotActive(tx, id)
  }
  const taskId = await createTask(tx, { botId: parsed.adminBotId, title: parsed.title, ...(parsed.parameters === undefined ? {} : { parameters: parsed.parameters }) })
  const card = await tx.doc(TaskCard, taskId)
  const group = { ...parsed, signature, groupId: randomUUID(), taskId, conversationId: card.conversationId, initiatingUser: 'authenticated-user', createdAt: card.createdAt }
  card.kind = 'group'; card.groupId = group.groupId
  groups.items.push(copy(group))
  return { group, created: true }
}

// Input receipts are data on the existing group document, not another scheduler.
export async function admitGroupTarget(tx, card, input, bots) {
  const group = await assertGroupTask(tx, card)
  if (!group) throw new TaskInputError(400, 'GROUP_TARGET_DENIED', '定向目标只能用于群聊。')
  if (!input || Object.keys(input).some(k => !['message','targetBotId','requestId'].includes(k)) || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000 || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId) || typeof input.targetBotId !== 'string') throw new TaskInputError(400, 'INVALID_GROUP_TARGET', '须提供单个targetBotId、message和稳定requestId。')
  assertGroupMessage(card, input.message)
  if (!group.memberBotIds.includes(input.targetBotId)) throw new TaskInputError(400, 'GROUP_TARGET_DENIED', '目标必须是本群成员。')
  await assertBotActive(tx, input.targetBotId)
  if (input.targetBotId !== group.adminBotId) {
    const { toolSets, ToolAccess } = await import('./tools.mjs')
    const sets = toolSets(card, bots, await tx.doc(ToolAccess))
    if (!['collaborators_list','task_assign','task_review'].every(n => sets.authorized.includes(n))) throw new TaskInputError(409, 'COLLABORATION_NOT_AUTHORIZED', '群管理员须已有协作及精确验收许可，手动@不授予权限。')
    const { feishuTaskAllowed, isFeishuResource } = await import('./feishu-calendar.mjs')
    const access = await tx.doc(ToolAccess)
    const targetResources = access.assignments?.[input.targetBotId]?.resources ?? []
    if (!await feishuTaskAllowed(tx, card, sets) || sets.resources.filter(isFeishuResource).some(r => !targetResources.includes(r)) ||
      sets.resources.some(isFeishuResource) && !['calendar_feishu_read_schedule', 'calendar_feishu_read_event', 'calendar_feishu_freebusy'].some(n => sets.authorized.includes(n))) throw new TaskInputError(403, 'GROUP_FORK_DENIED', '群上下文真实日历来源当前未获准。')
  }
  group.inputs ??= []
  const signature = JSON.stringify([input.targetBotId,input.message]), prior = group.inputs.find(r => r.requestId === input.requestId)
  if (prior && prior.signature !== signature) throw new TaskInputError(409, 'GROUP_INPUT_CONFLICT', '同一消息标识不能改变内容或目标。')
  return { group, signature, prior }
}
