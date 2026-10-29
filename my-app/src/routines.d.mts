export type RoutineRule = { type: string; time?: string; weekdays?: number[]; day?: number; seconds?: number; anchor?: string; at?: string; event?: string }
export const ROUTINE_EVENTS: Record<string, string>
export const ROUTINE_WHEN: [string, string][]
export const ROUTINE_WEEKDAYS: [number, string][]
export const ROUTINE_LIMITS: { modelCalls: number; toolCalls: number; totalTokens: number }
export function ruleLabel(rule?: RoutineRule, timezone?: string): string
export function statusLabel(status: string): string
export function runLabel(occurrence: { state: string; reason?: string; test?: boolean }): string
export function routineInstant(value: string | undefined, timezone: string): number | null
export function routineInput(form: { title: string; prompt: string; when: string; value?: string; weekdays?: number[]; day?: number | string; event?: string; timezone?: string; model?: string; notification?: string; writes?: boolean; botId: string; requestId: string; now?: number }): { error: string; input?: undefined } | { input: Record<string, unknown>; error?: undefined }
export function routineRule(form: { when: string; value?: string; weekdays?: number[]; day?: number | string; event?: string; timezone?: string; now?: number }): { rule: RoutineRule; error?: undefined } | { error: string; rule?: undefined }
