import { fail, object } from './workspace-schema.mjs'

const bad = message => fail(400, 'WORKSPACE_SCHEDULE_RULE', message)
export const SCHEDULE_EVENTS = ['todo_due', 'event_changed', 'task_finished']
export function normalizeScheduleRule(rule, timezone) {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() } catch { bad('需要有效IANA时区。') }
  if (typeof timezone !== 'string' || !object(rule)) bad('计划规则无效。')
  const exact = keys => { if (Object.keys(rule).some(k => !keys.includes(k))) bad('不支持cron、代码或额外规则字段。') }
  const instant = at => {
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) return false
    const day = at.slice(0, 10), local = new Date(`${day}T00:00:00Z`)
    return Number.isFinite(+local) && local.toISOString().slice(0, 10) === day && Number(at.slice(11, 13)) < 24 && Number(at.slice(14, 16)) < 60 && Number(at.slice(17, 19)) < 60
  }
  if (rule.type === 'at') { exact(['type', 'at']); if (!instant(rule.at)) bad('一次性时间必须带偏移。'); return { type: 'at', at: new Date(rule.at).toISOString() } }
  if (rule.type === 'interval') {
    exact(['type', 'seconds', 'anchor'])
    if (!Number.isSafeInteger(rule.seconds) || rule.seconds < 60 || rule.seconds > 31536000 || !instant(rule.anchor)) bad('间隔须为60秒至一年整数秒，含明确起点。')
    return { type: 'interval', seconds: rule.seconds, anchor: new Date(rule.anchor).toISOString() }
  }
  if (rule.type === 'daily') { exact(['type', 'time']); if (typeof rule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) bad('每日时间须为HH:mm。'); return { type: 'daily', time: rule.time } }
  // PLAN §8.5 event triggers (first batch); they have no clock due and fire from the scheduler's event poll.
  if (rule.type === 'event') { exact(['type', 'event']); if (!SCHEDULE_EVENTS.includes(rule.event)) bad('事件只支持待办到期、日程变更、本Bot任务结束。'); return { type: 'event', event: rule.event } }
  bad('仅支持at/daily/interval/event。')
}
const formatters = new Map()
function localParts(at, zone) {
  let formatter = formatters.get(zone)
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); if (formatters.size >= 64) formatters.clear(); formatters.set(zone, formatter) }
  return Object.fromEntries(formatter.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
}
// Resolve local civil time using observed offsets on both sides of the day.
// Missing DST times have no exact match; overlaps choose the first UTC instant.
function civilInstant(day, time, zone) {
  const [hour, minute] = time.split(':').map(Number), target = day + hour * 3600000 + minute * 60000, offsets = new Set()
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = target + hours * 3600000, p = localParts(sample, zone)
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - sample)
  }
  const date = new Date(day), candidates = []
  for (const offset of offsets) {
    const at = target - offset, p = localParts(at, zone)
    if (p.year === date.getUTCFullYear() && p.month === date.getUTCMonth() + 1 && p.day === date.getUTCDate() && p.hour === hour && p.minute === minute) candidates.push(at)
  }
  return candidates.length ? Math.min(...candidates) : null
}
export function nextScheduleDue(rule, zone, after) {
  if (rule.type === 'event') return null
  if (rule.type === 'at') return Date.parse(rule.at) > after ? Date.parse(rule.at) : null
  if (rule.type === 'interval') { const anchor = Date.parse(rule.anchor), step = rule.seconds * 1000; return anchor + Math.max(0, Math.floor((after - anchor) / step) + 1) * step }
  const p = localParts(after, zone), day = Date.UTC(p.year, p.month - 1, p.day)
  for (let i = 0; i < 370; i++) { const at = civilInstant(day + i * 86400000, rule.time, zone); if (at !== null && at > after) return at }
  bad('无法计算下一每日触发点。')
}
export function latestScheduleDue(rule, zone, first, now) {
  if (rule.type === 'event') return now
  if (rule.type === 'interval') return first + Math.floor((now - first) / (rule.seconds * 1000)) * rule.seconds * 1000
  if (rule.type !== 'daily') return first
  const p = localParts(now, zone), day = Date.UTC(p.year, p.month - 1, p.day)
  for (let i = 0; i < 370; i++) { const at = civilInstant(day - i * 86400000, rule.time, zone); if (at !== null && at <= now) return Math.max(first, at) }
  return first
}
