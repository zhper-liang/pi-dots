export type CapabilitySetupReceipt = {
  setupId: string; requestId: string; operationId: string; kind: 'mcp' | 'skill'; action: string
  taskId: number; inputId: number; targetBotId: string; name: string; description: string
  state: 'pending' | 'needs_auth' | 'needs_confirmation' | 'missing_dependency' | 'ready' | 'disabled' | 'unbound' | 'removed' | 'error' | 'unknown'
  capabilityId: string | null; enabledForBot: boolean; connectionId: string | null
  verification: { status: string; summary: string; checkedAt: string | null }
  missing: { kind: string; id: string; message: string }[]; affectedBotIds: string[]; approvalId: string | null
  credentialEntry: { kind: 'mcp-credential'; connectionId: string } | null; canResume: boolean; replayed: boolean; error: { code: string; message: string } | null
}
export type CapabilitySetupMessage = { id: number; role: string; toolName?: string; callId?: string; inReplyTo?: number; arguments?: Record<string, unknown>; result?: { ok: boolean; data?: unknown } }
export type CapabilitySetupEntry = { receipt: CapabilitySetupReceipt; messageId: number | null }
export type CapabilitySetupClient = { get: (receipt: CapabilitySetupReceipt, signal?: AbortSignal) => Promise<CapabilitySetupReceipt>; resume: (receipt: CapabilitySetupReceipt, signal?: AbortSignal) => Promise<CapabilitySetupReceipt> }
export const CAPABILITY_SETUP_STATES: Record<CapabilitySetupReceipt['state'], string>
export const CAPABILITY_SETUP_ACTIONS: Record<string, string>
export function capabilitySetupReceipt(value: unknown, taskId: number): CapabilitySetupReceipt | null
export function capabilitySetupEntries(messages: CapabilitySetupMessage[], taskId: number, projected?: unknown[]): Map<string, CapabilitySetupEntry>
export function sameCapabilitySetup(next: CapabilitySetupReceipt, original: CapabilitySetupReceipt): boolean
export function createCapabilitySetupClient(input: { token: string; fetchImpl?: typeof fetch }): CapabilitySetupClient
export type CapabilityManagerApproval = { id: string | number; taskId: number; toolName: string; callId?: string; inReplyTo?: number; arguments?: unknown; capabilityIntent?: unknown; decision?: unknown }
export type CapabilityManagerNotice = { kind: 'inspect'; managerKind: 'mcp' | 'skill'; targetBotId: string; targetRevision: string; capabilityCount: number } | { kind: 'approval'; managerKind: 'mcp' | 'skill'; targetBotId: string; approvalId: string; state: 'pending' | 'approved' | 'rejected' | 'inserted' }
export function capabilityManagerNotice(message: CapabilitySetupMessage, taskId: number, messages: CapabilitySetupMessage[], approvals?: CapabilityManagerApproval[]): CapabilityManagerNotice | null
