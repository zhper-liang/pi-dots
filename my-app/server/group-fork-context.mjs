import { deniedGroupInputs } from './group-result-provenance.mjs'
import { assertGroupTask } from './groups.mjs'
import { TaskInputError } from './task-config.mjs'

// Native ancestry remains the source of truth; never copy a transcript to fake a fork.
export async function forkPublicEntries(tx, card) {
  if (!card.forkSource) return []
  const source = card.forkSource
  const { TaskCard } = await import('./tasks.mjs')
  const record = await tx.task(source.parentTaskId)
  const { readCancelledArchive } = await import('./cancellation.mjs')
  const archive = record?.state.status === 'terminal' ? await readCancelledArchive(tx,source.parentTaskId) : null
  if(record?.state.status==='terminal'&&!archive)throw new TaskInputError(404,'GROUP_FORK_DENIED','群来源已故障结束；不能重建退役文档或继承旧授权。')
  const parent = archive ? archive.documents[TaskCard.definition.kind] : await tx.doc(TaskCard, source.parentTaskId)
  const group = await assertGroupTask(tx, parent)
  const conversation = await tx.conversation(card.conversationId)
  if (!group || group.groupId !== source.groupId || source.conversationId !== parent.conversationId || conversation?.owner?.taskId !== card.taskId || conversation.parent?.conversationId !== source.conversationId || conversation.parent?.at !== source.at || !group.memberBotIds.includes(card.bot.id) || card.initiatingUser !== parent.initiatingUser) throw new TaskInputError(404,'GROUP_FORK_DENIED','群子线程来源不可访问。')
  const { ToolAccess, toolSets } = await import('./tools.mjs')
  const { feishuTaskAllowed, isFeishuResource } = await import('./feishu-calendar.mjs')
  const bots = (await tx.doc((await import('./bot-directory.mjs')).BotDirectory)).items, access = await tx.doc(ToolAccess)
  const parentSets = toolSets(parent, bots, access), childSets = toolSets(card, bots, access)
  const { workspaceShareAllowed, workspaceHistoryAllowed } = await import('./workspace-grants.mjs')
  if (!workspaceShareAllowed(parent, card, access) || !await workspaceHistoryAllowed(tx, parent, parentSets) || !await feishuTaskAllowed(tx, parent, parentSets) || parentSets.resources.filter(isFeishuResource).some(r => !childSets.resources.includes(r))) throw new TaskInputError(403, 'GROUP_FORK_DENIED', '群上下文真实日历来源当前未获准。')
  const entries = []; let cursor
  do { const page = await tx.scanEntries({conversationId:card.conversationId,order:'ascending'},100,cursor); entries.push(...page.items); cursor=page.next } while(cursor)
  const inherited = entries.filter(e => e.conversationId === source.conversationId && e.id <= source.at)
  const denied=await deniedGroupInputs(tx,parent,inherited,{...(await import('./tasks.mjs')),bots:(await tx.doc((await import('./bot-directory.mjs')).BotDirectory)).items})
  const completed = new Set(inherited.filter(e => ['pidot.model-reply','pidot.test-reply'].includes(e.kind) && e.byTaskId === parent.taskId && !e.data.intermediate).map(e => e.data.inReplyTo))
  return inherited.filter(e => e.kind === 'pidot.user' && (e.id === source.at || completed.has(e.id)) || ['pidot.model-reply','pidot.test-reply'].includes(e.kind) && e.byTaskId === parent.taskId && completed.has(e.data.inReplyTo)&&!denied.has(e.data.inReplyTo)).map(e => ({id:e.id,sourceConversationId:e.conversationId,role:e.kind==='pidot.user'?'user':'assistant',content:e.data.content,createdAt:e.data.createdAt}))
}
