import { useState } from 'react'
import BotAvatar from './BotAvatar'
import { loadLook } from './botLook'
import { AutoAppliedCard } from './AutomationControls'
import SystemCard from './SystemCard'
import { ALWAYS_WARNING, cardActions, mirrorCard } from './system-cards.mjs'

// PLAN §8.1: each Bot has one main session (GET /api/bots → mainSessions). Mirror cards show a
// derived Task's approval, question, proposal, automatic write or end inside the main session;
// their buttons call the same endpoints as the derived Task and the inbox (no new approval logic).
export type MirrorMessage = { id: number; mirrorKind: 'approval' | 'blocker' | 'proposal' | 'auto-applied' | 'finished'; childTaskId: number; childTitle: string; botId: string; summary: string; live: string; createdAt: string; approvalId?: number; blockerId?: number; requestId?: string; sourceId?: string; payloadHash?: string; outcome?: string; result?: string; toolName?: string; allowAlways?: boolean; retryOf?: unknown }

export function MirrorCard({ token, item, onOpenTask }: { token: string; item: MirrorMessage; onOpenTask: (taskId: number, botId: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [decided, setDecided] = useState('')
  async function decide(approve: boolean, always = false) {
    setBusy(true); setError('')
    const [path, body] = item.mirrorKind === 'approval'
      ? [`/api/tasks/${item.childTaskId}/approvals/${item.approvalId}/decide`, { decision: approve ? 'approved' : 'rejected', ...(always ? { always: true } : {}) }]
      : ['/api/workspace/agent-confirm-local', { sourceId: item.sourceId, requestId: item.requestId, payloadHash: item.payloadHash, confirmed: true, ...(approve ? {} : { cancel: true }), ...(always ? { always: true } : {}) }]
    try {
      const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(result?.error?.message ?? '结果未确认，请打开任务查看。')
      setDecided(approve ? '已同意' : '已拒绝')
    } catch (e) { setError(e instanceof Error ? e.message : '结果未确认，请打开任务查看。') } finally { setBusy(false) }
  }
  if (item.mirrorKind === 'auto-applied' && item.requestId) return <AutoAppliedCard token={token} requestId={item.requestId} summary={item.summary} undone={item.live === 'undone'} createdAt={item.createdAt} />
  const card = mirrorCard(item), actions = decided ? [] : cardActions(card)
  return <SystemCard card={card} title={item.summary} state={decided || undefined} error={error}
    actions={<>
      {actions.includes('approve') && <button type="button" className="primary" disabled={busy} onClick={() => void decide(true)}>同意</button>}
      {actions.includes('always') && <button type="button" disabled={busy} onClick={() => { if (window.confirm(ALWAYS_WARNING)) void decide(true, true) }}>以后直接做</button>}
      {actions.includes('reject') && <button type="button" disabled={busy} onClick={() => void decide(false)}>拒绝</button>}
      {actions.includes('answer') && <button type="button" className="primary" onClick={() => onOpenTask(item.childTaskId, item.botId)}>去补充</button>}
      <button type="button" className="text-button" onClick={() => onOpenTask(item.childTaskId, item.botId)}>打开任务「{item.childTitle}」</button>
    </>}>
    {/* D-20: a "帮我想办法" result is shown right on its finished card; the task holds the full text. */}
    {item.mirrorKind === 'finished' && item.result ? <p className="system-card-result">{item.result}</p> : null}
  </SystemCard>
}

export function BotSessions({ bots, mainSessions, selectedId, onOpen }: { bots: { id: string; name: string; status?: string }[]; mainSessions: Record<string, number>; selectedId: number | null; onOpen: (taskId: number, botId: string) => void }) {
  const rows = bots.filter(b => mainSessions[b.id] !== undefined)
  if (!rows.length) return null
  return <section className="shell-section" aria-labelledby="side-mains">
    <div className="shell-section-head"><h2 id="side-mains">Bot</h2></div>
    <nav aria-label="Bot 主会话" className="shell-task-list">{rows.map(bot => <button type="button" key={bot.id} className={`task-link ${selectedId === mainSessions[bot.id] ? 'selected' : ''}`} aria-current={selectedId === mainSessions[bot.id] ? 'page' : undefined} onClick={() => onOpen(mainSessions[bot.id], bot.id)}>
      <BotAvatar name={bot.name} look={loadLook(bot.id)} size={22} />
      <span className="task-link-text"><strong>{bot.name}</strong><span>{bot.status === 'inactive' ? '已停用 · 只读' : '主会话'}</span></span>
    </button>)}</nav>
  </section>
}
