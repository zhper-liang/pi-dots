import { taskPath } from './taskPath'
import { useEffect, useRef, useState } from 'react'

type CancellableTask = { bot: { id: string };
  taskId: number; title: string
  cancellation?: { requestedAt: string } | null
  runtime: { status: string; outcome?: { status: string } }
}
export default function TaskCancellationControls<T extends CancellableTask>({ task, token, onUpdated, onError }: {
  task: T; token: string; onUpdated: (task: T) => void; onError: (error: unknown) => void
}) {
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const cancelled = Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted'
  async function cancel() {
    if (submitting.current || cancelled || !window.confirm(`取消「${task.title}」？后续工作会停止，已有记录保留。`)) return
    submitting.current = true; setBusy(true)
    const controller = new AbortController(); request.current = controller
    try {
      const response = await fetch(taskPath(task, `/cancel`), { method: 'POST', body: '{}', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '取消失败，请刷新核对会话状态。')
      if (!controller.signal.aborted) onUpdated(body.task)
    } catch (error) {
      if (!controller.signal.aborted) onError(error)
    } finally {
      if (!controller.signal.aborted) { submitting.current = false; setBusy(false) }
    }
  }
  return <section className={`task-cancellation ${cancelled ? 'is-cancelled' : ''}`} aria-label="取消会话">
    {cancelled ? <div role="status" data-testid="task-cancelled">
      <strong>会话已取消</strong>
      <p>后续工作已停止，已有记录都保留。</p>
      <details className="tech-info"><summary>技术信息</summary><p className="muted small">{task.cancellation && `${new Date(task.cancellation.requestedAt).toLocaleString('zh-CN')} · `}{task.runtime.status === 'terminal' ? '执行已停止。' : '已请求中止在途调用，等待真实回执。'}不能保证撤回已发生动作；迟到结果按实际成功或失败保存。</p></details>
    </div> : <>
      <div><strong>取消这个会话</strong><p className="muted small">停止这个会话及其进行中的子任务，保留历史消息。</p></div>
      <button type="button" className="cancel-task-button" disabled={busy || !['pending', 'running', 'waiting'].includes(task.runtime.status)} onClick={() => void cancel()}>{busy ? '正在取消…' : '取消会话'}</button>
    </>}
  </section>
}
