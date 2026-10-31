import { useCallback, useEffect, useRef, useState, useId } from 'react'
import { AutoAppliedCard } from './AutomationControls'
import { FindingCard } from './Findings'
import SystemCard from './SystemCard'
import ReminderWorkspace from './ReminderWorkspace'
import { ALWAYS_WARNING, cardActions, inboxCard, notificationReason, notificationSection } from './system-cards.mjs'

// Unified "待你确认" inbox backed by GET /api/inbox. Actions reuse existing endpoints; a decision
// whose outcome is unknown (network error, ambiguous response) is never resent automatically.
export type InboxItem = {
  kind: 'approval' | 'blocker' | 'workspace-proposal' | 'auto-applied' | 'finding' | 'skipped'
  taskId: number | null; botId: string; botName: string
  entryId?: number; approvalId?: number; blockerId?: number; requestId?: string; findingId?: string
  summary: string; createdAt: string | null
  detail: Record<string, unknown> & { payloadHash?: string; sourceId?: string; action?: string }
}
type Props = { proposalTaskId?: number; token: string; active: boolean; onCount: (count: number) => void; onOpenTask: (taskId: number, botId: string) => void }
type Outcome = { state: 'busy' } | { state: 'unknown' } | { state: 'error'; message: string }

const keyOf = (i: InboxItem) => `${i.kind}:${i.taskId}:${i.entryId ?? i.approvalId ?? i.blockerId ?? i.requestId ?? i.findingId}`
const taskHash = (i: InboxItem) => i.taskId === null ? null : `#bot=${encodeURIComponent(i.botId)}&task=${i.taskId}`

