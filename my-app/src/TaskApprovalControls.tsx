import { toolLabel } from './timeline.mjs'
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
  capabilitySetupSpec?: { setupId: string; taskId: number; inputId: number; targetBotId: string; scope: string; sourceFingerprint: string; capabilityId: string | null; affectedBotIds: string[]; tools: string[] }
  capabilityIntent?: { kind: 'mcp' | 'skill'; proposal: Record<string, unknown>; sourceFingerprint: string; scope: string }
  callId?: string; inReplyTo?: number
  externalMcp?: { connectionId: string; connectionName?: string; originalName?: string; description?: string; catalogRevision?: string }
  allowAlways?: boolean; retryOf?: { approvalId: number; operationId: string }; duplicateRisk?: string;
  operation?: { id: string; intentEntryId: number; createdAt: string; unknownAt?: string; capabilities: { reliableQuery: boolean; stableIdempotency: boolean; query?: { name: string; source: string; identity: string[]; maxAttempts: number; timeoutMs: number }; idempotency?: { name: string; source: string; key: string; scope: string; parameters: string; windowMs: number; windowStart: string; maxAttempts: number; timeoutMs: number } };
    query?: { attempts: { id: number; number: number; operationId: string; source: string; status: string; createdAt: string; finishedAt?: string; resultEntryId?: number; evidence?: unknown }[]; stopped: { reason: string; createdAt: string } | null };
    idempotency?: { attempts: { id: number; number: number; operationId: string; source: string; status: string; createdAt: string; finishedAt?: string; resultEntryId?: number; evidence?: unknown; replayed?: boolean }[]; stopped: { reason: string; createdAt: string } | null };
    verifications: { id: number; outcome: string; note: string; source: string; createdAt: string }[]; resolution: { outcome: string; retryApprovalId?: number } | null };  source?: { provider: string; calendarId: string; summary: string; connectionId: string; authorizationVersion: number }; before: EventSnapshot | null;
  arguments: { resource: string; eventId?: string; expectedStart?: string; expectedEnd?: string; start: string; end: string; title?: string; description?: string; timezone?: string; freeBusy?: string };
  decision: { decision: 'approved' | 'rejected' | 'inserted'; reason: string; source: string; createdAt: string } | null;
  insertion?: { messageId: number; message: string; createdAt: string };
  receipt: { id: number; source?: string; createdAt: string; result: { ok: boolean; data?: unknown; error?: { code: string; message: string; unknown?: boolean; retryable?: boolean } } } | null
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
  const management = items.some(item => item.externalMcp || ['bot_manage', 'routine_propose', 'mcp_manage', 'skill_manage'].includes(item.toolName))
  return <section className="task-blockers task-approvals" aria-label={management ? '操作确认' : '日历操作确认'} data-testid="task-approvals">
    <h3>{management ? '操作确认' : '日历操作审批'}</h3>
    <p className="muted small">确认下方操作后，机器人会继续处理。</p>
    {items.map((item) => item.toolName === 'routine_propose' ? <RoutineCard key={item.id} item={item} active={task.approvals?.activeId === item.id} locked={busy || cancelled || Boolean(item.decision || choices[item.id])} onDecide={(decision, always) => void decide(item.id, decision, undefined, always)} failed={failed?.id === item.id && !cancelled} />
      : item.toolName === 'bot_manage' ? <ManagementCard key={item.id} item={item} active={task.approvals?.activeId === item.id} locked={busy || cancelled || Boolean(item.decision || choices[item.id])} onDecide={(decision, always) => void decide(item.id, decision, undefined, always)} failed={failed?.id === item.id && !cancelled} /> : <SystemCard key={item.id} id={`approval-${item.id}`} className={`blocker-item ${item.status}${isCapabilityApproval(item) ? ' capability-approval-card' : ''}`} card={{ kind: 'approval', state: item.receipt || item.decision ? item.status : 'pending', toolName: item.toolName, retry: Boolean(item.retryOf), allowAlways: item.allowAlways }}
      title={capabilityApprovalTitle(item) ?? `审批 #${item.id} · ${item.arguments.title ?? item.before?.title ?? ''}`} state={capabilityApprovalState(item, cancelled) ?? (item.receipt ? item.status === 'executed' ? item.receipt.source === 'authenticated-user-verification' ? '用户核实完成 · 非工具独立验证' : item.receipt.source === 'tool-idempotent-recovery' ? '操作已恢复完成' : item.receipt.source === 'tool-result-query' ? '已核对操作结果' : item.simulated === false ? item.toolName === 'calendar_feishu_delete_event' ? '真实删除已回读核验' : item.toolName === 'calendar_feishu_update_event' ? '真实更新已回读核验' : '真实创建已回读核验' : '测试改期完成' : item.status === 'rejected' ? '已拒绝 · 未修改' : '未执行 · 见结果' : cancelled ? '已取消 · 不执行' : item.operation ? item.status === 'dispatching' ? '已登记派发意图 · 结果尚未保存' : '操作结果未知 · 等待用户核实' : item.decision?.decision === 'inserted' && !item.insertion ? '已选择插入 · 等待新要求' : item.decision ? '决定已保存 · 正在复查' : '等待批准 · 数据未修改')}>
      <dl className={`approval-parameters${isCapabilityApproval(item) ? ' capability-approval-parameters' : ''}`}>
        {isCapabilityApproval(item) ? <CapabilityApprovalParameters item={item} /> : <>
        <dt>操作 / 日历</dt><dd>{toolLabel(item.toolName)}</dd>
        <dt>日历</dt><dd>{item.simulated === false ? item.source?.summary ?? '飞书日历' : '测试日历'}</dd><dt>会议 ID</dt><dd>{item.arguments.eventId ?? '创建新事件（无before事件）'}</dd>
        {item.before && <><dt>原时间</dt><dd>{eventTime(item.before.start)} → {eventTime(item.before.end)}</dd></>}
        <dt>{item.toolName === 'calendar_feishu_delete_event' ? '删除目标' : '新时间'}</dt><dd>{item.toolName === 'calendar_feishu_delete_event' ? '删除此精确事件，不删除日历。不可撤回。' : `${item.arguments.start} → ${item.arguments.end}`}</dd>{item.simulated === false && item.before && <><dt>原事件</dt><dd><details className="tech-info"><summary>技术信息</summary><pre>{JSON.stringify(item.before, null, 2)}</pre></details></dd></>}
        <dt>时区 / 地点</dt><dd>{item.arguments.timezone ?? (item.before && typeof item.before.start !== 'string' ? item.before.start.timezone : 'Asia/Shanghai（UTC+08:00）')} / {item.before?.location ?? '不创建会议或邀请'}</dd>{item.simulated === false && <><dt>说明 / 忙闲</dt><dd>{item.arguments.description ?? item.before?.description ?? '（空）'} / {item.arguments.freeBusy ?? item.before?.freeBusyStatus ?? '未指定'}</dd><dt>真实副作用</dt><dd>{item.toolName === 'calendar_feishu_delete_event' ? '删除精确普通单次事件；无法撤回，拒绝含参会人事件。' : item.toolName === 'calendar_feishu_update_event' ? '仅PATCH批准字段；写前事件变化则冲突，须重新预览审批。' : '在指定日历创建一个单次定时日程。'}不通知、不邀请、不建会议。未知不自动重试；本地串行不防外部写者竞态，非原子CAS。</dd></>}
</>}
      </dl>
      <p className="muted small">意图创建：{new Date(item.createdAt).toLocaleString('zh-CN')} · 参数变更必须重新审批。</p>
      {item.retryOf && <div className="queue-notice" role="note"><strong>重新操作可能重复执行</strong><p>{item.duplicateRisk} 原审批 #{item.retryOf.approvalId} · 原操作 {item.retryOf.operationId}。这不是原动作已失败的证明；下列全部参数需要再次精确批准。</p></div>}
      {/* Native manager and external-MCP intents have no legacy calendar recovery contract. */}
      {item.operation && (approvalOperationKind(item) === 'manager' ? <p role="status" className="muted small">原配置操作已登记，结果见能力配置卡。</p>
        : approvalOperationKind(item) === 'external-mcp' ? <div className="approval-external-operation"><p role="status">{externalOperationSummary(item)}</p><details className="tech-info"><summary>技术信息</summary><p className="muted small">原调用标识：<code>{item.operation.id}</code>。仅展示这次调用的实际回执，不自动重新调用，也不使用未声明的查询或幂等恢复。</p></details></div>
        : approvalOperationKind(item) === 'calendar' ? <ActionOutcomeControls task={task} item={item} token={token} onUpdated={onUpdated} onError={onError} />
          : <p role="status" className="muted small">原操作已登记，请核对结果。</p>)}
      <div className="approval-actions">
        {!item.decision && !choices[item.id] && !cancelled && <>
          <label htmlFor={`approval-reason-${item.id}`}>决定原因（可选）</label>
          <textarea id={`approval-reason-${item.id}`} rows={2} maxLength={2000} value={reasons[item.id] ?? ''} disabled={busy || task.approvals?.activeId !== item.id}
            placeholder="可说明同意或拒绝的原因；选择插入后再填写新要求" onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} />
          {item.retryOf && <label className="risk-confirm"><input type="checkbox" checked={Boolean(riskAcknowledged[item.id])} disabled={busy || task.approvals?.activeId !== item.id} onChange={(event) => setRiskAcknowledged((current) => ({ ...current, [item.id]: event.target.checked }))} />我理解原动作可能已完成，重新执行可能造成重复，并确认上述精确参数。</label>}
        </>}
        <div className="action-row">
          <button type="button" disabled={busy || cancelled || Boolean(item.decision || choices[item.id]) || task.approvals?.activeId !== item.id || Boolean(item.retryOf && !riskAcknowledged[item.id])} onClick={() => void decide(item.id, 'approved')}>同意</button>
          {canAlways({ kind: 'approval', toolName: item.toolName, retry: Boolean(item.retryOf), allowAlways: isCapabilityApproval(item) ? false : item.allowAlways }) && <button type="button" disabled={busy || cancelled || Boolean(item.decision || choices[item.id]) || task.approvals?.activeId !== item.id} onClick={() => { if (window.confirm(ALWAYS_WARNING)) void decide(item.id, 'approved', undefined, true) }}>以后直接做</button>}
          <button type="button" disabled={busy || cancelled || Boolean(item.decision || choices[item.id]) || task.approvals?.activeId !== item.id} onClick={() => void decide(item.id, 'rejected')}>拒绝</button>
          <button type="button" disabled={busy || cancelled || Boolean(item.decision || choices[item.id]) || task.approvals?.activeId !== item.id} onClick={() => void decide(item.id, 'inserted')}>插入</button>
        </div>
        {(item.decision || choices[item.id]) && <p role="status">已选择{({ approved: '同意', rejected: '拒绝', inserted: '插入' })[item.decision?.decision ?? choices[item.id]]} · 本卡已锁定，不能更改选择；如需改主意，请等待新一轮审批卡。</p>}
        {item.decision?.source === 'policy-rule' && <p className="muted small">按“总是允许”规则自动通过 · 已发送，无法撤销</p>}
        {item.decision && <p className="muted small">{new Date(item.decision.createdAt).toLocaleString('zh-CN')} · {item.decision.reason || '未填写原因'}</p>}
        {item.decision?.decision === 'inserted' && !item.insertion && !cancelled && task.approvals?.activeId === item.id && <div>
          <label htmlFor={`approval-insert-${item.id}`}>修改要求</label>
          <textarea id={`approval-insert-${item.id}`} autoFocus rows={3} maxLength={4000} value={requirements[item.id] ?? ''} disabled={busy || submitted[item.id] !== undefined}
            placeholder="填写新要求。提交后由机器人重新规划，新操作需要新一轮审批。" onChange={(event) => setRequirements((current) => ({ ...current, [item.id]: event.target.value }))} />
          <button type="button" disabled={busy || submitted[item.id] !== undefined || !(requirements[item.id] ?? '').trim()} onClick={() => void decide(item.id, 'submit')}>提交新要求</button>
          <p className="muted small">提交前保持等待，不执行原操作；提交后不能修改本次要求。</p>
        </div>}
        {item.insertion && <p>已提交的新要求：{item.insertion.message}</p>}
        {failed?.id === item.id && !cancelled && <div role="alert">请求未确认，本卡保持锁定。请重试同一请求或刷新核对服务端记录。
          <button type="button" disabled={busy} onClick={() => void decide(item.id, failed.action, failed.message, failed.always)}>重试原请求</button>
        </div>}
        {cancelled && <p>会话已取消，不能用迟到选择或提交恢复执行。</p>}
      </div>
      {item.receipt && <div className="approval-receipt"><p>{item.receipt.result.ok ? '完成' : '没有成功'}</p><details className="tech-info"><summary>技术信息</summary><pre>{JSON.stringify({ taskId: item.taskId, approvalId: item.id, binding: item.binding, arguments: item.arguments, before: item.before, decision: item.decision, operation: item.operation, receipt: item.receipt }, null, 2)}</pre></details></div>}
    </SystemCard>)}
  </section>
}

