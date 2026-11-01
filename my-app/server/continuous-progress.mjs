// Inputs must be host-validated semantic evidence fingerprints / verified criteria / resolved
// dependencies. A new reply, entry id, plan title or the model's progress claim is not evidence.
export const CONTINUOUS_STALL_POLICY = Object.freeze({ evaluationsBeforeReplan: 3, maxUnproductiveReplans: 2 })

function signalSet(input) {
  if (!Array.isArray(input) || input.some(key => typeof key !== 'string' || !key || key.length > 200)) throw new TypeError('Progress signals must be bounded host keys')
  return [...new Set(input)]
}

/** Mutate only inside the same transaction that records the evaluated stage and decision. */
export function recordContinuousProgress(progress, { evaluationId, goalRevision, evidenceKeys = [], verifiedCriteria = [], resolvedDependencies = [], waiting = false }, policy = CONTINUOUS_STALL_POLICY) {
  if (!Number.isSafeInteger(evaluationId) || evaluationId < 1 || !Number.isSafeInteger(goalRevision) || goalRevision < 1) throw new TypeError('A durable evaluation identity and goal revision are required')
  if (!Number.isInteger(policy.evaluationsBeforeReplan) || policy.evaluationsBeforeReplan < 1 || !Number.isInteger(policy.maxUnproductiveReplans) || policy.maxUnproductiveReplans < 1) throw new TypeError('Invalid stall policy')
  const prior = progress.stall ?? {}
  if (prior.lastEvaluationId >= evaluationId) return { action: 'unchanged', replayed: true }
  if (waiting) return { action: 'waiting', replayed: false }
  const observed = { evidence: signalSet(evidenceKeys), criteria: signalSet(verifiedCriteria), resolved: signalSet(resolvedDependencies) }
  // Old criteria do not satisfy a revised goal. Evidence fingerprints remain known so repeatedly
  // relabelling the same artifact cannot count as new work after a plan or goal revision.
  const sameGoal = prior.goalRevision === goalRevision
  const known = { evidence: prior.known?.evidence ?? [], criteria: sameGoal ? prior.known?.criteria ?? [] : [], resolved: sameGoal ? prior.known?.resolved ?? [] : [] }
  const hasProgress = Object.keys(observed).some(kind => observed[kind].some(key => !known[kind].includes(key)))
  const merged = Object.fromEntries(Object.keys(observed).map(kind => [kind, [...new Set([...known[kind], ...observed[kind]])]]))
  const state = { ...prior, goalRevision, lastEvaluationId: evaluationId, known: merged,
    evaluated: hasProgress ? 0 : (prior.evaluated ?? 0) + 1, replans: hasProgress ? 0 : prior.replans ?? 0 }
  let action = hasProgress ? 'progress' : 'continue'
  if (!hasProgress && state.evaluated >= policy.evaluationsBeforeReplan) {
    if (state.replans >= policy.maxUnproductiveReplans) action = 'blocked'
    else { state.replans += 1; state.evaluated = 0; action = 'replan' }
  }
  state.lastAction = action
  progress.stall = state
  return { action, replayed: false, reason: action === 'blocked' ? '连续重规划后仍没有可核实的新成果或已解决缺口。' : action === 'replan' ? '连续评估没有实质进展，需要调整下一步而非重复原方案。' : null }
}
