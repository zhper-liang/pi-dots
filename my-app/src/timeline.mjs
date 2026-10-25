// PLAN §8.4 Task timeline: a read-only, time-ordered view built from the Task projection
// (GET …/tasks/:id). Pure; tested from server/. Arguments default to a one-line summary (P-14).
export const TOOL_LABELS = {
  'workspace.list': '查看事项', 'workspace.get': '读取事项', 'workspace.operation_status': '查看操作状态',
  'workspace.prepare_change': '提议改动', 'workspace.prepare_schedule': '提议定时任务',
  calendar_read_schedule: '读取模拟日程', calendar_read_event: '读取模拟日程详情', calendar_reschedule_event: '模拟改期',
  calendar_feishu_read_schedule: '读取飞书日程', calendar_feishu_read_event: '读取飞书日程详情', calendar_feishu_freebusy: '查飞书忙闲',
  calendar_feishu_create_event: '新建飞书日程', calendar_feishu_update_event: '修改飞书日程', calendar_feishu_delete_event: '删除飞书日程',
  task_create: '派活', task_status: '查进度', routine_propose: '提议例行任务', automation_pause: '暂停自动化', task_history_read: '读取历史', tool_result_read: '读取工具结果',
  report_blocker: '提问', blocker_resolve: '回答问题', blocker_escalate: '转交问题', task_assign: '分派子任务', task_review: '验收子任务',
  shared_publish: '发布共享信息', shared_link: '关联共享信息', shared_read: '读取共享信息', collaborators_list: '查看协作者',
  bot_inspect: '查看 Bot', bot_manage: '管理 Bot', skill_activate: '启用技能', skill_deactivate: '停用技能', skill_read_resource: '读取技能资料',
}
export const STATUS_LABELS = { ok: '成功', error: '未成功', running: '进行中', waiting: '等你处理', done: '完成', muted: '' }
const SYSTEM_TITLES = { 'auto-applied': '已自动执行', mirror: '任务动态', finding: '主动提醒', 'context-floor': '权限变化', skill: 'Skill' }
const APPROVAL_STATES = { executed: '已执行', rejected: '已拒绝', 'not-executed': '未执行', dispatching: '正在执行', 'outcome-unknown': '结果未知' }
const DECISIONS = { approved: '同意', rejected: '拒绝', inserted: '插入新要求' }
const PREFERRED = ['action', 'title', 'name', 'type', 'goal', 'start', 'end', 'eventId', 'botId', 'query', 'sourceId']
// Bookkeeping fields only matter in the raw view.
const LAST = ['id', 'requestId', 'operationId', 'expectedVersion', 'payloadHash']
const OPERATION_STATES = { awaiting_confirmation: '等你确认', succeeded: '已执行', failed: '失败', cancelled: '已取消', expired: '已过期', dispatching: '正在执行' }

export function toolLabel(name) { return TOOL_LABELS[name] ?? name ?? '工具' }

