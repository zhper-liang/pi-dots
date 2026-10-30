// Shared pure form rules; the server remains authoritative for permissions and recurrence.
export const ROUTINE_EVENTS = { todo_due: '待办到期', event_changed: '日程变更', task_finished: '本 Bot 的任务结束' }
export const ROUTINE_WHEN = [['at', '一次'], ['daily', '每日'], ['weekly', '每周'], ['monthly', '每月'], ['interval', '间隔'], ['event', '事件']]
export const ROUTINE_WEEKDAYS = [[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日']]
export const ROUTINE_LIMITS = Object.freeze({ modelCalls: 10, toolCalls: 20, totalTokens: 50000 })
const STATUS = { active: '启用中', paused: '已暂停', cancelled: '已取消', completed: '已完成', finishing: '最后一次运行中' }
const RUN_STATE = { claimed: '准备运行', dispatching: '正在启动', waiting: '运行中', succeeded: '完成', failed: '失败', cancelled: '已取消', skipped: '跳过', coalesced: '合并到下一次', unknown: '结果未知', retry_wait: '等待重试', suppressed: '未投递' }
const SKIP = { automation_paused: '自动化暂停中', authorization_revoked: '权限已变化', grace_expired: '错过时间', latest_only: '只补最近一次' }
const clock = (iso, timezone) => {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]))
    return `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`
  } catch { return '时间或时区无效' }
}

export function ruleLabel(rule = {}, timezone = 'Asia/Shanghai') {
  if (rule.type === 'daily') return `每天 ${rule.time}`
  if (rule.type === 'weekly') return `每周 ${ROUTINE_WEEKDAYS.filter(([id]) => rule.weekdays?.includes(id)).map(([, label]) => label).join('、')} ${rule.time}`
  if (rule.type === 'monthly') return `每月 ${rule.day} 日 ${rule.time}（短月取最后一天）`
  if (rule.type === 'interval') return rule.seconds % 3600 === 0 ? `每 ${rule.seconds / 3600} 小时` : rule.seconds % 60 === 0 ? `每 ${rule.seconds / 60} 分钟` : `每 ${rule.seconds} 秒`
  if (rule.type === 'at') return `${clock(rule.at, timezone)} 一次`
  if (rule.type === 'event') return `${ROUTINE_EVENTS[rule.event] ?? '事件'}时`
  return '时间未定'
}
export const statusLabel = s => STATUS[s] ?? s
export const runLabel = o => `${o.test ? '测试 · ' : ''}${RUN_STATE[o.state] ?? o.state}${o.state === 'skipped' && SKIP[o.reason] ? `（${SKIP[o.reason]}）` : ''}`

// An explicit offset is authoritative. A datetime-local value is interpreted in the chosen
// IANA zone, never the browser zone. Missing DST times are rejected; overlaps choose first UTC.
export function routineInstant(value, timezone) {
  if (typeof value !== 'string') return null
  if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) return Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute] = match.map(Number)
  const target = Date.UTC(year, month - 1, day, hour, minute)
  if (new Date(target).toISOString().slice(0, 16) !== value) return null
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const parts = at => Object.fromEntries(formatter.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
  const candidates = []
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = target + hours * 3600000, p = parts(sample)
    const at = target - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - sample), local = parts(at)
    if (local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute) candidates.push(at)
  }
  return candidates.length ? Math.min(...candidates) : null
}

/** Create form → schedule-manage input, or { error } with a message for the user. */
export function routineInput({ title, prompt, when, value, weekdays = [1], day = 1, event = 'todo_due', timezone = 'Asia/Shanghai', model = '', notification = 'inbox', writes = true, botId, requestId, now = Date.now() }) {
  if (!title?.trim() || title.length > 200) return { error: '请填写名称（最多200字）。' }
  if (!botId?.trim()) return { error: '请选择执行 Bot。' }
  if (!prompt?.trim() || prompt.length > 3000) return { error: '请写清楚每次要做什么（最多3000字）。' }
  try { if (typeof timezone !== 'string' || !timezone.trim()) throw Error(); new Intl.DateTimeFormat('en', { timeZone: timezone }).format() } catch { return { error: '请填写有效的 IANA 时区，例如 Asia/Shanghai。' } }
  if (typeof model !== 'string' || model.trim() && !/^[\w./:-]{1,200}$/.test(model.trim())) return { error: '模型只填名称，不填地址或密钥。' }
  if (!['inbox', 'none'].includes(notification) || typeof writes !== 'boolean') return { error: '请检查通知和改动设置。' }
  const built = routineRule({ when, value, weekdays, day, event, timezone, now })
  if (built.error) return built
  const rule = built.rule
  return { input: { requestId, command: 'create', title: title.trim(), timezone, rule, confirmed: true,
    actionSpec: { kind: 'agent_readonly_workflow', botId, sourceIds: ['local'], prompt: prompt.trim(), promptVersion: 'v1', callLimits: { ...ROUTINE_LIMITS }, notification, writes, ...(model.trim() ? { model: { id: model.trim() } } : {}) } } }
}

