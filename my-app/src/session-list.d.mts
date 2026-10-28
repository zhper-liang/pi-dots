export type SectionId = 'pinned' | 'confirm' | 'today' | 'yesterday' | 'week' | 'earlier' | 'archived'
export type SessionItem = { id: number; title: string; botName: string; at: number; confirm: boolean; archived: boolean }
export function lastActivity(task: { createdAt: string; messages?: { createdAt: string }[] }): number
export function timeBucket(at: number, now: number): 'today' | 'yesterday' | 'week' | 'earlier'
export function relativeTime(at: number, now: number): string
export function matchesQuery(item: { title: string; botName: string }, query: string): boolean
export const PIN_KEY: string
export function parsePins(raw: string | null): number[]
export function togglePin(pins: number[], id: number): number[]
export const SECTION_LABELS: Record<SectionId, string>
export function sessionSections<T extends SessionItem>(items: T[], options: { pins?: number[]; query?: string; now: number }): { id: SectionId; label: string; items: T[] }[]
