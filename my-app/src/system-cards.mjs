// PLAN §8.4 unified system cards: one registry for every card kind shown in conversations,
// mirror cards and the inbox, plus the button rules they share. Pure; tested from server/.
export const CARD_KINDS = {
  approval: { label: '需要你确认', tone: 'attention' },
  blocker: { label: '需要你补充', tone: 'attention' },
  mirror: { label: '任务动态', tone: 'muted' },
  finding: { label: '提醒', tone: 'attention' },
  'auto-applied': { label: '已自动执行', tone: 'busy' },
  summary: { label: '昨日遗留', tone: 'attention' },
  'routine-proposal': { label: '例行任务提议', tone: 'attention' },
  'bot-management': { label: 'Bot 管理提议', tone: 'attention' },
}
export const DETECTOR_LABELS = { conflict: '日程冲突', overdue: '待办逾期', unprepared: '会前未准备', followup: '话题跟进', summary: '昨日遗留' }
const STATE_LABELS = {
  pending: '等你决定', awaiting_confirmation: '等你决定', dispatching: '正在执行', 'outcome-unknown': '结果未知 · 去任务里核实',
  executed: '已执行', succeeded: '已执行', rejected: '已拒绝', cancelled: '已取消', expired: '已过期', 'not-executed': '未执行',
  resolved: '已补充', closed: '任务已结束', unavailable: '无法读取', failed: '失败', applied: '可撤销', undone: '已撤销',
  open: '', deferred: '已并入下次汇总', dismissed: '已忽略', muted: '这类已不再提醒', handled: '已派出任务',
}
const FINDING_STATES = { resolved: '已处理或已过时' }
const FINISHED = { succeeded: '已完成', failed: '失败', cancelled: '已取消' }
const WAITING = ['pending', 'awaiting_confirmation', 'open', 'deferred']

export function stateLabel(kind, state) {
  if (kind === 'finding' || kind === 'summary') return FINDING_STATES[state] ?? STATE_LABELS[state] ?? state ?? ''
  if (kind === 'mirror') return FINISHED[state] ?? STATE_LABELS[state] ?? state ?? ''
  return STATE_LABELS[state] ?? state ?? ''
}

/** Any pending approval can become a rule, except a pause or unknown-outcome retry. */
export function canAlways({ kind, retry = false, allowAlways = true }) {
  if (!['approval', 'bot-management', 'routine-proposal'].includes(kind)) return false
  return !retry && allowAlways !== false
}

/** Buttons a card shows: decide (同意/拒绝, maybe 总是同意), answer, undo, finding actions, or none. */
export function cardActions(card) {
  const waiting = WAITING.includes(card.state)
  if (card.kind === 'auto-applied') return card.state === 'applied' ? ['undo'] : []
  // PLAN §8.7: "帮我想办法" only when the setting is on and this finding has no analysis yet (card.assist).
  if (card.kind === 'finding' || card.kind === 'summary') return waiting ? ['handle', ...(card.assist === true ? ['assist'] : []), 'dismiss', ...(card.kind === 'summary' ? [] : ['mute'])] : []
  if (!waiting) return []
  if (card.kind === 'blocker') return ['answer']
  if (['approval', 'bot-management', 'routine-proposal'].includes(card.kind)) return canAlways(card) ? ['approve', 'always', 'reject'] : ['approve', 'reject']
  return []
}

export function cardView(card) {
  const kind = CARD_KINDS[card.kind] ? card.kind : 'mirror', base = CARD_KINDS[kind]
  const waiting = WAITING.includes(card.state)
  const label = (kind === 'finding' || kind === 'summary') && DETECTOR_LABELS[card.detector] ? DETECTOR_LABELS[card.detector] : base.label
  return { kind, label, tone: waiting ? base.tone : kind === 'auto-applied' && card.state === 'applied' ? 'busy' : 'muted', state: stateLabel(kind, card.state), waiting, actions: cardActions({ ...card, kind }) }
}

export const ALWAYS_WARNING = '以后这个 Bot 的同类操作会自动执行，不再问你。对外写入发出后无法撤销；全局暂停期间仍会询问。确定？'

/** Mirror entry (PLAN §8.1) → card input. Mirror decisions reuse the derived Task's endpoints. */
export function mirrorCard(item) {
  const kind = item.mirrorKind === 'blocker' ? 'blocker' : item.mirrorKind === 'auto-applied' ? 'auto-applied'
    : item.mirrorKind === 'finished' ? 'mirror' : item.toolName === 'bot_manage' ? 'bot-management' : ['routine_propose', 'workspace.prepare_schedule'].includes(item.toolName) ? 'routine-proposal' : 'approval'
  const state = kind === 'mirror' ? item.outcome : kind === 'auto-applied' ? (item.live === 'undone' ? 'undone' : 'applied') : item.live
  return { kind, state, toolName: item.toolName, allowAlways: item.allowAlways, retry: Boolean(item.retryOf) }
}

/** Inbox item (GET /api/inbox) → card input. */
export function inboxCard(item) {
  const d = item.detail ?? {}
  if (item.kind === 'blocker') return { kind: 'blocker', state: 'pending' }
  if (item.kind === 'auto-applied') return { kind: 'auto-applied', state: d.undone === true ? 'undone' : 'applied' }
  if (item.kind === 'finding') return { kind: d.detector === 'summary' ? 'summary' : 'finding', detector: d.detector, state: d.state ?? 'open' }
  if (item.kind === 'workspace-proposal') return { kind: 'approval', state: 'pending', toolName: 'workspace.prepare_change', allowAlways: d.allowAlways !== false }
  return { kind: d.toolName === 'bot_manage' ? 'bot-management' : ['routine_propose', 'workspace.prepare_schedule'].includes(d.toolName) ? 'routine-proposal' : 'approval', state: 'pending', toolName: d.toolName, allowAlways: d.allowAlways !== false, retry: Boolean(d.retryOf) }
}

/** D-11: an approval stays in the pending area until it has a receipt (unknown outcomes stay too). */
export function openApproval(item, cancelled = false) {
  if (item.receipt) return false
  return !cancelled || Boolean(item.operation)
}
export function openBlocker(item, cancelled = false) { return item.status === 'pending' && !cancelled }