type ApprovalItem = ApprovalState['items'][number]
const setupTools = ['mcp_manage', 'skill_manage']
function isCapabilityApproval(item: ApprovalItem) { return Boolean(item.externalMcp) || setupTools.includes(item.toolName) }
function approvalOperationKind(item: ApprovalItem) {
  if (setupTools.includes(item.toolName)) return 'manager'
  if (item.externalMcp) return 'external-mcp'
  const capabilities = item.operation?.capabilities
  return capabilities && typeof capabilities === 'object' ? 'calendar' : 'unrecognized'
}
function externalOutcomeUnknown(item: ApprovalItem) {
  return item.status === 'outcome-unknown' || item.receipt?.result.error?.unknown === true || ['MCP_INVOCATION_UNKNOWN', 'MCP_OUTCOME_UNKNOWN'].includes(item.receipt?.result.error?.code ?? '')
}
function externalOperationSummary(item: ApprovalItem) {
  if (externalOutcomeUnknown(item)) return '没确认外部调用结果，请核对实际状态。'
  if (item.receipt) return item.receipt.result.ok ? '外部调用完成，详情见技术信息。' : '外部调用没有成功，详情见技术信息。'
  return item.status === 'dispatching' ? '外部调用已发出，等结果。' : '外部调用还没有结果。'
}

