export const WORKSPACE_REFRESH_MS: number
export const WORKSPACE_REQUEST_TIMEOUT_MS: number
export type WorkspaceRead = { signal: AbortSignal; isCurrent: () => boolean }
export type PermissionSource = { id: string; authorized: boolean; readScope?: string; grantEpoch?: number; epoch?: number }
export function workspacePermissionKey(local: PermissionSource[], external: PermissionSource[]): string
export function isWorkspacePermissionError(error: unknown): boolean
export type WorkspaceRefreshController = {
  request(fresh?: boolean): Promise<void>
  capture(): number
  sameIdentity(ticket: number): boolean
  setScope(scope: string): void
  setActive(active: boolean): void
  setEnvironment(visible: boolean, online: boolean): void
  invalidate(): void
  dispose(): void
}
export function createWorkspaceRefresh(options: {
  load: (read: WorkspaceRead) => void | Promise<void>
  onError?: (error: unknown) => void
  onInvalidate?: (reason: 'scope' | 'permission') => void
  interval?: number
  timeout?: number
  timers?: { setTimeout: typeof globalThis.setTimeout; clearTimeout: typeof globalThis.clearTimeout }
}): WorkspaceRefreshController

export function applyWorkspaceReceipt<T>(items: T[], input: object, operation: object): T[]
