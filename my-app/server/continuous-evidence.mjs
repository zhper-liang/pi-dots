import { createHash } from 'node:crypto'
import { readTaskHistory } from './history-tool.mjs'
import { ToolResults, readToolResult } from './tool-results.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value > 0
const denied = () => ({ ok: false, error: { code: 'CONTINUOUS_EVIDENCE_UNAVAILABLE', message: '证据不存在、修订不匹配、覆盖不足或当前不可访问。' } })
const excluded = new Set(['task_assign', 'task_review', 'task_create', 'report_blocker', 'blocker_resolve', 'blocker_escalate',
  'skill_activate', 'skill_deactivate', 'skill_read_resource', 'memory_edit', 'memory_review', 'automation_pause',
  'shared_publish', 'shared_link', 'shared_read', 'task_history_read', 'session_search', 'session_history_read',
  'work_plan', 'work_submit', 'work_complete'])
const incomplete = new Set(['unknown', 'skipped', 'prepared', 'draft', 'pending', 'waiting', 'waiting-for-user-approval',
  'needs_confirmation', 'awaiting_confirmation', 'cancelled', 'failed', 'rejected', 'limited'])
const volatile = new Set(['requestId', 'operationId', 'attemptId', 'traceId', 'callId', 'entryId', 'stepId', 'createdAt', 'updatedAt',
  'fetchedAt', 'retrievedAt', 'readAt', 'timestamp', 'durationMs', 'latencyMs', 'execution', 'replayed', 'replay'])
const stable = value => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value)
  .filter(key => !volatile.has(key)).sort().map(key => [key, stable(value[key])])) : value
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

/** Conservative progress signal. Process exits, edit byte counts and new receipt IDs are not progress. */
export function continuousEvidenceFingerprint(toolName, args, result) {
  if (!successfulContinuousResult(result)) return null
  if (toolName === 'write') return typeof args?.content === 'string' ? `artifact:${digest(args.content)}` : null
  if (toolName === 'read') return typeof result.data?.content === 'string' ? `artifact:${digest(result.data.content)}` : null
  if (['bash', 'edit'].includes(toolName) || excluded.has(toolName)) return null
  // Unknown providers need a contract-specific semantic projection. Hashing an arbitrary
  // payload could mistake a fresh request/operation ID or server clock for actual progress.
  if (!['calendar_read_schedule', 'calendar_read_event', 'calendar_reschedule_event'].includes(toolName)) return null
  const data = stable(result.data)
  if (data === undefined || data === null || object(data) && !Object.keys(data).length) return null
  if (Array.isArray(data.events)) data.events.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return `source:${digest(data)}`
}

export function validContinuousEvidenceRef(ref) {
  if (!object(ref)) return false
  if (ref.kind === 'child-result') return Object.keys(ref).every(key => ['kind', 'relationId', 'revision'].includes(key)) &&
    typeof ref.relationId === 'string' && ref.relationId.length > 0 && ref.relationId.length <= 180 && integer(ref.revision)
  return Object.keys(ref).every(key => ['taskId', 'entryId'].includes(key)) && integer(ref.taskId) && integer(ref.entryId)
}

export function sameContinuousBinding(actual, expected, { submission = false } = {}) {
  return object(actual) && object(expected) && ['rootTaskId', 'rootInputId', 'goalRevision', 'planRevision', 'stepId',
    ...(submission ? ['submissionRevision'] : [])].every(key => actual[key] === expected[key])
}

/** ok is a transport result. Pending intentions and uncertain operations are not success evidence. */
export function successfulContinuousResult(result) {
  if (!object(result) || result.ok !== true || result.error) return false
  const data = result.data
  if (!object(data)) return true
  if (data.approvalId && !data.readbackVerified || data.unknown === true || data.complete === false || data.bounded === true ||
    incomplete.has(data.state) || incomplete.has(data.status) || incomplete.has(data.outcome) || data.executed === false) return false
  if (object(data.operation) && (!['completed', 'succeeded', 'success'].includes(data.operation.status) ||
    data.operation.outcome === 'unknown' || data.operation.result?.ok === false)) return false
  if (data.provider === 'feishu' && data.simulated === false && data.operationId && data.readbackVerified !== true) return false
  return true
}