function capabilityApprovalTitle(item: ApprovalItem) {
  if (item.externalMcp) return `确认 #${item.id} · ${item.externalMcp.connectionName ?? '连接名称未提供'} · ${item.externalMcp.originalName ?? '原工具名称未提供'}`
  if (setupTools.includes(item.toolName)) return `确认 #${item.id} · ${item.toolName === 'mcp_manage' ? 'MCP' : 'Skill'} 配置`
  return undefined
}
function capabilityApprovalState(item: ApprovalItem, cancelled: boolean) {
  if (!isCapabilityApproval(item)) return undefined
  if (item.externalMcp && externalOutcomeUnknown(item)) return '外部调用结果未知 · 不自动重试'
  if (item.externalMcp && item.receipt) return item.receipt.result.ok ? '外部调用结果已保存' : item.status === 'rejected' ? '已拒绝 · 未派发' : '外部调用状态未确认 · 见结果'
  if (item.receipt) return item.receipt.result.ok ? '配置结果已保存' : item.status === 'rejected' ? '已拒绝 · 未执行' : '未完成 · 查看结果'
  if (cancelled) return '会话已取消 · 不再派发'
  if (item.operation) return item.status === 'dispatching' ? '派发已登记 · 结果未确认' : '结果未知 · 核对原操作'
  return item.decision ? '决定已保存 · 等待宿主复核' : '等待本次精确确认 · 尚未执行'
}
function CapabilityApprovalParameters({ item }: { item: ApprovalItem }) {
  const args = item.arguments as unknown as Record<string, unknown>
  const setup = setupTools.includes(item.toolName), spec = item.capabilitySetupSpec
  const affected = (spec?.affectedBotIds ?? []).filter(id => typeof id === 'string')
  const tools = (spec?.tools ?? []).filter(name => typeof name === 'string')
  const target = spec?.targetBotId ?? (typeof args.targetBotId === 'string' ? args.targetBotId : null)
  const scope = spec?.scope ?? item.capabilityIntent?.scope ?? (typeof args.action === 'string' ? args.action : null)
  const fingerprint = spec?.sourceFingerprint ?? item.capabilityIntent?.sourceFingerprint
  return <>
    {item.externalMcp ? <><dt>连接</dt><dd>{item.externalMcp.connectionName ?? '服务端未提供连接名称'} · {item.externalMcp.connectionId}</dd><dt>原工具</dt><dd>{item.externalMcp.originalName ?? '服务端未提供原工具名称'}</dd>
      {item.externalMcp.description && <><dt>说明</dt><dd>{item.externalMcp.description}</dd></>}
      <dt>调用规则</dt><dd>自动化已暂停，这一步需要你确认。</dd></> : <><dt>配置类型</dt><dd>{item.toolName === 'mcp_manage' ? 'MCP' : 'Skill'}</dd>
      <dt>目标机器人</dt><dd>{target ?? '服务端未提供目标标签，请核对实际参数'}</dd>
      <dt>本次范围</dt><dd>{scope ?? '请核对下列宿主登记参数'}</dd>
      {!!affected.length && <><dt>本次确认覆盖的机器人</dt><dd>{affected.join('、')}</dd></>}
      {!!tools.length && <><dt>本次精确授权的工具</dt><dd><ul>{tools.map(name => <li key={name}><code>{toolLabel(name)}</code></li>)}</ul></dd></>}
      {fingerprint && <><dt>配置标识</dt><dd><details className="tech-info"><summary>技术信息</summary><code>{fingerprint}</code></details></dd></>}
      <dt>权限边界</dt><dd>仅确认这张卡登记的精确范围，不授予将来的自动配置权限。</dd></>}
    <dt>{setup ? '原始配置请求' : '本次精确调用参数'}</dt><dd><details className="tech-info"><summary>技术信息</summary><pre>{JSON.stringify(item.arguments, null, 2)}</pre></details></dd>
    {spec && <><dt>本次宿主确认绑定</dt><dd><details className="tech-info"><summary>技术信息</summary><pre>{JSON.stringify(spec, null, 2)}</pre></details></dd></>}
    {item.externalMcp && <><dt>技术信息</dt><dd><details className="tech-info"><summary>技术信息</summary><code>{item.toolName}</code></details></dd></>}
  </>
}

