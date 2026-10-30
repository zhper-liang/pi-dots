import { TaskInputError } from './task-config.mjs'

// Fixed production hosts. Only an in-process test fixture on loopback may replace them
// (same seam as createFeishuClient's fetchImpl); no env var, config file or HTTP input can.
export const GOOGLE_ENDPOINTS = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  calendar: 'https://www.googleapis.com/calendar/v3',
  tasks: 'https://tasks.googleapis.com/tasks/v1',
})
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])
export function googleEndpoints(overrides) {
  if (overrides === undefined) return GOOGLE_ENDPOINTS
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).some(key => !Object.hasOwn(GOOGLE_ENDPOINTS, key))) throw new Error('Google endpoint override is invalid')
  const result = { ...GOOGLE_ENDPOINTS }
  for (const [key, value] of Object.entries(overrides)) {
    let url
    try { url = new URL(value) } catch { throw new Error('Google endpoint override is invalid') }
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Google endpoint override must be a loopback test fixture')
    result[key] = url.href.replace(/\/$/, '')
  }
  return Object.freeze(result)
}

// Public errors carry a fixed Chinese message only: never provider text, URLs, tokens or paths.
const ERRORS = {
  GOOGLE_UNAVAILABLE: [503, 'config', '当前实例未启用 Google 连接。'],
  GOOGLE_NOT_CONFIGURED: [409, 'config', '尚未配置 Google OAuth 客户端，请先填写客户端 ID 和密钥。'],
  GOOGLE_CLIENT_INVALID: [409, 'config', 'Google OAuth 客户端配置无效，请检查客户端 ID 和密钥。'],
  GOOGLE_CLIENT_ENV_LOCKED: [409, 'config', '当前使用环境变量中的 Google 客户端配置；请修改服务端环境，界面保存不会覆盖它。'],
  GOOGLE_CLIENT_INPUT: [400, 'input', '请填写有效的客户端 ID 和密钥；留空密钥只会保留已保存的值。'],
  GOOGLE_CLIENT_REQUEST_CONFLICT: [409, 'input', '同一 requestId 不能用于不同的客户端配置。'],
  GOOGLE_STORAGE_FAILED: [500, 'config', '本机 Google 凭据文件无效或不可读写。'],
  GOOGLE_NOT_CONNECTED: [409, 'needs_auth', '尚未连接 Google 账号，请到设置页连接。'],
  GOOGLE_NEEDS_AUTH: [401, 'needs_auth', 'Google 连接需要重新授权，请到设置页重新连接。'],
  GOOGLE_SCOPE_MISSING: [403, 'needs_auth', 'Google 账号未授予这项服务，请到设置页重新连接并勾选。'],
  GOOGLE_CONNECT_INPUT: [400, 'input', '请至少选择一项 Google 服务。'],
  GOOGLE_ATTEMPT_MISSING: [409, 'input', '没有进行中的连接，请先点“连接 Google”。'],
  GOOGLE_ATTEMPT_EXPIRED: [409, 'input', '这次连接已超过 5 分钟，请重新点“连接 Google”。'],
  GOOGLE_ATTEMPT_USED: [409, 'input', '这次连接已经完成或失效，请重新点“连接 Google”。'],
  GOOGLE_REDIRECT_INVALID: [400, 'input', '粘贴的不是这次连接的跳转地址，请复制浏览器地址栏里的完整地址。'],
  GOOGLE_STATE_MISMATCH: [400, 'input', '跳转地址与这次连接不匹配，请使用最新一次连接的地址。'],
  GOOGLE_ACCESS_DENIED: [403, 'input', '你在 Google 页面拒绝了授权，未连接。'],
  GOOGLE_AUTH_FAILED: [502, 'provider', 'Google 授权没有完成，请重新连接。'],
  GOOGLE_NO_REFRESH_TOKEN: [502, 'provider', 'Google 没有返回长期授权；请到 Google 账号页移除 Pidot 的访问权限后重新连接。'],
  GOOGLE_BUSY: [409, 'conflict', 'Google 连接正在变更，请稍后再试。'],
  GOOGLE_INPUT: [400, 'input', 'Google 请求参数无效。'],
  GOOGLE_BAD_REQUEST: [400, 'provider', 'Google 拒绝了请求参数。'],
  GOOGLE_FORBIDDEN: [403, 'provider', 'Google 拒绝访问这项资源。'],
  GOOGLE_NOT_FOUND: [404, 'not_found', 'Google 中没有找到这项资源。'],
  GOOGLE_CONFLICT: [409, 'conflict', 'Google 中已存在相同对象。'],
  GOOGLE_GONE: [410, 'not_found', 'Google 中的对象或同步标记已失效，需要重新读取。'],
  GOOGLE_PRECONDITION: [409, 'conflict', 'Google 中的对象已被修改，请重新读取后再改。'],
  GOOGLE_RATE_LIMIT: [429, 'rate_limit', 'Google 请求过多，请稍后再试。'],
  GOOGLE_PROVIDER_ERROR: [502, 'provider', 'Google 服务暂时出错，请稍后再试。'],
  GOOGLE_TRANSPORT: [502, 'transport', 'Google 请求没有取得完整响应。'],
  GOOGLE_TIMEOUT: [504, 'transport', 'Google 请求超时。'],
  GOOGLE_CANCELLED: [409, 'transport', 'Google 请求已取消。'],
  GOOGLE_REDIRECT_REFUSED: [502, 'provider', 'Google 返回了跳转，已拒绝跟随。'],
  GOOGLE_RESPONSE_TOO_LARGE: [502, 'provider', 'Google 响应超过大小上限，已丢弃。'],
  GOOGLE_INVALID_RESPONSE: [502, 'provider', 'Google 响应格式无效。'],
}
export const GOOGLE_ERROR_CODES = Object.freeze(Object.keys(ERRORS))
const UNKNOWN_SUFFIX = '写入结果未知，可能已生效；不会自动重试，请按原请求核实。'
export class GoogleError extends TaskInputError {
  constructor(code, { outcomeUnknown = false, retryable = false, providerStatus = null, retryAfterMs = null } = {}) {
    const [status, kind, message] = ERRORS[code] ?? ERRORS.GOOGLE_PROVIDER_ERROR
    super(status, ERRORS[code] ? code : 'GOOGLE_PROVIDER_ERROR', outcomeUnknown ? `${message}${UNKNOWN_SUFFIX}` : message)
    this.name = 'GoogleError'
    this.kind = kind
    this.outcomeUnknown = outcomeUnknown
    this.retryable = retryable
    this.providerStatus = providerStatus
    this.retryAfterMs = retryAfterMs
  }
}
export const googleError = (code, options) => new GoogleError(code, options)
export const isGoogleNeedsAuth = error => error instanceof GoogleError && error.kind === 'needs_auth'

