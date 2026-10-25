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
  const labels: Record<string, string> = { retrying: '正在复用原幂等键恢复', unconfirmed: '本次结果未确认', querying: '查询中', completed: '确认完成', unknown: '暂未查明', error: '本次调用失败', timeout: '本次调用超时', interrupted: '尝试中断，结果未知', 'invalid-evidence': '证据不匹配' }
  const stopReasons: Record<string, string> = { IDEMPOTENCY_WINDOW_EXPIRED: '工具保障窗口已失效或尚未生效', IDEMPOTENCY_ATTEMPTS_EXHAUSTED: '幂等恢复次数已用完', QUERY_ATTEMPTS_EXHAUSTED: '已达本操作查询次数上限', CALL_LIMIT_REACHED: '当前调用额度不足', TOOL_NOT_AUTHORIZED: '工具已撤权或未授权', TOOL_RESOURCE_DENIED: '当前资源不允许访问', TOOL_IDENTITY_DENIED: 'Task身份不匹配', ACTION_BINDING_MISMATCH: '原操作与批准记录不匹配' }
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
    <h4>原操作记录 · {operation.id}</h4>
    <p className="muted small">派发前意图 #{operation.intentEntryId} · {new Date(operation.createdAt).toLocaleString('zh-CN')}。参数和批准见本卡，不因重启改变。</p>
    {!item.receipt && <p role="status"><strong>缺失：工具执行回执。原动作可能已经发生，也可能未发生；不能据此判为成功或失败。</strong>{operation.capabilities.stableIdempotency ? '工具仅在明确保障窗口内复用原标识与精确参数，最多有限次安全恢复；不成立时查询或等待，不作无保障重试。' : operation.capabilities.reliableQuery ? '工具支持按原操作 ID 可靠查询；宿主只作有限只读核实，不会重放写入。无结果不代表失败。' : '此操作未声明可靠结果查询或稳定幂等保障，宿主不会自动重做。'}请在日历中核对上述会议 ID 和精确时间，再提交核实说明。</p>}
    {operation.capabilities.query && <p className="muted small">可靠查询：{operation.capabilities.query.name} · 标识：{operation.capabilities.query.identity.join(' / ')} · 最多 {operation.capabilities.query.maxAttempts} 次，跨重启累计，计入工具额度。稳定幂等：{operation.capabilities.stableIdempotency ? '已声明（见保障条件）' : '未声明'}。</p>}
    {operation.capabilities.idempotency && <section aria-label="原操作幂等恢复证据">
      <h4>稳定幂等恢复 · 原标识、原参数、一次业务效果</h4>
      <p className="muted small">工具保障：{operation.capabilities.idempotency.name} · {operation.capabilities.idempotency.source}。仅模拟资源 {operation.capabilities.idempotency.scope}；精确绑定原批准参数。从原意图时间起 {operation.capabilities.idempotency.windowMs / 3600000} 小时内有效，截止 {new Date(Date.parse(operation.createdAt) + operation.capabilities.idempotency.windowMs).toLocaleString('zh-CN')}。最多 {operation.capabilities.idempotency.maxAttempts} 次，跨重启累计，每次计入工具额度；派发前复查权限、限额与取消。</p>
      {operation.idempotency?.attempts.map((attempt) => <div key={attempt.id} className="blocker-answer"><p>幂等恢复 {attempt.number} / {operation.capabilities.idempotency?.maxAttempts} · {labels[attempt.status] ?? attempt.status} · 原操作 {attempt.operationId}<br /><small>{attempt.source} · 审计 #{attempt.resultEntryId ?? attempt.id}</small></p>
        {attempt.replayed !== undefined && <p>{attempt.replayed ? '工具返回已保存的原结果；没有第二次业务修改。' : '原操作此前尚无效果，本次在保障窗口内安全完成首次修改。'}</p>}
        {attempt.evidence !== undefined && <details><summary>工具幂等证据（原请求哈希、保障窗口与原结果）</summary><pre>{JSON.stringify(attempt.evidence, null, 2)}</pre></details>}</div>)}
      {operation.idempotency?.stopped && <p role="status">幂等恢复已停止：{stopReasons[operation.idempotency.stopped.reason] ?? operation.idempotency.stopped.reason}（{operation.idempotency.stopped.reason}）。不进行无保障重试；有可靠查询则只读核实，否则保留未知等待。</p>}
    </section>}
    {querying && !cancelled && <p role="status">正在按工具契约核实或安全恢复原操作，暂不能提交用户核实；不会新建操作标识。</p>}
    {operation.query && <section aria-label="原操作自动查询证据">
      <h4>自动核实 · 只读，不重复改期</h4>
      {operation.query.attempts.map((attempt) => <div key={attempt.id} className="blocker-answer"><p>查询 {attempt.number} / {operation.capabilities.query?.maxAttempts} · {labels[attempt.status] ?? attempt.status} · 原操作 {attempt.operationId}<br /><small>{attempt.source} · {new Date(attempt.createdAt).toLocaleString('zh-CN')} · 审计 #{attempt.resultEntryId ?? attempt.id}</small></p>
        {attempt.evidence !== undefined && <details><summary>工具查询证据（原操作账本，不是相似会议）</summary><pre>{JSON.stringify(attempt.evidence, null, 2)}</pre></details>}</div>)}
      {querying && !cancelled && <p role="status">正在核实原操作结果，暂不能提交用户核实；不会执行新的写入。</p>}
      {operation.query.stopped && <p role="status">自动核实已停止：{stopReasons[operation.query.stopped.reason] ?? operation.query.stopped.reason}（{operation.query.stopped.reason}）。原结果仍未知，保留等待；查不到不代表失败，不自动重做。</p>}
    </section>}
    {cancelled && !item.receipt && <p>Task 已取消，原结果仍未知。取消不代表外部动作被回滚，旧核实或批准不能恢复执行。</p>}
    {operation.verifications.map((entry) => <p key={entry.id} className="blocker-answer">用户核实 #{entry.id} · {entry.outcome === 'completed' ? '确认完成' : entry.outcome === 'retry' ? '申请重新操作（尚需精确批准）' : '仍无法确认'}：{entry.note}<br /><small>{entry.source} · {new Date(entry.createdAt).toLocaleString('zh-CN')}</small></p>)}
    {operation.resolution?.outcome === 'retry' && <p>原结果仍未知，记录保留。请处理新审批 #{operation.resolution.retryApprovalId}，申请本身不会执行。</p>}
    {available && <div className="approval-actions">
      <label htmlFor={`verify-note-${item.id}`}>核实说明（必填，不是新授权或参数变更）</label>
      <textarea id={`verify-note-${item.id}`} rows={2} maxLength={2000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="说明你核对了哪个会议、实际时间，或为什么仍不能确认。" />
      <p className="muted small">重新操作可能重复执行。选择后仅创建同参数的新审批，仍须明确承认重复风险并再次批准；不会默认执行。</p>
      <div className="button-row"><button className="primary" disabled={busy || !note.trim()} onClick={() => void verify('completed')}>我已核实原操作完成</button>
        <button disabled={busy || !note.trim()} onClick={() => void verify('unknown')}>仍无法确认，继续等待</button>
        <button disabled={busy || !note.trim()} onClick={() => void verify('retry')}>申请重新操作（可能重复）</button></div>
    </div>}
  </div>
}
