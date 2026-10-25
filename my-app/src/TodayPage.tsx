import { useEffect, useState } from 'react'
import { hm } from './calendar-layout.mjs'
import { loadDay, todayKey, type DayData } from './todayQuery'
import { todayParts } from './today-summary.mjs'

export type Confirmation = { taskId: number; title: string; botName: string; reason: string }
type Props = {
  token: string; active: boolean; confirmations: Confirmation[]
  onOpenTask: (taskId: number) => void; onOpenInbox: () => void; onOpenCalendar: () => void; onOpenTodos: () => void
}

// PLAN §8.4 home page (P-13): a foldable "今天" summary above the Chief main session.
// Read-only; the conversation below is where work is asked for.
export default function TodaySummary({ token, active, confirmations, onOpenTask, onOpenInbox, onOpenCalendar, onOpenTodos }: Props) {
  // The load time drives the next-event line; reading the clock during render would be impure.
  const [data, setData] = useState<(DayData & { at: number }) | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(() => !window.matchMedia?.('(max-width: 719px)').matches)
  const day = todayKey()
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    loadDay(token, day, controller.signal).then(next => { setData({ ...next, at: Date.now() }); setError('') })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [token, day, active])
  const [date] = useState(() => new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' }))
  const time = (iso?: string) => iso ? hm(Date.parse(iso)) : ''
  const parts = data ? todayParts({ authorized: data.authorized, events: data.events, todos: data.todos, confirmations: confirmations.length, now: data.at, day }) : []

  return <details className="today-strip" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary><strong>今天</strong><span className="shell-muted">{date}</span><span className="today-strip-line">{error ? '读取失败' : data ? parts.join(' · ') : '正在读取…'}</span></summary>
    {error && <p role="alert" className="shell-alert-card">{error}</p>}
    {data && <div className="today-strip-body">
      <section aria-labelledby="today-events">
        <div className="today-card-head"><h2 id="today-events">日程</h2><button type="button" className="text-button" onClick={onOpenCalendar}>日历</button></div>
        {!data.authorized ? <p className="shell-muted small">本地日程暂未开放读取。</p> : data.events.length === 0 ? <p className="shell-muted small">没有安排。</p>
          : <ul className="today-list">{data.events.slice(0, 4).map(e => <li key={`${e.sourceId}:${e.id}`}><span className="today-time">{time(e.start)}</span><span>{e.title}</span>{e.sourceId !== 'local' && <span className="today-tag">飞书</span>}</li>)}</ul>}
        {data.warning && <p className="today-warn" role="status">{data.warning}</p>}
      </section>
      <section aria-labelledby="today-todos">
        <div className="today-card-head"><h2 id="today-todos">到期</h2><button type="button" className="text-button" onClick={onOpenTodos}>待办</button></div>
        {data.todos.length === 0 ? <p className="shell-muted small">没有到期或逾期的待办。</p>
          : <ul className="today-list">{data.todos.slice(0, 4).map(t => <li key={t.id}><span className={`today-time ${String(t.due).slice(0, 10) < day ? 'today-overdue' : ''}`}>{String(t.due).slice(0, 10) < day ? '已逾期' : '今天'}</span><span>{t.title}</span></li>)}</ul>}
      </section>
      <section aria-labelledby="today-confirm">
        <div className="today-card-head"><h2 id="today-confirm">等你确认</h2><button type="button" className="text-button" onClick={onOpenInbox}>收件箱</button></div>
        {confirmations.length === 0 ? <p className="shell-muted small">没有。</p>
          : <ul className="today-list">{confirmations.slice(0, 4).map(c => <li key={c.taskId}><button type="button" className="today-link" onClick={() => onOpenTask(c.taskId)}><span className="today-tag attention">{c.reason}</span><span>{c.title}</span></button></li>)}</ul>}
      </section>
    </div>}
  </details>
}