type ManageArgs = { action: 'create' | 'configure' | 'deactivate'; botId?: string; name?: string; description?: string; profile?: string; parameters?: unknown; tools?: string[]; resources?: string[] }
const manageLabels = { create: '新建机器人', configure: '修改机器人配置', deactivate: '停用机器人' }
// Explicit policy confirmation for Bot management.
function ManagementCard({ item, active, locked, onDecide, failed }: { item: ApprovalItem; active: boolean; locked: boolean; onDecide: (decision: 'approved' | 'rejected', always?: boolean) => void; failed: boolean }) {
  const args = item.arguments as unknown as ManageArgs, before = item.before as unknown as { name?: string; description?: string } | null
  const state = item.receipt ? item.receipt.result.ok ? '已生效' : item.status === 'rejected' ? '已拒绝 · 没有改动' : '未执行 · 见结果' : item.decision ? '决定已保存 · 正在执行' : '等待确认 · 尚未改动'
  return <SystemCard className={`blocker-item ${item.status}`} card={{ kind: 'bot-management', state: item.receipt || item.decision ? item.status : 'pending', toolName: 'bot_manage' }} title={`确认 #${item.id} · ${manageLabels[args.action]}`} state={state}>
    <dl className="approval-parameters">
      <dt>对象</dt><dd>{args.action === 'create' ? `新机器人「${args.name}」（${args.profile === 'mock-calendar' ? '日程类型' : '通用类型'}）` : `「${before?.name ?? args.botId}」`}</dd>
      {args.description !== undefined ? <><dt>职责</dt><dd>{before?.description && args.action === 'configure' ? `${before.description} → ${args.description}` : args.description}</dd></>
        : args.action === 'create' && <><dt>职责</dt><dd>按名字自动生成</dd></>}
      {args.action === 'configure' && <><dt>能力</dt><dd>{(args.tools ?? []).join('、') || '无'} / {(args.resources ?? []).join('、') || '无'}</dd></>}
      {args.parameters !== undefined && <><dt>参数</dt><dd>{JSON.stringify(args.parameters)}</dd></>}
    </dl>
    <p className="muted small">自动化已暂停，这一步需要你确认。</p>
    <div className="action-row">
      <button type="button" disabled={locked || !active} onClick={() => onDecide('approved')}>同意</button>
      {canAlways({ kind: 'approval', toolName: item.toolName, allowAlways: item.allowAlways }) && <button type="button" disabled={locked || !active} onClick={() => { if (window.confirm(ALWAYS_WARNING)) onDecide('approved', true) }}>以后直接做</button>}
      <button type="button" disabled={locked || !active} onClick={() => onDecide('rejected')}>拒绝</button>
    </div>
    {failed && <p role="alert">请求未确认，请刷新核对后再操作。</p>}
    {item.receipt && !item.receipt.result.ok && <details className="tech-info"><summary>技术信息</summary><p>{item.receipt.result.error?.code}：{item.receipt.result.error?.message}</p></details>}
  </SystemCard>
}

