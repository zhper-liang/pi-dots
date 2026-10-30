const labels = {
  ready: '已就绪', configured: '已保存，待检查', needs_auth: '需要凭据',
  missing_dependency: '缺少依赖', error: '连接失败', disabled: '已停用', removed: '已移除',
}
export const mcpStatusLabel = status => labels[status] ?? '状态待核查'
export const MCP_ENV_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR']
const keys = text => text.split(/[\s,]+/).map(key => key.trim()).filter(Boolean)

export function mcpConfigInput(form, connectionId) {
  const name = form.name.trim(), description = form.description.trim()
  if (!name || name.length > 200 || description.length > 4000) return { error: '请填写名称（最多200字），说明最多4000字。' }
  const config = { connectionId, name, description, transport: form.transport, credentialRequired: form.credentialRequired }
  if (form.transport === 'streamable-http') {
    let url
    try { url = new URL(form.url.trim()) } catch { return { error: '请填写完整的 MCP HTTP 地址。' } }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /key|token|secret|password|authorization/i.test(key))) return { error: '连接地址不能包含凭据或片段；凭据请在保存配置后单独输入。' }
    return { config: { ...config, url: url.href, allowLoopback: form.allowLoopback } }
  }
  if (form.transport !== 'stdio' || !/^(?:\/|[A-Za-z]:[\\/])/.test(form.executable.trim())) return { error: '请选择已安装程序的绝对路径。' }
  const args = form.args.split(/\r?\n/).filter(arg => arg.length > 0)
  const secretEnvKeys = keys(form.secretEnvKeys)
  if (args.length > 64 || args.some(arg => arg.length > 2048) || secretEnvKeys.length > 16 || new Set(secretEnvKeys).size !== secretEnvKeys.length || secretEnvKeys.some(key => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key))) return { error: '参数每行一个；秘密环境变量名使用大写字母、数字和下划线，最多16个且不能重复。' }
  return { config: { ...config, executable: form.executable.trim(), args, envKeys: [...form.envKeys], secretEnvKeys } }
}

export class McpRequestError extends Error {
  constructor(code, { status = 0, unknown = false } = {}) {
    super(unknown ? '操作结果未确认，请用原请求核查。' : ['MCP_REVISION_CONFLICT', 'MCP_CONFIG_CONFLICT'].includes(code) ? '连接配置已更新，请重新读取后再操作。' : '操作未完成，请检查配置或连接状态。')
    this.name = 'McpRequestError'; this.code = code; this.status = status; this.unknown = unknown
  }
}
const publicCheck = value => value && typeof value === 'object' ? {
  ...(typeof value.status === 'string' ? { status: value.status } : {}),
  ...(typeof value.checkedAt === 'string' ? { checkedAt: value.checkedAt } : {}),
  ...(typeof value.error?.code === 'string' ? { error: { code: value.error.code } } : {}),
} : null
function receipt(value) {
  if (!value || typeof value.connectionId !== 'string' || typeof value.revision !== 'string' || !Object.hasOwn(labels, value.status)) throw new McpRequestError('MCP_INVALID_RECEIPT', { unknown: true })
  return { connectionId: value.connectionId, revision: value.revision, status: value.status,
    ...(value.saved === true ? { saved: true } : {}), ...(value.removed === true ? { removed: true } : {}),
    ...(Number.isSafeInteger(value.toolCount) ? { toolCount: value.toolCount } : {}),
    ...(typeof value.replayed === 'boolean' ? { replayed: value.replayed } : {}),
    ...(value.lastCheck ? { lastCheck: publicCheck(value.lastCheck) } : {}) }
}
function connection(value) {
  const projected = receipt(value)
  if (typeof value.name !== 'string' || typeof value.description !== 'string' || !['streamable-http', 'stdio'].includes(value.transport)) throw new McpRequestError('MCP_INVALID_RESPONSE')
  return { ...projected, name: value.name, description: value.description, transport: value.transport,
    enabled: value.enabled === true, hasCredential: value.hasCredential === true, credentialRequired: value.credentialRequired === true,
    ...(Array.isArray(value.secretEnvKeys) ? { secretEnvKeys: value.secretEnvKeys.filter(key => typeof key === 'string') } : {}) }
}

// Keep the authenticated management routes in one place; no endpoint or secret enters model tools.
const base = '/api/external-mcp'
export function createExternalMcpClient({ token, fetchImpl = fetch }) {
  async function request(path, input, signal) {
    let response, body
    try {
      response = await fetchImpl(path, { method: input === undefined ? 'GET' : 'POST', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
      body = await response.json()
    } catch (error) {
      if (signal?.aborted) throw error
      throw new McpRequestError('MCP_RESPONSE_UNKNOWN', { unknown: true })
    }
    if (!response.ok) throw new McpRequestError(typeof body?.error?.code === 'string' ? body.error.code : 'MCP_REQUEST_FAILED', { status: response.status, unknown: response.status >= 500 || body?.error?.unknown === true })
    if (!body || !Object.hasOwn(body, 'data')) throw new McpRequestError('MCP_RESPONSE_UNKNOWN', { unknown: true })
    return body.data
  }
  return {
    async connections(signal) {
      const data = await request(base, undefined, signal)
      if (!Array.isArray(data?.items)) throw new McpRequestError('MCP_INVALID_RESPONSE')
      return data.items.map(connection)
    },
    async mutate(operation, input, signal) {
      if (!['configure', 'check', 'reconnect', 'disable', 'remove'].includes(operation)) throw new McpRequestError('MCP_INVALID_OPERATION')
      return receipt(await request(`${base}/${operation}`, input, signal))
    },
    async saveCredential(input, signal) {
      const result = receipt(await request(`${base}/credentials`, input, signal))
      if (result.saved !== true || result.connectionId !== input.connectionId) throw new McpRequestError('MCP_INVALID_RECEIPT', { unknown: true })
      return result
    },
    async requestStatus(requestId, signal) {
      const data = await request(`${base}/requests/${encodeURIComponent(requestId)}`, undefined, signal)
      if (data === null) return null
      if (!data || data.requestId !== requestId || !['pending', 'succeeded', 'failed', 'unknown'].includes(data.state) || typeof data.operation !== 'string') throw new McpRequestError('MCP_INVALID_RESPONSE', { unknown: true })
      return { requestId, operation: data.operation, state: data.state,
        ...(data.result ? { result: receipt(data.result) } : {}),
        ...(typeof data.error?.code === 'string' ? { error: { code: data.error.code } } : {}) }
    },
  }
}
