export type WorkspaceMcpRuntimeState = 'running' | 'not_running' | 'no_response' | 'unexpected' | 'invalid_config'
export type WorkspaceMcpConnection = {
  connectionId: string; name: string; revision: string; enabled: boolean
  status: 'ready' | 'configured' | 'needs_auth' | 'missing_dependency' | 'error' | 'disabled'
  toolCount: number; googleServices: ('gmail' | 'drive' | 'docs' | 'sheets')[]
  lastCheck: { checkedAt: string | null; code: string | null } | null
}
export type WorkspaceMcpStatus = {
  runtime: { state: WorkspaceMcpRuntimeState; version: string | null; expectedVersion: string | null; customAddress: boolean }
  googleTokenSource: boolean; connection: WorkspaceMcpConnection | null
}
export type WorkspaceMcpLine = { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; hint: string }
export type WorkspaceMcpView = { runtime: WorkspaceMcpLine; connection: WorkspaceMcpLine; canCheck: boolean; checkLabel: string; services: WorkspaceMcpConnection['googleServices'] }
export function publicWorkspaceMcpStatus(value: unknown): WorkspaceMcpStatus
export function workspaceMcpView(status: WorkspaceMcpStatus, google: { connected: boolean; services: string[] } | null): WorkspaceMcpView
export function workspaceMcpErrorText(status: number, body: unknown): string
