export type GoogleService = 'calendar' | 'tasks' | 'gmail' | 'drive' | 'docs' | 'sheets'
export type GoogleServiceRow = { id: 'calendar' | 'tasks' | 'workspace'; label: string; note: string; services: GoogleService[] }
export type GoogleStatus = {
  connected: boolean; status: 'connected' | 'needs_auth' | 'disconnected'; email: string | null; services: GoogleService[]; requested: GoogleService[]
  client: { configured: boolean; source: 'env' | 'file' | 'none'; invalid: boolean; editable: boolean }
  attempt: { active: true; expiresAt: string; authorizeUrl: string } | null
  lastResult: { result: 'connected' | 'denied' | 'failed' | 'expired'; code: string | null } | null
}
export type ServiceRowState = 'granted' | 'partial' | 'missing' | 'off'
export const GOOGLE_SERVICE_ROWS: readonly GoogleServiceRow[]
export const SERVICE_STATE_TEXT: Readonly<Record<ServiceRowState, string>>
export function publicGoogleStatus(value: unknown): GoogleStatus
export function serviceRowState(row: GoogleServiceRow, status: GoogleStatus): ServiceRowState
export function googleStatusText(status: GoogleStatus): string
export function googleResultText(last: GoogleStatus['lastResult']): string
export function disconnectText(result: { revoked?: boolean | null } | null): string
export function googleErrorText(status: number, body: unknown): string
