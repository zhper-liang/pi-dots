import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './calendar.css'
import { type Mode, addDays, dayKey, dayStart, dueDay, eventDays, hm, layoutDay, periodDays, shiftAnchor, toOffsetIso } from './calendar-layout.mjs'

type Item = { id: string; sourceId: string; title: string; version: number; due?: string | null; timezone?: string; start?: string; end?: string; description?: string; deletedAt?: string | null; status?: string }
type Ev = Item & { key: string; s: number; e: number; local: boolean }
type Receipt = { requestId: string; state: string }
type Pop =
  | { kind: 'create'; title: string; description: string; start: number; end: number }
  | { kind: 'detail'; ev: Ev }
  | { kind: 'edit'; ev: Ev; title: string; description: string; start: number; end: number; moved?: boolean }
  | { kind: 'delete'; ev: Ev }
const ZONE = 'Asia/Shanghai', HOUR = 48 // px per hour
const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const PALETTE = ['#6b7cff', '#e8833a', '#2f9e6e', '#c2477d', '#8a63d2', '#2a8fbd']
const sourceName = (id: string) => id === 'local' ? '本地日程' : id.startsWith('feishu') ? '飞书日历' : `外部日历 ${id}`
const toLocalInput = (ms: number) => toOffsetIso(ms).slice(0, 16)
const fromLocalInput = (v: string) => Date.parse(`${v}:00+08:00`)
const label = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`

export default function CalendarBoard({ token }: { token: string }) {
  const [now, setNow] = useState(() => Date.now())
  const today = dayKey(now)
  const [mode, setMode] = useState<Mode>('week'), [anchor, setAnchor] = useState(() => dayKey(Date.now()))
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [local, setLocal] = useState<Item[]>([]), [todos, setTodos] = useState<Item[]>([]), [external, setExternal] = useState<Item[]>([])
  const [extSources, setExtSources] = useState<string[]>([]), [extWarning, setExtWarning] = useState('')
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [pop, setPop] = useState<Pop | null>(null), [unconfirmed, setUnconfirmed] = useState(false)
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 719px)').matches)
  const pending = useRef<{ key: string; requestId: string } | null>(null)
  const generation = useRef(0), scroller = useRef<HTMLDivElement>(null), drag = useRef<{ key: string; offset: number } | null>(null)
  const days = useMemo(() => periodDays(mode, anchor), [mode, anchor])

  const api = useCallback(async <T,>(path: string, input?: object): Promise<T> => {
    let response: Response
    try { response = await fetch(`/api/workspace/${path}`, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }) }
    catch { const err = new Error('network'); err.name = 'NetworkError'; throw err }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) { const err = new Error(body.error?.message ?? '操作没有成功，请稍后再试。'); err.name = body.error?.code ?? String(response.status); throw err }
    return body.data as T
  }, [token])
  const load = useCallback(async () => {
    const gen = ++generation.current
    setLoading(true); setError('')
    try {
      const pageAll = async (type: 'Event' | 'Todo') => {
        const out: Item[] = []; let cursor: number | undefined = 0
        while (cursor !== undefined) { const p: { items: Item[]; next?: number } = await api('query', { type, sourceId: 'local', cursor, limit: 100 }); out.push(...p.items); cursor = p.next }
        return out
      }
      // The owner has implicit access to local data; a failure here is a read error, not a missing grant.
      let ev: Item[] = [], td: Item[] = [], localError = ''
      try { [ev, td] = await Promise.all([pageAll('Event'), pageAll('Todo')]) } catch { localError = '本地日程读取失败，请刷新。' }
      if (gen !== generation.current) return
      setAuthorized(!localError); if (localError) setError(localError)
      // External: only full-scope authorized sources, query the visible window.
      const ext: Item[] = []; const names: string[] = []; let warn = ''
      try {
        const { sources } = await api<{ sources: { id: string; authorized: boolean; readScope: string }[] }>('external-sources', {})
        const start = toOffsetIso(dayStart(days[0])), end = toOffsetIso(dayStart(addDays(days[days.length - 1], 1)))
        for (const s of sources.filter(x => x.authorized && x.readScope === 'full')) {
          names.push(s.id)
          try {
            const p = await api<{ items: Item[]; complete: boolean; stale?: boolean }>('external-query', { sourceId: s.id, start, end, timezone: ZONE })
            if (!p.complete || p.stale) warn = '外部日程不完整，不代表空闲'
            ext.push(...p.items.filter(i => !i.deletedAt).map(i => ({ ...i, sourceId: s.id })))
          } catch { warn = '外部日程不完整，不代表空闲' }
        }
      } catch { warn = '外部日程暂时无法读取，不代表空闲' }
      if (gen !== generation.current) return
      setLocal(ev); setTodos(td); setExternal(ext); setExtSources(names); setExtWarning(warn)
    } catch (e) {
      if (gen !== generation.current) return
      setError(e instanceof Error && e.name !== 'NetworkError' ? e.message : '连接中断，暂时无法读取日程。')
    } finally { if (gen === generation.current) setLoading(false) }
  }, [api, days])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t) }, [])
  useEffect(() => { const m = window.matchMedia('(max-width: 719px)'), f = () => setNarrow(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = HOUR * 7.5 }, [mode, narrow, authorized])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPop(null); return }
      const t = e.target as HTMLElement | null
      if (pop || t?.closest('input,textarea,select,[contenteditable="true"]')) return
      if (e.key === 'ArrowLeft') setAnchor(a => shiftAnchor(mode, a, -1))
      if (e.key === 'ArrowRight') setAnchor(a => shiftAnchor(mode, a, 1))
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [mode, pop])

  const colors = useMemo(() => { const m: Record<string, string> = { local: 'var(--cal-local, #1f6feb)' }; extSources.forEach((s, i) => { m[s] = PALETTE[i % PALETTE.length] }); return m }, [extSources])
  const events = useMemo<Ev[]>(() => [...local.map(i => ({ ...i, local: true })), ...external.map(i => ({ ...i, local: false }))]
    .filter(i => !i.deletedAt && i.start && i.end)
    .map(i => ({ ...i, key: `${i.sourceId}|${i.id}`, s: Date.parse(i.start!), e: Date.parse(i.end!) }))
    .filter(i => !Number.isNaN(i.s) && !Number.isNaN(i.e)), [local, external])
  const byDay = useMemo(() => { const m: Record<string, Ev[]> = {}; for (const ev of events) for (const d of eventDays(ev.s, ev.e)) (m[d] ??= []).push(ev); for (const d in m) m[d].sort((a, b) => a.s - b.s); return m }, [events])
  const dueByDay = useMemo(() => { const m: Record<string, Item[]> = {}; for (const t of todos) { const d = !t.deletedAt && dueDay(t.due); if (d) (m[d] ??= []).push(t) } return m }, [todos])

  async function command(input: object, done: string) {
    if (busy) return
    const key = JSON.stringify(input)
    if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() }
    setBusy(true); setError(''); setNotice('')
    try {
      await api<Receipt>('command', { ...input, requestId: pending.current.requestId })
      pending.current = null; setUnconfirmed(false); setPop(null); setNotice(done); await load()
    } catch (e) {
      const err = e as Error
      if (err.name === 'NetworkError') { setUnconfirmed(true); setError('结果未确认，可查询原请求') }
      else if (err.name === 'WORKSPACE_VERSION_CONFLICT') { pending.current = null; setPop(null); setError('这条日程刚被修改过，已为你刷新，请重新操作。'); await load() }
      else { pending.current = null; setError(err.message) }
    } finally { setBusy(false) }
  }
  async function lookup() {
    if (!pending.current || busy) return
    setBusy(true); setError('')
    try {
      const op = await api<Receipt | null>('operation', { requestId: pending.current.requestId, sourceId: 'local' })
      if (!op) { setError('还没有查到这次请求的结果。可以再次查询，或用相同内容重新保存（不会重复创建）。'); return }
      pending.current = null; setUnconfirmed(false); setPop(null); setNotice('已确认上次操作完成。'); await load()
    } catch (e) { setError((e as Error).name === 'NetworkError' ? '仍无法连接，请稍后再查询。' : (e as Error).message) }
    finally { setBusy(false) }
  }
  const eventData = (p: { title: string; description: string; start: number; end: number }) => ({ title: p.title.trim(), description: p.description, start: toOffsetIso(p.start), end: toOffsetIso(p.end), timezone: ZONE })
  function save() {
    if (!pop || (pop.kind !== 'create' && pop.kind !== 'edit')) return
    if (!pop.title.trim()) { setError('请填写标题。'); return }
    if (!(pop.end > pop.start)) { setError('结束时间需要晚于开始时间。'); return }
    if (pop.kind === 'create') void command({ sourceId: 'local', type: 'Event', action: 'create', data: eventData(pop) }, '已添加日程。')
    else void command({ sourceId: 'local', type: 'Event', action: 'update', id: pop.ev.id, expectedVersion: pop.ev.version, data: eventData(pop) }, '已更新日程。')
  }
  async function openEdit(ev: Ev) {
    setBusy(true); setError('')
    try {
      const detail = await api<{ items: Item[] }>('get', { type: 'Event', sourceId: 'local', id: ev.id })
      const latest = detail.items[0]
      if (!latest || latest.deletedAt) { setPop(null); setError('这条日程已被删除。'); await load(); return }
      const fresh: Ev = { ...ev, ...latest, s: Date.parse(latest.start!), e: Date.parse(latest.end!) }
      setPop({ kind: 'edit', ev: fresh, title: fresh.title, description: fresh.description ?? '', start: fresh.s, end: fresh.e })
    } catch (e) { setError((e as Error).name === 'NetworkError' ? '连接中断，请稍后再试。' : (e as Error).message) }
    finally { setBusy(false) }
  }
  function slotCreate(day: string, hour: number) {
    if (!authorized) { setError('本地日程读取失败，请刷新。'); return }
    const s = dayStart(day) + hour * 3600000
    setError(''); setPop({ kind: 'create', title: '', description: '', start: s, end: s + 3600000 })
  }
  function drop(day: string, clientY: number, col: HTMLElement) {
    const d = drag.current; drag.current = null
    const ev = d && events.find(x => x.key === d.key)
    if (!ev || !ev.local) return
    const y = clientY - col.getBoundingClientRect().top - d.offset
    const minutes = Math.max(0, Math.round(y / HOUR * 4) * 15)
    const s = dayStart(day) + minutes * 60000, dur = ev.e - ev.s
    if (s === ev.s) return
    setPop({ kind: 'edit', ev, title: ev.title, description: ev.description ?? '', start: s, end: s + dur, moved: true })
  }
  const rangeLabel = mode === 'month' ? `${anchor.slice(0, 4)}年${Number(anchor.slice(5, 7))}月` : mode === 'day' ? `${anchor.slice(0, 4)}年${label(anchor)} 周${WEEK[(new Date(dayStart(anchor) + 8 * 3600000).getUTCDay() + 6) % 7]}` : `${anchor.slice(0, 4)}年${label(days[0])} – ${label(days[6])}`
  const evButton = (ev: Ev, style?: CSSProperties, compact = false) => (
    <button key={ev.key} type="button" className={`cal-event${ev.local ? ' is-local' : ''}${compact ? ' is-compact' : ''}`} style={{ ...style, ['--ev' as string]: colors[ev.sourceId] ?? '#888' }}
      draggable={ev.local && mode !== 'month' && !narrow && !busy}
      onDragStart={e => { drag.current = { key: ev.key, offset: e.clientY - e.currentTarget.getBoundingClientRect().top }; e.dataTransfer.effectAllowed = 'move' }}
      onClick={e => { e.stopPropagation(); setPop({ kind: 'detail', ev }) }}
      aria-label={`${ev.title || '无标题'}，${hm(ev.s)} 到 ${hm(ev.e)}，${sourceName(ev.sourceId)}`}>
      <span className="cal-event-time">{hm(ev.s)}</span><span className="cal-event-title">{ev.title || '无标题'}</span>
    </button>)
  const dueChips = (d: string) => (dueByDay[d] ?? []).map(t => <span key={t.id} className={`cal-due${t.status === 'completed' ? ' is-done' : ''}`} title={`截止：${t.title}`}>截止 · {t.title}</span>)

  function timeGrid() {
    return <div className="cal-grid-wrap">
      <div className="cal-grid-head" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <span />
        {days.map(d => <div key={d} className={`cal-head-day${d === today ? ' is-today' : ''}`}>
          <span className="cal-head-week">周{WEEK[days.length === 1 ? (new Date(dayStart(d) + 8 * 3600000).getUTCDay() + 6) % 7 : days.indexOf(d)]}</span>
          <span className="cal-head-date">{Number(d.slice(8))}</span>
          <div className="cal-due-row">{dueChips(d)}</div>
        </div>)}
      </div>
      <div className="cal-grid-scroll" ref={scroller}>
        <div className="cal-grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)`, height: HOUR * 24 }}>
          <div className="cal-hours">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}</span>)}</div>
          {days.map(d => {
            const placed = layoutDay((byDay[d] ?? []).map(ev => ({ key: ev.key, start: ev.s, end: ev.e })), d)
            return <div key={d} className={`cal-col${d === today ? ' is-today' : ''}`} aria-label={`${label(d)}日程`}
              onDragOver={e => { if (drag.current) e.preventDefault() }} onDrop={e => { e.preventDefault(); drop(d, e.clientY, e.currentTarget) }}>
              {Array.from({ length: 24 }, (_, h) => <button key={h} type="button" className="cal-slot" style={{ top: h * HOUR, height: HOUR }} aria-label={`在${label(d)} ${h}:00 新建日程`} onClick={() => slotCreate(d, h)} />)}
              {placed.map(p => { const ev = byDay[d].find(x => x.key === p.key)!; return evButton(ev, { top: p.top / 60 * HOUR, height: Math.max(p.height / 60 * HOUR - 2, 18), left: `calc(${p.col / p.cols * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)` }, p.height < 40) })}
              {d === today && <div className="cal-now" style={{ top: (now - dayStart(d)) / 3600000 * HOUR }} aria-hidden="true" />}
            </div>
          })}
        </div>
      </div>
    </div>
  }
  function agenda() {
    return <ol className="cal-agenda">{days.map(d => <li key={d} className={d === today ? 'is-today' : ''}>
      <h3>{label(d)} 周{WEEK[days.length === 1 ? (new Date(dayStart(d) + 8 * 3600000).getUTCDay() + 6) % 7 : days.indexOf(d)]}{d === today && <em>今天</em>}</h3>
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
          <button type="button" className="cal-month-date" onClick={e => { e.stopPropagation(); setAnchor(d); setMode('day') }} aria-label={`查看${label(d)}`}>{Number(d.slice(8))}</button>
          <div className="cal-due-row">{dueChips(d)}</div>
          {list.slice(0, 3).map(ev => evButton(ev, undefined, true))}
          {list.length > 3 && <button type="button" className="cal-more" onClick={e => { e.stopPropagation(); setAnchor(d); setMode('day') }}>+{list.length - 3} 更多</button>}
        </div> })}
    </div>
  }
  function popover() {
    if (!pop) return null
    const close = () => setPop(null)
    let body: ReactNode
    if (pop.kind === 'detail') {
      const ev = pop.ev
      body = <>
        <h3 id="cal-pop-title">{ev.title || '无标题'}</h3>
        <p className="cal-pop-time">{label(dayKey(ev.s))} {hm(ev.s)} – {dayKey(ev.e - 1) !== dayKey(ev.s) ? `${label(dayKey(ev.e - 1))} ` : ''}{hm(ev.e)}</p>
        <p className="cal-pop-source"><i style={{ background: colors[ev.sourceId] ?? '#888' }} />{sourceName(ev.sourceId)}{!ev.local && ' · 只读'}</p>
        {ev.description && <p className="cal-pop-desc">{ev.description}</p>}
        <div className="cal-pop-actions">
          {ev.local && <><button type="button" className="cal-btn" disabled={busy} onClick={() => void openEdit(ev)}>编辑</button><button type="button" className="cal-btn is-danger" disabled={busy} onClick={() => setPop({ kind: 'delete', ev })}>删除</button></>}
          <button type="button" className="cal-btn" onClick={close}>关闭</button>
        </div></>
    } else if (pop.kind === 'delete') {
      body = <>
        <h3 id="cal-pop-title">删除这条日程？</h3>
        <p>「{pop.ev.title || '无标题'}」 {label(dayKey(pop.ev.s))} {hm(pop.ev.s)}–{hm(pop.ev.e)}。删除后不会影响关联的待办。</p>
        <div className="cal-pop-actions"><button type="button" className="cal-btn is-danger-solid" disabled={busy} onClick={() => void command({ sourceId: 'local', type: 'Event', action: 'delete', id: pop.ev.id, expectedVersion: pop.ev.version, confirmedDelete: true }, '已删除日程。')}>确认删除</button><button type="button" className="cal-btn" onClick={close}>取消</button></div></>
    } else {
      const p = pop
      body = <form onSubmit={e => { e.preventDefault(); save() }}>
        <h3 id="cal-pop-title">{p.kind === 'create' ? '新建日程' : p.moved ? '确认调整时间' : '编辑日程'}</h3>
        {p.kind === 'edit' && p.moved && <p className="cal-pop-hint">从 {label(dayKey(p.ev.s))} {hm(p.ev.s)} 移到 {label(dayKey(p.start))} {hm(p.start)}，确认后保存。</p>}
        <label className="cal-field">标题<input autoFocus required maxLength={500} value={p.title} onChange={e => setPop({ ...p, title: e.target.value })} placeholder="例如：看电影" /></label>
        <div className="cal-field-row">
          <label className="cal-field">开始<input type="datetime-local" required value={toLocalInput(p.start)} onChange={e => { const s = fromLocalInput(e.target.value); if (!Number.isNaN(s)) setPop({ ...p, start: s, end: s + (p.end - p.start) }) }} /></label>
          <label className="cal-field">结束<input type="datetime-local" required value={toLocalInput(p.end)} onChange={e => { const v = fromLocalInput(e.target.value); if (!Number.isNaN(v)) setPop({ ...p, end: v }) }} /></label>
        </div>
        <label className="cal-field">说明（可选）<textarea maxLength={4000} rows={2} value={p.description} onChange={e => setPop({ ...p, description: e.target.value })} /></label>
        {error && <p className="cal-pop-error" role="alert">{error}</p>}
        {unconfirmed && <button type="button" className="cal-btn" disabled={busy} onClick={() => void lookup()}>查询原请求结果</button>}
        <div className="cal-pop-actions"><button type="submit" className="cal-btn is-primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</button><button type="button" className="cal-btn" onClick={close}>取消</button></div>
        <p className="cal-pop-hint">时间按北京时间（Asia/Shanghai）保存。</p>
      </form>
    }
    return <div className="cal-pop-backdrop" onClick={close}>
      <div className="cal-pop" role="dialog" aria-modal="true" aria-labelledby="cal-pop-title" onClick={e => e.stopPropagation()}>{body}</div>
    </div>
  }

  const showAgenda = narrow && mode === 'week'
  return <section className="cal" aria-label="日历">
    <header className="cal-toolbar">
      <div className="cal-nav">
        <button type="button" className="cal-btn" onClick={() => setAnchor(a => shiftAnchor(mode, a, -1))} aria-label={`上一${mode === 'day' ? '天' : mode === 'week' ? '周' : '月'}`}>‹ 上一{mode === 'day' ? '天' : mode === 'week' ? '周' : '月'}</button>
        <button type="button" className="cal-btn" onClick={() => setAnchor(today)}>今天</button>
        <button type="button" className="cal-btn" onClick={() => setAnchor(a => shiftAnchor(mode, a, 1))} aria-label={`下一${mode === 'day' ? '天' : mode === 'week' ? '周' : '月'}`}>下一{mode === 'day' ? '天' : mode === 'week' ? '周' : '月'} ›</button>
        <h2 className="cal-range" aria-live="polite">{rangeLabel}</h2>
      </div>
      <div className="cal-modes" role="group" aria-label="视图">
        {(['day', 'week', 'month'] as Mode[]).map(m => <button key={m} type="button" className={`cal-mode${mode === m ? ' is-active' : ''}`} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'day' ? '日' : m === 'week' ? '周' : '月'}</button>)}
        <button type="button" className="cal-btn" onClick={() => void load()} disabled={loading} aria-label="刷新日程">{loading ? '读取中…' : '刷新'}</button>
      </div>
    </header>
    <div className="cal-legend" aria-label="来源图例">
      {authorized && <span><i style={{ background: colors.local }} />本地日程</span>}
      {extSources.map(s => <span key={s}><i style={{ background: colors[s] }} />{sourceName(s)}</span>)}
      {todos.some(t => t.due) && <span><i className="is-due" />待办截止</span>}
    </div>
    {extWarning && <div className="cal-banner is-warn" role="status">{extWarning}</div>}
    {error && !pop && <div className="cal-banner is-error" role="alert">{error}{unconfirmed && <button type="button" className="cal-link" disabled={busy} onClick={() => void lookup()}>查询原请求结果</button>}</div>}
    {notice && <div className="cal-banner is-ok" role="status">{notice}</div>}
    {mode === 'month' ? month() : showAgenda ? agenda() : timeGrid()}
    {popover()}
  </section>
}
