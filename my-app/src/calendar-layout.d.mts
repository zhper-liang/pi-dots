import type { LocalDateTime } from './local-time.mjs'
export const ZONE_OFFSET_MS: number
export const DAY_MS: number
export type Mode = 'day' | 'week' | 'month'
export function dayKey(ms: number, timezone?: string): string
export function dayStart(key: string, timezone?: string): number
export function addDays(key: string, n: number): string
export function weekday(key: string): number
export function weekStart(key: string): string
export function toOffsetIso(ms: number, timezone?: string): string
export function hm(ms: number, timezone?: string): string
export function periodDays(mode: Mode, anchor: string): string[]
export function shiftAnchor(mode: Mode, anchor: string, dir: number): string
export type Placed = { key: string; top: number; height: number; col: number; cols: number }
export function layoutDay(events: { key: string; start: number; end: number }[], key: string, minMinutes?: number, timezone?: string): Placed[]
export function eventDays(start: number, end: number, timezone?: string): string[]
export function dueDay(due: string | null | undefined, timezone?: string): string | null

export type WorkspacePane = 'calendar' | 'todos'
export function workspacePanes(narrow: boolean, selected?: WorkspacePane): { calendar: boolean; todos: boolean }
export function calendarTodos<T extends { id: string; title: string; due?: string | null; status?: string; deletedAt?: string | null }>(items: T[]): T[]

export type EventTimeDraft = { start: LocalDateTime; end: LocalDateTime; timezone: string; originalStart?: number; originalEnd?: number }
export function eventTimeDraft(start: number, end: number, timezone?: string, displayTimezone?: string): EventTimeDraft
export function eventTimeData(draft: EventTimeDraft): { start: string; end: string; timezone: string; error?: undefined } | { error: string }
