import { defineDoc } from '@earendil-works/pi-durable'
import { createHash, randomUUID } from 'node:crypto'
import { DetectorDirty } from './detector-state.mjs'

// PLAN §8.2 detectors. Pure code: no model call, no chat text (I-07). Inputs are structured
// records only; delivery appends system cards that never wake a model (I-08).
export const Findings = defineDoc({ kind: 'pidot.findings', version: 1, scope: 'session', initial: () => ({ items: [], muted: [], daily: {}, summaryDay: null, wakeAt: null, ranRevision: 0, lastRunAt: null, assist: false }) })
export const DETECTORS = ['conflict', 'overdue', 'unprepared', 'followup']
export const DETECTOR_LABELS = { conflict: '日程冲突', overdue: '待办逾期', unprepared: '会前未准备', followup: '话题跟进', summary: '昨日遗留' }
// P-08/P-09/P-10/P-19 and U-06/U-09 (all confirmed at phase 2 kickoff).
export const DETECTOR_PARAMS = Object.freeze({ conflictDays: 7, debounceMs: 2000, offsetMs: 8 * 3600000, prepHours: 12, freeMinutes: 30, summaryHour: 8, nightStart: 22, followupHours: 4, dailyCap: 10 })
const P = DETECTOR_PARAMS, HOUR = 3600000, DAY = 24 * HOUR
const iso = t => new Date(t).toISOString()
export const dayKey = t => new Date(t + P.offsetMs).toISOString().slice(0, 10)
export const dayStart = t => Date.parse(`${dayKey(t)}T00:00:00Z`) - P.offsetMs
export const dueInstant = due => /^\d{4}-\d{2}-\d{2}$/.test(due) ? Date.parse(`${due}T00:00:00Z`) - P.offsetMs + DAY : Date.parse(due)
const localHour = t => new Date(t + P.offsetMs).getUTCHours()
export const isNight = t => localHour(t) >= P.nightStart || localHour(t) < P.summaryHour
const clock = t => { const d = new Date(Date.parse(t) + P.offsetMs); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 32)
const ref = (type, r) => ({ type, sourceId: r.sourceId, id: String(r.id), version: r.version ?? 1 })
const merge = list => { const out = []; for (const [s, e] of [...list].sort((a, b) => a[0] - b[0])) { const last = out.at(-1); if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]) } return out }

/**
 * input: { events:[{sourceId,id,version,title,start,end,busyOnly?}], todos:[{sourceId,id,version,title,status,due,deletedAt}],
 * links:[{todoRef,eventRef}], pending:[{kind,taskId,id,version,createdAt,summary}], incomplete:[sourceId] }
 * → { findings:[{detector,refs,summary,dedupeKey,taskId?}], wakeAt } (wakeAt: next time a result can change without data change)
 */
export function detect(input, now) {
  const found = [], wake = [], title = e => e.busyOnly ? '忙碌' : e.title
  const events = input.events.filter(e => !e.deletedAt)
  const timed = events.filter(e => Date.parse(e.end) - Date.parse(e.start) < DAY) // all-day events never take part
  const horizon = now + P.conflictDays * DAY, note = input.incomplete?.length ? `（${input.incomplete.join('、')} 数据不全，未参与）` : ''
  const window = timed.filter(e => Date.parse(e.end) > now && Date.parse(e.start) < horizon).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  for (let i = 0; i < window.length; i++) for (let j = i + 1; j < window.length; j++) {
    const a = window[i], b = window[j]
    if (Date.parse(b.start) >= Date.parse(a.end)) break // touching ends are not a conflict
    found.push({ detector: 'conflict', refs: [ref('Event', a), ref('Event', b)], summary: `日程冲突：「${title(a)}」与「${title(b)}」在 ${clock(b.start)} 重叠${note}` })
  }
  for (const e of timed) if (Date.parse(e.start) >= horizon) wake.push(Date.parse(e.start) - P.conflictDays * DAY)
  const busy = merge(timed.map(e => [Date.parse(e.start), Date.parse(e.end)]))
  const free = (from, to) => busy.reduce((left, [s, e]) => left - Math.max(0, Math.min(e, to) - Math.max(s, from)), Math.max(0, to - from))
  const tightAt = (from, to) => { let lo = from, hi = to; while (hi - lo > 60000) { const mid = (lo + hi) / 2; if (free(mid, to) < P.freeMinutes * 60000) hi = mid; else lo = mid } return hi }
  const todayEnd = dayStart(now) + DAY
  for (const t of input.todos) if (t.status !== 'completed' && !t.deletedAt && t.due) {
    const dueAt = dueInstant(t.due)
    const past = now >= dueAt, today = !past && dueAt <= todayEnd
    const tight = today && free(now, dueAt) < P.freeMinutes * 60000
    if (past || tight) found.push({ detector: 'overdue', refs: [ref('Todo', t)], summary: past ? `待办「${t.title}」已逾期` : `待办「${t.title}」今天到期，剩余空闲不足 ${P.freeMinutes} 分钟` })
    if (!past) wake.push(dueAt, dayStart(dueAt))
    if (today && !tight) wake.push(tightAt(now, dueAt))
  }
  for (const l of input.links) {
    const e = events.find(x => x.sourceId === l.eventRef?.sourceId && String(x.id) === String(l.eventRef?.id))
    const t = input.todos.find(x => x.sourceId === l.todoRef?.sourceId && String(x.id) === String(l.todoRef?.id))
    if (!e || !t || t.status === 'completed' || t.deletedAt || Date.parse(e.start) <= now) continue // explicit links only (T2-04)
    if (Date.parse(e.start) - now <= P.prepHours * HOUR) found.push({ detector: 'unprepared', refs: [ref('Event', e), ref('Todo', t)], summary: `「${title(e)}」${clock(e.start)} 开始，关联待办「${t.title}」还没完成` })
    else wake.push(Date.parse(e.start) - P.prepHours * HOUR)
  }
  for (const p of input.pending) {
    const at = Date.parse(p.createdAt) + P.followupHours * HOUR
    if (now >= at) found.push({ detector: 'followup', refs: [{ type: p.kind, sourceId: `task:${p.taskId}`, id: String(p.id), version: p.version ?? 1 }], taskId: p.taskId, summary: p.summary })
    else wake.push(at)
  }
  const ds = dayStart(now)
  for (const h of [P.summaryHour, P.nightStart, P.summaryHour + 24]) wake.push(ds + h * HOUR)
  const next = wake.filter(w => w > now)
  return { findings: found.map(f => ({ ...f, dedupeKey: hash([f.detector, f.refs]) })), wakeAt: next.length ? Math.min(...next) : null }
}

