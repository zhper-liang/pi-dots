import type { SessionActionHandler, SessionActionResult, SessionActionVerifier } from './session-list.mjs'
export class SessionActionRecoveryError extends Error { state: 'failed' | 'unknown' | 'not_found'; retryable: boolean; status: number; code?: string; constructor(state: 'failed' | 'unknown' | 'not_found', options?: { retryable?: boolean; status?: number; code?: string }) }
export function createSessionActionHandlers(request: (path: string, init: { method: string; body?: string }) => Promise<unknown>): { action: SessionActionHandler; verify: SessionActionVerifier }
export function removeSessionState<T>(values: Record<number, T>, taskId: number): Record<number, T>
export function replaceMainSession(current: Record<string, number>, result: SessionActionResult): Record<string, number>
