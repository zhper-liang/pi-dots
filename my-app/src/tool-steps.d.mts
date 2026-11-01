export type ToolCallBlock = { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }
export type ChatItem = {
  id: number; role: string; content: string; callId?: string; toolName?: string
  arguments?: Record<string, unknown>
  result?: { ok: boolean; data?: unknown; error?: { code: string; message: string } }
  assistant?: { content: ToolCallBlock[] }
}
export type ToolStep<T extends ChatItem> = { key: string; callId?: string; name?: string; arguments?: Record<string, unknown>; receipt: T | null }
export type ChatUnit<T extends ChatItem> = { kind: 'message'; key: string; item: T } | { kind: 'tools'; key: string; first: T; steps: ToolStep<T>[] }
export type StepStatus = 'ok' | 'failed' | 'running' | 'waiting' | 'none'
export function chatUnits<T extends ChatItem>(messages?: T[]): ChatUnit<T>[]
export function stepStatus(step: ToolStep<ChatItem>, context?: { running?: boolean; waitingCallIds?: string[] }): StepStatus
export const stepLabels: Record<StepStatus, string>
export function toolSummary(names: string[], statuses: StepStatus[]): { text: string; tone: StepStatus }
export function stepDetail(step: ToolStep<ChatItem>): { arguments: string | null; result: string | null; error: string | null }
