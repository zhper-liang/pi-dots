// Pure helpers for the sidebar session list: time groups, search, pins. No DOM, storage or fetch.

const DAY = 86400000
// Calendar days in local time; Date.UTC(y, m, d) avoids DST-length days.
const dayIndex = (ms) => { const d = new Date(ms); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY) }

/** Last activity of a session: its newest message, else when it was created. */
export function lastActivity(task) {
  const times = [task.createdAt, task.messages?.at(-1)?.createdAt].map((iso) => Date.parse(iso ?? '')).filter(Number.isFinite)
  return times.length ? Math.max(...times) : 0
}

/** today / yesterday / week (2–6 days ago) / earlier, by local calendar day. Future times count as today. */
export function timeBucket(at, now) {
  const days = dayIndex(now) - dayIndex(at)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? 'week' : 'earlier'
}

/** Short gray time beside a row: 刚刚 · 5分 · 3时 · 2天 · 10月3日. */
export function relativeTime(at, now) {
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分`
  const days = dayIndex(now) - dayIndex(at)
  if (days <= 0) return `${Math.floor(minutes / 60)}时`
  if (days < 100) return `${days}天`
  const d = new Date(at)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** Case-insensitive match on the title and the Bot name; a blank query matches everything. */
export function matchesQuery(item, query) {
  const needle = query.trim().toLowerCase()
  return !needle || item.title.toLowerCase().includes(needle) || item.botName.toLowerCase().includes(needle)
}

export const PIN_KEY = 'pidot.pinned-sessions'
const MAX_PINS = 50
/** Stored pins: a JSON array of positive integer ids. Anything else reads as no pins. */
export function parsePins(raw) {
  try {
    const value = JSON.parse(raw ?? '[]')
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_PINS)
  } catch { return [] }
}
/** Pin moves the id to the front; unpin removes it. */
export function togglePin(pins, id) {
  return pins.includes(id) ? pins.filter((pin) => pin !== id) : [id, ...pins].slice(0, MAX_PINS)
}

export const SECTION_LABELS = { pinned: '已置顶', confirm: '等你确认', today: '今天', yesterday: '昨天', week: '7 天内', earlier: '更早', archived: '已归档' }
const ORDER = ['pinned', 'confirm', 'today', 'yesterday', 'week', 'earlier', 'archived']

/**
 * Sidebar sections in display order, empty ones dropped. Each item appears once:
 * archived > pinned (in pin order) > waiting for you > its time group (newest first).
 * Items: { id, title, botName, at, confirm, archived }.
 */
export function sessionSections(items, { pins = [], query = '', now }) {
  const groups = Object.fromEntries(ORDER.map((id) => [id, []]))
  for (const item of items.filter((entry) => !isSessionDeleted(entry) && matchesQuery(entry, query))) {
    const id = item.archived ? 'archived' : pins.includes(item.id) ? 'pinned' : item.confirm ? 'confirm' : timeBucket(item.at, now)
    groups[id].push(item)
  }
  for (const id of ORDER) groups[id].sort(id === 'pinned' ? (a, b) => pins.indexOf(a.id) - pins.indexOf(b.id) : (a, b) => b.at - a.at)
  return ORDER.filter((id) => groups[id].length).map((id) => ({ id, label: SECTION_LABELS[id], items: groups[id] }))
}

/** Only explicit deletion hides rows; archive remains a separate, reversible section. */
export function isSessionDeleted(item) {
  return item.deleted === true || (typeof item.deletedAt === 'string' && item.deletedAt.length > 0)
}
export function removeSessionPin(pins, id) {
  return pins.filter(pin => pin !== id)
}
export function sessionDeleteLabel(target) {
  return target.kind === 'main' ? '清空并开始新会话' : target.running ? '停止并删除' : '删除会话'
}
/** Never optimistically hide on HTTP acceptance/unknown; bind receipt to the exact target and request. */
export function isSessionActionReceipt(result, target, requestId) {
  return result !== null && typeof result === 'object' && result.deleted === true &&
    result.taskId === target.taskId && result.botId === target.botId && result.requestId === requestId &&
    typeof result.deletedAt === 'string' && Number.isFinite(Date.parse(result.deletedAt)) &&
    result.action === (target.kind === 'main' ? 'clear-main' : 'delete') &&
    (target.kind === 'main' ? Number.isSafeInteger(result.replacementTaskId) && result.replacementTaskId > 0 &&
      result.replacementTaskId !== target.taskId : result.replacementTaskId === null)
}
