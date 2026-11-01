import { createHash } from 'node:crypto'

export const evidenceFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function memoryTaskSourceAllowed(card, parent) {
  if (!card?.bot?.id || card.kind === 'group' || card.groupId || card.forkSource || card.collaboration || card.scheduledWorkflow || card.origin && card.origin !== 'user') return false
  if (card.mainParent) return !!parent && parent.kind === 'main' && parent.bot?.id === card.bot.id && parent.taskId === card.mainParent.mainTaskId && !parent.groupId && !parent.collaboration && !parent.scheduledWorkflow
  return card.initiatingUser === 'authenticated-user'
}
export const userMemoryEvidenceAllowed = (card, entry) => !!card?.bot?.id && !card.mainParent && memoryTaskSourceAllowed(card) && entry?.kind === 'pidot.user' && entry.data?.role === 'user' && !entry.data.source && !entry.data.calendarCommand && !entry.data.targetBotId && !entry.data.targetBotIds && typeof entry.data.content === 'string' && entry.conversationId === card.conversationId && (entry.byTaskId === undefined || entry.byTaskId === card.taskId)
// Only durable success receipts qualify. A successful Task status or an assistant assertion is not proof.
export function successfulMemoryTool(entry) {
  const data = entry?.data, result = data?.result
  return entry?.kind === 'pidot.tool-result' && result?.ok === true && data.toolResult?.isError !== true && typeof data.toolName === 'string' &&
    !/^(?:memory_|skill_|session_|task_history_read$|tool_result_read$|task_status$|task_create$|routine_|bot_manage$|collaborators_|task_assign$|shared_)/.test(data.toolName) &&
    !['unknown', 'pending', 'running', 'waiting-for-user-approval', 'cancelled', 'failed', 'skipped', 'prepared', 'proposed', 'waiting', 'preview'].some(state => result.data?.status === state || result.data?.state === state) && result.data?.unknown !== true && result.error?.unknown !== true && result.data?.success !== false && (result.data?.exitCode === undefined || result.data.exitCode === 0)
}
export function memoryEvidence(card, entry) {
  const kind = userMemoryEvidenceAllowed(card, entry) ? 'user' : successfulMemoryTool(entry) ? 'tool-result' : null
  if (!kind) return null
  const content = kind === 'user' ? entry.data.content : JSON.stringify({ toolName: entry.data.toolName, arguments: entry.data.arguments, result: entry.data.result })
  return { taskId: card.taskId, entryId: entry.id, kind, fingerprint: evidenceFingerprint([kind, content]), content }
}
