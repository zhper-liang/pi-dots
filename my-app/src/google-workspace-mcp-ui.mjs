const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const RUNTIME = ['running', 'not_running', 'no_response', 'unexpected', 'invalid_config']
const STATUS = ['ready', 'configured', 'needs_auth', 'missing_dependency', 'error', 'disabled']
const WORKSPACE = ['gmail', 'drive', 'docs', 'sheets']
const text = (value, max = 200) => typeof value === 'string' && value.length <= max ? value : null

/** Keep only the R3-05 status contract (GET /api/google/workspace-mcp); anything else is dropped. */
export function publicWorkspaceMcpStatus(value) {
  if (!object(value) || !object(value.runtime) || !RUNTIME.includes(value.runtime.state)) throw new Error('workspace-mcp 状态暂时不可用。')
  const version = text(value.runtime.version, 32), expected = text(value.runtime.expectedVersion, 32)
  const raw = object(value.connection) ? value.connection : null
  const connection = raw && typeof raw.connectionId === 'string' && typeof raw.revision === 'string' && STATUS.includes(raw.status) ? {
    connectionId: raw.connectionId, name: text(raw.name) ?? 'Google 邮件与文件', revision: raw.revision, enabled: raw.enabled === true, status: raw.status,
    toolCount: Number.isSafeInteger(raw.toolCount) && raw.toolCount >= 0 ? raw.toolCount : 0,
    googleServices: Array.isArray(raw.googleServices) ? raw.googleServices.filter(item => WORKSPACE.includes(item)) : [],
    lastCheck: object(raw.lastCheck) ? { checkedAt: text(raw.lastCheck.checkedAt, 64), code: typeof raw.lastCheck.error?.code === 'string' && /^MCP_[A-Z_]+$/.test(raw.lastCheck.error.code) ? raw.lastCheck.error.code : null } : null,
  } : null
  return { runtime: { state: value.runtime.state, version: version && /^[0-9A-Za-z.+-]+$/.test(version) ? version : null, expectedVersion: expected, customAddress: value.runtime.customAddress === true },
    googleTokenSource: value.googleTokenSource === true, connection }
}

const failure = Object.freeze({
  MCP_GOOGLE_NOT_CONNECTED: '上次检查时 Google 未连接或未授予 Gmail、Drive、Docs、Sheets。',
  MCP_GOOGLE_TOKEN_REJECTED: 'workspace-mcp 拒绝了 Google 令牌：令牌无效，或它暂时无法向 Google 核验。',
  MCP_GOOGLE_TOKEN_UNAVAILABLE: '上次检查时暂时取不到 Google 令牌。',
  MCP_TIMEOUT: '上次检查超时。',
})

/**
 * Honest status lines for the "连接 Google" card. `google` is the account status the card already has:
 * { connected, services }. Running, not running and connected are told apart; nothing pretends to work.
 */
export function workspaceMcpView(status, google) {
  const granted = google?.connected === true && WORKSPACE.every(service => google.services?.includes(service))
  const r = status.runtime, c = status.connection
  const runtime = r.state === 'running'
    ? { text: r.version && r.expectedVersion && r.version !== r.expectedVersion ? `正在运行（${r.version}，固定版本为 ${r.expectedVersion}）` : `正在运行${r.version ? `（${r.version}）` : ''}`, tone: r.version && r.expectedVersion && r.version !== r.expectedVersion ? 'warn' : 'ok', hint: '' }
    : r.state === 'not_running' ? { text: '没有运行', tone: 'bad', hint: '在 Pidot 所在机器上启动 workspace-mcp（启动命令见运维说明），再回来检查。' }
    : r.state === 'no_response' ? { text: '没有响应', tone: 'bad', hint: '端口能连上但没有回应；请重启 workspace-mcp。' }
    : r.state === 'unexpected' ? { text: '该地址上不是 workspace-mcp', tone: 'bad', hint: '配置的端口被其他程序占用，或 PIDOT_WORKSPACE_MCP_URL 指错了。' }
    : { text: '地址配置无效', tone: 'bad', hint: 'PIDOT_WORKSPACE_MCP_URL 只能是本机地址（127.0.0.1 或 localhost）。' }
  let connection
  if (!status.googleTokenSource) connection = { text: '本实例没有接通 Google 令牌', tone: 'bad', hint: '服务端未把 Google 连接交给外部 MCP；需要按说明接线后重启。' }
  else if (!c) connection = { text: '尚未接入', tone: 'muted', hint: '对 Chief 说“接上 Google 邮件和文件，给某个机器人用”，它会按模板接入并分配。' }
  else if (!c.enabled) connection = { text: '已停用', tone: 'muted', hint: '这个连接已停用，机器人暂时用不了它。' }
  else if (!granted) connection = { text: '等待 Google 授权', tone: 'bad', hint: '上方连接 Google 并勾选 Gmail、Drive、Docs、Sheets 后，再检查连接。' }
  else if (r.state !== 'running') connection = { text: '不可用：workspace-mcp 没有运行', tone: 'bad', hint: c.status === 'ready' ? '先启动 workspace-mcp，再检查连接。' : '' }
  else if (c.status === 'ready') connection = { text: `已连接 · ${c.toolCount} 个工具`, tone: 'ok', hint: '连好以后，到机器人的「能力 → MCP」里打开。' }
  else if (c.status === 'configured') connection = { text: '已保存，需重新检查', tone: 'warn', hint: 'Pidot 重启或配置变更后，要先检查连接才能使用。' }
  else connection = { text: '连接失败', tone: 'bad', hint: (c.lastCheck?.code && failure[c.lastCheck.code]) ?? '请确认 workspace-mcp 正在运行后重新检查。' }
  const canCheck = Boolean(c && c.enabled && status.googleTokenSource && granted && r.state === 'running')
  return { runtime, connection, canCheck, checkLabel: c?.status === 'ready' ? '重新检查' : '检查连接', services: c?.googleServices ?? [] }
}

/** Server MCP/Google errors carry fixed Chinese text; anything else gets a generic line. */
export function workspaceMcpErrorText(status, body) {
  const error = object(body) && object(body.error) ? body.error : null
  if (error && typeof error.code === 'string' && /^(?:MCP|GOOGLE)_[A-Z_]+$/.test(error.code) && typeof error.message === 'string') return error.message
  if (status === 404) return '本实例尚未提供 workspace-mcp 状态。'
  return status >= 500 ? '服务暂时无法处理，请稍后重试。' : '操作没有成功，请重试。'
}
