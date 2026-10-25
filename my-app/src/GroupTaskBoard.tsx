import { useState } from 'react'
import type { Relation } from './CollaborationPanel'

// Group child tasks dispatched via @Bot, grouped 进行中 / 已完成 / 已归档.
// Archiving only hides (server flag); it never cancels, deletes or touches approvals.
type Member = { id: string; name: string }
type Props = {
  groupId: string; groupTaskId: number; token: string; relations?: Relation[]; members: Member[]
  archivedIds: number[]; onArchived: () => void; onError: (message: string) => void
}
type Column = 'active' | 'done' | 'archived'
const labels: Record<Column, string> = { active: '进行中', done: '已完成', archived: '已归档' }
const doneStates = ['accepted', 'cancelled', 'failed']
function statusText(r: Relation) {
  if (r.businessStatus === 'accepted') return '已完成 · 管理员已接受'
  if (r.businessStatus === 'cancelled') return '已取消'
  if (r.businessStatus === 'failed') return '执行失败'
  if (r.businessStatus === 'rework-requested') return '返工中'
  if (r.result) return '已提交结果 · 等管理员验收'
  return '处理中'
}

export default function GroupTaskBoard({ groupId, groupTaskId, token, relations, members, archivedIds, onArchived, onError }: Props) {
  const [busy, setBusy] = useState<number | null>(null)
  const items = (relations ?? []).filter(r => r.parentTaskId === groupTaskId)
  if (!items.length) return <section aria-label="群任务" className="today-card group-board"><h3>群任务</h3><p className="shell-muted small">还没有分派的任务。在下方输入框选「@」某个 Bot 后发送，就会派给它。</p></section>
  const name = (id: string) => members.find(m => m.id === id)?.name ?? id
  const columnOf = (r: Relation): Column => archivedIds.includes(r.childTaskId) ? 'archived' : r.businessStatus && doneStates.includes(r.businessStatus) ? 'done' : 'active'
  async function archive(r: Relation, archived: boolean) {
    setBusy(r.childTaskId)
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/children/${r.childTaskId}/archive`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }) })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.error?.message ?? '归档失败，请刷新后重试。')
      onArchived()
    } catch (e) { onError(e instanceof Error && e.name !== 'TypeError' ? e.message : '归档结果未确认，请刷新后查看。') }
    finally { setBusy(null) }
  }
  return <section aria-label="群任务" className="today-card group-board"><h3>群任务</h3>
    {(['active', 'done', 'archived'] as Column[]).map(col => {
      const list = items.filter(r => columnOf(r) === col)
      const body = list.length === 0 ? <p className="shell-muted small">无</p> : <ul className="group-task-list">{list.map(r => {
        const latest = r.revisions?.length ? r.revisions[r.revisions.length - 1] : r.result
        return <li key={r.id} className="group-task-card">
          <p><strong>@{name(r.executorBotId)}</strong> · {statusText(r)}</p>
          <p className="group-task-goal">{r.goal}</p>
          {latest && <details open={col === 'done'}><summary>结果{r.acceptedRevision ? ` · 修订 #${r.acceptedRevision}` : ''}</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{latest.content}</p></details>}
          <div className="inbox-actions">
            <a href={`#bot=${encodeURIComponent(r.executorBotId)}&task=${r.childTaskId}`}>打开任务</a>
            <button type="button" disabled={busy === r.childTaskId} onClick={() => void archive(r, col !== 'archived')}>{col === 'archived' ? '取消归档' : '归档'}</button>
          </div>
        </li>
      })}</ul>
      return col === 'active' ? <div key={col}><h4>{labels[col]} · {list.length}</h4>{body}</div>
        : <details key={col} open={col === 'done'}><summary>{labels[col]} · {list.length}</summary>{body}</details>
    })}
    <p className="shell-muted small">归档只是隐藏，不会取消或删除任务。</p>
  </section>
}
