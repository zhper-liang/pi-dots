import type { MemoryDocument, MemoryEdit, MemoryFileStatus, MemoryItem, MemoryKind } from './memory-types'
export function memoryActorLabel(actor?: string | null): string
export function memoryHandwritten(item?: Pick<MemoryItem, 'sourceEntries'> | null): boolean
export function memorySavedNotice(action: string, file?: MemoryFileStatus | null): string
export function memoryFileView(file: MemoryFileStatus | null | undefined, kind: MemoryKind): { path: string; synced: string; reason: string | null } | null
export function createMemoryRequestTracker(makeId?: () => string): {
  prepare(body: Omit<MemoryEdit, 'requestId'>): MemoryEdit
  settle(): void
}
export function memoryErrorMessage(code?: string | null): string
export function memoryDate(value?: string | number | null): string
export function reconcileMemoryDraft<T extends { expectedVersion: number }>(draft: T | null, document: MemoryDocument): { draft: T | null; current: MemoryDocument; conflicted: boolean }
export function resolveMemorySourceHash(token: string, source: import('./memory-types').MemorySource, signal?: AbortSignal, fetcher?: typeof fetch): Promise<string>

export function memoryLearningReason(job: { state: string; code?: string | null }): string
