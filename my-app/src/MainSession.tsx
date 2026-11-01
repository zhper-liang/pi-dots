import { useState } from 'react'
import TaskBlockerControls, { type BlockedTask } from './TaskBlockerControls'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'
import { AutoAppliedCard } from './AutomationControls'
import SystemCard from './SystemCard'
import { ALWAYS_WARNING, cardActions, mirrorCard } from './system-cards.mjs'

// PLAN §8.1: each Bot has one main session (GET /api/bots → mainSessions). Mirror cards show a
// derived Task's approval, question, proposal, automatic write or end inside the main session;
// their buttons call the same endpoints as the derived Task and the inbox (no new approval logic).
export type MirrorMessage = { id: number; mirrorKind: 'approval' | 'blocker' | 'proposal' | 'auto-applied' | 'finished'; childTaskId: number; childTitle: string; botId: string; summary: string; live: string; createdAt: string; approvalId?: number; blockerId?: number; requestId?: string; sourceId?: string; payloadHash?: string; outcome?: string; result?: string; toolName?: string; allowAlways?: boolean; retryOf?: unknown }

export function MirrorQuestion({ token, item, onSettled }: { token: string; item: MirrorMessage; onSettled: (status: string) => void }) {
  const [task, setTask] = useState<BlockedTask | null>(null)
  const [error, setError] = useState('')
  function project(value: BlockedTask) {
    if (!value?.bot || value.taskId !== item.childTaskId || value.bot.id !== item.botId) throw new Error('问题归属已变化，请打开原会话核对。')
    const blocker = value.blockers?.items.find(question => question.id === item.blockerId)
    if (!blocker) throw new Error('没有读取到这个问题，请打开原会话核对。')
    return { ...value, blockers: { activeId: value.blockers?.activeId ?? null, items: [blocker] } }
  }
  const refresh = useWorkspaceRefresh({
    scopeKey: JSON.stringify([token, item.botId, item.childTaskId, item.blockerId]), active: item.live === 'pending',
    load: async ({ signal, isCurrent }) => {
      const response = await fetch(`/api/bots/${encodeURIComponent(item.botId)}/tasks/${item.childTaskId}`, { signal, headers: { Authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '无法读取问题，请打开原会话核对权限。')
      const value = project(body.task)
      if (isCurrent()) { setTask(value); setError('') }
    },
    onError: caught => { setTask(null); setError(caught instanceof Error ? caught.message : '问题读取失败。') },
  })
  return <div className="mirror-question">
    {error ? <p role="alert">{error}<button type="button" onClick={() => void refresh.refresh()}>重新读取问题</button></p> : !task ? <p role="status">正在读取问题…</p> : <TaskBlockerControls task={task} token={token} onError={() => { /* The shared form retains its original request and shows action errors. */ }} onUpdated={updated => {
      try {
        const value = project(updated)
        setTask(value); setError('')
        const status = value.blockers.items[0].status
        if (status !== 'pending') onSettled(status === 'resolved' ? '已回答' : status === 'superseded' ? '已按调整继续' : status === 'skipped' ? '已跳过' : '已取消')
      } catch (caught) { setTask(null); setError(caught instanceof Error ? caught.message : '问题状态已变化。') }
    }} />}
  </div>
}

export function MirrorCard({ token, item, onOpenTask }: { token: string; item: MirrorMessage; onOpenTask: (taskId: number, botId: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [decided, setDecided] = useState('')
  const [expanded, setExpanded] = useState(false)
  async function decide(approve: boolean, always = false) {
    setBusy(true); setError('')
    const [path, body] = item.mirrorKind === 'approval'
      ? [`/api/tasks/${item.childTaskId}/approvals/${item.approvalId}/decide`, { decision: approve ? 'approved' : 'rejected', ...(always ? { always: true } : {}) }]
      : ['/api/workspace/agent-confirm-local', { sourceId: item.sourceId, requestId: item.requestId, payloadHash: item.payloadHash, confirmed: true, ...(approve ? {} : { cancel: true }), ...(always ? { always: true } : {}) }]
    try {
      const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(result?.error?.message ?? '没确认结果，打开会话查看。')
      setDecided(approve ? '已同意' : '已拒绝')
    } catch (e) { setError(e instanceof Error ? e.message : '没确认结果，打开会话查看。') } finally { setBusy(false) }
  }
  if (item.mirrorKind === 'auto-applied' && item.requestId) return <AutoAppliedCard token={token} requestId={item.requestId} summary={item.summary} undone={item.live === 'undone'} createdAt={item.createdAt} />
  const card = mirrorCard(item), actions = decided ? [] : cardActions(card)
  return <SystemCard card={card} title={item.summary} state={decided || undefined} error={error}
    actions={<>
      {actions.includes('approve') && <button type="button" className="primary" disabled={busy} onClick={() => void decide(true)}>同意</button>}
      {actions.includes('always') && <button type="button" disabled={busy} onClick={() => { if (window.confirm(ALWAYS_WARNING)) void decide(true, true) }}>以后直接做</button>}
      {actions.includes('reject') && <button type="button" disabled={busy} onClick={() => void decide(false)}>拒绝</button>}
      {actions.includes('answer') && <button type="button" className="primary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起问题' : '在这里补充'}</button>}
      <button type="button" className="text-button" onClick={() => onOpenTask(item.childTaskId, item.botId)}>打开会话「{item.childTitle}」</button>
    </>}>
    {expanded && item.mirrorKind === 'blocker' && item.live === 'pending' && <MirrorQuestion key={`${token}:${item.botId}:${item.childTaskId}:${item.blockerId}`} token={token} item={item} onSettled={setDecided} />}
    {/* D-20: a "帮我想办法" result is shown right on its finished card; the task holds the full text. */}
    {item.mirrorKind === 'finished' && item.result ? <p className="system-card-result">{item.result}</p> : null}
  </SystemCard>
}
