// Unified "待你确认" inbox (ADR-011). Read-only projection over existing durable state:
// Task approvals/blockers come from the same visibility-filtered Task view the UI uses,
// local workspace proposals from workspaceAgent.pending. Actions reuse existing endpoints.
const pad = n => String(n).padStart(2, '0')
export function chineseTime(value) {
  if (typeof value !== 'string') return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + 8 * 3600000) // display in Asia/Shanghai, the app's fixed zone
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
const quote = s => typeof s === 'string' && s.trim() ? `「${s.trim().slice(0, 80)}」` : ''
const kindName = { Event: '日程', Todo: '待办' }


const EVENT_TEXT = { todo_due: '待办到期时', event_changed: '日程变更时', task_finished: '本Bot的任务结束时' }
/** Plain-language schedule rule (PLAN §8.5), shared by the inbox summary and the routine card. */
export function ruleText(rule = {}) {
  if (rule.type === 'daily') return `每天 ${rule.time}`
  if (rule.type === 'interval') return rule.seconds % 3600 === 0 ? `每 ${rule.seconds / 3600} 小时` : rule.seconds % 60 === 0 ? `每 ${rule.seconds / 60} 分钟` : `每 ${rule.seconds} 秒`
  if (rule.type === 'at') return `${chineseTime(rule.at)} 一次`
  if (rule.type === 'event') return EVENT_TEXT[rule.event] ?? '事件触发'
  return '时间未定'
}
export function summarizeApproval(botName, toolName, args = {}, before = null) {
  const who = botName || 'Bot', title = quote(args.title ?? before?.title ?? before?.summary)
  if (toolName === 'calendar_feishu_create_event') return `${who}想在 ${chineseTime(args.start)} 添加飞书日程${title}`
  if (toolName === 'calendar_feishu_update_event') return `${who}想修改飞书日程${title}${args.start ? `，改到 ${chineseTime(args.start)}` : ''}`
  if (toolName === 'calendar_feishu_delete_event') return `${who}想删除飞书日程${title}`
  if (toolName === 'calendar_reschedule_event') return `${who}想把模拟日程${title}从 ${chineseTime(args.expectedStart)} 改到 ${chineseTime(args.start)}`
  if (toolName === 'routine_propose') return `${who}想新建例行任务${quote(args.title)}（${ruleText(args.rule)}）`
  if (toolName === 'bot_manage') {
    const target = quote(before?.name) || quote(args.botId)
    if (args.action === 'create') return `${who}想新建Bot${quote(args.name)}（${args.profile === 'mock-calendar' ? '日程类型' : '通用类型'}${args.parameters ? '，带自定义参数' : ''}）`
    if (args.action === 'deactivate') return `${who}想停用Bot${target}`
    return `${who}想修改Bot${target}的配置`
  }
  return `${who}想执行「${toolName}」，需要你确认`
}
// Past tense for the automatic-execution record (I-13): what already happened, with undo.
export function summarizeAutoApplied(botName, op) {
  const who = botName || 'Bot', a = op.normalizedArgs ?? {}, data = a.data ?? {}, before = op.confirmation?.before
  const kind = kindName[a.type] ?? '事项', title = quote(data.title ?? before?.title)
  if (op.action === 'create') return a.type === 'Event' ? `${who}已自动在 ${chineseTime(data.start)} 添加${title || kind}` : `${who}已自动添加${kind}${title}`
  if (op.action === 'delete') return `${who}已自动删除${kind}${title}`
  return `${who}已自动修改${kind}${title}${a.type === 'Event' && data.start ? `，改到 ${chineseTime(data.start)}` : ''}`
}
export function summarizeOperation(botName, op) {
  const who = botName || 'Bot', a = op.normalizedArgs ?? {}, data = a.data ?? {}, before = op.confirmation?.before
  const kind = kindName[a.type] ?? '事项', title = quote(data.title ?? before?.title)
  if (op.action === 'create') return a.type === 'Event' ? `${who}想在 ${chineseTime(data.start)} 添加${title || kind}` : `${who}想添加${kind}${title}`
  if (op.action === 'delete') return `${who}想删除${kind}${title}`
  return `${who}想修改${kind}${title}${a.type === 'Event' && data.start ? `，改到 ${chineseTime(data.start)}` : ''}`
}

export async function buildInbox({ listTasks, pendingOperations, bots, autoApplied = async () => [], findings = async () => [] }) {
  const items = [], name = id => bots.find(b => b.id === id)?.name ?? id
  for (const task of await listTasks()) {
    const botId = task.bot?.id, botName = task.bot?.name ?? name(botId)
    for (const a of task.approvals?.items ?? []) if (a.status === 'pending')
      items.push({ kind: 'approval', taskId: task.taskId, botId, botName, approvalId: a.id, summary: summarizeApproval(botName, a.toolName, a.arguments, a.before), createdAt: a.createdAt, detail: { toolName: a.toolName, arguments: a.arguments, before: a.before ?? null, binding: a.binding, simulated: a.simulated, allowAlways: a.allowAlways !== false, ...(a.retryOf ? { retryOf: a.retryOf } : {}) } })
    for (const b of task.blockers?.items ?? []) if (b.status === 'pending' && b.assignee === 'user')
      items.push({ kind: 'blocker', taskId: task.taskId, botId, botName, blockerId: b.id, summary: `${botName}需要你补充：${b.question}`, createdAt: b.history?.[0]?.createdAt ?? b.createdAt ?? null, detail: { question: b.question, requiredInformation: b.requiredInformation, version: b.version } })
  }
  let cursor
  do {
    const page = await pendingOperations(cursor)
    for (const op of page.items) if (op.state === 'awaiting_confirmation' && op.confirmation?.expiresAt > Date.now()) {
      const botId = op.actor.subjectId
      items.push({ kind: 'workspace-proposal', taskId: op.actor.taskId ?? null, botId, botName: name(botId), requestId: op.requestId, summary: summarizeOperation(name(botId), op), createdAt: op.confirmation.createdAt ?? null, detail: { sourceId: op.normalizedArgs.sourceId, action: op.action, normalizedArgs: op.normalizedArgs, payloadHash: op.payloadHash, before: op.confirmation.before ?? null, expiresAt: new Date(op.confirmation.expiresAt).toISOString(), allowAlways: op.confirmation.allowAlways !== false } })
    }
    cursor = page.next
  } while (cursor !== undefined)
  // Record of automatic writes (I-13): informational, never counted as "待你确认".
  for (const { op, undone } of await autoApplied()) {
    const botId = op.actor.subjectId
    items.push({ kind: 'auto-applied', taskId: op.actor.taskId ?? null, botId, botName: name(botId), requestId: op.requestId, summary: summarizeAutoApplied(name(botId), op), createdAt: op.confirmation?.createdAt ?? null, detail: { action: op.action, type: op.normalizedArgs.type, target: op.receipt.target, reason: op.receipt.autoApplied, undone } })
  }
  // Proactive findings (PLAN §8.2, U-02): kept in the inbox, never counted as "待你确认".
  for (const f of await findings()) items.push({ kind: 'finding', taskId: f.taskId ?? null, botId: 'chief', botName: name('chief'), findingId: f.id, summary: f.summary, createdAt: f.createdAt, detail: { detector: f.detector, lines: f.lines ?? [], state: f.state, delivery: f.delivery, assist: f.assist === true, assistTaskId: f.assistTaskId ?? null } })
  return { items: items.sort((x, y) => String(y.createdAt ?? '').localeCompare(String(x.createdAt ?? ''))) }
}
