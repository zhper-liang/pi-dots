import { TaskBlockers } from './blockers.mjs'
import { TaskSkills } from './skills.mjs'
import { CallUsage } from './tools.mjs'
import { ContextCompaction } from './context-compaction.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const counters = ['modelCalls', 'toolCalls', 'totalTokens', 'unknownTokenCalls']

// A question parks one input inside the existing Task, never a second execution slot.
export async function parkQuestionInput(tx, card, item, { ChatInput, ChatQueue, admitNextInput, TaskCard }) {
  if (!item.parked) {
    const skills = await tx.doc(TaskSkills, card.taskId)
    const usage = await tx.doc(CallUsage, card.taskId)
    const compacted = await tx.doc(ContextCompaction, card.taskId)
    item.resumeState = { parameters: copy(card.parameters), taskState: copy(card.taskState ?? {}),
      taskStateSources: copy(card.taskStateSources ?? {}), compaction: { latest: copy(compacted.latest), coveredKeys: copy(compacted.coveredKeys) }, activeSkills: copy(skills.active), lastFailure: copy(skills.lastFailure ?? null),
      ...(card.kind === 'main' ? { usage: Object.fromEntries([...counters, 'inputEntryId'].map(key => [key, usage[key] ?? (key === 'inputEntryId' ? item.inReplyTo : 0)])) } : {}) }
    skills.active = []; skills.lastFailure = null
    compacted.latest = null; compacted.coveredKeys = []
    if (card.kind === 'main') { for (const key of counters) usage[key] = 0; usage.inputEntryId = null }
    item.parked = true
  }
  const blockers = await tx.doc(TaskBlockers, card.taskId)
  blockers.activeId = null
  const slot = await tx.doc(ChatInput, card.taskId)
  slot.entryId = null
  await admitNextInput(tx, card.taskId, slot, { TaskCard, ChatQueue })
}

export async function restoreQuestionInput(tx, card, entryId) {
  const blockers = await tx.doc(TaskBlockers, card.taskId)
  const item = blockers.items.find(item => item.inReplyTo === entryId && item.resumeQueued && item.resumeState)
  if (!item) return false
  const state = item.resumeState
  card.parameters = copy(state.parameters); card.taskState = copy(state.taskState); card.taskStateSources = copy(state.taskStateSources)
  const compacted = await tx.doc(ContextCompaction, card.taskId)
  if (state.compaction) { compacted.latest = copy(state.compaction.latest); compacted.coveredKeys = copy(state.compaction.coveredKeys) }
  const skills = await tx.doc(TaskSkills, card.taskId)
  skills.active = copy(state.activeSkills); skills.lastFailure = copy(state.lastFailure)
  if (state.usage) {
    const usage = await tx.doc(CallUsage, card.taskId)
    usage.lifetime ??= Object.fromEntries(counters.map(key => [key, 0]))
    for (const key of counters) usage.lifetime[key] += usage[key] ?? 0
    Object.assign(usage, copy(state.usage))
  }
  item.parked = false; item.resumeQueued = false
  delete item.resumeState
  return true
}

export async function enqueueQuestionInput(tx, card, item, { ChatInput, ChatQueue, TaskCard, admitNextInput }) {
  if (!item.parked || item.resumeQueued) return
  const queue = await tx.doc(ChatQueue, card.taskId)
  // Resumptions precede normal FIFO messages, but retain their own arrival order.
  const blockers = await tx.doc(TaskBlockers, card.taskId)
  const resumeIds = new Set(blockers.items.filter(row => row.resumeQueued).map(row => row.inReplyTo))
  let index = 0
  while (index < queue.entryIds.length && resumeIds.has(queue.entryIds[index])) index++
  queue.entryIds.splice(index, 0, item.inReplyTo)
  item.resumeQueued = true
  await admitNextInput(tx, card.taskId, await tx.doc(ChatInput, card.taskId), { TaskCard, ChatQueue })
}
