export const ZONE_OFFSET_MS: number
export const DAY_MS: number
export type Mode = 'day' | 'week' | 'month'
export function dayKey(ms: number): string
export function dayStart(key: string): number
export function addDays(key: string, n: number): string
export function weekday(key: string): number
export function weekStart(key: string): string
export function toOffsetIso(ms: number): string
export function hm(ms: number): string
export function periodDays(mode: Mode, anchor: string): string[]
export function shiftAnchor(mode: Mode, anchor: string, dir: number): string
export type Placed = { key: string; top: number; height: number; col: number; cols: number }
export function layoutDay(events: { key: string; start: number; end: number }[], key: string, minMinutes?: number): Placed[]
export function eventDays(start: number, end: number): string[]
export function dueDay(due: string | null | undefined): string | null
