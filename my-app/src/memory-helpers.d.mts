import type { MemoryDocument, MemoryEdit } from './memory-types'
export function createMemoryRequestTracker(makeId?: () => string): {
  prepare(body: Omit<MemoryEdit, 'requestId'>): MemoryEdit
  settle(): void
}
export function memoryErrorMessage(code?: string | null): string
export function memoryDate(value?: string | null): string
export function reconcileMemoryDraft<T extends { expectedVersion: number }>(draft: T | null, document: MemoryDocument): { draft: T | null; current: MemoryDocument; conflicted: boolean }
export function resolveMemorySourceHash(token: string, source: import('./memory-types').MemorySource, signal?: AbortSignal, fetcher?: typeof fetch): Promise<string>
