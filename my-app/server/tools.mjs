import { workspaceTools, WORKSPACE_TOOLS, validWorkspaceArgs } from './workspace-tools.mjs'
import { FEISHU_MUTATION_TOOLS, feishuMutationTools, normalizeFeishuMutation } from './feishu-mutation.mjs'
import { FEISHU_CREATE_TOOL, feishuCreateTool, normalizeFeishuCreate } from './feishu-write.mjs'
import { feishuTools, FEISHU_TOOLS, validFeishuArgs, isFeishuResource } from './feishu-calendar.mjs'
import { REVIEW_TOOL, reviewTool, validReviewArgs } from './review-tools.mjs'
import { blockerActions, BLOCKER_ACTIONS, validBlockerAction } from './blocker-actions.mjs'
import { sharedTools, SHARED_TOOLS, validSharedArgs } from './shared-tools.mjs'
import { collaborationTools, COLLABORATION_TOOLS, validCollaborationArgs } from './collaboration-tools.mjs'
import { managementTools, MANAGEMENT_TOOLS, validManagementArgs } from './management-tools.mjs'
import { calendarWriteTool, CALENDAR_WRITE_TOOL, validCalendarWriteArgs } from './approvals.mjs'
import { blockerTool, BLOCKER_TOOL, validBlockerArgs } from './blockers.mjs'
import { historyTool, HISTORY_TOOL, validHistoryArgs } from './history-tool.mjs'
import { skillTools, validSkillArgs } from './skill-tools.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError } from './task-config.mjs'
import { RESULT_READ_TOOL, resultReadTool, validDate, validResultReadArgs } from './tool-results.mjs'
import { AUTOMATION_PAUSE_TOOL, automationPauseTool, validAutomationPauseArgs } from './policy.mjs'
import { mainTools, MAIN_TOOLS, MAIN_READ_TOOLS, validMainArgs } from './main-tools.mjs'

export const CALENDAR_TOOL = 'calendar_read_schedule'
export const CALENDAR_EVENT_TOOL = 'calendar_read_event'
export const DEFAULT_CALL_LIMITS = Object.freeze({ modelCalls: 20, toolCalls: 10 })
export const ToolAccess = defineDoc({ kind: 'pidot.tool-access', version: 1, scope: 'session', initial: () => ({ assignments: {}, revoked: {} }) })
export const CallUsage = defineDoc({ kind: 'pidot.call-usage', version: 1, scope: 'task',
  initial: () => ({ modelCalls: 0, toolCalls: 0, totalTokens: 0, unknownTokenCalls: 0 }) })