function short(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
/** One-line argument summary: preferred keys first, at most 3 pairs, long values cut. */
export function summarizeArgs(args, max = 80) {
  if (args === undefined || args === null) return ''
  if (typeof args !== 'object') return short(args, max)
  // workspace.prepare_change nests the item under change{type,id,data}; flatten one level each.
  const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  const change = obj(args.change)
  const flat = { ...args, ...change, ...obj(change.data), ...obj(args.data) }
  delete flat.data; delete flat.change
  const keys = Object.keys(flat).filter(k => flat[k] !== undefined && flat[k] !== null && flat[k] !== '')
  const ordered = [...PREFERRED.filter(k => keys.includes(k)), ...keys.filter(k => !PREFERRED.includes(k) && !LAST.includes(k)), ...LAST.filter(k => keys.includes(k))].slice(0, 3)
  const text = ordered.map(k => `${k}: ${short(flat[k], 32)}`).join(' · ')
  return keys.length > ordered.length ? short(`${text} …`, max) : short(text, max)
}

function resultSummary(result) {
  if (!result) return ''
  if (!result.ok) return [result.error?.code, result.error?.message].filter(Boolean).join('：')
  const data = result.data
  if (data && typeof data === 'object') {
    if (data.status === 'waiting-for-user-approval') return '等你审批'
    if (OPERATION_STATES[data.state]) return OPERATION_STATES[data.state]
    if (typeof data.taskId === 'number') return `任务 #${data.taskId}`
    if (Array.isArray(data.items)) return `${data.items.length} 条`
  }
  return ''
}

/** Build the ordered timeline. Entries: input, model, tool, reply, error, approval, decision, receipt, question, answer, system, end. */
export function buildTimeline(task) {
  const entries = [], calls = new Map()
  let seq = 0
  const push = (entry) => { const e = { seq: seq++, status: 'muted', summary: '', ...entry }; entries.push(e); return e }
  for (const m of task.messages ?? []) {
    const at = m.createdAt ?? null
    if (m.role === 'user') push({ id: `m${m.id}`, at, kind: 'input', title: '你的输入', summary: short(m.content ?? '', 80), detail: m.content })
    else if (m.role === 'assistant' && m.assistant) {
      const blocks = (m.assistant.content ?? []).filter(b => b.type === 'toolCall')
      push({ id: `m${m.id}`, at, kind: 'model', title: '模型回合', summary: [m.content && short(m.content, 60), `调用 ${blocks.length} 个工具`].filter(Boolean).join(' · '), detail: m.execution ? { model: m.execution.model, provider: m.execution.provider } : undefined })
      for (const b of blocks) calls.set(b.id, push({ id: `c${b.id}`, at, kind: 'tool', title: toolLabel(b.name), tool: b.name, summary: summarizeArgs(b.arguments), status: 'running', detail: { arguments: b.arguments } }))
    } else if (m.role === 'tool') {
      const status = m.result?.ok ? 'ok' : 'error', call = calls.get(m.callId)
      if (call) { call.status = status; call.result = resultSummary(m.result); call.detail = { arguments: call.detail?.arguments ?? m.arguments, result: m.result } }
      else push({ id: `m${m.id}`, at, kind: 'tool', title: toolLabel(m.toolName), tool: m.toolName, summary: summarizeArgs(m.arguments), status, result: resultSummary(m.result), detail: { arguments: m.arguments, result: m.result } })
    } else if (m.role === 'assistant') push({ id: `m${m.id}`, at, kind: 'reply', title: '回复', summary: short(m.content ?? '', 80), status: 'done', detail: m.content })
    else if (m.role === 'error') push({ id: `m${m.id}`, at, kind: 'error', title: '执行失败', summary: m.errorCode ?? short(m.content ?? '', 80), status: 'error', detail: m.content })
    else if (m.role === 'system') push({ id: `m${m.id}`, at, kind: 'system', title: SYSTEM_TITLES[m.systemKind] ?? '系统', summary: short(m.summary ?? m.content ?? '', 80) })
  }
  for (const a of task.approvals?.items ?? []) {
    const what = `${toolLabel(a.toolName)}${a.arguments?.title ? `「${short(a.arguments.title, 30)}」` : ''}`
    push({ id: `a${a.id}`, at: a.createdAt, kind: 'approval', title: '请求审批', summary: what, status: a.status === 'pending' && !a.decision ? 'waiting' : 'muted', detail: { toolName: a.toolName, arguments: a.arguments } })
    if (a.decision) push({ id: `a${a.id}d`, at: a.decision.createdAt, kind: 'decision', title: `审批：${DECISIONS[a.decision.decision] ?? a.decision.decision}`, summary: [what, a.decision.source === 'policy-rule' ? '按"总是允许"规则' : a.decision.reason].filter(Boolean).join(' · ') })
    if (a.receipt) push({ id: `a${a.id}r`, at: a.receipt.createdAt, kind: 'receipt', title: `执行结果：${APPROVAL_STATES[a.status] ?? a.status}`, summary: what, status: a.receipt.result?.ok ? 'ok' : 'error', detail: a.receipt.result })
    else if (a.status === 'outcome-unknown') push({ id: `a${a.id}u`, at: a.operation?.unknownAt ?? a.createdAt, kind: 'receipt', title: '执行结果：结果未知', summary: `${what} · 不会自动重试`, status: 'waiting' })
  }
  for (const b of task.blockers?.items ?? []) {
    push({ id: `b${b.id}`, at: b.createdAt, kind: 'question', title: '需要补充', summary: short(b.question ?? '', 80), status: b.status === 'pending' ? 'waiting' : 'muted' })
    if (b.answer) push({ id: `b${b.id}a`, at: b.answer.createdAt, kind: 'answer', title: '已补充', summary: short(b.answer.content ?? '', 80), status: 'done' })
  }
  if (task.cancellation) push({ id: 'end', at: task.cancellation.requestedAt, kind: 'end', title: '已取消', summary: '记录保留，不再执行', status: 'muted' })
  else if (task.runtime?.status === 'terminal') push({ id: 'end', at: null, kind: 'end', title: '执行异常结束', status: 'error' })
  // Stable order: by time; entries without a time keep their position after earlier timed ones.
  let last = ''
  for (const e of entries) { if (e.at) last = e.at; else e.sortAt = e.kind === 'end' ? '￿' : last }
  return entries.sort((x, y) => (x.at ?? x.sortAt ?? '').localeCompare(y.at ?? y.sortAt ?? '') || x.seq - y.seq)
}
