import { assertGroupTask, assertGroupMessage } from './groups.mjs'
import { assertNotCancelled } from './cancellation.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError, currentTaskState, currentTaskStateSources } from './task-config.mjs'

// Persist intent independently of the sole admitted input. No second execution slot.
export const ChatSteering = defineDoc({
  kind: 'pidot.chat-steering', version: 1, scope: 'task', initial: () => ({ pending: [], applied: [] }),
})

export async function applySteering(tx, card, entryId) {
  const steering = await tx.doc(ChatSteering, card.taskId)
  const pending = steering.pending.filter((item) => item.targetInputId === entryId)
  for (const item of pending) {
    // Content is captured only after ownership validation at enqueue; no table
    // reads after a receipt write (Harness enforces read-before-write).
    const entry = { id: item.entryId, data: { content: item.content } }
    // Explicit user steering becomes an additive, verbatim task constraint. Never
    // parse natural language into permissions, budget changes, Skill or approvals.
    const state = currentTaskState(card)
    const constraints = [...new Set([...state.constraints, entry.data.content])]
    const appliedAt = new Date().toISOString()
    const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.steer-applied', data: {
      messageId: entry.id, inReplyTo: entryId, changes: { constraints }, source: 'user-steer', createdAt: appliedAt,
    } })
    card.taskState = { ...state, constraints }
    card.taskStateSources = { ...currentTaskStateSources(card), constraints: {
      type: 'user-steer', entryId: audit.id, messageId: entry.id, configRef: JSON.parse(JSON.stringify(card.configRef)),
    } }
    steering.applied.push({ ...JSON.parse(JSON.stringify(item)), appliedEntryId: audit.id, appliedAt })
  }
  steering.pending = steering.pending.filter((item) => item.targetInputId !== entryId)
  return pending.length
}

export function steeringApi({ harness, context, TaskCard, ChatInput, ChatQueue, taskKind }) {
  return {
    async steer(id, input) {
      const object = input && typeof input === 'object' && !Array.isArray(input)
      const keys = object ? Object.keys(input) : []
      const convert = keys.length === 1 && keys[0] === 'messageId' && Number.isSafeInteger(input.messageId) && input.messageId > 0
      const direct = keys.length === 1 && keys[0] === 'message' && typeof input.message === 'string' && input.message.trim() && input.message.length <= 4000
      if (!convert && !direct) throw new TaskInputError(400, 'INVALID_STEER', '仅提供 message（1–4000字符）或待排队消息的 messageId。')
      const result = await harness.commit(async (tx) => {
        const record = await tx.task(id)
        if (!record || record.kind !== taskKind) throw new TaskInputError(404, 'TASK_NOT_FOUND', '会话不存在。')
        await assertNotCancelled(tx, id, record)
        if ((await tx.doc(TaskCard, id)).scheduledWorkflow) throw new TaskInputError(409, 'WORKSPACE_WORKFLOW_INPUT_IMMUTABLE', '定时输入与提示版本已冻结，不能插入改变。')
        const {Collaboration}=await import('./collaboration.mjs')
        if((await tx.doc(Collaboration)).items.some(r=>r.childTaskId===id && r.reviewRequired)) throw new TaskInputError(409,'REVIEW_CHILD_INPUT_DENIED','受管子任务的返工仅接受绑定主管工具；信息回答和精确审批仍用原事项入口。')
        if (!['pending', 'running'].includes(record.state.status)) throw new TaskInputError(409, 'TASK_UNAVAILABLE', '当前 Task 无法插入。')
        if (record.state.checkpoint?.phase === 'awaitApproval') throw new TaskInputError(409, 'TASK_AWAITING_APPROVAL', '等待具体操作审批；插入不能代替审批。')
        if (record.state.checkpoint?.phase === 'awaitBlocker') throw new TaskInputError(409, 'TASK_BLOCKED', '请从对应待办问题回答；插入不能解除阻塞。')
        const slot = await tx.doc(ChatInput, id)
        const targetInputId = slot.entryId ?? (record.state.checkpoint?.lastOutcome === 'limited' ? record.state.checkpoint.lastInputId : null)
        if (!targetInputId) throw new TaskInputError(409, 'STEER_UNAVAILABLE', '当前没有执行中或受限等待的输入，请使用普通发送。')
        const card = await tx.doc(TaskCard, id)
        await assertGroupTask(tx, card)
        if (direct) assertGroupMessage(card, input.message)
        const queue = await tx.doc(ChatQueue, id)
        let entry
        if (convert) {
          const index = queue.entryIds.indexOf(input.messageId)
          entry = await tx.entry(input.messageId)
          if (index < 0 || entry?.kind !== 'pidot.user' || entry.conversationId !== card.conversationId) {
            throw new TaskInputError(409, 'MESSAGE_NOT_QUEUED', '消息已被接收、已转插入或不属于当前队列。')
          }
          // A message sent with a "/" Skill runs as its own input; inserting it would drop the Skill.
          if (entry.data.skillId) throw new TaskInputError(409, 'SKILL_COMMAND_NOT_STEERABLE', '这条消息指定了 Skill，只能按顺序单独处理，不能转为插入。')
          queue.entryIds.splice(index, 1)
        } else {
          entry = await tx.appendEntry(card.conversationId, { kind: 'pidot.user', data: {
            role: 'user', content: input.message, createdAt: new Date().toISOString(),
          } })
        }
        const steering = await tx.doc(ChatSteering, id)
        steering.pending.push({ entryId: entry.id, targetInputId, content: entry.data.content })
        return { taskId: id, conversationId: card.conversationId, messageId: entry.id, targetInputId, status: 'steer-pending' }
      }, context)
      // A limited Task stays waiting: only the existing explicit raiseLimits API resumes it.
      harness.resume()
      return result
    },
  }
}
