export type RoutineRule = { type: string; time?: string; seconds?: number; anchor?: string; at?: string; event?: string }
export const ROUTINE_EVENTS: Record<string, string>
export const ROUTINE_WHEN: [string, string][]
export const ROUTINE_LIMITS: { modelCalls: number; toolCalls: number; totalTokens: number }
export function ruleLabel(rule?: RoutineRule): string
export function statusLabel(status: string): string
export function runLabel(occurrence: { state: string; reason?: string; test?: boolean }): string
export function routineInput(form: { title: string; prompt: string; when: string; value?: string; notification?: string; writes?: boolean; botId: string; requestId: string; now?: number }): { error: string; input?: undefined } | { input: Record<string, unknown>; error?: undefined }
