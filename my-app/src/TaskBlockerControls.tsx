import { taskPath } from './taskPath'
import SystemCard from './SystemCard'
import { openBlocker } from './system-cards.mjs'
import { useEffect, useRef, useState, type FormEvent } from 'react'

export type BlockerState = { activeId: number | null; related?: BlockerState['items']; items: {
  id: number; taskId: number; question: string; requiredInformation: string; assignee: string;
  version?: number; rootWorkId?: string; inReplyTo?: number; parentTaskId?: number; supervisorBotId?: string;
  history?: {action:string; assignee:string; reason?:string; createdAt:string}[];
  status: 'pending' | 'resolved' | 'cancelled'; createdAt: string;
  answer: { id: number; content: string; createdAt: string; source: string } | null
}[] }
export type BlockedTask = { bot: { id: string }; taskId: number; title: string; groupId?: string; blockers?: BlockerState;
  collaborations?: {childTaskId:number;executorBotId:string}[]; cancellation?: unknown; runtime: { status: string; outcome?: { status: string } } }
export default function TaskBlockerControls<T extends BlockedTask>({ task, token, onUpdated, onError, scope }: {
  task: T; token: string; onUpdated: (task: T) => void; onError: (error: unknown) => void; scope?: 'open' | 'settled'
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const cancelled = Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted'
  const items = [...(task.blockers?.items ?? []), ...(task.groupId ? [] : task.blockers?.related ?? [])].filter(item => !scope || (scope === 'open') === openBlocker(item, cancelled))
  const own=(id:number)=>task.blockers?.items.some(item=>item.id===id)
  if (!items.length) return null
  async function resolve(event: FormEvent, id: number) {
    event.preventDefault()
    if (!own(id) || submitting.current || cancelled || !(drafts[id] ?? '').trim()) return
    const item=items.find(item=>item.id===id)!
    if(item.assignee!=='user') return
    submitting.current = true; setBusy(true)
    const controller = new AbortController(); request.current = controller
    try {
      const response = await fetch(taskPath(task, `/blockers/${id}/resolve`), {
        method: 'POST', body: JSON.stringify({ answer: drafts[id], ...(item.rootWorkId?{version:item.version,rootWorkId:item.rootWorkId,inReplyTo:item.inReplyTo}:{}) }), signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '回答未确认，请刷新核对记录后再操作。')
      if (!controller.signal.aborted) { onUpdated(body.task); setDrafts((current) => ({ ...current, [id]: '' })) }
    } catch (error) { if (!controller.signal.aborted) onError(error) }
    finally { if (!controller.signal.aborted) { submitting.current = false; setBusy(false) } }
  }
  return <section className="task-blockers" aria-label="待处理问题" data-testid="task-blockers">
    <h3>待处理问题 · Task #{task.taskId}</h3>
    <p className="muted small">从对应事项回答后，原 Task 保留历史、配置、进度与调用计数继续；普通排队消息和插入不会被当作回答。</p>
    {items.map((item) => <SystemCard key={item.id} className={`blocker-item ${item.status}`} card={{ kind: 'blocker', state: item.status === 'pending' && !cancelled ? 'pending' : item.status }} title={`问题 #${item.id}`} state={item.status === 'resolved' ? '已回答' : cancelled || item.status==='cancelled' ? '已取消 · 问题保留' : item.assignee==='supervisor'?'等待主管处理':'已转用户 / 等待用户回答'}>
      <p className="blocker-question">{item.question}</p>
      <p className="muted small">需要：{item.requiredInformation} · 处理人：{item.assignee==='supervisor'?`主管 ${item.supervisorBotId} / Task #${item.parentTaskId}`:'认证用户'} · 子任务 #{item.taskId} · v{item.version??1} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p>
      {item.history?.map((event,index)=><p className="muted small" key={index}>{event.action} → {event.assignee} {event.reason??''} · {new Date(event.createdAt).toLocaleString('zh-CN')}</p>)}
      {item.answer ? <div className="blocker-answer"><strong>处理人回答（不代表批准）</strong><p>{item.answer.content}</p><span className="muted small">{new Date(item.answer.createdAt).toLocaleString('zh-CN')} · 已保存到此事项，仅处理一次</span></div>
        : cancelled || item.status==='cancelled' ? <p className="muted">此 Task 已取消，不能通过回答恢复。</p>
          : !own(item.id) ? <p className="muted">此为子任务同一事项；请<a href={`#bot=${encodeURIComponent(task.collaborations?.find(r=>r.childTaskId===item.taskId)?.executorBotId??'')}&task=${item.taskId}`}>打开子任务 #{item.taskId}</a> 精准处理。</p>
          : item.assignee!=='user' ? <p className="muted">仅绑定主管可回答或显式转用户；普通消息不解除等待。</p>
          : <form onSubmit={(event) => void resolve(event, item.id)}>
            <label htmlFor={`blocker-answer-${item.id}`}>回答问题 #{item.id}</label>
            <textarea id={`blocker-answer-${item.id}`} rows={2} maxLength={4000} value={drafts[item.id] ?? ''} disabled={busy || task.blockers?.activeId !== item.id}
              placeholder="例如 Asia/Shanghai；此处回答只对应这个问题" onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
            <button className="primary" disabled={busy || task.blockers?.activeId !== item.id || !(drafts[item.id] ?? '').trim()}>{busy ? '正在提交回答…' : '提交回答并继续原 Task'}</button>
            <p className="muted small">等待期间不会持续调用模型；提交不修改工具授权、不代表批准外部动作。</p>
          </form>}
    </SystemCard>)}
  </section>
}
