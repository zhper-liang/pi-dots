import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './calendar.css'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'
import { applyWorkspaceReceipt, isWorkspacePermissionError, workspacePermissionKey, type PermissionSource, type WorkspaceRead } from './workspace-refresh.mjs'
import EditorDialog from './EditorDialog'
import LocalTimePicker from './LocalTimePicker'
import { getLocalTimezone, localInstant, type LocalDateTime } from './local-time.mjs'
import { type Mode, type EventTimeDraft, eventTimeDraft, eventTimeData, addDays, weekday, dayKey as calendarDayKey, dayStart as calendarDayStart, dueDay as calendarDueDay, eventDays as calendarEventDays, hm as calendarHm, layoutDay as calendarLayoutDay, periodDays, shiftAnchor, toOffsetIso as calendarIso } from './calendar-layout.mjs'

type Item = { id: string; sourceId: string; title: string; version: number; due?: string | null; timezone?: string; start?: string; end?: string; description?: string; deletedAt?: string | null; status?: string }
type Ev = Item & { key: string; s: number; e: number; local: boolean }
type Receipt = { requestId: string; state: string; receipt?: { target?: { id: string }; version?: number; deletedAt?: string | null } }
type Draft = EventTimeDraft & { title: string; description: string }
type Pop =
  | ({ kind: 'create' } & Draft)
  | { kind: 'detail'; ev: Ev }
  | ({ kind: 'edit'; ev: Ev; moved?: boolean } & Draft)
  | { kind: 'delete'; ev: Ev }
  | { kind: 'conflict'; ev: Ev }