export async function continuousEvidenceAccess(tx, card, inputId, { bots } = {}) {
  const { ToolAccess, toolSets } = await import('./tools.mjs')
  const { BotDirectory } = await import('./bot-directory.mjs')
  const { workspaceHistoryAllowed } = await import('./workspace-grants.mjs')
  const sets = toolSets(card, bots ?? (await tx.doc(BotDirectory)).items, await tx.doc(ToolAccess))
  if (!await workspaceHistoryAllowed(tx, card, sets)) return null
  const history = await readTaskHistory(tx, card, {}, inputId, sets, { collect: true })
  return { sets, ...history }
}

function fullCoverage(entries, sourceAllowed, resultRef, length) {
  const pages = entries.filter(entry => entry.kind === 'pidot.tool-result' && entry.data.toolName === 'tool_result_read' &&
    entry.data.arguments?.resultRef === resultRef && sourceAllowed(entry) && entry.data.result?.ok === true &&
    entry.data.result.data?.coverage?.kind === 'raw-text').map(entry => entry.data.result.data.coverage)
    .filter(page => Number.isSafeInteger(page.offset) && Number.isSafeInteger(page.end) && page.end > page.offset &&
      page.offset >= 0 && page.end <= length && page.totalCharacters === length).sort((a, b) => a.offset - b.offset)
  let end = 0
  for (const page of pages) { if (page.offset > end) break; end = Math.max(end, page.end) }
  return end === length
}

export function continuousArtifactVersion(source, visible, sourceAllowed, expected, { inputId = expected.rootInputId } = {}) {
  const mutations = visible.filter(entry => entry.kind === 'pidot.tool-result' && entry.data.inReplyTo === inputId &&
    ['bash', 'write', 'edit'].includes(entry.data.toolName))
  const floor = Math.max(source.id - 1, ...mutations.map(entry => entry.id))
  const pages = visible.filter(entry => entry.id > floor && entry.kind === 'pidot.tool-result' && entry.data.toolName === 'read' &&
    entry.data.arguments?.path === source.data.arguments?.path && entry.data.inReplyTo === inputId &&
    entry.data.continuousBinding?.rootTaskId === expected.rootTaskId && entry.data.continuousBinding?.goalRevision === expected.goalRevision &&
    entry.data.result?.ok === true && sourceAllowed(entry)).sort((a, b) => b.id - a.id)
  const last = pages[0]?.data.result.data
  if (!last || !Number.isSafeInteger(last.totalCharacters) || last.totalCharacters < 0 ||
    typeof last.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(last.sha256)) return null
  const selected = pages.filter(entry => entry.data.result.data?.sha256 === last.sha256 && entry.data.result.data.totalCharacters === last.totalCharacters)
    .sort((a, b) => a.data.result.data.offset - b.data.result.data.offset || a.id - b.id)
  const content = [], entryIds = []
  let end = 0
  for (const entry of selected) {
    const data = entry.data.result.data, chars = Array.from(data.content ?? '')
    if (!Number.isSafeInteger(data.offset) || data.offset < 0 || data.offset > end || data.offset + chars.length > last.totalCharacters) continue
    if (data.offset < end && chars.slice(0, Math.min(end - data.offset, chars.length)).join('') !== content.slice(data.offset, data.offset + chars.length).join('')) return null
    content.push(...chars.slice(end - data.offset)); end = content.length; entryIds.push(entry.id)
  }
  if (end !== last.totalCharacters || digest(content.join('')) !== last.sha256 ||
    source.data.toolName === 'write' && digest(source.data.arguments.content ?? '') !== last.sha256 ||
    source.data.toolName === 'read' && source.data.result.data?.sha256 && source.data.result.data.sha256 !== last.sha256) return null
  return { sha256: last.sha256, readEntryIds: [...new Set(entryIds)], coverage: 'full-file-read',
    currentness: 'host-read-version; external-changes-not-monitored' }
}

