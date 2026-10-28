import { randomUUID } from 'node:crypto'
import { defineDoc } from '@earendil-works/pi-durable'
import { BotDirectory, assertBotActive } from './bot-directory.mjs'
import { TaskInputError } from './task-config.mjs'

// Identity/membership only. Scheduling, input, usage and recovery remain ChatTask's.
export const GroupDirectory = defineDoc({ kind: 'pidot.groups', version: 1, scope: 'session', initial: () => ({ items: [] }) })
const copy = x => JSON.parse(JSON.stringify(x))
// Literal "@名" in the body may address group members directly. Fenced code, inline code, quoted text,
// block quotes and e-mail addresses are data, not addressing.
const MENTION = /(^|\s)[@＠]([^\s@＠，。！？、；：,.!?;:]+)/gu
export function mentionNames(message) {
  if (typeof message !== 'string') return []
  const names = []
  let fenced = false
  for (const line of message.normalize('NFKC').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced || /^\s*>/.test(line)) continue
    const prose = line.replace(/`[^`]*`/g, ' ').replace(/"[^"]*"|“[^”]*”|「[^」]*」/g, ' ').replace(/[\w.+-]+@[\w.-]+/g, ' ')
    for (const match of prose.matchAll(MENTION)) names.push(match[2])
  }
  return names
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
// A message may address several members: structured targetBotIds (member picker) and literal "@名" are
// merged, in order, deduplicated. Each target later runs in its own bounded fork and replies publicly.
export const MAX_GROUP_TARGETS = 8
export async function admitGroupTarget(tx, card, input, bots) {
  const group = await assertGroupTask(tx, card)
  if (!group) throw new TaskInputError(400, 'GROUP_TARGET_DENIED', '定向目标只能用于群聊。')
  // The requestId only gates durable receipts; a plain message may omit it (no targets → nothing to record).
  const hasRequest = input && Object.hasOwn(input, 'requestId')
  if (!input || Object.keys(input).some(k => !['message','targetBotId','targetBotIds','requestId'].includes(k)) || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000 ||
    hasRequest && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) ||
    (input.targetBotId !== undefined && typeof input.targetBotId !== 'string') ||
    (input.targetBotIds !== undefined && (!Array.isArray(input.targetBotIds) || input.targetBotIds.some((id) => typeof id !== 'string')))) {
    throw new TaskInputError(400, 'INVALID_GROUP_TARGET', '须提供 message、稳定 requestId，以及 targetBotId 或 targetBotIds。')
  }
  const members = await groupMembers(tx, group)
  const byName = new Map(members.map((member) => [member.name.normalize('NFKC').trim(), member]))
  const mentions = mentionNames(input.message)
  const unknown = mentions.filter((name) => !byName.has(name.normalize('NFKC').trim()))
  if (unknown.length) throw new TaskInputError(400, 'GROUP_MENTION_UNKNOWN', `群里没有叫「${unknown[0]}」的 Bot；请从成员列表选择。`)
  const listed = [...(input.targetBotIds ?? []), ...(input.targetBotId ? [input.targetBotId] : [])]
  // The limit counts what the sender asked for, not duplicates collapsed afterwards.
  if (listed.length > MAX_GROUP_TARGETS || mentions.length > MAX_GROUP_TARGETS) throw new TaskInputError(400, 'GROUP_TARGET_LIMIT', `一条消息最多 @ ${MAX_GROUP_TARGETS} 个 Bot。`)
  const targets = [...new Set([...listed, ...mentions.map((name) => byName.get(name.normalize('NFKC').trim()).id)])]
  if (!targets.length) return null
  if (targets.length && !hasRequest) throw new TaskInputError(400, 'INVALID_GROUP_TARGET', '定向消息需要稳定的 requestId，以便重试时不重复派发。')
  for (const id of targets) {
    if (!group.memberBotIds.includes(id)) throw new TaskInputError(400, 'GROUP_TARGET_DENIED', '目标必须是本群成员。')
    if (byName.get(id)?.status === 'inactive') throw new TaskInputError(409, 'BOT_INACTIVE', `「${byName.get(id)?.name ?? id}」已停用，不能接收新消息。`)
    await assertBotActive(tx, id)
  }
  // The admin's collaboration tools stay required for the private fork itself; the user's explicit @ is
  // not a grant, so it cannot stand in for a missing tool. The reply reaches the group only when the
  // admin can review it, so a fork is never created for a reply that could never be published.
  const others = targets.filter((id) => id !== group.adminBotId)
  if (others.length) {
    const { toolSets, ToolAccess } = await import('./tools.mjs')
    const sets = toolSets(card, bots, await tx.doc(ToolAccess))
    if (!['collaborators_list','task_assign','task_review'].every(n => sets.authorized.includes(n))) throw new TaskInputError(409, 'COLLABORATION_NOT_AUTHORIZED', '这个 Bot 尚未开启“Bot 协作”工具组，@ 未发出，也不会因此获得权限；请先在 Bot 设置里打开该组。')
    const { feishuTaskAllowed, isFeishuResource } = await import('./feishu-calendar.mjs')
    const access = await tx.doc(ToolAccess)
    for (const id of others) {
      const targetResources = access.assignments?.[id]?.resources ?? []
      if (!await feishuTaskAllowed(tx, card, sets) || sets.resources.filter(isFeishuResource).some(r => !targetResources.includes(r)) ||
        sets.resources.some(isFeishuResource) && !['calendar_feishu_read_schedule', 'calendar_feishu_read_event', 'calendar_feishu_freebusy'].some(n => sets.authorized.includes(n))) throw new TaskInputError(403, 'GROUP_FORK_DENIED', '群上下文真实日历来源当前未获准。')
    }
  }
  group.inputs ??= []
  const signature = JSON.stringify([targets, input.message]), prior = hasRequest ? group.inputs.find(r => r.requestId === input.requestId) : undefined
  if (prior && prior.signature !== signature) throw new TaskInputError(409, 'GROUP_INPUT_CONFLICT', '同一消息标识不能改变内容或目标。')
  return { group, signature, prior, targets, members }
}
