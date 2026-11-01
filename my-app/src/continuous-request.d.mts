export function createContinuousRequestGate(options: { storage?: Storage; key: string; makeId: () => string }): {
  begin(path: string, method: string, payload: object, idempotent?: boolean): { requestId: string } | null
  finish(success: boolean): void
  current(): boolean
  dispose(): void
}