export default function InboxPage({ token, active, onCount, onOpenTask, proposalTaskId }: Props) {
  const sectionId = useId()
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const countRef = useRef(onCount)
  useEffect(() => { countRef.current = onCount }, [onCount])
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/inbox', { headers: { Authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '通知读取失败。')
      const next: InboxItem[] = (body.data?.items ?? []).filter((item: InboxItem) => proposalTaskId === undefined || item.kind === 'workspace-proposal' && item.taskId === proposalTaskId)
      // Automatic-execution records (I-13) are informational and never count as "待你确认".
      setItems(next); setLoadError(''); countRef.current(next.filter(i => notificationSection(i) === 'attention').length)
    } catch (e) { setLoadError(e instanceof Error && e.name !== 'TypeError' ? e.message : '通知读取失败，请稍后刷新。') }
  }, [token, proposalTaskId])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [load])
  useEffect(() => { if (active) void load() }, [active, load])

  async function act(item: InboxItem, approve: boolean, always = false) {
    const key = keyOf(item)
    if (outcomes[key]?.state === 'busy' || outcomes[key]?.state === 'unknown') return
    setOutcomes(o => ({ ...o, [key]: { state: 'busy' } }))
    let path: string, body: unknown
    if (item.kind === 'approval') { path = `/api/tasks/${item.taskId}/approvals/${item.approvalId}/decide`; body = { decision: approve ? 'approved' : 'rejected', ...(always ? { always: true } : {}) } }
    else { path = '/api/workspace/agent-confirm-local'; body = { sourceId: item.detail.sourceId, requestId: item.requestId, payloadHash: item.detail.payloadHash, confirmed: true, ...(approve ? {} : { cancel: true }), ...(always ? { always: true } : {}) } }
    let response: Response
    try { response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    catch { setOutcomes(o => ({ ...o, [key]: { state: 'unknown' } })); return }
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      // A 4xx is a definitive refusal; 5xx or an unreadable body leaves the outcome unknown.
      setOutcomes(o => ({ ...o, [key]: response.status >= 500 || !result ? { state: 'unknown' } : { state: 'error', message: result.error?.message ?? '操作被拒绝。' } }))
      return
    }
    setOutcomes(o => { const n = { ...o }; delete n[key]; return n })
    await load()
  }

  if (items === null) return <p className="shell-muted">{loadError || '正在读取…'}</p>
  if (proposalTaskId !== undefined && items.length === 0) return null
  const confirm = items.filter(i => notificationSection(i) === 'attention'), records = items.filter(i => i.kind === 'auto-applied'), findings = items.filter(i => i.kind === 'finding')
  return <div className={`inbox-page${proposalTaskId === undefined ? ' notification-columns' : ''}`}>
    <section aria-labelledby={`${sectionId}-confirm`}>
    <h2 id={`${sectionId}-confirm`} className="inbox-heading">需要你处理{confirm.length ? ` · ${confirm.length}` : ''}</h2>
    {loadError && <p role="alert" className="shell-note">{loadError}</p>}
    {confirm.length === 0 ? <p className="shell-muted">暂时没有需要你处理的事。</p>
      : <ul className="inbox-list">{confirm.map(item => {
        const key = keyOf(item), outcome = outcomes[key], hash = taskHash(item)
        const locked = outcome?.state === 'busy' || outcome?.state === 'unknown'
        const card = inboxCard(item), actions = cardActions(card)
        return <li key={key} className="inbox-card">
          <SystemCard card={card} title={item.summary} meta={`${item.botName}${item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString('zh-CN')}` : ''}`}
            state={outcome?.state === 'busy' ? '正在提交…' : item.kind === 'skipped' ? '已跳过' : undefined} error={outcome?.state === 'unknown' ? '没确认结果，打开会话看一下。' : outcome?.state === 'error' ? outcome.message : undefined}
            actions={<>
              {actions.includes('answer') && hash && <button type="button" className="primary" onClick={() => onOpenTask(item.taskId!, item.botId)}>去补充</button>}
              {actions.includes('approve') && <button type="button" className="primary" disabled={locked} onClick={() => void act(item, true)}>同意</button>}
              {actions.includes('always') && <button type="button" disabled={locked} onClick={() => { if (window.confirm(ALWAYS_WARNING)) void act(item, true, true) }}>以后直接做</button>}
              {actions.includes('reject') && <button type="button" disabled={locked} onClick={() => void act(item, false)}>拒绝</button>}
              {hash && <a href={hash} onClick={e => { e.preventDefault(); onOpenTask(item.taskId!, item.botId) }}>打开会话</a>}
            </>}>
            <p>{notificationReason(item)}</p>
            <details className="tech-info"><summary>技术信息</summary><pre>{JSON.stringify({ taskId: item.taskId, botId: item.botId, approvalId: item.approvalId, blockerId: item.blockerId, entryId: item.entryId, requestId: item.requestId, ...item.detail }, null, 2)}</pre></details>
          </SystemCard>
        </li>
      })}</ul>}
    </section>
    {proposalTaskId === undefined && <section aria-labelledby={`${sectionId}-reminders`}>
      <h2 id={`${sectionId}-reminders`} className="inbox-heading">提醒</h2>
    {findings.length > 0 && <>
      <h3 id={`${sectionId}-findings`}>日程与待办提醒</h3>
      <ul className="inbox-list" aria-labelledby={`${sectionId}-findings`}>{findings.map(item => <li key={keyOf(item)} className="inbox-card">
        <FindingCard compact token={token} finding={{ id: item.findingId!, detector: String(item.detail.detector ?? ''), summary: item.summary, lines: item.detail.lines as string[] | undefined, state: item.detail.state as string | undefined, assist: item.detail.assist === true, assistTaskId: (item.detail.assistTaskId as number | null | undefined) ?? null }} onOpenTask={onOpenTask} />
        <p className="shell-muted">{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '记录时间未提供'}</p>
        <details className="tech-info"><summary>技术信息</summary><pre>{JSON.stringify({ taskId: item.taskId, findingId: item.findingId, ...item.detail }, null, 2)}</pre></details>
        {item.taskId !== null && <a href={taskHash(item)!} onClick={e => { e.preventDefault(); onOpenTask(item.taskId!, item.botId) }}>打开相关会话</a>}
      </li>)}</ul>
    </>}
    {records.length > 0 && <>
      <h3 id={`${sectionId}-auto`}>机器人自动做的事</h3>
      <ul className="inbox-list" aria-labelledby={`${sectionId}-auto`}>{records.map(item => <li key={keyOf(item)} className="inbox-card">
        <details className="tech-info"><summary>技术信息</summary><pre>{JSON.stringify({ taskId: item.taskId, requestId: item.requestId, ...item.detail }, null, 2)}</pre></details>
        <AutoAppliedCard token={token} requestId={item.requestId!} summary={item.summary} undone={item.detail.undone === true} createdAt={item.createdAt} />
        {item.taskId !== null && <a href={taskHash(item)!} onClick={e => { e.preventDefault(); onOpenTask(item.taskId!, item.botId) }}>打开会话</a>}
      </li>)}</ul>
    </>}
      <ReminderWorkspace token={token} onOpenTask={onOpenTask} />
    </section>}
  </div>
}
