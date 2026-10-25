// Main-session intrinsic tools (PLAN §8.1). Pure definitions, no imports: tools.mjs and
// main-session.mjs both depend on this file without an import cycle.
export const TASK_CREATE_TOOL = 'task_create'
export const TASK_STATUS_TOOL = 'task_status'
export const ROUTINE_PROPOSE_TOOL = 'routine_propose'
export const MAIN_TOOLS = [TASK_CREATE_TOOL, TASK_STATUS_TOOL, ROUTINE_PROPOSE_TOOL]
// PLAN §8.5: proposed routines use the Bot's own sources and fixed per-run limits (P-20: own Bot only).
export const ROUTINE_TIMEZONE = 'Asia/Shanghai'
export const ROUTINE_CALL_LIMITS = Object.freeze({ modelCalls: 10, toolCalls: 20, totalTokens: 50000 })
// D-05: the main session carries only the policy "R0 read-only" row; collaboration tools that
// park the session (task_assign, report_blocker, shared_publish …) are excluded.
export const MAIN_READ_TOOLS = ['calendar_read_schedule', 'calendar_read_event', 'calendar_feishu_read_schedule', 'calendar_feishu_read_event', 'calendar_feishu_freebusy',
  'tool_result_read', 'task_history_read', 'skill_activate', 'skill_deactivate', 'skill_read_resource', 'workspace.list', 'workspace.get', 'workspace.operation_status',
  'collaborators_list', 'shared_read']
export const MAIN_CHIEF_TOOLS = ['bot_inspect', 'bot_manage']
// PLAN §8.7 "帮我想办法" (P-16): limits per click; the read tools Chief may be given for it (D-19).
export const FINDING_ASSIST_LIMITS = Object.freeze({ modelCalls: 5, toolCalls: 10 })
export const ASSIST_READ_TOOLS = ['workspace.list', 'workspace.get']
export const MAIN_TASK_LIMIT = 5 // P-07: running derived Tasks per Bot
// The main session's fixed tool list is the allowed subset of the Bot's assignment (I-09).
export const mainSessionTools = (botId, tools) => tools.filter(t => MAIN_READ_TOOLS.includes(t) || t === 'automation_pause' || botId === 'chief' && MAIN_CHIEF_TOOLS.includes(t))

export const mainTools = [
  { name: TASK_CREATE_TOOL, description: '把较长执行或要等待的工作派给本Bot的一个独立任务（执行者就是自己）。立即返回taskId，不等待结果；进度用task_status查，结束后会在下一轮出现概述。operationId在同一用户输入内唯一标识这次派活，重复调用返回原回执。目标与完成标准要写清楚；执行者固定是自己，不能指定其他Bot（要交给别的Bot时，在目标里写明，由派出的任务用task_assign交出去）。',
    parameters: { type: 'object', additionalProperties: false, required: ['operationId', 'goal', 'completionCriteria'], properties: {
      operationId: { type: 'string', pattern: '^[a-zA-Z0-9_.:-]+$', maxLength: 80 },
      goal: { type: 'string', minLength: 1, maxLength: 4000 },
      completionCriteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } } } } },
  { name: TASK_STATUS_TOOL, description: '只读查看本主会话派出的任务：状态、待审批数、待补充数、结束时的结果摘要。不传taskId返回全部。',
    parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'integer', minimum: 1 } } } },
  { name: ROUTINE_PROPOSE_TOOL, description: '为本Bot自己提议一个例行任务（定时或事件触发），默认直接创建；规则或全局暂停可能要求确认，遇到确认时以最终回执为准。rule：{type:"daily",time:"HH:mm"} 每天；{type:"interval",seconds:≥60,anchor:带偏移的ISO时间} 间隔；{type:"at",at:带偏移的ISO时间} 一次；{type:"event",event:"todo_due"|"event_changed"|"task_finished"} 待办到期/日程变更/本Bot任务结束。时区固定 Asia/Shanghai。运行时按Bot当时的权限和规则：写入默认直接执行，删除默认先问；无人值守遇到先问会跳过并记录。',
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'prompt', 'rule', 'sourceIds', 'notification'], properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      prompt: { type: 'string', minLength: 1, maxLength: 3000, description: '每次运行要做的事' },
      rule: { type: 'object' },
      sourceIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^[a-zA-Z0-9_.:-]+$', maxLength: 120 } },
      notification: { enum: ['inbox', 'none'], description: 'inbox=结果进收件箱' } } } },
]
export function validMainArgs(call) {
  const a = call.arguments
  if (call.argumentsError || !a || typeof a !== 'object' || Array.isArray(a)) return false
  if (call.name === ROUTINE_PROPOSE_TOOL) {
    const keys = ['title', 'prompt', 'rule', 'sourceIds', 'notification']
    return Object.keys(a).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(a, k)) &&
      typeof a.title === 'string' && a.title.trim().length > 0 && a.title.length <= 200 && typeof a.prompt === 'string' && a.prompt.trim().length > 0 && a.prompt.length <= 3000 &&
      a.rule !== null && typeof a.rule === 'object' && !Array.isArray(a.rule) && ['inbox', 'none'].includes(a.notification) &&
      Array.isArray(a.sourceIds) && a.sourceIds.length >= 1 && a.sourceIds.length <= 8 && new Set(a.sourceIds).size === a.sourceIds.length && a.sourceIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(id))
  }
  if (call.name === TASK_STATUS_TOOL) return Object.keys(a).every(k => k === 'taskId') && (a.taskId === undefined || Number.isSafeInteger(a.taskId) && a.taskId > 0)
  if (call.name !== TASK_CREATE_TOOL || Object.keys(a).some(k => !['operationId', 'goal', 'completionCriteria'].includes(k))) return false
  return typeof a.operationId === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(a.operationId) &&
    typeof a.goal === 'string' && a.goal.trim().length > 0 && a.goal.length <= 4000 &&
    Array.isArray(a.completionCriteria) && a.completionCriteria.length >= 1 && a.completionCriteria.length <= 20 &&
    a.completionCriteria.every(c => typeof c === 'string' && c.trim().length > 0 && c.length <= 1000)
}
