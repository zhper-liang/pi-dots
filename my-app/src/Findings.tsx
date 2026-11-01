import { useCallback, useEffect, useState } from 'react'
import SystemCard from './SystemCard'
import { cardActions, DETECTOR_LABELS as labels } from './system-cards.mjs'

// PLAN §8.2 detector findings: POST /api/findings {id, action} (handle | dismiss | mute) or
// {action:'unmute', detector}; GET /api/findings lists open findings and muted detectors.
// assist: the "帮我想办法" setting is on (PLAN §8.7); assistTaskId: the read-only analysis already started.
export type FindingView = { id: string; detector: string; summary: string; lines?: string[]; state?: string; handledTaskId?: number | null; assist?: boolean; assistTaskId?: number | null }

async function act(token: string, body: unknown) {
  const response = await fetch('/api/findings', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error?.message ?? '操作失败。')
  return result.data
}

export function FindingCard({ token, finding, onOpenTask, compact = false }: { token: string; finding: FindingView; compact?: boolean; onOpenTask: (taskId: number, botId: string) => void }) {
  const [state, setState] = useState(''), [taskId, setTaskId] = useState<number | null>(null), [assistId, setAssistId] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const current = state || finding.state || 'open', handled = taskId ?? finding.handledTaskId ?? null, assisted = assistId ?? finding.assistTaskId ?? null
  async function run(action: 'handle' | 'assist' | 'dismiss' | 'mute') {
    setBusy(true); setError('')
    try {
      const r = await act(token, { id: finding.id, action })
      if (action === 'handle') { setTaskId(r.taskId); setState('resolved') } else if (action === 'assist') setAssistId(r.taskId)
      else setState(action === 'dismiss' ? 'dismissed' : 'muted')
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败。') } finally { setBusy(false) }
  }
  const card = { kind: finding.detector === 'summary' ? 'summary' : 'finding', detector: finding.detector, state: handled !== null ? 'handled' : current, assist: finding.assist === true && assisted === null }
  const actions = cardActions(card)
  return <SystemCard card={card} title={finding.summary} error={error}
    actions={<>
      {actions.includes('handle') && <button type="button" className="primary" disabled={busy} onClick={() => void run('handle')}>处理</button>}
      {actions.includes('assist') && <button type="button" disabled={busy} onClick={() => void run('assist')}>帮我想办法</button>}
      {actions.includes('dismiss') && <button type="button" disabled={busy} onClick={() => void run('dismiss')}>忽略</button>}
      {actions.includes('mute') && <button type="button" disabled={busy} onClick={() => void run('mute')}>这类别再提醒</button>}
      {handled !== null && <button type="button" className="text-button" onClick={() => onOpenTask(handled, 'chief')}>{compact ? '查看已派出的任务' : `已派出任务 #${handled}`}</button>}
      {assisted !== null && <button type="button" className="text-button" onClick={() => onOpenTask(assisted, 'chief')}>{compact ? '查看分析任务' : `查看分析 · 任务 #${assisted}`}</button>}
    </>}>
    {finding.lines?.length ? compact ? <details className="inbox-detail"><summary>诊断</summary><ul className="small system-card-lines">{finding.lines.map((line, i) => <li key={i}>{line}</li>)}</ul></details> : <ul className="small system-card-lines">{finding.lines.map((line, i) => <li key={i}>{line}</li>)}</ul> : null}
  </SystemCard>
}

// Settings: restore a detector category muted with "这类别再提醒" (T2-10).
export function MutedDetectors({ token }: { token: string }) {
  const [muted, setMuted] = useState<string[] | null>(null), [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/findings', { headers: { Authorization: `Bearer ${token}` } }), body = await response.json()
      if (!response.ok) throw new Error(body.error?.message)
      setMuted(body.data.muted)
    } catch { setError('读取失败，请稍后刷新。') }
  }, [token])
  useEffect(() => { void load() }, [load])
  async function restore(detector: string) {
    try { setMuted((await act(token, { action: 'unmute', detector })).muted) } catch (e) { setError(e instanceof Error ? e.message : '操作失败。') }
  }
  if (muted === null) return <p className="shell-muted">{error || '正在读取…'}</p>
  return <div>
    <h3>主动提醒</h3>
    <p className="shell-muted small">日程冲突、待办逾期、会前没准备、话题该跟进时提醒你。每天最多 10 条，22:00–08:00 只进通知。</p>
    {muted.length === 0 ? <p>所有提醒都开着。</p> : <ul>{muted.map(d => <li key={d}>{labels[d] ?? d} · 已不再提醒 <button type="button" onClick={() => void restore(d)}>恢复</button></li>)}</ul>}
    {error && <p role="alert" className="shell-note">{error}</p>}
  </div>
}

// This preference only shows the analysis action. Tool access is managed in capabilities.
type AssistState = { assist: boolean }
export function AssistSettings({ token }: { token: string }) {
  const [value, setValue] = useState<AssistState | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/findings', { headers: { Authorization: `Bearer ${token}` } }), body = await response.json()
      if (!response.ok) throw new Error(body.error?.message)
      setValue({ assist: body.data.assist === true })
    } catch { setError('读取失败，请稍后刷新。') }
  }, [token])
  useEffect(() => { void load() }, [load])
  async function save(enabled: boolean) {
    setBusy(true); setError('')
    try { setValue(await act(token, { action: 'assist-setting', enabled })) }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败。'); void load() } finally { setBusy(false) }
  }
  if (!value) return <p className="shell-muted">{error || '正在读取…'}</p>
  return <div className="assist-settings">
    <h3>帮我想办法</h3>
    <p className="shell-muted small">打开后，提醒卡上多一个「帮我想办法」：pipi 只看不改地分析这条提醒，把办法发到对话里，每次会用一点模型额度。</p>
    <p role="status">{value.assist ? '已打开' : '已关闭（默认）'}</p>
    <div className="bot-actions">
      {!value.assist && <button type="button" className="primary" disabled={busy} onClick={() => void save(true)}>打开</button>}
      {value.assist && <button type="button" disabled={busy} onClick={() => void save(false)}>关闭</button>}
    </div>
    {value.assist && <p className="shell-muted small">关掉只是去掉按钮，已经开始的分析会做完。</p>}
    {error && <p role="alert" className="shell-note">{error}</p>}
  </div>
}