/** Apply one detection pass to the Findings document: dedupe, silent resolve, U-06 delivery, daily summary. */
export async function applyDetection(tx, { findings, wakeAt }, at, { summaryInput = {}, dirtyRevision = 0 } = {}) {
  const doc = await tx.doc(Findings), day = dayKey(at), fresh = []
  const current = new Set(findings.map(f => f.dedupeKey))
  // Any ref version change, deletion or completion drops the key: the old Finding resolves silently (T2-05).
  for (const f of doc.items) if (['open', 'deferred', 'dismissed', 'muted'].includes(f.state) && f.detector !== 'summary' && !current.has(f.dedupeKey)) Object.assign(f, { state: 'resolved', resolvedAt: iso(at) })
  // U-05/U-06: the first daytime pass of a day sums up what was left over (before today's new findings).
  let summary = null
  if (!isNight(at) && doc.summaryDay !== day) {
    doc.summaryDay = day
    const deferred = doc.items.filter(f => f.state === 'deferred')
    const lines = [...(summaryInput.overdueTodos ?? []).map(t => `未完成待办「${t.title}」`), ...(summaryInput.pending ?? []).map(p => `未处理：${p.summary}`), ...(summaryInput.expired ?? []).map(e => `已过期的提案：${e.summary}`), ...deferred.map(f => f.summary)]
    for (const f of doc.items) if (f.detector === 'summary' && f.state === 'open') Object.assign(f, { state: 'resolved', resolvedAt: iso(at) })
    for (const f of deferred) Object.assign(f, { state: 'open', delivery: 'summary' })
    if (lines.length) { summary = { id: randomUUID(), detector: 'summary', refs: [], dedupeKey: `summary:${day}`, summary: `昨日遗留 ${lines.length} 项`, lines, state: 'open', createdAt: iso(at), delivery: 'card' }; doc.items.push(summary) }
  }
  for (const f of findings) {
    if (doc.items.some(x => x.dedupeKey === f.dedupeKey)) continue // one notice per object version, whatever its state
    const row = { id: randomUUID(), ...f, state: doc.muted.includes(f.detector) ? 'muted' : 'open', createdAt: iso(at), delivery: null }
    doc.items.push(row)
    if (row.state !== 'open') continue
    if (isNight(at)) row.delivery = 'inbox'
    else if ((doc.daily[day] ?? 0) < P.dailyCap) { doc.daily[day] = (doc.daily[day] ?? 0) + 1; row.delivery = 'card'; fresh.push(row) }
    else Object.assign(row, { state: 'deferred', delivery: 'deferred' })
  }
  doc.items = doc.items.filter(f => f.state !== 'resolved' || at - Date.parse(f.resolvedAt) < 30 * DAY)
  Object.assign(doc, { wakeAt: wakeAt === null ? null : iso(wakeAt), ranRevision: dirtyRevision, lastRunAt: iso(at) })
  for (const d of Object.keys(doc.daily)) if (d < dayKey(at - 7 * DAY)) delete doc.daily[d]
  return [...fresh, ...(summary ? [summary] : [])]
}

/**
 * Background worker: data change (DetectorDirty commit) → debounce → recompute; plus its own wake timer
 * for time-based results (D-07). Never polls, never calls a model. Detection runs during a global pause (I-14).
 */
export function createDetectorWorker({ harness, context, gather, deliver, now = Date.now, debounceMs = P.debounceMs, onError = () => {} }) {
  let running, debounce, wakeTimer, unsubscribe, stopped = false
  async function tick() {
    if (running) return running
    running = (async () => {
      const at = now(), input = await gather(at)
      const result = detect(input, at)
      return harness.commit(async tx => {
        const dirty = await tx.doc(DetectorDirty)
        const delivered = await applyDetection(tx, result, at, { summaryInput: input.summary, dirtyRevision: dirty.revision })
        await deliver(tx, delivered)
        return { delivered: delivered.length, wakeAt: result.wakeAt }
      }, context)
    })()
    try { return await running } finally { running = undefined }
  }
  const run = () => tick().then(r => { if (!stopped && r?.wakeAt) { clearTimeout(wakeTimer); wakeTimer = setTimeout(run, Math.min(Math.max(r.wakeAt - now(), 1000), DAY)); wakeTimer.unref?.() } }, onError)
  return {
    tick,
    start() {
      unsubscribe = harness.subscribeCommits(({ changes }) => {
        if (stopped || !changes.some(c => c.record?.kind === DetectorDirty.definition.kind)) return
        clearTimeout(debounce); debounce = setTimeout(run, debounceMs); debounce.unref?.()
      })
      void run()
    },
    async close() { stopped = true; clearTimeout(debounce); clearTimeout(wakeTimer); unsubscribe?.(); await running?.catch(() => {}) },
  }
}