type RoutineArgs = { title: string; prompt: string; rule: RoutineRule; sourceIds: string[]; notification: string }
// A routine card is shown when the current policy asks for confirmation.
function RoutineCard({ item, active, locked, onDecide, failed }: { item: ApprovalItem; active: boolean; locked: boolean; onDecide: (decision: 'approved' | 'rejected', always?: boolean) => void; failed: boolean }) {
  const args = item.arguments as unknown as RoutineArgs
  const state = item.receipt ? item.receipt.result.ok ? '已创建' : item.status === 'rejected' ? '已拒绝 · 没有创建' : '未创建 · 见原因' : item.decision ? '决定已保存 · 正在创建' : '等你确认 · 尚未创建'
  return <SystemCard className={`blocker-item ${item.status}`} card={{ kind: 'routine-proposal', state: item.receipt || item.decision ? item.status : 'pending', toolName: 'routine_propose' }} title={`定时任务「${args.title}」`} state={state}>
    <dl className="approval-parameters">
      <dt>每次要做</dt><dd>{args.prompt}</dd>
      <dt>什么时候</dt><dd>{ruleLabel(args.rule)}（Asia/Shanghai）</dd>
      <dt>读哪些</dt><dd>{args.sourceIds.map(id => id === 'local' ? '本地日程和待办' : id).join('、')}</dd>
      <dt>结果</dt><dd>{args.notification === 'inbox' ? '放进通知' : '只留运行记录'}</dd>
      <dt>能做的改动</dt><dd>按这个机器人的能力运行；需要你确认的步骤会跳过。</dd>
    </dl>
    <p className="muted small">创建后可在「事项 → 定时任务」里测试运行、暂停或取消。</p>
    <div className="action-row">
      <button type="button" disabled={locked || !active} onClick={() => onDecide('approved')}>同意</button>
      {canAlways({ kind: 'approval', toolName: item.toolName, allowAlways: item.allowAlways }) && <button type="button" disabled={locked || !active} onClick={() => { if (window.confirm(ALWAYS_WARNING)) onDecide('approved', true) }}>以后直接做</button>}
      <button type="button" disabled={locked || !active} onClick={() => onDecide('rejected')}>拒绝</button>
    </div>
    {failed && <p role="alert">请求未确认，请刷新核对后再操作。</p>}
    {item.receipt && !item.receipt.result.ok && <details className="tech-info"><summary>技术信息</summary><p>{item.receipt.result.error?.code}：{item.receipt.result.error?.message}</p></details>}
  </SystemCard>
}
