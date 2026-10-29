import { memoryErrorMessage } from './memory-helpers.mjs'

/** Authenticated HTTP transport, deliberately separate from the document views. */
export function createMemoryApi(token, fetcher = (...args) => fetch(...args)) {
  async function request(path, body, signal) {
    let response
    try {
      response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', signal,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause
      throw Object.assign(new Error('暂时无法连接。若正在保存，结果尚未确认，请用原请求重试。'), { ambiguous: body !== undefined })
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const code = payload?.error?.code
      throw Object.assign(new Error(response.status === 401 ? '连接已失效，请重新连接。' : memoryErrorMessage(code)), { code, ambiguous: body !== undefined && response.status >= 500 })
    }
    if (!payload || !Object.hasOwn(payload, 'data')) throw Object.assign(new Error('未能确认服务器结果，请重新读取。'), { ambiguous: body !== undefined })
    return payload.data
  }
  return {
    getBot: (botId, signal) => request(`/api/bots/${encodeURIComponent(botId)}/memory`, undefined, signal),
    editBot: (botId, edit) => request(`/api/bots/${encodeURIComponent(botId)}/memory`, edit),
    getPreferences: signal => request('/api/settings/preferences', undefined, signal),
    editPreferences: ({ kind: _kind, ...edit }) => request('/api/settings/preferences', edit),
  }
}