/** Dereference only host records. A caller cannot supply result bodies, status, hashes or authority. */
export async function resolveContinuousEvidence(tx, card, ref, expected, services = {}) {
  if (!validContinuousEvidenceRef(ref) || !expected || expected.rootTaskId !== card.executionPolicy?.rootTaskId ||
    expected.rootInputId !== card.executionPolicy?.rootInputId || expected.goalRevision !== card.taskState?.goalRevision) return denied()
  if (ref.kind === 'child-result') {
    // LR-06 supplies the exact relation/result/review resolver; absence never grants acceptance.
    if (!services.resolveChildEvidence) return denied()
    const result = await services.resolveChildEvidence(tx, card, copy(ref), copy(expected))
    return result?.ok && result.evidence?.kind === 'independent-review' &&
      sameContinuousBinding(result.evidence.binding, expected, { submission: true }) ? copy(result) : denied()
  }
  if (ref.taskId !== card.taskId) return denied()
  const access = services.access ?? await continuousEvidenceAccess(tx, card, expected.rootInputId, services)
  if (!access) return denied()
  const { visible, sourceAllowed, sets } = access
  const entry = visible.find(item => item.id === ref.entryId)
  if (!entry || entry.conversationId !== card.conversationId || entry.byTaskId !== card.taskId ||
    entry.kind !== 'pidot.tool-result' || entry.data.inReplyTo !== expected.rootInputId || !sourceAllowed(entry)) return denied()
  let source = entry, result = entry.data.result, artifact
  if (entry.data.toolName === 'tool_result_read') {
    source = visible.find(item => item.kind === 'pidot.tool-result' && item.data.result?.data?.resultRef === entry.data.arguments?.resultRef)
    if (!source || !sourceAllowed(source)) return denied()
    result = source.data.result
  }
  if (!sameContinuousBinding(source.data.continuousBinding, expected) || excluded.has(source.data.toolName) ||
    !sets.authorized.includes(source.data.toolName) || source.data.arguments?.resource && !sets.resources.includes(source.data.arguments.resource) ||
    source.data.arguments?.sourceId && !sets.resources.includes(`workspace:${source.data.arguments.sourceId}`)) return denied()
  if (result?.data?.bounded) {
    const resultRef = result.data.resultRef
    artifact = (await tx.doc(ToolResults, card.taskId)).artifacts[resultRef]
    if (!artifact || artifact.taskId !== card.taskId || artifact.conversationId !== card.conversationId ||
      artifact.source.callId !== source.data.callId || artifact.source.turnId !== source.data.turnId ||
      artifact.summary.sha256 !== createHash('sha256').update(artifact.raw).digest('hex')) return denied()
    const check = await readToolResult(tx, card, { resultRef, resource: artifact.summary.resource, view: 'text', limit: 1 }, sets)
    if (!check.ok || !fullCoverage(visible, sourceAllowed, resultRef, Array.from(artifact.raw).length)) return denied()
    try { result = JSON.parse(artifact.raw) } catch { return denied() }
  }
  if (!successfulContinuousResult(result)) return denied()
  const args = source.data.arguments ?? {}
  const version = ['read', 'write', 'edit'].includes(source.data.toolName) ? continuousArtifactVersion(source, visible, sourceAllowed, expected) : null
  const evidence = { kind: ['read', 'write', 'edit'].includes(source.data.toolName) ? 'artifact-record' : 'tool-receipt',
    ref: { taskId: card.taskId, entryId: source.id }, binding: copy(source.data.continuousBinding), toolName: source.data.toolName,
    basis: 'host-tool-receipt', quality: 'requires-review', fingerprint: continuousEvidenceFingerprint(source.data.toolName, args, result), scope: source.data.toolName === 'bash' ? 'process-exit' :
      ['write', 'edit'].includes(source.data.toolName) ? 'write-receipt' : source.data.toolName === 'read' ? 'file-read' : 'tool-contract',
    ...(artifact ? { resultRef: source.data.result.data.resultRef, sha256: artifact.summary.sha256, coverage: 'full-result-read' } : {}),
    ...(['read', 'write', 'edit'].includes(source.data.toolName) ? { path: args.path, artifactVersion: version,
      ...(source.data.toolName === 'write' ? { sha256: createHash('sha256').update(args.content ?? '').digest('hex') } : {}),
      ...(source.data.toolName === 'read' ? { coverage: { offset: result.data.offset, nextOffset: result.data.nextOffset,
        totalCharacters: result.data.totalCharacters }, ...(result.data.offset === 0 && result.data.nextOffset === null
          ? { sha256: createHash('sha256').update(result.data.content ?? '').digest('hex') } : {}) } : {}) } : {}) }
  return { ok: true, evidence }
}

export async function validateContinuousEvidence(tx, card, refs, expected, services = {}) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 40) return denied()
  const access = services.access ?? await continuousEvidenceAccess(tx, card, expected.rootInputId, services)
  if (!access) return denied()
  const evidence = [], keys = new Set()
  for (const ref of refs) {
    const resolved = await resolveContinuousEvidence(tx, card, ref, expected, { ...services, access })
    if (!resolved.ok) return denied()
    const key = JSON.stringify(resolved.evidence.ref ?? ref)
    if (!keys.has(key)) { keys.add(key); evidence.push(resolved.evidence) }
  }
  return { ok: true, evidence }
}
