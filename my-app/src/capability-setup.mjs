// Pure safe receipt projection and authenticated setup client; no UI state or persistent storage.
export const CAPABILITY_SETUP_STATES = { pending: '配置待处理', needs_auth: '等待安全输入凭据', needs_confirmation: '等待对应操作确认', missing_dependency: '依赖尚未满足',
  ready: '已启用并通过校验', disabled: '这个机器人的能力已停用', unbound: '已取消关联', removed: '已移除连接', error: '配置未完成', unknown: '结果未知，需核查原操作' }
export const CAPABILITY_SETUP_ACTIONS = { inspect: '检查', add: '接入', update: '更新', disable: '停用', unbind: '解绑', remove: '移除', rollback: '回退', resume: '续办' }
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const bounded = (value, max = 4000) => typeof value === 'string' && value.length <= max
const id = (value) => bounded(value, 200) && value.length > 0

/** Accept safe host metadata only. A provider's content/text is never a management receipt. */
export function capabilitySetupReceipt(value, taskId) {
  if (!object(value) || !id(value.setupId) || !id(value.requestId) || !id(value.operationId) || value.taskId !== taskId || !Number.isSafeInteger(value.inputId) || Number(value.inputId) <= 0 ||
    !['mcp', 'skill'].includes(String(value.kind)) || !Object.hasOwn(CAPABILITY_SETUP_STATES, String(value.state)) || !Object.hasOwn(CAPABILITY_SETUP_ACTIONS, String(value.action)) ||
    !id(value.targetBotId) || !bounded(value.name, 200) || !bounded(value.description) || !object(value.verification) || !bounded(value.verification.status, 100) || !bounded(value.verification.summary)) return null
  const missing = Array.isArray(value.missing) ? value.missing.filter((item) => object(item) && bounded(item.kind, 100) && bounded(item.id, 200) && bounded(item.message)).slice(0, 128).map(item => ({ kind: item.kind, id: item.id, message: item.message })) : []
  const connectionId = id(value.connectionId) ? value.connectionId : null
  return {
    setupId: value.setupId, requestId: value.requestId, operationId: value.operationId, kind: value.kind, action: String(value.action),
    taskId, inputId: Number(value.inputId), targetBotId: value.targetBotId, name: value.name, description: value.description, state: value.state,
    capabilityId: id(value.capabilityId) ? value.capabilityId : null, enabledForBot: value.enabledForBot === true, connectionId,
    verification: { status: value.verification.status, summary: value.verification.summary, checkedAt: bounded(value.verification.checkedAt, 100) ? value.verification.checkedAt : null },
    missing, affectedBotIds: Array.isArray(value.affectedBotIds) ? value.affectedBotIds.filter((value) => id(value)).slice(0, 64) : [],
    approvalId: id(value.approvalId) ? value.approvalId : Number.isSafeInteger(value.approvalId) && Number(value.approvalId) > 0 ? String(value.approvalId) : null,
    credentialEntry: object(value.credentialEntry) && value.credentialEntry.kind === 'mcp-credential' && connectionId !== null && value.credentialEntry.connectionId === connectionId ? { kind: 'mcp-credential', connectionId } : null,
    canResume: value.canResume === true, replayed: value.replayed === true,
    error: object(value.error) && bounded(value.error.code, 200) && bounded(value.error.message) ? { code: value.error.code, message: value.error.message } : null,
  }
}
export function capabilitySetupEntries(messages, taskId, projected = []) {
  const entries = new Map(), projections = new Map()
  for (const value of projected) { const receipt = capabilitySetupReceipt(value, taskId); if (receipt) projections.set(receipt.setupId, receipt) }
  const inputs = new Set(messages.filter(message => message.role === 'user').map(message => message.id))
  for (const message of messages) {
    if (message.role !== 'tool' || !['mcp_manage', 'skill_manage'].includes(message.toolName ?? '') || typeof message.result?.ok !== 'boolean') continue
    const receipt = capabilitySetupReceipt(message.result.data, taskId)
    const resumed = message.arguments?.action === 'resume' && message.arguments.operationId === receipt?.operationId
    if (!receipt || !inputs.has(receipt.inputId) || !inputs.has(message.inReplyTo ?? -1) || receipt.inputId !== message.inReplyTo && !resumed) continue
    const projection = projections.get(receipt.setupId)
    const sameOrigin = projection && projection.requestId === receipt.requestId && projection.operationId === receipt.operationId && projection.targetBotId === receipt.targetBotId && projection.kind === receipt.kind && projection.action === receipt.action
    entries.set(receipt.setupId, { receipt: sameOrigin ? projection : receipt, messageId: message.id })
  }
  for (const [setupId, receipt] of projections) if (!entries.has(setupId)) entries.set(setupId, { receipt, messageId: null })
  return entries
}
/** Separate genuine read-only/approval manager results from setup mutation receipts. */
export function capabilityManagerNotice(message, taskId, messages, approvals = []) {
  if (message.role !== 'tool' || !['mcp_manage', 'skill_manage'].includes(message.toolName) || message.result?.ok !== true || !object(message.arguments) ||
    !messages.some(item => item.role === 'user' && item.id === message.inReplyTo) || !object(message.result.data)) return null
  const value = message.result.data, args = message.arguments, kind = message.toolName === 'mcp_manage' ? 'mcp' : 'skill'
  if (value.action === 'inspect' && args.action === 'inspect' && value.kind === kind && id(value.targetBotId) && value.targetBotId === args.targetBotId && id(value.targetRevision) && Array.isArray(value.capabilities)) {
    return { kind: 'inspect', managerKind: kind, targetBotId: value.targetBotId, targetRevision: value.targetRevision, capabilityCount: value.capabilities.length }
  }
  if (value.status !== 'waiting-for-user-approval' || value.taskId !== taskId || !['string', 'number'].includes(typeof value.approvalId)) return null
  const approval = approvals.find(item => String(item.id) === String(value.approvalId) && item.taskId === taskId && item.toolName === message.toolName && item.inReplyTo === message.inReplyTo)
  if (!approval || !object(approval.capabilityIntent) || approval.capabilityIntent.kind !== kind || !object(approval.capabilityIntent.proposal) ||
    approval.capabilityIntent.proposal.operationId !== args.operationId || approval.capabilityIntent.proposal.targetBotId !== args.targetBotId || approval.capabilityIntent.proposal.action !== args.action ||
    (message.callId && approval.callId ? message.callId !== approval.callId : JSON.stringify(approval.arguments) !== JSON.stringify(args))) return null
  const decision = object(approval.decision) && ['approved', 'rejected', 'inserted'].includes(approval.decision.decision) ? approval.decision.decision : 'pending'
  return { kind: 'approval', managerKind: kind, approvalId: String(approval.id), targetBotId: String(args.targetBotId), state: decision }
}
export function sameCapabilitySetup(next, original) {
  return next.setupId === original.setupId && next.taskId === original.taskId && next.requestId === original.requestId && next.operationId === original.operationId && next.targetBotId === original.targetBotId && next.kind === original.kind && next.action === original.action
}
export function createCapabilitySetupClient({ token, fetchImpl = fetch }) {
  async function request(original, resume, signal) {
    const path = `/api/capability-setups/${encodeURIComponent(original.setupId)}`
    const response = await fetchImpl(resume ? `${path}/resume` : `${path}?taskId=${original.taskId}`, { method: resume ? 'POST' : 'GET', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(resume ? { body: JSON.stringify({ taskId: original.taskId, inputId: original.inputId }) } : {}) })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error('原没确认配置成功，点「核查原配置」。')
    const current = capabilitySetupReceipt(body?.data, original.taskId)
    if (!current || !sameCapabilitySetup(current, original)) throw new Error('配置结果没有对应上，点「核查原配置」。')
    return current
  }
  return { get: (receipt, signal) => request(receipt, false, signal), resume: (receipt, signal) => request(receipt, true, signal) }
}
