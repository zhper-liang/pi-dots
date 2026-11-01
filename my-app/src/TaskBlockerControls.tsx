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
    <h3>待处理问题</h3>
    <p className="muted small">在下面回答，机器人就能接着处理。</p>
    {items.map((item) => <SystemCard key={item.id} className={`blocker-item ${item.status}`} card={{ kind: 'blocker', state: item.status === 'pending' && !cancelled ? 'pending' : item.status }} title="需要你回答" state={item.status === 'resolved' ? '已回答' : cancelled || item.status==='cancelled' ? '已取消' : item.assignee==='supervisor'?'等派活的机器人处理':'等你回答'}>
      <p className="blocker-question">{item.question}</p>
      {item.requiredInformation && <p className="muted small">需要：{item.requiredInformation}</p>}
      {item.answer ? <div className="blocker-answer"><strong>回答</strong><p>{item.answer.content}</p><span className="muted small">{new Date(item.answer.createdAt).toLocaleString('zh-CN')}</span></div>
        : cancelled || item.status==='cancelled' ? <p className="muted">会话已取消，回答已保留。</p>
          : !own(item.id) ? <p className="muted">这个问题在子任务里，<a href={`#bot=${encodeURIComponent(task.collaborations?.find(r=>r.childTaskId===item.taskId)?.executorBotId??'')}&task=${item.taskId}`}>去子任务回答</a>。</p>
          : item.assignee!=='user' ? <p className="muted">由派活的机器人回答，它答不了会转给你。</p>
          : <form onSubmit={(event) => void resolve(event, item.id)}>
            <label htmlFor={`blocker-answer-${item.id}`}>你的回答</label>
            <textarea id={`blocker-answer-${item.id}`} rows={2} maxLength={4000} value={drafts[item.id] ?? ''} disabled={busy || task.blockers?.activeId !== item.id}
              placeholder="在这里回答这个问题" onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
            <button className="primary" disabled={busy || task.blockers?.activeId !== item.id || !(drafts[item.id] ?? '').trim()}>{busy ? '正在提交回答…' : '提交回答并继续'}</button>
            <p className="muted small">回答后接着处理这个问题。</p>
          </form>}
    </SystemCard>)}
  </section>
}
