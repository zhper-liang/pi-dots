import { defineDoc } from '@earendil-works/pi-durable'
import { randomUUID } from 'node:crypto'
import { TaskInputError } from './task-config.mjs'

// The only policy decision is whether an assigned write tool runs, asks, or is denied.
// Tool assignment and source authorization are checked before this function is called.
export const PolicyRules = defineDoc({ kind: 'pidot.policy-rules', version: 1, scope: 'session', initial: () => ({ items: [] }) })
export const AutomationPause = defineDoc({ kind: 'pidot.automation-pause', version: 1, scope: 'session', initial: () => ({ paused: false, since: null, by: null, epoch: 0 }) })
export const ATTENDED_LOCAL_EXPIRY_MS = 300000
export const AUTOMATION_PAUSE_TOOL = 'automation_pause'
export const automationPauseTool = Object.freeze({ name: AUTOMATION_PAUSE_TOOL,
  description: '暂停全部自动化（例行任务、事件触发与自动执行都改为询问或停止）。只能暂停，不能恢复；恢复只能由用户在设置页操作。用户明确要求停下自动化时使用。',
  parameters: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 200 } } } })
export const validAutomationPauseArgs = call => !call.argumentsError && call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) &&
  Object.keys(call.arguments).every(k => k === 'reason') && (call.arguments.reason === undefined || typeof call.arguments.reason === 'string' && call.arguments.reason.length <= 200)

const READ_AND_INTERNAL = new Set(['calendar_read_schedule', 'calendar_read_event', 'calendar_feishu_read_schedule', 'calendar_feishu_read_event', 'calendar_feishu_freebusy',
  'tool_result_read', 'task_history_read', 'skill_activate', 'skill_deactivate', 'skill_read_resource', 'workspace.list', 'workspace.get', 'workspace.operation_status',
  'collaborators_list', 'bot_inspect', 'shared_read', 'task_status', AUTOMATION_PAUSE_TOOL,
  'report_blocker', 'blocker_resolve', 'blocker_escalate', 'task_assign', 'task_review', 'shared_publish', 'shared_link', 'task_create'])
const WRITE_TOOLS = new Set(['calendar_feishu_create_event', 'calendar_feishu_update_event', 'calendar_feishu_delete_event', 'calendar_reschedule_event',
  'workspace.prepare_schedule', 'routine_propose', 'workspace.prepare_change', 'bot_manage'])
export const REGISTERED_TOOLS = Object.freeze([...READ_AND_INTERNAL, ...WRITE_TOOLS])
export const unattended = origin => ['routine', 'detector', 'event'].includes(origin)

const matches = (m, c) => (m.tool === undefined || m.tool === c.tool) && (m.action === undefined || m.action === c.action) &&
  (m.sourceId === undefined || m.sourceId === c.sourceId) && (m.type === undefined || m.type === c.type)
const specificity = m => ['tool', 'action', 'sourceId', 'type'].filter(key => m[key] !== undefined).length
const strength = { deny: 3, ask: 2, allow: 1 }
export function pickRule(rules, call) {
  let best = null
  for (const rule of rules) {
    if (rule.origin === 'preset' || !rule.match || Object.hasOwn(rule.match, 'risk') || rule.botId !== call.botId || !matches(rule.match, call)) continue
    if (!best || specificity(rule.match) > specificity(best.match) || specificity(rule.match) === specificity(best.match) && strength[rule.effect] > strength[best.effect]) best = rule
  }
  return best
}

export async function decide(tx, call) {
  const action = call.action ?? call.args?.action
  const verdict = (effect, reason, allowAlways = false) => ({ effect, reason, allowAlways,
    ...(effect === 'ask' ? { expiresInMs: ATTENDED_LOCAL_EXPIRY_MS } : {}) })
  if (READ_AND_INTERNAL.has(call.tool)) return verdict('allow', 'read-or-internal')
  if (!WRITE_TOOLS.has(call.tool) || call.tool === 'bot_manage' && !['create', 'configure', 'deactivate'].includes(action) ||
    call.tool === 'workspace.prepare_change' && !['create', 'update', 'delete'].includes(action)) return verdict('deny', 'unregistered')
  const rule = pickRule((await tx.doc(PolicyRules)).items, { ...call, action })
  const deletion = call.tool === 'calendar_feishu_delete_event' || call.tool === 'workspace.prepare_change' && action === 'delete' || call.tool === 'bot_manage' && action === 'deactivate'
  let effect = rule?.effect ?? (deletion ? 'ask' : 'allow')
  let reason = rule ? rule.origin + '-rule' : deletion ? 'delete-default' : 'write-default'
  const paused = (await tx.doc(AutomationPause)).paused
  if (effect === 'allow' && paused) { effect = 'ask'; reason = 'automation-paused' }
  return verdict(effect, reason, effect === 'ask' && !paused)
}

const policyError = (status, code, message) => new TaskInputError(status, code, message)
export function validateRule(input) {
  const m = input?.match
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some(k => !['tool', 'action', 'sourceId', 'type'].includes(k)) ||
    typeof m.tool !== 'string' || !WRITE_TOOLS.has(m.tool) || ['action', 'sourceId', 'type'].some(k => m[k] !== undefined && (typeof m[k] !== 'string' || !m[k])) ||
    !['allow', 'ask', 'deny'].includes(input.effect)) throw policyError(400, 'POLICY_RULE_INVALID', '规则须匹配已登记写工具，可选动作、来源和类型；效果为 allow/ask/deny。')
}
export async function addRule(tx, { botId, match, effect, origin = 'user' }) {
  validateRule({ match, effect })
  const doc = await tx.doc(PolicyRules)
  doc.items = doc.items.filter(r => r.origin !== 'preset' && !(r.botId === botId && r.origin === origin && JSON.stringify(r.match) === JSON.stringify(match)))
  const rule = { id: randomUUID(), botId, match: { ...match }, effect, origin, createdAt: new Date().toISOString() }
  doc.items.push(rule)
  return rule
}
export async function removeRules(tx, predicate) {
  const doc = await tx.doc(PolicyRules)
  doc.items = doc.items.filter(r => r.origin !== 'preset' && !predicate(r))
}
export async function listRules(tx, botId) {
  return JSON.parse(JSON.stringify((await tx.doc(PolicyRules)).items.filter(r => r.origin !== 'preset' && !Object.hasOwn(r.match ?? {}, 'risk') && (botId === undefined || r.botId === botId))))
}
export const localMatch = (tool, action) => ({ tool, action, sourceId: 'local' })

export async function automationStatus(tx) { return JSON.parse(JSON.stringify(await tx.doc(AutomationPause))) }
export async function setAutomationPause(tx, { paused, by }) {
  const doc = await tx.doc(AutomationPause)
  if (doc.paused === paused) return JSON.parse(JSON.stringify(doc))
  Object.assign(doc, { paused, since: paused ? new Date().toISOString() : null, by: paused ? by : null, epoch: doc.epoch + 1 })
  return JSON.parse(JSON.stringify(doc))
}
export async function automationPaused(tx) { return (await tx.doc(AutomationPause)).paused === true }
