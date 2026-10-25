// PLAN §8.4 home page (P-13): the one-line "今天" summary above the Chief main session. Pure; tested from server/.
import { hm } from './calendar-layout.mjs'

/** Next event that has not ended yet, by start time. */
export function nextEvent(events, now) {
  return events.filter(e => Date.parse(e.end ?? e.start) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0] ?? null
}

/** Summary parts in display order; empty parts are dropped. day is 'YYYY-MM-DD' (Asia/Shanghai). */
export function todayParts({ authorized = true, events = [], todos = [], confirmations = 0, now, day }) {
  const parts = []
  if (!authorized) parts.push('本地日程未开放读取')
  else {
    const next = nextEvent(events, now)
    parts.push(events.length ? `${events.length} 个日程` : '今天没有日程')
    if (next) parts.push(`${Date.parse(next.start) <= now ? '进行中' : `下一个 ${hm(Date.parse(next.start))}`} ${next.title}`)
    const overdue = todos.filter(t => String(t.due).slice(0, 10) < day).length
    if (todos.length) parts.push(`${todos.length} 项到期${overdue ? `（${overdue} 项已逾期）` : ''}`)
  }
  if (confirmations) parts.push(`${confirmations} 项等你确认`)
  return parts
}
