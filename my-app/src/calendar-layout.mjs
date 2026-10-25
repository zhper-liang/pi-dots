// Pure calendar math. Times are epoch ms; days are 'YYYY-MM-DD' in Asia/Shanghai (fixed UTC+8, no DST).
export const ZONE_OFFSET_MS = 8 * 3600000
export const DAY_MS = 86400000

export function dayKey(ms) { return new Date(ms + ZONE_OFFSET_MS).toISOString().slice(0, 10) }
export function dayStart(key) { return Date.parse(`${key}T00:00:00+08:00`) }
export function addDays(key, n) { return dayKey(dayStart(key) + n * DAY_MS + 3600000) }
export function weekday(key) { return (new Date(dayStart(key) + ZONE_OFFSET_MS).getUTCDay() + 6) % 7 } // Mon=0
export function weekStart(key) { return addDays(key, -weekday(key)) }
export function toOffsetIso(ms) { return new Date(ms + ZONE_OFFSET_MS).toISOString().slice(0, 19) + '+08:00' }
export function hm(ms) { return new Date(ms + ZONE_OFFSET_MS).toISOString().slice(11, 16) }

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
export function layoutDay(events, key, minMinutes = 20) {
  const s0 = dayStart(key), e0 = s0 + DAY_MS
  const items = events.filter(e => e.start < e0 && e.end > s0)
    .map(e => { const a = Math.max(e.start, s0), b = Math.min(Math.max(e.end, e.start), e0); const top = (a - s0) / 60000; return { key: e.key, top, height: Math.max((b - a) / 60000, minMinutes), col: 0, cols: 1 } })
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
export function eventDays(start, end) {
  const out = []; const last = dayKey(Math.max(start, end - 1))
  for (let d = dayKey(start); d <= last; d = addDays(d, 1)) out.push(d)
  return out
}

/** Todo due → day key; accepts YYYY-MM-DD or offset ISO. */
export function dueDay(due) {
  if (!due) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due
  const t = Date.parse(due); return Number.isNaN(t) ? null : dayKey(t)
}
