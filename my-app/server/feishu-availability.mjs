/** Application calendar only. No event text or identifiers enter the derived result. */
const day = 86400000
function parts(ms, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(p => [p.type, p.value]))
}
export function localDateBoundary(date, timezone) {
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw Error('invalid-date')
  const utc = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) throw Error('invalid-date')
  const matches = new Set()
  // Probe offsets on both sides of DST. Missing/ambiguous midnight is unsupported, never fixed at 24h.
  for (const delta of [-2 * day, -day, 0, day, 2 * day]) {
    const t = utc + delta, p = parts(t, timezone)
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)
    const candidate = utc - (local - t), q = parts(candidate, timezone)
    if (`${q.year}-${q.month}-${q.day}` === date && q.hour === '00' && q.minute === '00' && q.second === '00') matches.add(candidate)
  }
  if (matches.size !== 1) throw Error('unsupported-date-boundary')
  return [...matches][0]
}
export function validAvailabilityWindow(a) {
  try {
    for (const value of [a.start, a.end]) {
      if (typeof value === 'string' && value.endsWith('Z')) continue
      const p = parts(Date.parse(value), a.timezone ?? 'Asia/Shanghai')
      // Explicit offsets must describe actual wall time in the selected zone, including DST.
      if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` !== value.slice(0, 16) || Number(p.second) !== Number(value.slice(17, 19) || 0)) return false
    }
    return a.durationMinutes === undefined || Number.isSafeInteger(a.durationMinutes) && a.durationMinutes >= 1 && a.durationMinutes <= 31 * 1440
  } catch { return false }
}
export function applicationAvailability(schedule, { durationMinutes } = {}, collectedAt = new Date().toISOString()) {
  const lo = Date.parse(schedule.start), hi = Date.parse(schedule.end), intervals = []
  let complete = schedule.complete === true, reason = schedule.incompleteReason ?? null
  const uncertain = code => { complete = false; reason ??= code }
  if (schedule.coverage !== 'expanded-instance-view') uncertain('instance-coverage-unconfirmed')
  for (const e of schedule.events ?? []) {
    if (e.status === 'cancelled') continue
    if (e.status !== 'confirmed' || !['busy', 'free'].includes(e.freeBusyStatus)) { uncertain('unsupported-event-status'); continue }
    if (e.isFree || e.freeBusyStatus === 'free') continue
    try {
      const start = e.allDay ? localDateBoundary(e.start.date, e.start.timezone) : Number(e.start.timestamp) * 1000
      const end = e.allDay ? localDateBoundary(e.end.date, e.end.timezone) : Number(e.end.timestamp) * 1000
      if (e.allDay && e.start.timezone !== e.end.timezone) throw Error('mixed-date-timezone')
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw Error('invalid-event-range')
      if (end === start) continue
      if (start < hi && end > lo) intervals.push([Math.max(lo, start), Math.min(hi, end)])
    } catch { uncertain('unsupported-event-time') }
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const [start, end] of intervals) {
    const prior = merged.at(-1)
    if (prior && start <= prior[1]) prior[1] = Math.max(prior[1], end)
    else merged.push([start, end])
  }
  const gaps = []; let cursor = lo
  if (complete) { for (const [start, end] of merged) { if (start > cursor) gaps.push([cursor, start]); cursor = end } if (cursor < hi) gaps.push([cursor, hi]) }
  const iso = pairs => pairs.map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() }))
  return { kind: 'application-calendar-freebusy', label: '应用日历忙闲', scope: 'selected-application-calendar-only', source: schedule.source, simulated: false, start: schedule.start, end: schedule.end, timezone: schedule.timezone, collectedAt, complete, incompleteReason: reason, coverage: schedule.coverage, busy: iso(merged), free: complete ? iso(gaps) : null, ...(durationMinutes !== undefined ? { durationMinutes, suggestions: complete ? iso(gaps.filter(([s, e]) => e - s >= durationMinutes * 60000).map(([s]) => [s, s + durationMinutes * 60000])) : null } : {}), notice: '仅覆盖选定应用日历，不代表个人所有日历、参会人或会议室可用；[start,end)结束不含。仅为采集时快照，不保证展示后仍空闲，不是预订锁。结果不完整时不能推断空闲。' }
}
