import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react'
import { ItemsIcon } from './Icons'
import { addDays, periodDays, weekday } from './calendar-layout.mjs'
import { type LocalDateTime, isValidLocalDate, isValidLocalTime, localDateTime, localInstant } from './local-time.mjs'
import './editor-controls.css'

export type LocalTimePickerProps = LocalDateTime & {
  onChange: (value: LocalDateTime) => void
  label?: string
  mode?: 'datetime' | 'time'
  disabled?: boolean
  pending?: boolean
  error?: string
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))
const QUICK_TIMES = ['08:00', '12:00', '18:00', '21:00']
const firstOfMonth = (date: string) => `${date.slice(0, 7)}-01`
// These existing calendar helpers operate only on Gregorian day keys here, never timezone conversion.
const adjacentMonth = (month: string, direction: number) => {
  try {
    const next = firstOfMonth(addDays(month, direction < 0 ? -1 : 32))
    return isValidLocalDate(next) ? next : null
  } catch { return null }
}

/** Controlled wall-time editor. Never replaces a persisted timezone with the current device zone. */
export default function LocalTimePicker({ date, time, timezone, onChange, label = '时间', mode = 'datetime', disabled = false, pending = false, error }: LocalTimePickerProps) {
  const id = useId(), grid = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const today = localDateTime(now, timezone)?.date ?? localDateTime(now, 'UTC')!.date
  const validDate = isValidLocalDate(date), validTime = isValidLocalTime(time)
  const [view, setView] = useState(() => ({ date, month: firstOfMonth(validDate ? date : today) }))
  const [focused, setFocused] = useState(date)
  const month = view.date === date ? view.month : firstOfMonth(validDate ? date : today)
  const days = useMemo(() => {
    try { return periodDays('month', month).filter(isValidLocalDate) }
    catch { return [] }
  }, [month])
  const focusDay = days.includes(focused) ? focused : days.includes(date) ? date : month
  const previous = adjacentMonth(month, -1), next = adjacentMonth(month, 1)
  const zoneValid = localDateTime(0, timezone) !== null
  const validation = !zoneValid ? '保存的时区无效，请检查原计划设置。'
    : !validTime ? '请选择小时和分钟。'
    : mode === 'datetime' && !validDate ? '请选择有效日期。'
    : mode === 'datetime' && localInstant({ date, time, timezone }) === null ? '该时刻因夏令时或时区变更不存在，请选择其他时间。' : ''
  const message = error || validation
  const locked = disabled || pending
  const changeDate = (value: string) => {
    if (locked) return
    setView({ date: value, month: firstOfMonth(value) })
    setFocused(value)
    onChange({ date: value, time, timezone })
  }
  const navigate = (target: string | null) => {
    if (target && !locked) { setView({ date, month: target }); setFocused(target) }
  }
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, day: string) => {
    if (locked || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    const distance = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowUp' ? -7 : event.key === 'ArrowDown' ? 7
      : event.key === 'Home' ? -weekday(day) : event.key === 'End' ? 6 - weekday(day) : null
    if (distance === null) return
    event.preventDefault()
    let target: string
    try { target = addDays(day, distance) } catch { return }
    if (!isValidLocalDate(target)) return
    setFocused(target)
    if (target.slice(0, 7) !== month.slice(0, 7)) setView({ date, month: firstOfMonth(target) })
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-editor-date="${target}"]`)?.focus({ preventScroll: true }))
  }
  const changeTime = (value: string) => { if (!locked) onChange({ date, time: value, timezone }) }

  return <fieldset className="local-time-picker" disabled={locked} onFocusCapture={() => setNow(Date.now())} aria-invalid={message ? true : undefined} aria-describedby={message ? `${id}-error` : undefined} aria-busy={pending || undefined}>
    <legend>{label}</legend>
    {mode === 'datetime' && <section className="local-time-date-card" aria-label={`${label}日期`}>
      <div className="local-time-date-summary"><ItemsIcon /><span>{validDate ? `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8))}日` : '选择日期'}</span></div>
      <div className="local-time-shortcuts">
        <button type="button" className="editor-control-button" disabled={locked || !zoneValid} onClick={() => { const now = localDateTime(Date.now(), timezone); if (now) changeDate(now.date) }}>今天</button>
        <button type="button" className="editor-control-button" disabled={locked || !zoneValid} onClick={() => { const now = localDateTime(Date.now(), timezone); if (now) changeDate(addDays(now.date, 1)) }}>明天</button>
      </div>
      <div className="local-time-month-nav">
        <button type="button" className="editor-control-button" aria-label="上个月" disabled={locked || !previous} onClick={() => navigate(previous)}>‹</button>
        <span aria-live="polite">{Number(month.slice(0, 4))}年{Number(month.slice(5, 7))}月</span>
        <button type="button" className="editor-control-button" aria-label="下个月" disabled={locked || !next} onClick={() => navigate(next)}>›</button>
      </div>
      <div className="local-time-calendar" role="grid" aria-label={`${label}日期选择`} ref={grid}>
        <div className="local-time-week" role="row">{WEEK.map(day => <span role="columnheader" key={day} aria-label={`星期${day}`}>{day}</span>)}</div>
        {Array.from({ length: Math.ceil(days.length / 7) }, (_, row) => <div className="local-time-week" role="row" key={row}>
          {days.slice(row * 7, row * 7 + 7).map(day => <button key={day} type="button" role="gridcell" data-editor-date={day}
            className={`local-time-day${day.slice(0, 7) !== month.slice(0, 7) ? ' is-outside' : ''}`}
            disabled={locked} tabIndex={day === focusDay ? 0 : -1} aria-selected={day === date} aria-current={day === today ? 'date' : undefined}
            aria-label={`${Number(day.slice(0, 4))}年${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`}
            onFocus={() => setFocused(day)} onKeyDown={event => moveFocus(event, day)} onClick={() => changeDate(day)}>{Number(day.slice(8))}</button>)}
        </div>)}
      </div>
    </section>}
    <div className="local-time-clock-card">
      <div className="local-time-clock">
        <label htmlFor={`${id}-hour`}>小时<select id={`${id}-hour`} value={validTime ? time.slice(0, 2) : ''} disabled={locked}
          onChange={event => changeTime(`${event.target.value}:${validTime ? time.slice(3) : '00'}`)}>
          <option value="" disabled>选择小时</option>{HOURS.map(hour => <option key={hour} value={hour}>{hour}</option>)}
        </select></label>
        <span aria-hidden="true">:</span>
        <label htmlFor={`${id}-minute`}>分钟<select id={`${id}-minute`} value={validTime ? time.slice(3) : ''} disabled={locked}
          onChange={event => changeTime(`${validTime ? time.slice(0, 2) : '00'}:${event.target.value}`)}>
          <option value="" disabled>选择分钟</option>{MINUTES.map(minute => <option key={minute} value={minute}>{minute}</option>)}
        </select></label>
      </div>
      <div className="local-time-shortcuts" role="group" aria-label={`${label}常用时段`}>{QUICK_TIMES.map(value => <button key={value} type="button" className="editor-control-button" disabled={locked} aria-pressed={time === value} onClick={() => changeTime(value)}>{value}</button>)}</div>
    </div>
    {message && <p className="editor-control-error" id={`${id}-error`} role="alert">{message}</p>}
  </fieldset>
}
