import { routineInstant } from './routines.mjs'

/** The zone is captured by the caller when a draft is created, never on every edit. */
export function getLocalTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function isValidLocalDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const instant = Date.parse(`${date}T12:00:00Z`)
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === date
}

export function isValidLocalTime(time) {
  return typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
}

const validZone = timezone => {
  if (typeof timezone !== 'string' || !timezone.trim()) return false
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); return true }
  catch { return false }
}

/** Wall time in an explicit IANA zone. Reuses the schedule resolver: gaps reject, overlaps use first UTC. */
export function localInstant(value) {
  if (!value || !isValidLocalDate(value.date) || !isValidLocalTime(value.time) || !validZone(value.timezone)) return null
  try { return routineInstant(`${value.date}T${value.time}`, value.timezone) }
  catch { return null }
}

/** Only epoch milliseconds, Date objects and offset-bearing ISO strings describe an instant. */
export function localDateTime(instant = Date.now(), timezone = getLocalTimezone()) {
  if (!validZone(timezone)) return null
  let at
  if (instant instanceof Date) at = instant.getTime()
  else if (typeof instant === 'number') at = instant
  else if (typeof instant === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(instant)) {
    if (!isValidLocalDate(instant.slice(0, 10)) || !isValidLocalTime(instant.slice(11, 16))) return null
    at = Date.parse(instant)
  } else return null
  if (!Number.isFinite(at) || Number.isNaN(new Date(at).getTime())) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  const date = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`
  return isValidLocalDate(date) ? { date, time: `${parts.hour}:${parts.minute}`, timezone } : null
}

/** A human label without a permanently visible zone/ISO field. Invalid inputs stay explicit (null). */
export function formatLocalDateTime(instant, timezone = getLocalTimezone()) {
  const value = localDateTime(instant, timezone)
  return value ? `${Number(value.date.slice(0, 4))}年${Number(value.date.slice(5, 7))}月${Number(value.date.slice(8))}日 ${value.time}` : null
}

export function validateLocalRange(start, end) {
  const from = localInstant(start), to = localInstant(end)
  if (from === null) return { error: '开始时间无效，或该时刻因夏令时/时区变更不存在。' }
  if (to === null) return { error: '结束时间无效，或该时刻因夏令时/时区变更不存在。' }
  if (to <= from) return { error: '结束时间必须晚于开始时间；跨日请先选择结束日期。' }
  return { start: from, end: to }
}