export const calendarTool = Object.freeze({
  name: CALENDAR_TOOL,
  description: '读取个人模拟日程（非真实日历）。提供 date=YYYY-MM-DD 或 month=YYYY-MM，两者互斥；资源固定 mock:personal。月结果过大时仅返回概要和 resultRef，须用 tool_result_read 按日期或事件读取再分析；概要不代表已读。日期不清先询问。',
  parameters: { type: 'object', additionalProperties: false, required: ['resource'], oneOf: [{ required: ['date'] }, { required: ['month'] }], properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '明确指定的日期，如 2026-10-16' },
    month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: '明确指定的月份，如 2026-10；不可同时提供 date' },
    resource: { type: 'string', enum: ['mock:personal'] },
  } },
  resultSchema: { type: 'object', additionalProperties: false, required: ['simulated', 'source', 'timezone', 'resource', 'events'], oneOf: [{ required: ['date'] }, { required: ['month'] }], properties: {
    simulated: { const: true }, source: { const: 'pidot.mock-calendar.v1' }, date: { type: 'string' }, month: { type: 'string' },
    timezone: { const: 'Asia/Shanghai' }, resource: { const: 'mock:personal' },
    events: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'start', 'end'],
      properties: { id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } } } },
  } },
})
export const calendarEventTool = Object.freeze({
  name: CALENDAR_EVENT_TOOL,
  description: '读取本次执行中 calendar_read_schedule 已返回的个人模拟日程事项详情（非真实日历）。必须提供本次执行中列表回执或 tool_result_read 已返回事件片段中的 eventId，概要中的未读事件不能直接读详情；资源固定 mock:personal。',
  parameters: { type: 'object', additionalProperties: false, required: ['eventId', 'resource'], properties: {
    eventId: { type: 'string', minLength: 1, maxLength: 100, description: 'calendar_read_schedule 成功回执 events[].id 中的标识' },
    resource: { type: 'string', enum: ['mock:personal'] },
  } },
  resultSchema: { type: 'object', additionalProperties: false, required: ['simulated', 'source', 'timezone', 'resource', 'event'], properties: {
    simulated: { const: true }, source: { const: 'pidot.mock-calendar.v1' }, timezone: { const: 'Asia/Shanghai' },
    resource: { const: 'mock:personal' }, event: { type: 'object', additionalProperties: false,
      required: ['id', 'title', 'start', 'end', 'location', 'description'], properties: {
        id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
        location: { type: 'string' }, description: { type: 'string' },
      } },
  } },
})
const installed = [...managementTools, calendarTool, calendarEventTool, resultReadTool, historyTool, ...skillTools, blockerTool, calendarWriteTool, ...collaborationTools, reviewTool, ...sharedTools, ...blockerActions, ...feishuTools, feishuCreateTool, ...feishuMutationTools, ...workspaceTools, automationPauseTool, ...mainTools]
const copy = (value) => JSON.parse(JSON.stringify(value))
export function toolSets(card, bots, access) {
  const bot = bots.find((item) => item.id === card.bot.id)
  const names = installed.map((tool) => tool.name).filter(name => (!MANAGEMENT_TOOLS.includes(name) || card.bot.id === 'chief' && card.managementTools?.includes(name)) && (!MAIN_TOOLS.includes(name) || card.kind === 'main'))
  const assigned = access.assignments?.[card.bot.id] ?? { tools: bot?.defaults.tools ?? [], resources: bot?.defaults.toolResources ?? [] }
  // S1: authorized = installed ∩ current assignment − revoked. No pool, no snapshot, no epoch.
  const authorized = names.filter((name) => assigned.tools.includes(name) && !access.revoked[card.bot.id]?.includes(name))
  if (card.bot.id === 'chief') for (const name of [...MANAGEMENT_TOOLS, BLOCKER_TOOL]) {
    if (card.managementTools?.includes(name) && !access.revoked.chief?.includes(name) && !authorized.includes(name)) authorized.push(name)
  }
  let resources = [...assigned.resources]
  // Routine runs keep to workspace tools (D-12). Only writes=true routines (never test runs or
  // legacy read-only briefs, D-13) may propose changes, and decide() still arbitrates each one.
  if (card.scheduledWorkflow) {
    const allowed = new Set(['workspace.list', 'workspace.get', ...(card.scheduledWorkflow.writes === true && !card.scheduledWorkflow.test ? ['workspace.prepare_change', 'workspace.operation_status'] : [])])
    authorized.splice(0, authorized.length, ...authorized.filter(n => allowed.has(n)))
    resources = resources.filter(r => (card.scheduledWorkflow.resources ?? card.parameters.toolResources ?? []).includes(r))
  }
  // PLAN §8.7 / D-20: a "帮我想办法" Task only reads (the R0 read-only row); it never writes or parks to ask.
  if (card.findingAssist) {
    authorized.splice(0, authorized.length, ...authorized.filter(n => MAIN_READ_TOOLS.includes(n)))
    resources = resources.filter(r => (card.findingAssist.resources ?? card.parameters.toolResources ?? []).includes(r))
  }
  // S1: main session gets all assigned tools (not just read-only). Main tools added unconditionally.
  if (card.kind === 'main') {
    authorized.splice(0, authorized.length, ...new Set([...authorized, ...MAIN_TOOLS, AUTOMATION_PAUSE_TOOL]))
  }
  return { installed: names, assigned: [...assigned.tools], authorized, displayed: [...authorized], resources }
}
export function toolDefinitions(names) {
  return installed.filter((tool) => names.includes(tool.name)).map(({ name, description, parameters }) => copy({ name, description, parameters }))
}
export function toolCatalog() { return copy(installed.filter(t => !MANAGEMENT_TOOLS.includes(t.name) && !MAIN_TOOLS.includes(t.name))) }
export function callLimits(parameters) {
  return { ...DEFAULT_CALL_LIMITS, ...(parameters.callLimits ?? {}) }
}
export class CallLimitError extends Error {
  constructor(kind) { super(`已达到本 Task 的 ${kind} 调用限制；停止新增调用。`); this.code = 'CALL_LIMIT_REACHED'; this.kind = kind }
}
export function checkModelLimit(usage, parameters) {
  const limits = callLimits(parameters)
  if (usage.modelCalls >= limits.modelCalls) throw new CallLimitError('modelCalls')
  if (limits.totalTokens !== undefined && (usage.unknownTokenCalls > 0 || usage.totalTokens >= limits.totalTokens)) throw new CallLimitError('totalTokens')
}
export function parseRevocation(input, bot) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
    !Array.isArray(input.revoked) || input.revoked.length > installed.length || new Set(input.revoked).size !== input.revoked.length ||
    input.revoked.some((name) => typeof name !== 'string' || !(bot.defaults.tools?.includes(name) || bot.id === 'chief' && MANAGEMENT_TOOLS.includes(name)) || !installed.some((tool) => tool.name === name))) {
    throw new TaskInputError(400, 'INVALID_TOOL_ACCESS', 'revoked 仅接受该 Bot 预置白名单内的工具名数组；不能扩大授权。')
  }
  return [...input.revoked]
}
const denied = (code, message) => ({ ok: false, error: { code, message } })
export function checkToolCall({ card, record, conversation, call, displayed, sets, priorEventIds = [] }) {
  if (record?.input?.botId !== card.bot.id || record?.id !== card.taskId || card.configRef.botId !== card.bot.id || conversation?.owner?.taskId !== card.taskId) {
    return denied('TOOL_IDENTITY_DENIED', 'Task、Bot 或 conversation 身份不匹配。')
  }
  if (!sets.installed.includes(call.name)) return denied('TOOL_NOT_INSTALLED', '工具未登记。')
  if (!sets.authorized.includes(call.name) || !displayed.includes(call.name)) return denied('TOOL_NOT_AUTHORIZED', '工具未授权、已撤权或未在本轮展示。')
  if (skillTools.some((tool) => tool.name === call.name)) return validSkillArgs(call) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', 'Skill 参数无效；不接受路径、规则或版本覆盖。')
  if (MANAGEMENT_TOOLS.includes(call.name)) return card.bot.id === 'chief' && validManagementArgs(call) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', 'Chief管理参数无效；必须明确目标、版本与变更。')
  if (SHARED_TOOLS.includes(call.name)) return validSharedArgs(call) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', '共享参数无效。')
  if (COLLABORATION_TOOLS.includes(call.name)) return validCollaborationArgs(call) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', '协作参数无效。')
  if (call.name === REVIEW_TOOL) return validReviewArgs(call) ? { ok:true } : denied('TOOL_INVALID_ARGUMENTS','验收参数无效；须绑定确切修订与状态。')
  const args = call.arguments
  if (WORKSPACE_TOOLS.includes(call.name)) return !call.argumentsError && validWorkspaceArgs(call.name, args) && sets.resources.includes(`workspace:${args.sourceId}`) ? { ok: true } : denied('TOOL_RESOURCE_DENIED', '工作区参数、来源或固定权限无效。')
  if (BLOCKER_ACTIONS.includes(call.name)) return validBlockerAction(call) ? { ok:true } : denied('TOOL_INVALID_ARGUMENTS','具体阻塞事项参数无效。')
  if (call.name === BLOCKER_TOOL) return !call.argumentsError && validBlockerArgs(args) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', '问题、必要信息和用户处理人参数无效。')
  if (call.name === HISTORY_TOOL) return !call.argumentsError && validHistoryArgs(args) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', '历史读取参数无效。')
  if (call.name === AUTOMATION_PAUSE_TOOL) return validAutomationPauseArgs(call) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', '只能暂停自动化；恢复只能由用户在设置页操作。')
  if (MAIN_TOOLS.includes(call.name)) return card.kind === 'main' && validMainArgs(call) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', '主会话工具参数无效；task_create 不能指定其他Bot。')
  if (call.argumentsError || !args || typeof args !== 'object' || Array.isArray(args) ||
    !Object.hasOwn(args, 'resource')) {
    return denied('TOOL_INVALID_ARGUMENTS', '工具参数格式无效。')
  }
  if (FEISHU_MUTATION_TOOLS.includes(call.name)) return normalizeFeishuMutation(call.name, args) && sets.resources.includes(args.resource) ? { ok: true } : denied('TOOL_RESOURCE_DENIED', '真实更新删除参数或资源未获准。')
  if (call.name === FEISHU_CREATE_TOOL) return normalizeFeishuCreate(args) && sets.resources.includes(args.resource) ? { ok: true } : denied('TOOL_RESOURCE_DENIED', '真实创建参数或资源未获准。')
  if (FEISHU_TOOLS.includes(call.name)) return validFeishuArgs(call.name, args) && sets.resources.includes(args.resource) ? { ok: true } : denied('TOOL_RESOURCE_DENIED', '真实日历参数或资源未获准。')
  if (call.name === RESULT_READ_TOOL && args.resource?.startsWith('workspace:')) return validResultReadArgs(args) && sets.resources.includes(args.resource) ? { ok: true } : denied('TOOL_RESOURCE_DENIED', '工作区来源已撤权。')
  if (call.name === RESULT_READ_TOOL && isFeishuResource(args.resource)) return validResultReadArgs(args) && sets.resources.includes(args.resource) ? { ok: true } : denied('TOOL_RESOURCE_DENIED', '真实来源已撤权。')
  if (args.resource !== 'mock:personal' || !sets.resources.includes(args.resource)) return denied('TOOL_RESOURCE_DENIED', '不允许读取该日程资源。')
  if (call.name === RESULT_READ_TOOL) {
    return validResultReadArgs(args) ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', '结果读取参数无效。')
  }
  if (call.name === CALENDAR_WRITE_TOOL) {
    if (!validCalendarWriteArgs(args)) return denied('TOOL_INVALID_ARGUMENTS', '改期参数无效；必须提供原时间与精确的新时间（+08:00），不可空改或覆盖额外字段。')
    return priorEventIds.includes(args.eventId) ? { ok: true } : denied('TOOL_EVENT_NOT_LISTED', '必须先读取本次执行的事件列表。')
  }
  if (Object.keys(args).length !== 2) return denied('TOOL_INVALID_ARGUMENTS', '工具仅接受资源与日期、月份或事件标识。')
  if (call.name === CALENDAR_TOOL && Object.hasOwn(args, 'month')) {
    return typeof args.month === 'string' && /^\d{4}-\d{2}$/.test(args.month) && validDate(`${args.month}-01`)
      ? { ok: true } : denied('TOOL_INVALID_ARGUMENTS', '月份必须为有效 YYYY-MM。')
  }
  if (call.name === CALENDAR_TOOL) {
    if (!Object.hasOwn(args, 'date') || typeof args.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.date) ||
      !Number.isFinite(Date.parse(`${args.date}T00:00:00Z`)) || new Date(`${args.date}T00:00:00Z`).toISOString().slice(0, 10) !== args.date) {
      return denied('TOOL_INVALID_ARGUMENTS', '参数仅接受有效 YYYY-MM-DD 日期和 resource。')
    }
  } else if (call.name === CALENDAR_EVENT_TOOL) {
    if (!Object.hasOwn(args, 'eventId') || typeof args.eventId !== 'string' || !args.eventId.trim() || args.eventId.length > 100) {
      return denied('TOOL_INVALID_ARGUMENTS', '参数仅接受列表回执中的 eventId 和 resource。')
    }
    if (!priorEventIds.includes(args.eventId)) return denied('TOOL_EVENT_NOT_LISTED', '详情工具仅接受本次执行中先前列表回执返回的事件标识。')
  } else return denied('TOOL_NOT_INSTALLED', '工具未登记。')
  return { ok: true }
}

