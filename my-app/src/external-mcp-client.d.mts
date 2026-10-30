export type McpStatus = 'ready' | 'configured' | 'needs_auth' | 'missing_dependency' | 'error' | 'disabled' | 'removed'
export type McpCheck = { status?: string; checkedAt?: string; error?: { code: string } }
export type McpReceipt = { connectionId: string; revision: string; status: McpStatus; saved?: true; removed?: true; toolCount?: number; replayed?: boolean; lastCheck?: McpCheck | null }
export type McpConnection = McpReceipt & { credentialSource?: 'google'; name: string; description: string; transport: 'streamable-http' | 'stdio'; enabled: boolean; hasCredential: boolean; credentialRequired: boolean; secretEnvKeys?: string[] }
export type McpConfig = { connectionId: string; name: string; description: string; transport: 'streamable-http' | 'stdio'; credentialRequired: boolean; url?: string; allowLoopback?: boolean; executable?: string; args?: string[]; envKeys?: string[]; secretEnvKeys?: string[] }
export type McpConfigForm = { name: string; description: string; transport: 'streamable-http' | 'stdio'; credentialRequired: boolean; url: string; allowLoopback: boolean; executable: string; args: string; envKeys: string[]; secretEnvKeys: string }
export type McpOperation = 'configure' | 'check' | 'reconnect' | 'disable' | 'remove'
export type McpMutation = { requestId: string; connectionId?: string; expectedRevision?: string; config?: McpConfig; confirmGlobal?: true }
export type McpCredentialInput = { requestId: string; connectionId: string; expectedRevision: string; credential: { bearerToken: string } | { env: Record<string, string> } }
export type McpRequestStatus = { requestId: string; operation: string; state: 'pending' | 'succeeded' | 'failed' | 'unknown'; result?: McpReceipt; error?: { code: string } }
export type ExternalMcpClient = {
  connections: (signal?: AbortSignal) => Promise<McpConnection[]>
  mutate: (operation: McpOperation, input: McpMutation, signal?: AbortSignal) => Promise<McpReceipt>
  saveCredential: (input: McpCredentialInput, signal?: AbortSignal) => Promise<McpReceipt>
  requestStatus: (requestId: string, signal?: AbortSignal) => Promise<McpRequestStatus | null>
}
export const MCP_ENV_KEYS: string[]
export function mcpStatusLabel(status: string): string
export function mcpConfigInput(form: McpConfigForm, connectionId: string): { config: McpConfig; error?: undefined } | { error: string; config?: undefined }
export class McpRequestError extends Error { code: string; status: number; unknown: boolean; constructor(code: string, options?: { status?: number; unknown?: boolean }) }
export function createExternalMcpClient(input: { token: string; fetchImpl?: typeof fetch }): ExternalMcpClient
