import { taskPath } from './taskPath'
import { useEffect, useRef, useState } from 'react'
import type { ApprovalState } from './TaskApprovalControls'

type OutcomeTask = { bot: { id: string }; taskId: number; approvals?: ApprovalState; cancellation?: unknown; runtime: { status: string; outcome?: { status: string } } }
export default function ActionOutcomeControls<T extends OutcomeTask>({ task, item, token, onUpdated, onError }: {
  task: T; item: ApprovalState['items'][number]; token: string; onUpdated: (task: T) => void; onError: (error: unknown) => void
}) {
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false)
  const submitting = useRef(false), request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const operation = item.operation
  if (!operation) return null
  const cancelled = Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted'
  const querying = Boolean(operation.query?.attempts.some((attempt) => attempt.status === 'querying') || operation.idempotency?.attempts.some((attempt) => attempt.status === 'retrying'))
  const available = !querying && !cancelled && item.status === 'outcome-unknown' && task.approvals?.activeId === item.id && !operation.resolution && !item.receipt
  async function verify(outcome: 'completed' | 'unknown' | 'retry') {
    if (submitting.current || !available || !note.trim()) return
    submitting.current = true; setBusy(true)
    const controller = new AbortController(); request.current = controller
    try {
      const response = await fetch(taskPath(task, `/approvals/${item.id}/verify`), { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ outcome, note: note.trim() }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '核实未确认，请刷新后核对原记录。')
      if (!controller.signal.aborted) onUpdated(body.task)
    } catch (error) { if (!controller.signal.aborted) onError(error) }
    finally { if (!controller.signal.aborted) { submitting.current = false; setBusy(false) } }
  }
  return <div className="action-outcome" data-testid="action-outcome">
    <h4>核对上次操作</h4>
    {!item.receipt && <p role="status">还没确认结果，请核对日历中的时间，再填写下面的说明。</p>}
    {querying && !cancelled && <p role="status">正在自动核对结果，先别提交。</p>}
    {!querying && (operation.query?.stopped || operation.idempotency?.stopped) && <p role="status">自动核对没能确认结果，请你看一下日历。</p>}
    {cancelled && !item.receipt && <p>会话已取消，上次操作的结果还没确认。</p>}
    {operation.verifications.map((entry) => <p key={entry.id} className="blocker-answer">你核对过：{entry.outcome === 'completed' ? '已完成' : entry.outcome === 'retry' ? '要求重做（需要再确认）' : '还不能确认'}。{entry.note}<br /><time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time></p>)}
    {operation.resolution?.outcome === 'retry' && <p>上次结果还没确认，请处理新的确认卡。</p>}
    {available && <div className="approval-actions">
      <label htmlFor={`verify-note-${item.id}`}>核对说明（必填）</label>
      <textarea id={`verify-note-${item.id}`} rows={2} maxLength={2000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="说明你核对了哪个会议、实际时间，或为什么仍不能确认。" />
      <p className="muted small">重试可能重复改动，需要你在新卡片里确认。</p>
      <div className="button-row"><button className="primary" disabled={busy || !note.trim()} onClick={() => void verify('completed')}>我已核实原操作完成</button>
        <button disabled={busy || !note.trim()} onClick={() => void verify('unknown')}>仍无法确认，继续等待</button>
        <button disabled={busy || !note.trim()} onClick={() => void verify('retry')}>申请重新操作（可能重复）</button></div>
    </div>}
  </div>
}
