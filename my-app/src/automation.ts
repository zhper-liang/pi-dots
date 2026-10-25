// Global pause and undo of automatic writes (ADR-012, I-13/I-14).
// GET/POST /api/automation and POST /api/workspace/agent-undo (server/tasks.mjs, workspace-mcp-business.mjs).
// Resume is a user page action only; no Bot tool can resume.
export type AutomationState = { paused: boolean; since: string | null; by: string | null; epoch: number }

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined
    ? { headers: { Authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(result.error?.message ?? '操作失败。'), { code: result.error?.code, status: response.status })
  return result.data as T
}

export const loadAutomation = (token: string) => call<AutomationState>(token, '/api/automation')
export const setAutomationPaused = (token: string, paused: boolean) => call<AutomationState>(token, '/api/automation', { paused, confirmed: true })
// Idempotent on the server (requestId undo:<operationId>): a repeat returns the same receipt.
export const undoAutomatic = (token: string, requestId: string) => call<unknown>(token, '/api/workspace/agent-undo', { requestId, confirmed: true })
export const pausedBy = (state: AutomationState) => state.by?.startsWith('bot:') ? `Bot ${state.by.slice(4)}` : '你'