/** Frequency-only preview: independent of required title/prompt/Bot fields. */
export function routineRule({ when, value, weekdays = [1], day = 1, event = 'todo_due', timezone = 'Asia/Shanghai', now = Date.now() }) {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() } catch { return { error: '请填写有效的 IANA 时区。' } }
  let rule
  if (['daily', 'weekly', 'monthly'].includes(when)) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? '')) return { error: '时间请写成 08:00 这样。' }
    rule = { type: when, time: value }
    if (when === 'weekly') {
      if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7) || new Set(weekdays).size !== weekdays.length) return { error: '请至少选择一个星期，周一为1、周日为7。' }
      rule.weekdays = [...weekdays].sort((a, b) => a - b)
    }
    if (when === 'monthly') {
      if (!Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 31) return { error: '每月日期请填1至31，短月取最后一天。' }
      rule.day = Number(day)
    }
  } else if (when === 'interval') {
    const minutes = Number(value)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) return { error: '间隔请填1至525600的整数分钟。' }
    rule = { type: 'interval', seconds: minutes * 60, anchor: new Date(now + 60000).toISOString() }
  } else if (when === 'at') {
    const at = routineInstant(value, timezone)
    if (at === null || at <= now) return { error: '请选一个将来的有效时间；夏令时缺失时刻不可用。' }
    rule = { type: 'at', at: new Date(at).toISOString() }
  } else if (when === 'event' && ROUTINE_EVENTS[event] || ROUTINE_EVENTS[when]) rule = { type: 'event', event: ROUTINE_EVENTS[when] ? when : event }
  else return { error: '请选择什么时候运行。' }
  return { rule }
}

/** Seeded legacy Bots omit status; only an explicit inactive value excludes a Bot. */
export function routineBotChoices(bots, allowed) {
  return bots.filter(bot => bot.status !== 'inactive' && (!allowed || allowed.some(option => option.id === bot.id && option.status !== 'inactive')))
}

/** UI-only guard over authenticated read responses; never grants missing capabilities. */
export function routineBotSelection({ botId, directory, configuration, task }) {
  const bot = directory?.bots?.find(item => item.id === botId)
  if (!bot || bot.status === 'inactive' || configuration?.bot?.id !== botId || configuration.bot.status === 'inactive') return { error: '执行 Bot 已停用或不存在，请重新选择。' }
  const revision = configuration.bot.configRef?.version
  const models = [...new Set((configuration.models ?? []).map(item => item.id).filter(id => typeof id === 'string' && id))].sort()
  const mainTaskId = directory.mainSessions?.[botId]
  if (typeof revision !== 'string' || !revision || !Number.isSafeInteger(mainTaskId) || task?.taskId !== mainTaskId || task.bot?.id !== botId || task.kind !== 'main') return { error: 'Bot 当前版本或主会话已改变，请重新读取。' }
  if (task.parameters?.mode !== 'model' || !models.length) return { error: '目标 Bot 没有可用模型，请先配置模型。' }
  const tools = configuration.assigned?.tools ?? [], resources = configuration.assigned?.resources ?? []
  const missing = [...['workspace.list', 'workspace.get'].filter(name => !tools.includes(name)), ...(!resources.includes('workspace:local') ? ['workspace:local'] : [])]
  return { botId, revision, mainTaskId, models, defaultModel: configuration.bot.defaults?.model?.id ?? '', missing,
    fingerprint: JSON.stringify([botId, revision, mainTaskId, models, [...tools].sort(), [...resources].sort()]) }
}
