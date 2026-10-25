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
    if (submitting.current || cancelled || !window.confirm(`确认取消 Task #${task.taskId}「${task.title}」？将停止此 Task 后续模型、工具与队列，并取消其在途子任务（若有）；已有结果和未处理消息保留，不能在此 Task 自动恢复。已发起动作无法保证撤回。`)) return
    submitting.current = true; setBusy(true)
    const controller = new AbortController(); request.current = controller
    try {
      const response = await fetch(taskPath(task, `/cancel`), { method: 'POST', body: '{}', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '取消失败，请刷新核对 Task 状态。')
      if (!controller.signal.aborted) onUpdated(body.task)
    } catch (error) {
      if (!controller.signal.aborted) onError(error)
    } finally {
      if (!controller.signal.aborted) { submitting.current = false; setBusy(false) }
    }
  }
  return <section className={`task-cancellation ${cancelled ? 'is-cancelled' : ''}`} aria-label="取消指定 Task">
    {cancelled ? <div role="status" data-testid="task-cancelled">
      <strong>Task #{task.taskId} 已取消</strong>
      <p>不再新增模型调用、工具调用或消费队列。已有进度、结果和未处理消息全部保留，不会自动恢复或另建工作。</p>
      <p className="muted small">{task.cancellation && `${new Date(task.cancellation.requestedAt).toLocaleString('zh-CN')} · `}{task.runtime.status === 'terminal' ? '执行已停止。' : '已请求中止在途调用，等待真实回执。'}不能保证撤回已发生动作；迟到结果按实际成功或失败保存。</p>
    </div> : <>
      <div><strong>取消整个 Task #{task.taskId}</strong><p className="muted small">执行者：仅取消本子任务并向原主管报告取消；主管：取消整个长期会话及其在途子任务。保留历史和队列，不影响其他主管或 Bot 的独立会话。</p></div>
      <button type="button" className="cancel-task-button" disabled={busy || !['pending', 'running', 'waiting'].includes(task.runtime.status)} onClick={() => void cancel()}>{busy ? '正在取消…' : '取消此 Task'}</button>
    </>}
  </section>
}