async function readCapped(response, limit) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => {}); throw googleError('GOOGLE_RESPONSE_TOO_LARGE') }
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) { await reader.cancel().catch(() => {}); throw googleError('GOOGLE_RESPONSE_TOO_LARGE') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One HTTP exchange: no redirect following, a hard timeout, a body size cap, no retries.
 * `write` marks any failure after the request may have reached Google as outcomeUnknown.
 */
export function createGoogleTransport({ fetchImpl = globalThis.fetch, timeoutMs = 10000, maxBytes = 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Google transport needs fetch')
  return async function send(url, { method = 'GET', headers = {}, body, signal, write = method !== 'GET', limitBytes = maxBytes, timeout = timeoutMs } = {}) {
    if (signal?.aborted) throw googleError('GOOGLE_CANCELLED')
    const timer = AbortSignal.timeout(timeout), combined = signal ? AbortSignal.any([signal, timer]) : timer
    const failed = () => signal?.aborted ? googleError('GOOGLE_CANCELLED', { outcomeUnknown: write }) : googleError(timer.aborted ? 'GOOGLE_TIMEOUT' : 'GOOGLE_TRANSPORT', { outcomeUnknown: write, retryable: true })
    let response
    try { response = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual', signal: combined }) }
    catch { throw failed() }
    if (response.status >= 300 && response.status < 400 || response.type === 'opaqueredirect') { await response.body?.cancel().catch(() => {}); throw googleError('GOOGLE_REDIRECT_REFUSED', { outcomeUnknown: write, providerStatus: response.status }) }
    let text
    try { text = await readCapped(response, limitBytes) }
    catch (error) { if (error instanceof GoogleError) throw new GoogleError(error.code, { outcomeUnknown: write && (response.ok || response.status >= 500) }); throw failed() }
    let data = null
    if (text.trim()) { try { data = JSON.parse(text) } catch { if (response.ok) throw googleError('GOOGLE_INVALID_RESPONSE', { outcomeUnknown: write }) } }
    return { status: response.status, ok: response.ok, data, headers: response.headers }
  }
}

const retryAfter = headers => {
  const value = headers?.get?.('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}
function apiError(result, write) {
  const reason = result.data?.error?.errors?.[0]?.reason ?? result.data?.error?.status ?? ''
  const s = result.status, unknown = write && s >= 500
  if (s === 400) return googleError('GOOGLE_BAD_REQUEST', { providerStatus: s })
  if (s === 401) return googleError('GOOGLE_NEEDS_AUTH', { providerStatus: s })
  if (s === 403 && /rateLimit|userRateLimit|quota/i.test(reason)) return googleError('GOOGLE_RATE_LIMIT', { providerStatus: s, retryable: true, retryAfterMs: retryAfter(result.headers) })
  if (s === 403 && /insufficient|scope|PERMISSION_DENIED/i.test(reason)) return googleError('GOOGLE_SCOPE_MISSING', { providerStatus: s })
  if (s === 403) return googleError('GOOGLE_FORBIDDEN', { providerStatus: s })
  if (s === 404) return googleError('GOOGLE_NOT_FOUND', { providerStatus: s })
  if (s === 409) return googleError('GOOGLE_CONFLICT', { providerStatus: s })
  if (s === 410) return googleError('GOOGLE_GONE', { providerStatus: s })
  if (s === 412) return googleError('GOOGLE_PRECONDITION', { providerStatus: s })
  if (s === 429) return googleError('GOOGLE_RATE_LIMIT', { providerStatus: s, retryable: true, retryAfterMs: retryAfter(result.headers) })
  return googleError('GOOGLE_PROVIDER_ERROR', { providerStatus: s, retryable: s >= 500, outcomeUnknown: unknown })
}
const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,2000}$/
const SERVICES = new Set(['calendar', 'tasks'])
const ALLOWED_HEADERS = new Set(['if-match', 'if-none-match'])

/**
 * Authorized REST calls to the fixed Calendar/Tasks hosts. Reads get at most one backoff retry
 * (429/5xx/transport). Writes are never resent after a failure; the only resend for any method is
 * one forced token refresh after a 401, because Google rejected that request before acting on it.
 */
export function createGoogleClient({ fetchImpl = globalThis.fetch, endpoints = GOOGLE_ENDPOINTS, timeoutMs = 10000, maxBytes = 1024 * 1024, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxBackoffMs = 2000, token, rejectToken = () => {} }) {
  if (typeof token !== 'function') throw new Error('Google client needs a token source')
  const send = createGoogleTransport({ fetchImpl, timeoutMs, maxBytes })
  async function api(service, path, { method = 'GET', query, body, headers = {}, signal, limitBytes } = {}) {
    if (!SERVICES.has(service) || typeof path !== 'string' || !SAFE_PATH.test(path) || /(^|\/)\.\.?(\/|$)|\/\//.test(path) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw googleError('GOOGLE_INPUT')
    const base = endpoints[service], url = new URL(base + path)
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname)) throw googleError('GOOGLE_INPUT')
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    const extra = {}
    for (const [key, value] of Object.entries(headers)) { if (!ALLOWED_HEADERS.has(key.toLowerCase()) || typeof value !== 'string' || /[\r\n]/.test(value)) throw googleError('GOOGLE_INPUT'); extra[key] = value }
    const write = method !== 'GET', encoded = body === undefined ? undefined : JSON.stringify(body)
    let refreshed = false, retried = false
    for (;;) {
      const bearer = await token({ services: [service], signal })
      let result
      try {
        result = await send(url.href, { method, signal, write, limitBytes, headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}`, ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: encoded })
      } catch (error) {
        if (!write && !retried && error.retryable) { retried = true; await sleep(Math.min(250, maxBackoffMs)); continue }
        throw error
      }
      if (result.ok) return { status: result.status, data: result.data, etag: result.headers.get('etag') ?? result.data?.etag ?? null }
      if (result.status === 401 && !refreshed) { refreshed = true; rejectToken(bearer); continue }
      const error = apiError(result, write)
      if (!write && !retried && error.retryable) { retried = true; await sleep(Math.min(error.retryAfterMs ?? 250, maxBackoffMs)); continue }
      throw error
    }
  }
  return { api, endpoints }
}
