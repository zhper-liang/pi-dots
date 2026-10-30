const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const SERVICES = ['calendar', 'tasks', 'gmail', 'drive', 'docs', 'sheets']
const list = value => Array.isArray(value) ? value.filter(item => SERVICES.includes(item)) : []

// UI checkboxes (D13): Calendar, Tasks, and the four workspace-mcp services as one row.
export const GOOGLE_SERVICE_ROWS = Object.freeze([
  Object.freeze({ id: 'calendar', label: 'Google 日历', note: '全部日历显示在日历视图，Bot 可读写', services: Object.freeze(['calendar']) }),
  Object.freeze({ id: 'tasks', label: 'Google 任务', note: '任务列表按截止日显示，Bot 可读写', services: Object.freeze(['tasks']) }),
  Object.freeze({ id: 'workspace', label: 'Gmail、Drive、Docs、Sheets', note: '经 workspace-mcp 使用，共用这一次登录', services: Object.freeze(['gmail', 'drive', 'docs', 'sheets']) }),
])

/** Keep only the public contract; an unexpected (possibly secret) field is never retained. */
export function publicGoogleStatus(value) {
  if (!object(value) || typeof value.connected !== 'boolean' || !['connected', 'needs_auth', 'disconnected'].includes(value.status) || !object(value.client)) throw new Error('Google 连接状态暂时不可用。')
  const attempt = object(value.attempt) && value.attempt.active === true && typeof value.attempt.authorizeUrl === 'string' && /^https?:\/\//.test(value.attempt.authorizeUrl)
    ? { active: true, expiresAt: String(value.attempt.expiresAt ?? ''), authorizeUrl: value.attempt.authorizeUrl } : null
  const last = object(value.lastResult) && ['connected', 'denied', 'failed', 'expired'].includes(value.lastResult.result) ? { result: value.lastResult.result, code: typeof value.lastResult.code === 'string' ? value.lastResult.code : null } : null
  return { connected: value.connected, status: value.status, email: typeof value.email === 'string' ? value.email : null, services: list(value.services), requested: list(value.requested),
    client: { configured: value.client.configured === true, source: ['env', 'file', 'none'].includes(value.client.source) ? value.client.source : 'none', invalid: value.client.invalid === true, editable: value.client.editable !== false },
    attempt, lastResult: last }
}

/** 'granted' | 'partial' | 'missing' (asked for, not granted) | 'off' */
export function serviceRowState(row, status) {
  const granted = row.services.filter(service => status.services.includes(service)).length
  if (status.connected && granted === row.services.length) return 'granted'
  if (status.connected && granted > 0) return 'partial'
  return status.status !== 'disconnected' && row.services.some(service => status.requested.includes(service)) ? 'missing' : 'off'
}
export const SERVICE_STATE_TEXT = Object.freeze({ granted: '已授权', partial: '部分授权', missing: '未授权', off: '' })

export function googleStatusText(status) {
  if (status.attempt) return '正在等待 Google 授权…'
  if (status.connected) return status.email ? `已连接：${status.email}` : '已连接'
  if (status.status === 'needs_auth') return status.email ? `需要重新连接：${status.email}` : '需要重新连接'
  return '未连接'
}
export function googleResultText(last) {
  if (!last) return ''
  if (last.result === 'connected') return '已连接 Google。'
  if (last.result === 'denied') return '你在 Google 页面拒绝了授权，未连接。'
  if (last.result === 'expired') return '这次连接已超过 5 分钟，请重新点“连接 Google”。'
  return '这次授权没有完成，请重新连接。'
}
export function disconnectText(result) {
  if (result?.revoked === false) return '已断开：本机凭据已删除，Google 来源已从所有 Bot 移除。但 Google 端撤销没有确认，请到 Google 账号的“第三方应用和服务”页面手动移除 Pidot。'
  return '已断开：Google 授权已撤销，本机凭据已删除，Google 来源已从所有 Bot 移除。'
}
/** Server Google errors carry fixed Chinese text; anything else gets a generic line. */
export function googleErrorText(status, body) {
  const error = object(body) && object(body.error) ? body.error : null
  if (error && typeof error.code === 'string' && /^GOOGLE_[A-Z_]+$/.test(error.code) && typeof error.message === 'string') return error.message
  return status >= 500 ? '服务暂时无法处理，请稍后重试。' : '操作没有成功，请重试。'
}
