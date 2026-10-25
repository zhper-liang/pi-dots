import { useEffect, useRef, useState } from 'react'
import { taskPath } from './taskPath'
type Usage = { modelCalls: number; toolCalls: number; totalTokens: number; unknownTokenCalls: number }
type Node = { groupId?: string; rootWorkId?: string; sourceMessageId?: number; businessStatus?: string; queueLength?: number; taskId: number; botId: string; botName: string; role: string; botStatus: string; runtime: { status: string; checkpoint?: { phase?: string; lastOutcome?: string } }; activeInputId: number | null; usage: Usage; limits: { modelCalls: number; toolCalls: number; totalTokens?: number }; cancelled: boolean; permissionRevoked: boolean; pending: { kind: string; id: number; version?: number; assignee?: string; summary: string }[] }
export type Overview = { groupId?: string; activeRootWorkId?: string | null; roots?: {rootWorkId:string;parentInputId:number}[]; totals?: Usage; parentTaskId: number; nodes: Node[]; stops: { rootWorkId: string; entryId: number; requestedAt: string }[]; events: { id: string; rootWorkId: string; at: string; kind: string; taskId: number }[] }
type Root = { rootWorkId: string; parentTaskId: number; parentInputId: number; result: { status: string } | null; businessStatus?: string }
export default function CollaborationOverview<T extends { taskId: number; bot: { id: string }; activeInputId: number | null; collaborationOverview?: Overview | null; collaborations?: Root[] }>({ task, token, onUpdated, onError }: { task: T; token: string; onUpdated: (task: T) => void; onError: (error: unknown) => void }) {
  const [busy,setBusy]=useState(false), lock=useRef(false)
  const request=useRef<AbortController | null>(null)
  useEffect(()=>()=>request.current?.abort(),[])
  const view=task.collaborationOverview
  if(!view)return null
  const roots=view.roots?.map(r=>({...r,parentTaskId:view.parentTaskId}))??[...new Map((task.collaborations??[]).map(r=>[r.rootWorkId,r])).values()]
  const nodeLink=(n: Node)=>`#bot=${encodeURIComponent(n.groupId?'groups':n.botId)}&task=${n.taskId}${n.sourceMessageId?`&message=${n.sourceMessageId}`:''}`
  async function stop(rootWorkId: string) {
    if(lock.current||!window.confirm(`停止根工作 ${rootWorkId}？停止该原输入及其在途子任务，保留回执；不取消长期会话、其他根工作或其他Bot会话。已发生外部动作不能撤回。`))return
    lock.current=true;setBusy(true)
    const controller=new AbortController();request.current=controller
    try {const res=await fetch(taskPath(task,'/stop-work'),{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({rootWorkId})});const body=await res.json();if(!res.ok)throw Error(body.error?.message??'停止失败，请刷新核对。');if(!controller.signal.aborted)onUpdated(body.task)}catch(error){if(!controller.signal.aborted)onError(error)}finally{if(!controller.signal.aborted){lock.current=false;setBusy(false)}}
  }
  return <section className="collaboration-overview task-state" aria-label="协作工作概览"><h3>协作工作树 · 统一待处理</h3>
    <p>群长期会话保留历史；停止本轮工作不取消群会话，后续输入仍按队列处理。单子取消只影响该子线程。</p>
    {view.totals&&<p data-testid="collaboration-total">群/工作累计（每个Task只计一次）：模型 {view.totals.modelCalls} · 工具 {view.totals.toolCalls} · Token {view.totals.totalTokens} · 未知用量 {view.totals.unknownTokenCalls}；不是共享额度，也不是每轮用量。</p>}
    <p>主管管理本项工作，不等于 Chief Bot 管理权。普通消息保持 FIFO；协作事件不是用户插入或动作批准。</p>
    {roots.map(r=><div key={r.rootWorkId}><strong>根工作 {r.rootWorkId}</strong> · 原输入 #{r.parentInputId} {view.stops.some(s=>s.rootWorkId===r.rootWorkId)?<span role="status">已停止 · 不再续跑，迟到回执留档</span>:r.parentTaskId===task.taskId&&<button disabled={busy||view.activeRootWorkId!==r.rootWorkId&&task.activeInputId!==r.parentInputId&&!task.collaborations?.some(i=>i.rootWorkId===r.rootWorkId&&(!i.result||i.businessStatus==='rework-requested'))} onClick={()=>void stop(r.rootWorkId)}>停止本项根工作</button>}</div>)}
    <ul>{view.nodes.map(n=><li key={n.taskId}><a href={nodeLink(n)}>{n.role==='supervisor'?'主管':'↳ 执行者'} {n.botName} · Task #{n.taskId}</a><p>{n.cancelled?'已取消':n.botStatus==='inactive'?'Bot已停用 · 不自动恢复/改派':n.permissionRevoked?'授权已撤销 · 不可继续':n.runtime.checkpoint?.lastOutcome==='failed'?'执行失败 · 非成功':n.runtime.checkpoint?.lastOutcome==='limited'?'累计限额 · 用户按原入口处理':n.runtime.checkpoint?.phase==='awaitChildren'?'等待执行者 · 无模型轮询':n.businessStatus==='accepted'?'已接受 · 结果保留，不复活':n.businessStatus==='submitted'?'已提交 · 尚未接受':n.runtime.checkpoint?.phase==='awaitBlocker'?'等待原问题回答':n.runtime.checkpoint?.phase==='awaitApproval'?'等待原审批/结果核实':n.runtime.checkpoint?.phase??n.runtime.status}</p><p>队列 {n.queueLength??0} · 业务状态 {n.businessStatus??'长期主管会话'}{n.rootWorkId?` · 根工作 ${n.rootWorkId}`:''}</p><p>累计模型 {n.usage.modelCalls}/{n.limits.modelCalls} · 工具 {n.usage.toolCalls}/{n.limits.toolCalls} · Token {n.usage.totalTokens}{n.limits.totalTokens?`/${n.limits.totalTokens}`:''} · 未知用量 {n.usage.unknownTokenCalls}</p>{n.pending.map(i=><p key={`${i.kind}:${i.id}:${i.version??0}`}><a href={nodeLink(n)}>待处理 {i.kind} #{i.id}{i.version?` v${i.version}`:''} · {i.assignee??'认证用户'} · {i.summary}</a></p>)}</li>)}</ul>
    <p className="muted small">各 Task 独立累计，不共享额度。停止单子任务请进入该子线程；取消整个长期会话使用下方 Task 取消，覆盖其在途子任务。停用不等于取消。</p>
    <details open><summary>责任时间线 · 持久事件</summary><ol>{view.events.map(e=><li key={e.id}>{e.at} · {e.kind} · Task #{e.taskId} · {e.rootWorkId}</li>)}</ol></details>
  </section>
}