/** Pure read-only deterministic fixture; never calls an external calendar or performs a write. */
export function readMockSchedule({ date, month, resource }) {
  if (month !== undefined) return { simulated: true, source: 'pidot.mock-calendar.v1', month, timezone: 'Asia/Shanghai', resource,
    events: Array.from({ length: 31 }, (_, n) => `${month}-${String(n + 1).padStart(2, '0')}`).filter(validDate)
      .flatMap((day) => readMockSchedule({ date: day, resource }).events) }
  const events = date === '2026-10-16' ? [
    { id: 'mock-20261016-1', title: '模拟：项目晨会', start: `${date}T09:30:00+08:00`, end: `${date}T10:00:00+08:00` },
    { id: 'mock-20261016-2', title: '模拟：阅读与复盘', start: `${date}T15:00:00+08:00`, end: `${date}T16:00:00+08:00` },
  ] : date === '2026-10-20' ? [
    { id: 'mock-20261020-1', title: '模拟：方案评审', start: `${date}T09:30:00+08:00`, end: `${date}T10:30:00+08:00` },
    { id: 'mock-20261020-2', title: '模拟：跨组同步', start: `${date}T10:00:00+08:00`, end: `${date}T10:45:00+08:00` },
    { id: 'mock-20261020-3', title: '模拟：午后整理', start: `${date}T14:00:00+08:00`, end: `${date}T14:30:00+08:00` },
  ] : date === '2026-10-17' || !validDate(date) ? [] : [
    { id: `mock-${date.replaceAll('-', '')}-1`, title: '模拟：项目晨会', start: `${date}T09:30:00+08:00`, end: `${date}T10:30:00+08:00` },
    { id: `mock-${date.replaceAll('-', '')}-2`, title: '模拟：跨组同步', start: `${date}T10:00:00+08:00`, end: `${date}T10:45:00+08:00` },
    { id: `mock-${date.replaceAll('-', '')}-3`, title: '模拟：午后整理', start: `${date}T14:00:00+08:00`, end: `${date}T14:30:00+08:00` },
  ]
  return { simulated: true, source: 'pidot.mock-calendar.v1', date, timezone: 'Asia/Shanghai', resource, events }
}
export function validSchedule(result, args) {
  return result?.simulated === true && result.source === 'pidot.mock-calendar.v1' && (args.month !== undefined ? result.month === args.month && !Object.hasOwn(result, 'date') : result.date === args.date && !Object.hasOwn(result, 'month')) &&
    result.resource === args.resource && result.timezone === 'Asia/Shanghai' && Object.keys(result).length === 6 &&
    Array.isArray(result.events) && result.events.length <= (args.month !== undefined ? 1550 : 50) && result.events.every((event) =>
      event && Object.keys(event).length === 4 && ['id', 'title', 'start', 'end'].every((key) => typeof event[key] === 'string' && event[key].length <= 200) &&
      validDate(event.start.slice(0, 10)) && (args.month !== undefined
        ? event.start.startsWith(`${args.month}-`) && event.end.startsWith(`${event.start.slice(0, 10)}T`)
        : event.start.startsWith(`${args.date}T`) && event.end.startsWith(`${args.date}T`)) &&
      Number.isFinite(Date.parse(event.start)) && Date.parse(event.end) > Date.parse(event.start))
}

