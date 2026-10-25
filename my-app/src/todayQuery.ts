// Same local + external query logic as CalendarBoard.load, scoped to a single day. Read-only.
import { addDays, dayKey, dayStart, dueDay, toOffsetIso } from './calendar-layout.mjs'

export type DayItem = { id: string; sourceId: string; title: string; version: number; due?: string | null; start?: string; end?: string; deletedAt?: string | null; status?: string }
export type DayData = { authorized: boolean; events: DayItem[]; todos: DayItem[]; warning: string }
const ZONE = 'Asia/Shanghai'

function workspaceApi(token: string, signal?: AbortSignal) {
  return async <T,>(path: string, input?: object): Promise<T> => {
    let response: Response
    try { response = await fetch(`/api/workspace/${path}`, { method: input ? 'POST' : 'GET', signal, headers: { Authorization: `Bearer ${token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }) }
    catch (e) { if (signal?.aborted) throw e; const err = new Error('连接中断，暂时无法读取今天的安排。'); err.name = 'NetworkError'; throw err }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error?.message ?? '读取没有成功，请稍后再试。')
    return body.data as T
  }
}

export async function loadDay(token: string, day: string, signal?: AbortSignal): Promise<DayData> {
  const api = workspaceApi(token, signal)
  const status = await api<{ sources: { id: string; authorized: boolean }[] }>('status')
  const authorized = status.sources.find(s => s.id === 'local')?.authorized ?? false
  const pageAll = async (type: 'Event' | 'Todo') => {
    const out: DayItem[] = []; let cursor: number | undefined = 0
    while (cursor !== undefined) { const p: { items: DayItem[]; next?: number } = await api('query', { type, sourceId: 'local', cursor, limit: 100 }); out.push(...p.items); cursor = p.next }
    return out
  }
  const [ev, td] = authorized ? await Promise.all([pageAll('Event'), pageAll('Todo')]) : [[], []]
  const from = dayStart(day), to = dayStart(addDays(day, 1))
  const ext: DayItem[] = []; let warning = ''
  try {
    const { sources } = await api<{ sources: { id: string; authorized: boolean; readScope: string }[] }>('external-sources', {})
    for (const s of sources.filter(x => x.authorized && x.readScope === 'full')) {
      try {
        const p = await api<{ items: DayItem[]; complete: boolean; stale?: boolean }>('external-query', { sourceId: s.id, start: toOffsetIso(from), end: toOffsetIso(to), timezone: ZONE })
        if (!p.complete || p.stale) warning = '外部日程不完整，不代表空闲'
        ext.push(...p.items.filter(i => !i.deletedAt).map(i => ({ ...i, sourceId: s.id })))
      } catch { warning = '外部日程不完整，不代表空闲' }
    }
  } catch (e) { if (signal?.aborted) throw e; warning = '外部日程暂时无法读取，不代表空闲' }
  const overlaps = (i: DayItem) => { const s = Date.parse(i.start ?? ''), e = Date.parse(i.end ?? ''); return Number.isFinite(s) && Number.isFinite(e) && s < to && Math.max(e, s + 1) > from }
  const events = [...ev.filter(i => !i.deletedAt), ...ext].filter(overlaps).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!))
  const todos = td.filter(i => { const d = dueDay(i.due); return !i.deletedAt && i.status !== 'completed' && d !== null && d <= day })
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
  return { authorized, events, todos, warning }
}
export const todayKey = () => dayKey(Date.now())
