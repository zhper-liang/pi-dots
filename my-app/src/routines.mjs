// PLAN §8.5 routines under each Bot: the pure parts of the Bot page's 例行任务 section (labels,
// the create-form → schedule-manage input, run state). Tested from server/.
export const ROUTINE_EVENTS = { todo_due: '待办到期', event_changed: '日程变更', task_finished: '本 Bot 的任务结束' }
export const ROUTINE_WHEN = [
  ['daily', '每天'], ['interval', '每隔（分钟）'], ['at', '只一次'],
  ['todo_due', '待办到期时'], ['event_changed', '日程变更时'], ['task_finished', '本 Bot 的任务结束时'],
]
// Same per-run limits as a routine proposed in conversation (server main-tools.mjs ROUTINE_CALL_LIMITS).
export const ROUTINE_LIMITS = Object.freeze({ modelCalls: 10, toolCalls: 20, totalTokens: 50000 })
const STATUS = { active: '启用中', paused: '已暂停', cancelled: '已取消', completed: '已完成', finishing: '最后一次运行中' }
const RUN_STATE = { claimed: '准备运行', dispatching: '正在启动', waiting: '运行中', succeeded: '完成', failed: '失败', cancelled: '已取消', skipped: '跳过', coalesced: '合并到下一次', unknown: '结果未知', retry_wait: '等待重试', suppressed: '未投递' }
const SKIP = { automation_paused: '自动化暂停中', authorization_revoked: '权限已变化', grace_expired: '错过时间', latest_only: '只补最近一次' }
const pad = n => String(n).padStart(2, '0')
const clock = iso => { const d = new Date(Date.parse(iso) + 8 * 3600000); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` }

/** Plain-language rule, matching the server's inbox wording (inbox.mjs ruleText). */
export function ruleLabel(rule = {}) {
  if (rule.type === 'daily') return `每天 ${rule.time}`
  if (rule.type === 'interval') return rule.seconds % 3600 === 0 ? `每 ${rule.seconds / 3600} 小时` : rule.seconds % 60 === 0 ? `每 ${rule.seconds / 60} 分钟` : `每 ${rule.seconds} 秒`
  if (rule.type === 'at') return `${clock(rule.at)} 一次`
  if (rule.type === 'event') return `${ROUTINE_EVENTS[rule.event] ?? '事件'}时`
  return '时间未定'
}
export const statusLabel = s => STATUS[s] ?? s
export const runLabel = o => `${o.test ? '测试 · ' : ''}${RUN_STATE[o.state] ?? o.state}${o.state === 'skipped' && SKIP[o.reason] ? `（${SKIP[o.reason]}）` : ''}`

/** Create form → schedule-manage input, or { error } with a message for the user. */
export function routineInput({ title, prompt, when, value, notification = 'inbox', writes = true, botId, requestId, now = Date.now() }) {
  if (!title?.trim()) return { error: '请填写名称。' }
  if (!prompt?.trim()) return { error: '请写清楚每次要做什么。' }
  let rule
  if (when === 'daily') { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? '')) return { error: '时间请写成 08:00 这样。' }; rule = { type: 'daily', time: value } }
  else if (when === 'interval') {
    const minutes = Number(value)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) return { error: '间隔请填 1 以上的整数分钟。' }
    rule = { type: 'interval', seconds: minutes * 60, anchor: new Date(now + 60000).toISOString() }
  } else if (when === 'at') {
    const at = Date.parse(value ?? '')
    if (!Number.isFinite(at) || at <= now) return { error: '请选一个将来的时间。' }
    rule = { type: 'at', at: new Date(at).toISOString() }
  } else if (ROUTINE_EVENTS[when]) rule = { type: 'event', event: when }
  else return { error: '请选择什么时候运行。' }
  return { input: { requestId, command: 'create', title: title.trim(), timezone: 'Asia/Shanghai', rule, confirmed: true,
    actionSpec: { kind: 'agent_readonly_workflow', botId, sourceIds: ['local'], prompt: prompt.trim(), promptVersion: 'v1', callLimits: { ...ROUTINE_LIMITS }, notification, writes } } }
}
