/** UI contract mirrors bot-memory service projections; HTTP envelopes stay in the adapter. */
export type MemoryKind = 'personality' | 'memory' | 'preferences'
export type MemorySource = { taskId: number; entryId: number }
export type MemoryItem = { id: string; content: string; sourceEntries: MemorySource[]; createdAt: string; updatedAt: string }
export type MemoryStatus = { state: 'ready' | 'pending'; code: string | null; updatedAt: string | null }
export type MemoryFileCode = 'MEMORY_FILE_TOO_LONG' | 'MEMORY_FILE_INVALID' | 'MEMORY_FILE_UNAVAILABLE' | 'MEMORY_FILE_WRITE_FAILED'
/** R2 file state (CONTRACTS §10). `path` is relative to the data directory; `file` is null when file mode is off. */
export type MemoryFileStatus = { path: string; state: 'synced' | 'rejected' | 'pending'; code: MemoryFileCode | null; syncedAt: string | null }
/** 'file' = imported from a hand edit of the memory file. Items with `sourceEntries: []` are hand-written. */
export type MemoryActor = 'user' | 'candidate' | 'file'
export type MemoryRevision = { kind: MemoryKind; botId?: string; version: number; updatedAt: string | null; content?: string; items?: MemoryItem[]; sourceEntries: MemorySource[]; actor: MemoryActor }
export type MemoryHistory = { items: MemoryRevision[]; nextBeforeVersion: number | null }
export type MemoryDocument = { kind: MemoryKind; botId?: string; version: number; updatedAt: string | null; sourceEntries: MemorySource[]; status: MemoryStatus; content?: string; items?: MemoryItem[]; history?: MemoryRevision[]; historyNextBeforeVersion?: number | null; file?: MemoryFileStatus | null }
export type BotMemoryView = { personality: MemoryDocument; preferences: MemoryDocument; memory: MemoryDocument; history?: { personality: MemoryRevision[]; memory: MemoryRevision[] }; historyNextBeforeVersion?: { personality: number | null; memory: number | null } }
export type MemoryEdit = { kind: MemoryKind; expectedVersion: number; requestId: string; action: 'set' | 'update' | 'delete'; id?: string; content?: string; sourceEntries?: MemorySource[] }
export type MemoryOutcome = { ok: boolean; code: string | null; version: number; changed: boolean; replayed: boolean; document: MemoryDocument }
export interface MemoryApi {
  getBot(botId: string, signal?: AbortSignal): Promise<BotMemoryView>
  editBot(botId: string, edit: MemoryEdit): Promise<MemoryOutcome>
  getPreferences(signal?: AbortSignal): Promise<MemoryDocument>
  editPreferences(edit: MemoryEdit): Promise<MemoryOutcome>
}
export type MemorySourceHandler = (source: MemorySource) => void