const HOUR = 48 // px per hour
const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const PALETTE = ['var(--c-text-2)', 'var(--c-muted)', 'var(--c-text-4)']
const sourceName = (id: string) => id === 'local' ? '本地日程' : id.startsWith('feishu') ? '飞书日历' : `外部日历 ${id}`
const label = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`

export default function CalendarBoard({ token, initialMode = 'week', active = true, refreshKey, onChanged }: { token: string; initialMode?: Mode; active?: boolean; refreshKey?: number; onChanged?: () => void }) {
  const [timezone] = useState(getLocalTimezone)
  const dayKey = (ms: number) => calendarDayKey(ms, timezone)
  const dayStart = useCallback((key: string) => calendarDayStart(key, timezone), [timezone])
  const hm = (ms: number) => calendarHm(ms, timezone)
  const toOffsetIso = useCallback((ms: number) => calendarIso(ms, timezone), [timezone])
  const [now, setNow] = useState(() => Date.now())
  const today = dayKey(now)
  const [mode, setMode] = useState<Mode>(initialMode), [anchor, setAnchor] = useState(() => dayKey(Date.now()))
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [local, setLocal] = useState<Item[]>([]), [todos, setTodos] = useState<Item[]>([]), [external, setExternal] = useState<Item[]>([])
  const [extSources, setExtSources] = useState<string[]>([]), [extWarning, setExtWarning] = useState('')
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [pop, setPop] = useState<Pop | null>(null), [unconfirmed, setUnconfirmed] = useState(false)
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 719px)').matches)
  const [canRetry, setCanRetry] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const permission = useRef(''), identityToken = useRef(token), latestToken = useRef(token)
  latestToken.current = token
  const running = useRef(false)
  const pending = useRef<{ key: string; requestId: string } | null>(null)
  const generation = useRef(0), scroller = useRef<HTMLDivElement>(null), drag = useRef<{ key: string; offset: number } | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const rememberOpener = () => { if (!pop && document.activeElement instanceof HTMLElement) opener.current = document.activeElement }
  const days = useMemo(() => periodDays(mode, anchor), [mode, anchor])

  const api = useCallback(async <T,>(path: string, input?: object, signal?: AbortSignal): Promise<T> => {
    let response: Response
    try { response = await fetch(`/api/workspace/${path}`, { signal, method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }) }
    catch { const err = new Error('network'); err.name = 'NetworkError'; throw err }
    const body = await response.json().catch(() => { const err = new Error('回执读取中断'); err.name = 'NetworkError'; throw err })
    if (!response.ok) { const err = new Error(body.error?.message ?? '操作没有成功，请稍后再试。'); err.name = response.status >= 500 ? 'NetworkError' : body.error?.code ?? String(response.status); if (isWorkspacePermissionError(Object.assign(err, { status: response.status })) && latestToken.current === token && !signal?.aborted) { clearProjection(true); setRefreshError('权限已失效，已隐藏旧数据。') }; throw err }
    return body.data as T
  }, [token])
  function clearProjection(sensitive = false) {
    setLocal([]); setTodos([]); setExternal([]); setExtSources([]); setAuthorized(null)
    if (sensitive) { generation.current++; setPop(null); setNotice(''); permission.current = ''; running.current = false; setBusy(false); if (pending.current) setUnconfirmed(true) }
  }
  const load = async ({ signal, isCurrent }: WorkspaceRead) => {
    const gen = generation.current
    setLoading(true)
    const current = () => isCurrent() && gen === generation.current
    const permissions = async () => {
      const [localStatus, externalStatus] = await Promise.all([
        api<{ sources: PermissionSource[] }>('status', undefined, signal),
        api<{ sources: PermissionSource[] }>('external-sources', {}, signal)
      ])
      return { local: localStatus.sources, external: externalStatus.sources, key: workspacePermissionKey(localStatus.sources, externalStatus.sources) }
    }
    try {
      const before = await permissions()
      if (!current()) return
      if (permission.current && permission.current !== before.key) {
        clearProjection(true); permission.current = before.key
        void refresh(); return
      }
      permission.current = before.key
      if (before.local.find(source => source.id === 'local')?.authorized === false) {
        clearProjection(true); setAuthorized(false); setRefreshError('当前来源权限已失效，已隐藏旧数据。'); return
      }
      // The owner has implicit local access. Pagination and external full-scope rules remain unchanged.
      const pageAll = async (type: 'Event' | 'Todo') => {
        const out: Item[] = []; let cursor: number | undefined = 0
        while (cursor !== undefined) {
          if (!current()) return out
          const p: { items: Item[]; next?: number } = await api('query', { type, sourceId: 'local', cursor, limit: 100 }, signal)
          out.push(...p.items); cursor = p.next
        }
        return out
      }
      const [ev, td] = await Promise.all([pageAll('Event'), pageAll('Todo')])
      if (!current()) return
      const ext: Item[] = [], extTodos: Item[] = [], names: string[] = []; let warn = ''
      const sources = before.external
      const start = toOffsetIso(dayStart(days[0])), end = toOffsetIso(dayStart(addDays(days[days.length - 1], 1)))
      for (const source of sources.filter(x => x.authorized && x.readScope === 'full')) {
        if (!current()) return
        names.push(source.id)
        try {
          const page = await api<{ items: Item[]; complete: boolean; stale?: boolean }>('external-query', { sourceId: source.id, start, end, timezone }, signal)
          if (!current()) return
          if (!page.complete || page.stale) warn = '外部日程不完整，不代表空闲'
          // R3: Todo-type sources (Google Tasks) show as due-day chips, never as timed blocks (D8).
          ;(source.itemType === 'Todo' ? extTodos : ext).push(...page.items.filter(item => !item.deletedAt).map(item => ({ ...item, sourceId: source.id })))
        } catch (error) {
          if (!current()) return
          if (isWorkspacePermissionError(error)) throw error
          // A failed source must not leave its previously authorized body on screen.
          setExternal(items => items.filter(item => item.sourceId !== source.id))
          warn = '外部日程暂时无法核验，不代表空闲'
        }
      }
      const after = await permissions()
      if (!current()) return
      if (after.key !== before.key) { clearProjection(true); permission.current = after.key; void refresh(); return }
      setLocal(ev); setTodos([...td, ...extTodos]); setExternal(ext); setExtSources(names); setExtWarning(warn); setAuthorized(true); setRefreshError('')
    } catch (error) {
      if (!current()) return
      // No permission proof is preferable to keeping a potentially revoked cached projection.
      clearProjection(isWorkspacePermissionError(error))
      setRefreshError(isWorkspacePermissionError(error) ? '权限已失效，已隐藏旧数据。' : '暂时无法核验工作区，已隐藏旧数据；连接恢复后自动重试。')
    } finally { if (isCurrent()) setLoading(false) }
  }
  const { refresh } = useWorkspaceRefresh({
    scopeKey: JSON.stringify([token, 'local+external-full', days[0], days.at(-1), timezone]), active, refreshKey, load,
    onInvalidate: () => {
      const tokenChanged = identityToken.current !== token
      identityToken.current = token
      generation.current++
      clearProjection(tokenChanged)
      if (pending.current && !tokenChanged) { running.current = false; setBusy(false); setUnconfirmed(true) }
      setRefreshError(''); setLoading(false)
      if (tokenChanged) { pending.current = null; setUnconfirmed(false); setCanRetry(false); setError(''); setBusy(false); running.current = false }
    },
    onError: () => { clearProjection(); setLoading(false); setRefreshError('工作区读取超时，已隐藏旧数据；稍后自动重试。') }
  })
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t) }, [])
  useEffect(() => { const m = window.matchMedia('(max-width: 719px)'), f = () => setNarrow(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = HOUR * 7.5 }, [mode, narrow])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return
      const t = e.target as HTMLElement | null
      if (pop || t?.closest('input,textarea,select,[contenteditable="true"]')) return
      if (e.key === 'ArrowLeft') setAnchor(a => shiftAnchor(mode, a, -1))
      if (e.key === 'ArrowRight') setAnchor(a => shiftAnchor(mode, a, 1))
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [mode, pop, active, busy])

  const colors = useMemo(() => { const m: Record<string, string> = { local: 'var(--c-text-2)' }; extSources.forEach((s, i) => { m[s] = PALETTE[i % PALETTE.length] }); return m }, [extSources])
  const events = useMemo<Ev[]>(() => [...local.map(i => ({ ...i, local: true })), ...external.map(i => ({ ...i, local: false }))]
    .filter(i => !i.deletedAt && i.start && i.end)
    .map(i => ({ ...i, key: `${i.sourceId}|${i.id}`, s: Date.parse(i.start!), e: Date.parse(i.end!) }))
    .filter(i => !Number.isNaN(i.s) && !Number.isNaN(i.e)), [local, external])
  const byDay = useMemo(() => { const m: Record<string, Ev[]> = {}; for (const ev of events) for (const d of calendarEventDays(ev.s, ev.e, timezone)) (m[d] ??= []).push(ev); for (const d in m) m[d].sort((a, b) => a.s - b.s); return m }, [events, timezone])
  const dueByDay = useMemo(() => { const m: Record<string, Item[]> = {}; for (const t of todos) { const d = !t.deletedAt && calendarDueDay(t.due, timezone); if (d) (m[d] ??= []).push(t) } return m }, [todos, timezone])

  async function command(input: object, done: string) {
    if (running.current) return
    const gen = generation.current, operationToken = token
    const current = () => gen === generation.current && latestToken.current === operationToken
    const key = JSON.stringify(input)
    if (pending.current && pending.current.key !== key) { setError('上次请求结果未确认，请先查询原请求，不能换参数重试。'); return }
    if (!pending.current) pending.current = { key, requestId: crypto.randomUUID() }
    running.current = true; setCanRetry(false)
    setBusy(true); setError(''); setNotice('')
    try {
      const receipt = await api<Receipt>('command', { ...input, requestId: pending.current.requestId })
      if (!current()) return
      if (receipt.state !== 'succeeded') { setUnconfirmed(true); setError(`请求状态：${receipt.state}，请查询原请求。`); return }
      pending.current = null; setUnconfirmed(false); setPop(null); setNotice(done); setLocal(items => applyWorkspaceReceipt(items, input, receipt)); onChanged?.(); void refresh(true)
    } catch (e) {
      if (!current()) return
      const err = e as Error
      if (err.name === 'NetworkError') { setUnconfirmed(true); setError('结果未确认，可查询原请求') }
      else if (err.name === 'WORKSPACE_VERSION_CONFLICT') {
        pending.current = null; setUnconfirmed(false)
        const id = (input as { id: string }).id
        try {
          const detail = await api<{ items: Item[] }>('get', { type: 'Event', sourceId: 'local', id })
          if (!current()) return
          const latest = detail.items[0]
          if (latest) setPop({ kind: 'conflict', ev: { ...latest, key: `${latest.sourceId}|${latest.id}`, local: true, s: Date.parse(latest.start!), e: Date.parse(latest.end!) } })
          else { setPop(null); setError('这条日程已不存在，将自动更新。') }
        } catch { if (current()) setError('版本冲突，未覆盖日程；当前版本读取失败，请稍后重新确认。') }
      }
      else { pending.current = null; setError(err.message) }
    } finally { if (current()) { running.current = false; setBusy(false) } }
  }
  async function lookup() {
    if (!pending.current || running.current) return
    const gen = generation.current, operationToken = token
    const current = () => gen === generation.current && latestToken.current === operationToken
    running.current = true
    setBusy(true); setError('')
    try {
      const op = await api<Receipt | null>('operation', { requestId: pending.current.requestId, sourceId: 'local' })
      if (!current()) return
      if (!op) { setCanRetry(true); setError('未查到原请求。可再次查询，或按原请求标识和原参数重试，不会重复创建。'); return }
      if (op.state !== 'succeeded') { setError(`原请求状态：${op.state}，尚不能确认完成；请继续查询，勿新建请求。`); return }
      pending.current = null; setUnconfirmed(false); setPop(null); setNotice('已确认上次操作完成。'); onChanged?.(); void refresh(true)
    } catch (e) { if (current()) setError((e as Error).name === 'NetworkError' ? '仍无法连接，请稍后再查询。' : (e as Error).message) }
    finally { if (current()) { running.current = false; setBusy(false) } }
  }
  function save() {
    if (!pop || (pop.kind !== 'create' && pop.kind !== 'edit')) return
    if (!pop.title.trim()) { setError('请填写标题。'); return }
    const timing = eventTimeData(pop)
    if (timing.error) { setError(timing.error); return }
    const data = { title: pop.title.trim(), description: pop.description, ...timing }
    if (pop.kind === 'create') void command({ sourceId: 'local', type: 'Event', action: 'create', data }, '已添加日程。')
    else void command({ sourceId: 'local', type: 'Event', action: 'update', id: pop.ev.id, expectedVersion: pop.ev.version, data }, '已更新日程。')
  }
  async function openEdit(ev: Ev) {
    if (!ev.local || running.current || pending.current) return
    rememberOpener()
    const gen = generation.current, operationToken = token
    const current = () => gen === generation.current && latestToken.current === operationToken
    running.current = true
    setBusy(true); setError('')
    try {
      const detail = await api<{ items: Item[] }>('get', { type: 'Event', sourceId: 'local', id: ev.id })
      if (!current()) return
      const latest = detail.items[0]
      if (!latest || latest.deletedAt) { setPop(null); setError('这条日程已被删除。'); void refresh(true); return }
      const fresh: Ev = { ...ev, ...latest, s: Date.parse(latest.start!), e: Date.parse(latest.end!) }
      setPop({ kind: 'edit', ev: fresh, title: fresh.title, description: fresh.description ?? '', ...eventTimeDraft(fresh.s, fresh.e, fresh.timezone, timezone) })
    } catch (e) { if (current()) setError((e as Error).name === 'NetworkError' ? '连接中断，请稍后再试。' : (e as Error).message) }
    finally { if (current()) { running.current = false; setBusy(false) } }
  }
  function slotCreate(day: string, hour: number) {
    if (running.current || pending.current) return
    if (!authorized) { setError('本地日程读取失败，将自动更新。'); return }
    const s = localInstant({ date: day, time: `${String(hour).padStart(2, '0')}:00`, timezone })
    if (s === null) { setError('该本机时间不存在，请选择其他时段。'); return }
    rememberOpener(); setError(''); setPop({ kind: 'create', title: '', description: '', ...eventTimeDraft(s, s + 3600000, timezone, timezone) })
  }
  function drop(day: string, clientY: number, col: HTMLElement) {
    const d = drag.current; drag.current = null
    const ev = d && events.find(x => x.key === d.key)
    if (!ev || !ev.local || narrow || running.current || pending.current) return
    const y = clientY - col.getBoundingClientRect().top - d.offset
    const minutes = Math.max(0, Math.round(y / HOUR * 4) * 15)
    const s = localInstant({ date: addDays(day, Math.floor(minutes / 1440)), time: `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`, timezone }), dur = ev.e - ev.s
    if (s === null) { setError('该本机时间不存在，请选择其他时段。'); return }
    if (s === ev.s) return
    rememberOpener(); setPop({ kind: 'edit', ev, title: ev.title, description: ev.description ?? '', ...eventTimeDraft(s, s + dur, ev.timezone, timezone), moved: true })
  }
  const rangeLabel = mode === 'month' ? `${anchor.slice(0, 4)}年${Number(anchor.slice(5, 7))}月` : mode === 'day' ? `${anchor.slice(0, 4)}年${label(anchor)} 周${WEEK[weekday(anchor)]}` : `${anchor.slice(0, 4)}年${label(days[0])} – ${label(days[6])}`
  const evButton = (ev: Ev, style?: CSSProperties, compact = false) => (
    <button key={ev.key} type="button" className={`cal-event${ev.local ? ' is-local' : ''}${compact ? ' is-compact' : ''}`} style={{ ...style, ['--ev' as string]: colors[ev.sourceId] ?? '#888' }}
      draggable={ev.local && mode !== 'month' && !narrow && !busy && !unconfirmed}
      onDragStart={e => { drag.current = { key: ev.key, offset: e.clientY - e.currentTarget.getBoundingClientRect().top }; e.dataTransfer.effectAllowed = 'move' }}
      onClick={e => { e.stopPropagation(); if (busy || pending.current) return; rememberOpener(); setError(''); if (narrow && ev.local) void openEdit(ev); else setPop({ kind: 'detail', ev }) }}
      onDragEnd={() => { drag.current = null }}
      aria-label={`${ev.title || '无标题'}，${hm(ev.s)} 到 ${hm(ev.e)}，${sourceName(ev.sourceId)}`}>
      <span className="cal-event-time">{hm(ev.s)}</span><span className="cal-event-title">{ev.title || '无标题'}</span>
    </button>)
  const dueChips = (d: string) => (dueByDay[d] ?? []).map(t => <span key={t.id} className={`cal-due${t.status === 'completed' ? ' is-done' : ''}`} title={`截止：${t.title}`}>截止 · {t.title}</span>)

  function timeGrid() {
    return <div className="cal-grid-wrap">
      <div className="cal-grid-head" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <span />
        {days.map(d => <div key={d} className={`cal-head-day${d === today ? ' is-today' : ''}`}>
          <span className="cal-head-week">周{WEEK[days.length === 1 ? weekday(d) : days.indexOf(d)]}</span>
          <span className="cal-head-date">{Number(d.slice(8))}</span>
          <div className="cal-due-row">{dueChips(d)}</div>
        </div>)}
      </div>
      <div className="cal-grid-scroll" ref={scroller}>
        <div className="cal-grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)`, height: HOUR * 24 }}>
          <div className="cal-hours">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}</span>)}</div>
          {days.map(d => {
            const placed = calendarLayoutDay((byDay[d] ?? []).map(ev => ({ key: ev.key, start: ev.s, end: ev.e })), d, 20, timezone)
            return <div key={d} className={`cal-col${d === today ? ' is-today' : ''}`} aria-label={`${label(d)}日程`}
              onDragOver={e => { if (drag.current) e.preventDefault() }} onDrop={e => { e.preventDefault(); drop(d, e.clientY, e.currentTarget) }}>
              {Array.from({ length: 24 }, (_, h) => <button key={h} type="button" className="cal-slot" style={{ top: h * HOUR, height: HOUR }} aria-label={`在${label(d)} ${h}:00 新建日程`} onClick={() => slotCreate(d, h)} />)}
              {placed.map(p => { const ev = byDay[d].find(x => x.key === p.key)!; return evButton(ev, { top: p.top / 60 * HOUR, height: Math.max(p.height / 60 * HOUR - 2, 18), left: `calc(${p.col / p.cols * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)` }, p.height < 40) })}
              {d === today && <div className="cal-now" style={{ top: (Number(hm(now).slice(0, 2)) + Number(hm(now).slice(3)) / 60) * HOUR }} aria-hidden="true" />}
            </div>
          })}
        </div>
      </div>
    </div>
  }
  function agenda() {
    return <ol className="cal-agenda">{days.map(d => <li key={d} className={d === today ? 'is-today' : ''}>
      <h3>{label(d)} 周{WEEK[days.length === 1 ? weekday(d) : days.indexOf(d)]}{d === today && <em>今天</em>}</h3>
      <div className="cal-due-row">{dueChips(d)}</div>
      {(byDay[d] ?? []).length ? <ul>{byDay[d].map(ev => <li key={ev.key}>{evButton(ev)}</li>)}</ul> : <p className="cal-empty">没有安排</p>}
      {authorized && <button type="button" className="cal-link" onClick={() => slotCreate(d, 9)}>＋ 添加</button>}
    </li>)}</ol>
  }
  function month() {
    return <div className="cal-month">
      {WEEK.map(w => <div key={w} className="cal-month-week">周{w}</div>)}
      {days.map(d => { const list = byDay[d] ?? []; const out = d.slice(0, 7) !== anchor.slice(0, 7)
        return <div key={d} className={`cal-month-day${d === today ? ' is-today' : ''}${out ? ' is-out' : ''}`} onClick={() => slotCreate(d, 9)}>
          <button type="button" className="cal-month-date" onClick={e => { e.stopPropagation(); setAnchor(d); setMode('day') }} aria-label={`查看${label(d)}`}><span>{Number(d.slice(8))}</span></button>
          <div className="cal-due-row">{dueChips(d)}</div>
          {list.slice(0, 3).map(ev => evButton(ev, undefined, true))}
          {list.length > 3 && <button type="button" className="cal-more" onClick={e => { e.stopPropagation(); setAnchor(d); setMode('day') }}>+{list.length - 3} 更多</button>}
        </div> })}
    </div>
  }
  function popover() {
    if (!pop) return null
    const close = () => { if (!busy) setPop(null) }
    let body: ReactNode
    if (pop.kind === 'conflict') {
      const ev = pop.ev
      body = <>
        <h3 className="cal-dialog-heading">日程已变更，请重新确认</h3>
        <section className="cal-conflict" role="alert">
          <strong>服务端当前版本 {ev.version}</strong>
          <p>{ev.title}</p>
          <p>{label(dayKey(ev.s))} {hm(ev.s)} – {label(dayKey(ev.e))} {hm(ev.e)}</p>
          {ev.description && <p className="cal-pop-desc">{ev.description}</p>}
          <p>{ev.deletedAt ? '这条日程已删除，不能继续改期。' : '本次修改未保存，也没有覆盖当前内容。请按当前版本重新编辑，再明确保存。'}</p>
        </section>
        {error && <p className="cal-pop-error" role="alert">{error}</p>}
        <div className="cal-pop-actions">{!ev.deletedAt && <button type="button" className="cal-btn" disabled={busy} onClick={() => void openEdit(ev)}>按当前版本重新编辑</button>}<button type="button" className="cal-btn" onClick={close}>关闭</button></div>
      </>
    } else if (pop.kind === 'detail') {
      const ev = pop.ev
      body = <>
        <h3 className="cal-dialog-heading">{ev.title || '无标题'}</h3>
        <p className="cal-pop-time">{label(dayKey(ev.s))} {hm(ev.s)} – {dayKey(ev.e - 1) !== dayKey(ev.s) ? `${label(dayKey(ev.e - 1))} ` : ''}{hm(ev.e)}</p>
        <p className="cal-pop-source"><i style={{ background: colors[ev.sourceId] ?? '#888' }} />{sourceName(ev.sourceId)}{!ev.local && ' · 只读'}</p>
        {ev.description && <p className="cal-pop-desc">{ev.description}</p>}
        <div className="cal-pop-actions">
          {ev.local && <><button type="button" className="cal-btn" disabled={busy} onClick={() => void openEdit(ev)}>编辑</button><button type="button" className="cal-btn is-danger" disabled={busy} onClick={() => setPop({ kind: 'delete', ev })}>删除</button></>}
          <button type="button" className="cal-btn" onClick={close}>关闭</button>
        </div></>
    } else if (pop.kind === 'delete') {
      body = <>
        <h3 className="cal-dialog-heading">删除这条日程？</h3>
        <p>「{pop.ev.title || '无标题'}」 {label(dayKey(pop.ev.s))} {hm(pop.ev.s)}–{hm(pop.ev.e)}。删除后不会影响关联的待办。</p>
        <div className="cal-pop-actions"><button type="button" className="cal-btn is-danger-solid" disabled={busy || unconfirmed} onClick={() => void command({ sourceId: 'local', type: 'Event', action: 'delete', id: pop.ev.id, expectedVersion: pop.ev.version, confirmedDelete: true }, '已删除日程。')}>确认删除</button><button type="button" className="cal-btn" onClick={close}>取消</button></div></>
    } else {
      const p = pop
      body = <form onSubmit={e => { e.preventDefault(); save() }}>
        <h3 className="cal-dialog-heading">{p.kind === 'create' ? '新建日程' : p.moved ? '确认调整时间' : '编辑日程'}</h3>
        {p.kind === 'edit' && p.moved && <p className="cal-pop-hint">从 {label(dayKey(p.ev.s))} {hm(p.ev.s)} 移到 {label(p.start.date)} {p.start.time}，确认后保存。</p>}
        <fieldset className="cal-edit-fields" disabled={busy || unconfirmed}><legend className="cal-pop-hint">{p.kind === 'edit' ? `本地日程 · 当前版本 ${p.ev.version}` : '本地日程'}</legend>
        <label className="cal-field">标题<input disabled={busy || unconfirmed} autoFocus required maxLength={500} value={p.title} onChange={e => setPop({ ...p, title: e.target.value })} placeholder="例如：看电影" /></label>
        <div className="cal-time-pickers">
          <LocalTimePicker label="开始" date={p.start.date} time={p.start.time} timezone={p.start.timezone} disabled={busy || unconfirmed} onChange={(start: LocalDateTime) => setPop({ ...p, start })} />
          <LocalTimePicker label="结束" date={p.end.date} time={p.end.time} timezone={p.end.timezone} disabled={busy || unconfirmed} onChange={(end: LocalDateTime) => setPop({ ...p, end })} />
        </div>
        <label className="cal-field">说明（可选）<textarea disabled={busy || unconfirmed} maxLength={4000} rows={2} value={p.description} onChange={e => setPop({ ...p, description: e.target.value })} /></label></fieldset>
        {error && <p className="cal-pop-error" role="alert">{error}</p>}
        {unconfirmed && <button type="button" className="cal-btn" disabled={busy} onClick={() => void lookup()}>查询原请求结果</button>}
        {unconfirmed && canRetry && <button type="button" className="cal-btn" disabled={busy} onClick={() => { if (pending.current) void command(JSON.parse(pending.current.key), '已按原请求确认保存。') }}>按原请求重试</button>}
        <div className="cal-pop-actions"><button type="submit" className="cal-btn is-primary" disabled={busy || unconfirmed}>{busy ? '正在保存…' : '保存'}</button><button type="button" className="cal-btn" onClick={close}>取消</button></div>
        <p className="cal-pop-hint">按本机时间显示；编辑保留日程原时区。普通日程不会自动执行 Bot。</p>
      </form>
    }
    const title = pop.kind === 'create' ? '新建日程' : pop.kind === 'edit' ? (pop.moved ? '确认调整时间' : '编辑日程') : pop.kind === 'delete' ? '删除这条日程？' : pop.kind === 'conflict' ? '日程已变更，请重新确认' : pop.ev.title || '无标题'
    return <EditorDialog open={active} title={title} onClose={close} pending={busy} returnFocus={opener} initialFocus="input,button">
      <div className="cal-pop-content">{body}{(pop.kind === 'delete' || pop.kind === 'detail') && error && <p className="cal-pop-error" role="alert">{error}</p>}{(pop.kind === 'delete' || pop.kind === 'detail') && unconfirmed && <button type="button" className="cal-btn" disabled={busy} onClick={() => void lookup()}>查询原请求结果</button>}</div>
    </EditorDialog>
  }

  const showAgenda = narrow && mode === 'week'
  return <section className="cal" aria-label="日历">
    <div className="cal-main">
    <div className="cal-workspace">
    <section className="cal-calendar-pane" aria-label="日程视图">
    <header className="cal-toolbar">
      <div className="cal-nav">
        <button type="button" className="cal-btn" onClick={() => setAnchor(a => shiftAnchor(mode, a, -1))} aria-label={`上一${mode === 'day' ? '天' : mode === 'week' ? '周' : '月'}`}>‹ 上一{mode === 'day' ? '天' : mode === 'week' ? '周' : '月'}</button>
        <button type="button" className="cal-btn" onClick={() => setAnchor(today)}>今天</button>
        <button type="button" className="cal-btn" onClick={() => setAnchor(a => shiftAnchor(mode, a, 1))} aria-label={`下一${mode === 'day' ? '天' : mode === 'week' ? '周' : '月'}`}>下一{mode === 'day' ? '天' : mode === 'week' ? '周' : '月'} ›</button>
        <h2 className="cal-range" aria-live="polite">{rangeLabel}</h2>
      </div>
      <div className="cal-modes" role="group" aria-label="视图">
        {(['day', 'week', 'month'] as Mode[]).map(m => <button key={m} type="button" className={`cal-mode${mode === m ? ' is-active' : ''}`} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'day' ? '日' : m === 'week' ? '周' : '月'}</button>)}
      </div>
    </header>
    <div className="cal-legend" aria-label="来源图例">
      {authorized && <span><i style={{ background: colors.local }} />本地日程</span>}
      {extSources.map(s => <span key={s}><i style={{ background: colors[s] }} />{sourceName(s)}</span>)}
      {todos.some(t => t.due) && <span><i className="is-due" />待办截止</span>}
    </div>
    {loading && authorized === null && <p role="status">正在读取日程…</p>}
    {refreshError && <div className="cal-banner is-warn" role="status">{refreshError}</div>}
    {extWarning && <div className="cal-banner is-warn" role="status">{extWarning}</div>}
    {(error || unconfirmed) && !pop && <div className="cal-banner is-error" role="alert">{error || '上次日程请求结果未确认。'}{unconfirmed && <button type="button" className="cal-link" disabled={busy} onClick={() => void lookup()}>查询原请求结果</button>}{unconfirmed && canRetry && <button type="button" className="cal-link" disabled={busy} onClick={() => { if (pending.current) void command(JSON.parse(pending.current.key), '已按原请求确认保存。') }}>按原请求重试</button>}</div>}
    {notice && <div className="cal-banner is-ok" role="status">{notice}</div>}
    {mode === 'month' ? month() : showAgenda ? agenda() : timeGrid()}
    </section>
    </div>
    </div>
    {active && popover()}
  </section>
}
