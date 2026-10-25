export type TimelineKind = 'input' | 'model' | 'tool' | 'reply' | 'error' | 'approval' | 'decision' | 'receipt' | 'question' | 'answer' | 'system' | 'end'
export type TimelineStatus = 'ok' | 'error' | 'running' | 'waiting' | 'done' | 'muted'
export type TimelineEntry = { id: string; seq: number; at: string | null; kind: TimelineKind; title: string; summary: string; status: TimelineStatus; tool?: string; result?: string; detail?: unknown }
export const TOOL_LABELS: Record<string, string>
export const STATUS_LABELS: Record<TimelineStatus, string>
export function toolLabel(name?: string): string
export function summarizeArgs(args: unknown, max?: number): string
export function buildTimeline(task: unknown): TimelineEntry[]
