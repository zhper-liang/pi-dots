// Single source of truth for the conversation status badge (previously an inline ternary in App.tsx).
// Structural type so it accepts the full Task shape from App.tsx without importing it.
export type StatusTask = {
  botLifecycle?: string
  cancellation?: unknown
  activeInputId: number | null
  waiting?: { kind?: string } | null
  approvals?: { activeId?: number | string | null } | null
  blockers?: { activeId: number | null; items: { id: number; assignee?: string }[] } | null
  parameters: Record<string, unknown>
  runtime: { status: string; outcome?: { status: string }; checkpoint: { phase: string; lastOutcome?: string; waitingReason?: string } | null }
}

export type StatusTone = 'neutral' | 'busy' | 'attention' | 'danger' | 'muted'

export function taskStatus(task: StatusTask, sending = false): { label: string; tone: StatusTone } {
  const mode = task.parameters.mode === 'model' ? '真实模型' : '测试模式'
  const checkpoint = task.runtime.checkpoint
  if (sending) return { label: '正在提交…', tone: 'busy' }
  if (task.botLifecycle === 'inactive') return { label: 'Bot 已停用 · 历史与真实结果保留', tone: 'muted' }
  if (Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted') return { label: '已取消 · 记录保留', tone: 'muted' }
  if (task.runtime.status === 'terminal') return { label: 'Task 执行异常 · 无法继续', tone: 'danger' }
  if (task.waiting?.kind === 'action-outcome') return { label: '结果待核实 · 仅按工具保障安全恢复', tone: 'attention' }
  if (checkpoint?.phase === 'awaitChildren') return { label: '等待子任务结果 · 不持续调用模型', tone: 'busy' }
  if (task.approvals?.activeId) return { label: '等待你的审批 · 不持续调用模型', tone: 'attention' }
  if (task.blockers?.activeId) {
    const active = task.blockers.items.find(b => b.id === task.blockers?.activeId)
    return { label: active?.assignee === 'supervisor' ? '等待主管处理 · 不持续调用模型' : '等待用户回答 · 不持续调用模型', tone: 'attention' }
  }
  if (task.activeInputId !== null) return { label: `执行中 · ${mode === '测试模式' ? '测试回复' : mode}`, tone: 'busy' }
  if (checkpoint?.lastOutcome === 'limited') return { label: `受限等待 · ${checkpoint.waitingReason} · 请提高上限后继续`, tone: 'attention' }
  if (checkpoint?.lastOutcome === 'failed') return { label: '上轮执行失败 · 可继续发送', tone: 'danger' }
  return { label: `等待输入 · ${mode}`, tone: 'neutral' }
}

export function taskStatusLabel(task: StatusTask, sending = false): string {
  return taskStatus(task, sending).label
}