const mockEventDetails = Object.freeze({
  'mock-20261016-1': Object.freeze({ location: '线上会议室', description: '项目进度同步与阻塞项讨论。' }),
  'mock-20261016-2': Object.freeze({ location: '个人日程', description: '阅读并整理本周复盘笔记。' }),
  'mock-20261020-1': Object.freeze({ location: '线上会议室 A', description: '评审方案初稿与风险清单。' }),
  'mock-20261020-2': Object.freeze({ location: '线上会议室 B', description: '同步跨组依赖及进度。' }),
  'mock-20261020-3': Object.freeze({ location: '个人日程', description: '整理会议结论与后续事项。' }),
})
/** Read details only from the deterministic fixture; unknown IDs never fall through to a real calendar. */
export function readMockEvent({ eventId, resource }) {
  const match = /^mock-(\d{4})(\d{2})(\d{2})-[1-3]$/.exec(eventId)
  const day = match && `${match[1]}-${match[2]}-${match[3]}`
  const summary = day && validDate(day) ? readMockSchedule({ date: day, resource }).events.find((event) => event.id === eventId) : null
  const details = mockEventDetails[eventId] ?? (summary ? { location: '模拟会议室', description: '月度模拟夹具中的日程，仅作测试，不是真实日历。' } : null)
  if (!summary || !details) return null
  return { simulated: true, source: 'pidot.mock-calendar.v1', timezone: 'Asia/Shanghai', resource,
    event: { ...summary, ...details } }
}
export function validEventDetail(result, args) {
  const event = result?.event
  return result?.simulated === true && result.source === 'pidot.mock-calendar.v1' && result.timezone === 'Asia/Shanghai' &&
    result.resource === args.resource && Object.keys(result).length === 5 && event?.id === args.eventId &&
    Object.keys(event).length === 6 && ['id', 'title', 'start', 'end', 'location', 'description'].every((key) =>
      typeof event[key] === 'string' && event[key].length <= (key === 'description' ? 1000 : 200)) &&
    Number.isFinite(Date.parse(event.start)) && Number.isFinite(Date.parse(event.end)) && Date.parse(event.end) > Date.parse(event.start)
}
