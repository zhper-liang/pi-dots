// Single source of truth for the conversation status badge (previously an inline ternary in App.tsx).
// Structural type so it accepts the full Task shape from App.tsx without importing it.
import type { Mood } from './bot-mood.mjs'

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

/** label and tone are the words and color; mood picks the bot's face (bot-mood.mjs). */
export function taskStatus(task: StatusTask, sending = false): { label: string; tone: StatusTone; mood: Mood } {
  const checkpoint = task.runtime.checkpoint
  if (sending) return { label: '正在发送…', tone: 'busy', mood: 'thinking' }
  if (task.botLifecycle === 'inactive') return { label: '已停用', tone: 'muted', mood: 'resting' }
  if (Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted') return { label: '已取消', tone: 'muted', mood: 'resting' }
  if (task.runtime.status === 'terminal') return { label: '出错了，不能继续', tone: 'danger', mood: 'error' }
  if (task.waiting?.kind === 'action-outcome') return { label: '结果待确认', tone: 'attention', mood: 'waiting' }
  if (checkpoint?.phase === 'awaitChildren') return { label: '等子任务结果', tone: 'busy', mood: 'thinking' }
  if (task.approvals?.activeId) return { label: '等你确认', tone: 'attention', mood: 'waiting' }
  if (task.blockers?.activeId) {
    const active = task.blockers.items.find(b => b.id === task.blockers?.activeId)
    return { label: active?.assignee === 'supervisor' ? '等主管处理' : '等你回答', tone: 'attention', mood: 'waiting' }
  }
  if (task.activeInputId !== null) return { label: '正在回复', tone: 'busy', mood: 'thinking' }
  if (checkpoint?.lastOutcome === 'limited') return { label: '已到调用上限', tone: 'attention', mood: 'limited' }
  if (checkpoint?.lastOutcome === 'failed') return { label: '上次出错，可以继续发', tone: 'danger', mood: 'error' }
  return { label: '空闲', tone: 'neutral', mood: 'idle' }
}

export function taskStatusLabel(task: StatusTask, sending = false): string {
  return taskStatus(task, sending).label
}
