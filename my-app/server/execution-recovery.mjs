// Harness is the only scheduler/state machine. This is a read-only presentation
// of its durable checkpoint, not an independently persisted recovery state.
export function executionDisposition(record, slot, cancellation) {
  if (record.state.status === 'terminal' || cancellation) return 'ended'
  if (['waiting', 'completing'].includes(record.state.status)) return 'waiting'
  const checkpoint = record.state.checkpoint
  if (['awaitApproval', 'awaitBlocker'].includes(checkpoint?.phase) || (checkpoint?.lastOutcome === 'limited' && slot.entryId == null)) return 'waiting'
  if (checkpoint?.phase === 'awaitInput' && slot.entryId == null) return 'idle'
  return 'resumable'
}

// Snapshot the existing Documents, never a second queue or recovery state machine.
// Capture this in the recovery audit BEFORE resume can consume or apply anything.
export function messageControlSnapshot(slot, queue, steering, cancellation, checkpoint) {
  return {
    activeInputId: slot.entryId,
    waitingInputId: slot.entryId == null && checkpoint?.lastOutcome === 'limited' ? checkpoint.lastInputId : null,
    queuedInputIds: [...queue.entryIds],
    pendingSteers: steering.pending.map(({ entryId, targetInputId }) => ({ entryId, targetInputId })),
    appliedSteerIds: steering.applied.map(({ entryId }) => entryId),
    cancellationEntryId: cancellation?.entryId ?? null,
  }
}

// Pure projection of the original wait, including a saved response that has not
// reached the next checkpoint. Approval parameters/answers are data, not grants.
export function waitingSnapshot(checkpoint, slot, blockers, approvals, usage, limits, cancellation) {
  let kind, item = null
  if (checkpoint?.phase === 'awaitBlocker') {
    kind = 'blocker'; item = blockers.items.find((entry) => entry.id === checkpoint.blockerId) ?? null
  } else if (checkpoint?.phase === 'awaitApproval') {
    item = approvals.items.find((entry) => entry.id === checkpoint.approvalId) ?? null
    kind = item?.operation && !item.receipt ? 'action-outcome' : 'approval'
  } else if (checkpoint?.lastOutcome === 'limited') kind = 'limits'
  else return null
  const responseSaved = kind === 'limits' ? slot.entryId != null : kind === 'blocker' ? item?.status === 'resolved' : kind === 'action-outcome' ? Boolean(item?.operation?.resolution) : Boolean(item?.decision)
  return JSON.parse(JSON.stringify({ kind, inputId: checkpoint.entryId ?? checkpoint.lastInputId,
    status: cancellation ? 'cancelled' : kind === 'approval' && item?.decision?.decision === 'inserted' && !item.insertion ? 'insertion-pending' : responseSaved ? 'response-saved' : 'pending',
    reason: kind === 'action-outcome' ? 'action-outcome-unknown' : checkpoint.waitingReason ?? null, item, usage, limits }))
}
