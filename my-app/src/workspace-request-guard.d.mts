export function createWorkspaceRequestGuard(): {
  identity(next: string): void
  invalidate(): void
  capture(): number
  sameIdentity(ticket: number): boolean
  begin(): { revision: number; sequence: number }
  current(ticket: { revision: number; sequence: number }): boolean
}
