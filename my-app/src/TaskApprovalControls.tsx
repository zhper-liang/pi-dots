import { taskPath } from './taskPath'
import ActionOutcomeControls from './ActionOutcomeControls'
import SystemCard from './SystemCard'
import { ALWAYS_WARNING, canAlways, openApproval } from './system-cards.mjs'
import { ruleLabel, type RoutineRule } from './routines.mjs'
import { useEffect, useRef, useState } from 'react'

type EventSnapshot = { id: string; title: string; start: string | {timestamp: string; timezone: string}; end: string | {timestamp: string; timezone: string}; location: string; description: string; freeBusyStatus?: string }
const eventTime = (value: EventSnapshot['start']) => typeof value === 'string' ? value : `${new Intl.DateTimeFormat('zh-CN', { timeZone: value.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(Number(value.timestamp) * 1000))} (${value.timezone})`
export type ApprovalState = { activeId: number | null; items: {
  id: number; taskId: number; toolName: string; binding: string; simulated: boolean; createdAt: string;
  status: 'pending' | 'executed' | 'rejected' | 'not-executed' | 'dispatching' | 'outcome-unknown';
  allowAlways?: boolean; retryOf?: { approvalId: number; operationId: string }; duplicateRisk?: string;
  operation?: { id: string; intentEntryId: number; createdAt: string; unknownAt?: string; capabilities: { reliableQuery: boolean; stableIdempotency: boolean; query?: { name: string; source: string; identity: string[]; maxAttempts: number; timeoutMs: number }; idempotency?: { name: string; source: string; key: string; scope: string; parameters: string; windowMs: number; windowStart: string; maxAttempts: number; timeoutMs: number } };
    query?: { attempts: { id: number; number: number; operationId: string; source: string; status: string; createdAt: string; finishedAt?: string; resultEntryId?: number; evidence?: unknown }[]; stopped: { reason: string; createdAt: string } | null };
    idempotency?: { attempts: { id: number; number: number; operationId: string; source: string; status: string; createdAt: string; finishedAt?: string; resultEntryId?: number; evidence?: unknown; replayed?: boolean }[]; stopped: { reason: string; createdAt: string } | null };
    verifications: { id: number; outcome: string; note: string; source: string; createdAt: string }[]; resolution: { outcome: string; retryApprovalId?: number } | null };  source?: { provider: string; calendarId: string; summary: string; connectionId: string; authorizationVersion: number }; before: EventSnapshot | null;
  arguments: { resource: string; eventId?: string; expectedStart?: string; expectedEnd?: string; start: string; end: string; title?: string; description?: string; timezone?: string; freeBusy?: string };
  decision: { decision: 'approved' | 'rejected' | 'inserted'; reason: string; source: string; createdAt: string } | null;
  insertion?: { messageId: number; message: string; createdAt: string };
  receipt: { id: number; source?: string; createdAt: string; result: { ok: boolean; data?: unknown; error?: { code: string; message: string } } } | null
}[] }
export type ApprovalTask = { bot: { id: string }; taskId: number; approvals?: ApprovalState; cancellation?: unknown; runtime: { status: string; outcome?: { status: string } } }
export default function TaskApprovalControls<T extends ApprovalTask>({ task, token, onUpdated, onError, scope }: {
  task: T; token: string; onUpdated: (task: T) => void; onError: (error: unknown) => void; scope?: 'open' | 'settled'
}) {
  const [reasons, setReasons] = useState<Record<number, string>>({})
  const [riskAcknowledged, setRiskAcknowledged] = useState<Record<number, boolean>>({})
  const [choices, setChoices] = useState<Record<number, 'approved' | 'rejected' | 'inserted'>>({})
  const [requirements, setRequirements] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState<Record<number, string>>({})
  const [failed, setFailed] = useState<{ id: number; action: 'approved' | 'rejected' | 'inserted' | 'submit'; message?: string; always?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false), request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const cancelled = Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted'
  const items = (task.approvals?.items ?? []).filter(item => !scope || (scope === 'open') === openApproval(item, cancelled))
  if (!items.length) return null
  async function decide(id: number, decision: 'approved' | 'rejected' | 'inserted' | 'submit', retryMessage?: string, always = false) {
    if (submitting.current || cancelled) return
    const message = retryMessage ?? requirements[id] ?? ''
    if (decision === 'submit' && !message.trim()) return
    if (decision !== 'submit') setChoices((current) => ({ ...current, [id]: decision }))
    else setSubmitted((current) => ({ ...current, [id]: message }))
    submitting.current = true; setBusy(true); setFailed(null)
    const controller = new AbortController(); request.current = controller
    try {
      const response = await fetch(taskPath(task, `/approvals/${id}/${decision === 'submit' ? 'insert' : 'decide'}`), { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(decision === 'submit' ? { message } : { decision, reason: reasons[id] ?? '', ...(items.find((item) => item.id === id)?.retryOf && decision === 'approved' && riskAcknowledged[id] ? { acknowledgeDuplicateRisk: true } : {}), ...(always ? { always: true } : {}) }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '审批未确认，请刷新核对记录后再操作。')
      if (!controller.signal.aborted) onUpdated(body.task)
    } catch (error) { if (!controller.signal.aborted) { setFailed({ id, action: decision, message, always }); onError(error) } }
    finally { if (!controller.signal.aborted) { submitting.current = false; setBusy(false) } }
  }
  const management = items.some(item => ['bot_manage', 'routine_propose'].includes(item.toolName))
  return <section className="task-blockers task-approvals" aria-label={management ? '操作确认' : '模拟日历审批'} data-testid="task-approvals">
    <h3>{management ? '操作确认' : '日历操作审批'} · Task #{task.taskId}</h3>
    <p className="muted small">模拟与真实来源逐卡标明。批准只绑定下列精确字段，不授予工具或额度；派发前再次检查。普通消息和模型自称批准无效。</p>
    {items.map((item) => item.toolName === 'routine_propose' ? <RoutineCard key={item.id} item={item} active={task.approvals?.activeId === item.id} locked={busy || cancelled || Boolean(item.decision || choices[item.id])} onDecide={(decision, always) => void decide(item.id, decision, undefined, always)} failed={failed?.id === item.id && !cancelled} />
      : item.toolName === 'bot_manage' ? <ManagementCard key={item.id} item={item} active={task.approvals?.activeId === item.id} locked={busy || cancelled || Boolean(item.decision || choices[item.id])} onDecide={(decision, always) => void decide(item.id, decision, undefined, always)} failed={failed?.id === item.id && !cancelled} /> : <SystemCard key={item.id} className={`blocker-item ${item.status}`} card={{ kind: 'approval', state: item.receipt || item.decision ? item.status : 'pending', toolName: item.toolName, retry: Boolean(item.retryOf), allowAlways: item.allowAlways }}
      title={`审批 #${item.id} · ${item.arguments.title ?? item.before?.title ?? ''}`} state={item.receipt ? item.status === 'executed' ? item.receipt.source === 'authenticated-user-verification' ? '用户核实完成 · 非工具独立验证' : item.receipt.source === 'tool-idempotent-recovery' ? '工具幂等恢复完成 · 原操作回执' : item.receipt.source === 'tool-result-query' ? '工具自动核实完成 · 恢复回执' : item.simulated === false ? item.toolName === 'calendar_feishu_delete_event' ? '真实删除已回读核验' : item.toolName === 'calendar_feishu_update_event' ? '真实更新已回读核验' : '真实创建已回读核验' : '模拟改期成功' : item.status === 'rejected' ? '已拒绝 · 未修改' : '未执行 · 见回执' : cancelled ? '已取消 · 不执行' : item.operation ? item.status === 'dispatching' ? '已登记派发意图 · 结果尚未保存' : '操作结果未知 · 等待用户核实' : item.decision?.decision === 'inserted' && !item.insertion ? '已选择插入 · 等待新要求' : item.decision ? '决定已保存 · 正在复查' : '等待批准 · 数据未修改'}>
      <dl className="approval-parameters">
        <dt>操作 / 资源</dt><dd>{item.toolName} / {item.arguments.resource}</dd>
        <dt>来源 / 日历</dt><dd>{item.simulated === false ? `真实飞书 / ${item.source?.summary} / ${item.source?.calendarId} · 授权版本 ${item.source?.authorizationVersion}` : '模拟日历（无真实副作用）'}</dd><dt>会议 ID</dt><dd>{item.arguments.eventId ?? '创建新事件（无before事件）'}</dd>
        {item.before && <><dt>原时间</dt><dd>{eventTime(item.before.start)} → {eventTime(item.before.end)}</dd></>}
        <dt>{item.toolName === 'calendar_feishu_delete_event' ? '删除目标' : '新时间'}</dt><dd>{item.toolName === 'calendar_feishu_delete_event' ? '删除此精确事件，不删除日历。不可撤回。' : `${item.arguments.start} → ${item.arguments.end}`}</dd>{item.simulated === false && item.before && <><dt>完整原事件</dt><dd>{JSON.stringify(item.before)}</dd></>}
        <dt>时区 / 地点</dt><dd>{item.arguments.timezone ?? (item.before && typeof item.before.start !== 'string' ? item.before.start.timezone : 'Asia/Shanghai（UTC+08:00）')} / {item.before?.location ?? '不创建会议或邀请'}</dd>{item.simulated === false && <><dt>说明 / 忙闲</dt><dd>{item.arguments.description ?? item.before?.description ?? '（空）'} / {item.arguments.freeBusy ?? item.before?.freeBusyStatus ?? '未指定'}</dd><dt>真实副作用</dt><dd>{item.toolName === 'calendar_feishu_delete_event' ? '删除精确普通单次事件；无法撤回，拒绝含参会人事件。' : item.toolName === 'calendar_feishu_update_event' ? '仅PATCH批准字段；写前事件变化则冲突，须重新预览审批。' : '在指定日历创建一个单次定时日程。'}不通知、不邀请、不建会议。未知不自动重试；本地串行不防外部写者竞态，非原子CAS。</dd></>}
      </dl>
      <p className="muted small">意图创建：{new Date(item.createdAt).toLocaleString('zh-CN')} · 参数变更必须重新审批。</p>
      {item.retryOf && <div className="queue-notice" role="note"><strong>重新操作可能重复执行</strong><p>{item.duplicateRisk} 原审批 #{item.retryOf.approvalId} · 原操作 {item.retryOf.operationId}。这不是原动作已失败的证明；下列全部参数需要再次精确批准。</p></div>}
      {item.operation && <ActionOutcomeControls task={task} item={item} token={token} onUpdated={onUpdated} onError={onError} />}
      <div className="approval-actions">
        {!item.decision && !choices[item.id] && !cancelled && <>
          <label htmlFor={`approval-reason-${item.id}`}>决定原因（可选）</label>
          <textarea id={`approval-reason-${item.id}`} rows={2} maxLength={2000} value={reasons[item.id] ?? ''} disabled={busy || task.approvals?.activeId !== item.id}
            placeholder="可说明同意或拒绝的原因；选择插入后再填写新要求" onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} />
          {item.retryOf && <label className="risk-confirm"><input type="checkbox" checked={Boolean(riskAcknowledged[item.id])} disabled={busy || task.approvals?.activeId !== item.id} onChange={(event) => setRiskAcknowledged((current) => ({ ...current, [item.id]: event.target.checked }))} />我理解原动作可能已完成，重新执行可能造成重复，并确认上述精确参数。</label>}
        </>}
        <div className="action-row">
          <button type="button" disabled={busy || cancelled || Boolean(item.decision || choices[item.id]) || task.approvals?.activeId !== item.id || Boolean(item.retryOf && !riskAcknowledged[item.id])} onClick={() => void decide(item.id, 'approved')}>同意</button>
          {canAlways({ kind: 'approval', toolName: item.toolName, retry: Boolean(item.retryOf), allowAlways: item.allowAlways }) && <button type="button" disabled={busy || cancelled || Boolean(item.decision || choices[item.id]) || task.approvals?.activeId !== item.id} onClick={() => { if (window.confirm(ALWAYS_WARNING)) void decide(item.id, 'approved', undefined, true) }}>以后直接做</button>}
          <button type="button" disabled={busy || cancelled || Boolean(item.decision || choices[item.id]) || task.approvals?.activeId !== item.id} onClick={() => void decide(item.id, 'rejected')}>拒绝</button>
          <button type="button" disabled={busy || cancelled || Boolean(item.decision || choices[item.id]) || task.approvals?.activeId !== item.id} onClick={() => void decide(item.id, 'inserted')}>插入</button>
        </div>
        {(item.decision || choices[item.id]) && <p role="status">已选择{({ approved: '同意', rejected: '拒绝', inserted: '插入' })[item.decision?.decision ?? choices[item.id]]} · 本卡已锁定，不能更改选择；如需改主意，请等待新一轮审批卡。</p>}
        {item.decision?.source === 'policy-rule' && <p className="muted small">按“总是允许”规则自动通过 · 已发送，无法撤销</p>}
        {item.decision && <p className="muted small">{new Date(item.decision.createdAt).toLocaleString('zh-CN')} · {item.decision.reason || '未填写原因'}</p>}
        {item.decision?.decision === 'inserted' && !item.insertion && !cancelled && task.approvals?.activeId === item.id && <div>
          <label htmlFor={`approval-insert-${item.id}`}>修改要求</label>
          <textarea id={`approval-insert-${item.id}`} autoFocus rows={3} maxLength={4000} value={requirements[item.id] ?? ''} disabled={busy || submitted[item.id] !== undefined}
            placeholder="填写新要求。提交后由 Bot 重新规划，新操作需要新一轮审批。" onChange={(event) => setRequirements((current) => ({ ...current, [item.id]: event.target.value }))} />
          <button type="button" disabled={busy || submitted[item.id] !== undefined || !(requirements[item.id] ?? '').trim()} onClick={() => void decide(item.id, 'submit')}>提交新要求</button>
          <p className="muted small">提交前保持等待，不执行原操作；提交后不能修改本次要求。</p>
        </div>}
        {item.insertion && <p>已提交的新要求：{item.insertion.message}</p>}
        {failed?.id === item.id && !cancelled && <div role="alert">请求未确认，本卡保持锁定。请重试同一请求或刷新核对服务端记录。
          <button type="button" disabled={busy} onClick={() => void decide(item.id, failed.action, failed.message, failed.always)}>重试原请求</button>
        </div>}
        {cancelled && <p>Task 已取消，不能用迟到选择或提交恢复执行。</p>}
      </div>
      {item.receipt && <div className="approval-receipt"><p><strong>执行回执 #{item.receipt.id}</strong> · {item.receipt.result.ok ? item.receipt.source === 'authenticated-user-verification' ? '用户核实：原操作已完成；宿主未独立验证，不再次执行' : item.receipt.source === 'tool-idempotent-recovery' ? '工具在有效保障窗口复用原标识与原参数恢复；业务效果只发生一次（详见证据）' : item.receipt.source === 'tool-result-query' ? '工具按原操作 ID 查询确认完成并补录；未再次写入' : item.simulated === false ? '真实飞书操作API接受并按精确ID回读核验' : '按工具成功回执记录模拟改期' : `${item.receipt.result.error?.code}：${item.receipt.result.error?.message}`}</p><details><summary>原意图、审批绑定与实际结果</summary><pre>{JSON.stringify({ taskId: item.taskId, approvalId: item.id, binding: item.binding, arguments: item.arguments, before: item.before, decision: item.decision, operation: item.operation, receipt: item.receipt }, null, 2)}</pre></details></div>}
    </SystemCard>)}
  </section>
}

type ApprovalItem = ApprovalState['items'][number]
type ManageArgs = { action: 'create' | 'configure' | 'deactivate'; botId?: string; name?: string; description?: string; profile?: string; parameters?: unknown; tools?: string[]; resources?: string[] }
const manageLabels = { create: '新建 Bot', configure: '修改 Bot 配置', deactivate: '停用 Bot' }
// Explicit policy confirmation for Bot management.
function ManagementCard({ item, active, locked, onDecide, failed }: { item: ApprovalItem; active: boolean; locked: boolean; onDecide: (decision: 'approved' | 'rejected', always?: boolean) => void; failed: boolean }) {
  const args = item.arguments as unknown as ManageArgs, before = item.before as unknown as { name?: string; description?: string } | null
  const state = item.receipt ? item.receipt.result.ok ? '已生效' : item.status === 'rejected' ? '已拒绝 · 没有改动' : '未执行 · 见回执' : item.decision ? '决定已保存 · 正在执行' : '等待确认 · 尚未改动'
  return <SystemCard className={`blocker-item ${item.status}`} card={{ kind: 'bot-management', state: item.receipt || item.decision ? item.status : 'pending', toolName: 'bot_manage' }} title={`确认 #${item.id} · ${manageLabels[args.action]}`} state={state}>
    <dl className="approval-parameters">
      <dt>对象</dt><dd>{args.action === 'create' ? `新 Bot「${args.name}」（${args.profile === 'mock-calendar' ? '日程类型' : '通用类型'}）` : `「${before?.name ?? args.botId}」`}</dd>
      {args.description !== undefined ? <><dt>职责</dt><dd>{before?.description && args.action === 'configure' ? `${before.description} → ${args.description}` : args.description}</dd></>
        : args.action === 'create' && <><dt>职责</dt><dd>按名字自动生成</dd></>}
      {args.action === 'configure' && <><dt>工具 / 资源</dt><dd>{(args.tools ?? []).join('、') || '无'} / {(args.resources ?? []).join('、') || '无'}</dd></>}
      {args.parameters !== undefined && <><dt>参数</dt><dd>{JSON.stringify(args.parameters)}</dd></>}
    </dl>
    <p className="muted small">创建和配置默认直接做，停用默认先问。工具与资源变更从所有会话的下一次调用起生效。</p>
    <div className="action-row">
      <button type="button" disabled={locked || !active} onClick={() => onDecide('approved')}>同意</button>
      {canAlways({ kind: 'approval', toolName: item.toolName, allowAlways: item.allowAlways }) && <button type="button" disabled={locked || !active} onClick={() => { if (window.confirm(ALWAYS_WARNING)) onDecide('approved', true) }}>以后直接做</button>}
      <button type="button" disabled={locked || !active} onClick={() => onDecide('rejected')}>拒绝</button>
    </div>
    {failed && <p role="alert">请求未确认，请刷新核对后再操作。</p>}
    {item.receipt && !item.receipt.result.ok && <p className="muted small">{item.receipt.result.error?.code}：{item.receipt.result.error?.message}</p>}
  </SystemCard>
}

type RoutineArgs = { title: string; prompt: string; rule: RoutineRule; sourceIds: string[]; notification: string }
// A routine card is shown when the current policy asks for confirmation.
function RoutineCard({ item, active, locked, onDecide, failed }: { item: ApprovalItem; active: boolean; locked: boolean; onDecide: (decision: 'approved' | 'rejected', always?: boolean) => void; failed: boolean }) {
  const args = item.arguments as unknown as RoutineArgs
  const state = item.receipt ? item.receipt.result.ok ? '已创建' : item.status === 'rejected' ? '已拒绝 · 没有创建' : '未创建 · 见原因' : item.decision ? '决定已保存 · 正在创建' : '等你确认 · 尚未创建'
  return <SystemCard className={`blocker-item ${item.status}`} card={{ kind: 'routine-proposal', state: item.receipt || item.decision ? item.status : 'pending', toolName: 'routine_propose' }} title={`例行任务「${args.title}」`} state={state}>
    <dl className="approval-parameters">
      <dt>每次要做</dt><dd>{args.prompt}</dd>
      <dt>什么时候</dt><dd>{ruleLabel(args.rule)}（Asia/Shanghai）</dd>
      <dt>读哪些</dt><dd>{args.sourceIds.map(id => id === 'local' ? '本地日程和待办' : id).join('、')}</dd>
      <dt>结果</dt><dd>{args.notification === 'inbox' ? '放进收件箱' : '只留运行记录'}</dd>
      <dt>能做的改动</dt><dd>按 Bot 当前工具、资源和规则执行。需要询问时跳过该步骤，并在结果中写明需要你来做。</dd>
    </dl>
    <p className="muted small">创建后可在 Bot 页测试运行、暂停或取消。</p>
    <div className="action-row">
      <button type="button" disabled={locked || !active} onClick={() => onDecide('approved')}>同意</button>
      {canAlways({ kind: 'approval', toolName: item.toolName, allowAlways: item.allowAlways }) && <button type="button" disabled={locked || !active} onClick={() => { if (window.confirm(ALWAYS_WARNING)) onDecide('approved', true) }}>以后直接做</button>}
      <button type="button" disabled={locked || !active} onClick={() => onDecide('rejected')}>拒绝</button>
    </div>
    {failed && <p role="alert">请求未确认，请刷新核对后再操作。</p>}
    {item.receipt && !item.receipt.result.ok && <p className="muted small">{item.receipt.result.error?.code}：{item.receipt.result.error?.message}</p>}
  </SystemCard>
}
