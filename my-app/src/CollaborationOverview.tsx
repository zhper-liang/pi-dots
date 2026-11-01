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
    if(lock.current||!window.confirm(`停止这项工作？后续工作会停止，已有结果保留。`))return
    lock.current=true;setBusy(true)
    const controller=new AbortController();request.current=controller
    try {const res=await fetch(taskPath(task,'/stop-work'),{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({rootWorkId})});const body=await res.json();if(!res.ok)throw Error(body.error?.message??'停止失败，请刷新核对。');if(!controller.signal.aborted)onUpdated(body.task)}catch(error){if(!controller.signal.aborted)onError(error)}finally{if(!controller.signal.aborted){lock.current=false;setBusy(false)}}
  }
  return <section className="collaboration-overview task-state" aria-label="协作概览"><h3>协作概览</h3>
    {roots.map(root => <div key={root.rootWorkId}><strong>当前工作</strong> {view.stops.some(stop => stop.rootWorkId === root.rootWorkId) ? <span role="status">已停止</span> : root.parentTaskId === task.taskId && <button disabled={busy || view.activeRootWorkId !== root.rootWorkId && task.activeInputId !== root.parentInputId && !task.collaborations?.some(item => item.rootWorkId === root.rootWorkId && (!item.result || item.businessStatus === 'rework-requested'))} onClick={() => void stop(root.rootWorkId)}>停止这项工作</button>}</div>)}
    <ul>{view.nodes.map(node => <li key={node.taskId}>
      <a href={nodeLink(node)}>{node.role === 'supervisor' ? '主管' : '↳ 执行者'} {node.botName}</a>
      <p>{node.cancelled ? '已取消' : node.botStatus === 'inactive' ? '已停用' : node.permissionRevoked ? '权限已撤销' : node.runtime.checkpoint?.lastOutcome === 'failed' ? '执行失败' : node.runtime.checkpoint?.lastOutcome === 'limited' ? '已到调用上限' : node.runtime.checkpoint?.phase === 'awaitChildren' ? '等子任务结果' : node.businessStatus === 'accepted' ? '已验收' : node.businessStatus === 'submitted' ? '等主管验收' : node.activeInputId !== null ? '正在处理' : '空闲'}</p>
      {node.pending.map(item => <p key={`${item.kind}:${item.id}:${item.version ?? 0}`}><a href={nodeLink(node)}>待处理 · {item.summary}</a></p>)}
    </li>)}</ul>
  </section>
}
