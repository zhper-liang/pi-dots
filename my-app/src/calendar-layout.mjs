// Pure calendar math; optional display zone defaults to the legacy Asia/Shanghai contract.
import { getLocalTimezone, localDateTime, localInstant, validateLocalRange } from './local-time.mjs'
export const ZONE_OFFSET_MS = 8 * 3600000
export const DAY_MS = 86400000

export function dayKey(ms, timezone = 'Asia/Shanghai') { return localDateTime(ms, timezone)?.date ?? '' }
export function dayStart(key, timezone = 'Asia/Shanghai') { return localInstant({ date: key, time: '00:00', timezone }) ?? NaN }
export function addDays(key, n) { return new Date(Date.parse(`${key}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10) }
export function weekday(key) { return (new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7 }
export function weekStart(key) { return addDays(key, -weekday(key)) }
export function toOffsetIso(ms, timezone = 'Asia/Shanghai') {
  const value = localDateTime(ms, timezone)
  if (!value) return ''
  const seconds = new Date(ms).toISOString().slice(17, 19)
  const offset = Math.round((Date.parse(`${value.date}T${value.time}:${seconds}Z`) - Math.floor(ms / 1000) * 1000) / 60000)
  const absolute = Math.abs(offset)
  return `${value.date}T${value.time}:${seconds}${offset < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}
export function hm(ms, timezone = 'Asia/Shanghai') { return localDateTime(ms, timezone)?.time ?? '' }

/** Display in the device zone, but retain the event's saved zone as metadata. */
export function eventTimeDraft(start, end, timezone = getLocalTimezone(), displayTimezone = getLocalTimezone()) {
  return { start: localDateTime(start, displayTimezone), end: localDateTime(end, displayTimezone), timezone, originalStart: start, originalEnd: end }
}
export function eventTimeData(draft) {
  const range = validateLocalRange(draft.start, draft.end)
  const original = (value, at) => {
    const prior = localDateTime(at, value.timezone)
    return Number.isFinite(at) && prior?.date === value.date && prior.time === value.time ? at : null
  }
  // A title-only edit must not truncate saved seconds or move the second DST occurrence.
  const start = original(draft.start, draft.originalStart) ?? range.start
  const end = original(draft.end, draft.originalEnd) ?? range.end
  if (start === undefined || end === undefined) return { error: range.error }
  if (end <= start) return { error: '结束时间必须晚于开始时间；跨日请先选择结束日期。' }
  return { start: toOffsetIso(start, draft.timezone), end: toOffsetIso(end, draft.timezone), timezone: draft.timezone }
}

/** Range of visible days for a mode. */
export function periodDays(mode, anchor) {
  if (mode === 'day') return [anchor]
  if (mode === 'week') { const s = weekStart(anchor); return Array.from({ length: 7 }, (_, i) => addDays(s, i)) }
  const first = anchor.slice(0, 8) + '01', s = weekStart(first)
  const next = addDays(first, 32).slice(0, 8) + '01'
  const days = []; for (let d = s; days.length < 42 && (d < next || days.length % 7); d = addDays(d, 1)) days.push(d)
  return days
}
export function shiftAnchor(mode, anchor, dir) {
  if (mode === 'day') return addDays(anchor, dir)
  if (mode === 'week') return addDays(anchor, 7 * dir)
  const [y, m] = anchor.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + dir, 1))
  return t.toISOString().slice(0, 10)
}

/** Clip events to one day and assign overlap columns.
 * Input: [{ key, start, end }] (ms). Output: [{ key, top, height, col, cols }] where top/height are minutes. */
export function layoutDay(events, key, minMinutes = 20, timezone = 'Asia/Shanghai') {
  const s0 = dayStart(key, timezone), e0 = dayStart(addDays(key, 1), timezone)
  const minute = at => at === e0 ? 1440 : Number(hm(at, timezone).slice(0, 2)) * 60 + Number(hm(at, timezone).slice(3))
  const items = events.filter(e => e.start < e0 && e.end > s0)
    .map(e => { const a = Math.max(e.start, s0), b = Math.min(Math.max(e.end, e.start), e0); const top = minute(a); return { key: e.key, top, height: Math.max(minute(b) - top, minMinutes), col: 0, cols: 1 } })
    .sort((a, b) => a.top - b.top || b.height - a.height)
  let cluster = [], clusterEnd = -1, colEnds = []
  const flush = () => { for (const it of cluster) it.cols = colEnds.length; cluster = []; colEnds = [] }
  for (const it of items) {
    if (it.top >= clusterEnd) { flush(); clusterEnd = -1 }
    let c = colEnds.findIndex(end => end <= it.top)
    if (c < 0) { c = colEnds.length; colEnds.push(0) }
    colEnds[c] = it.top + it.height; it.col = c; cluster.push(it); clusterEnd = Math.max(clusterEnd, it.top + it.height)
  }
  flush()
  return items
}

/** Day keys an event touches (end exclusive). */
export function eventDays(start, end, timezone = 'Asia/Shanghai') {
  const out = []; const last = dayKey(Math.max(start, end - 1), timezone)
  for (let d = dayKey(start, timezone); d <= last; d = addDays(d, 1)) out.push(d)
  return out
}

/** Todo due → day key; accepts YYYY-MM-DD or offset ISO. */
export function dueDay(due, timezone = 'Asia/Shanghai') {
  if (!due) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due
  const t = Date.parse(due); return Number.isNaN(t) ? null : dayKey(t, timezone)
}

/** Desktop shows both panes; phones retain the chosen pane without unmounting drafts. */
export function workspacePanes(narrow, selected = 'calendar') {
  return { calendar: !narrow || selected === 'calendar', todos: !narrow || selected === 'todos' }
}

/** Active todos in deadline order, undated last. Never infer a calendar duration. */
export function calendarTodos(items) {
  const deadline = item => {
    if (!dueDay(item.due)) return Infinity
    return item.due.length === 10 ? dayStart(item.due) : Date.parse(item.due)
  }
  return items.filter(item => !item.deletedAt && item.status !== 'completed')
    .slice().sort((a, b) => deadline(a) - deadline(b) || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id))
}
