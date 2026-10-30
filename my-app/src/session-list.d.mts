export type SectionId = 'pinned' | 'confirm' | 'today' | 'yesterday' | 'week' | 'earlier' | 'archived'
export type SessionItem = { id: number; title: string; botName: string; at: number; confirm: boolean; archived: boolean; deleted?: boolean; deletedAt?: string | null }
export function lastActivity(task: { createdAt: string; messages?: { createdAt: string }[] }): number
export function timeBucket(at: number, now: number): 'today' | 'yesterday' | 'week' | 'earlier'
export function relativeTime(at: number, now: number): string
export function matchesQuery(item: { title: string; botName: string }, query: string): boolean
export const PIN_KEY: string
export function parsePins(raw: string | null): number[]
export function togglePin(pins: number[], id: number): number[]
export const SECTION_LABELS: Record<SectionId, string>
export function sessionSections<T extends SessionItem>(items: T[], options: { pins?: number[]; query?: string; now: number }): { id: SectionId; label: string; items: T[] }[]

export type SessionActionTarget = { taskId: number; title: string; botId: string; kind: 'session' | 'group' | 'main'; running?: boolean; owner?: string }
export type SessionActionRequest = { requestId: string; confirmed: true }
export type SessionActionResult = { taskId: number; botId: string; action: 'delete' | 'clear-main'; deleted: true; deletedAt: string; replacementTaskId: number | null; requestId: string; replayed: boolean }
export type SessionActionVerifier = (target: SessionActionTarget, input: SessionActionRequest) => Promise<SessionActionResult | null>
export type SessionActionHandler = (target: SessionActionTarget, input: SessionActionRequest) => Promise<SessionActionResult>
export function isSessionDeleted(item: { deleted?: boolean; deletedAt?: string | null }): boolean
export function removeSessionPin(pins: number[], id: number): number[]
export function sessionDeleteLabel(target: { kind: string; running?: boolean }): string
export function isSessionActionReceipt(result: unknown, target: SessionActionTarget, requestId: string): result is SessionActionResult
