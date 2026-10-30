import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { googleError, createGoogleTransport } from './google-client.mjs'

const G = 'https://www.googleapis.com/auth/'
export const GOOGLE_IDENTITY_SCOPES = Object.freeze(['openid', `${G}userinfo.email`])
// Service id -> scopes it needs. UI groups gmail/drive/docs/sheets as one "workspace" checkbox (D13).
export const GOOGLE_SERVICE_SCOPES = Object.freeze({
  calendar: Object.freeze([`${G}calendar.events`, `${G}calendar.calendarlist.readonly`]),
  tasks: Object.freeze([`${G}tasks`]),
  gmail: Object.freeze([`${G}gmail.readonly`, `${G}gmail.compose`, `${G}gmail.send`]),
  drive: Object.freeze([`${G}drive`, `${G}drive.file`, `${G}drive.readonly`]),
  docs: Object.freeze([`${G}documents`]),
  sheets: Object.freeze([`${G}spreadsheets`]),
})
export const GOOGLE_SERVICE_GROUPS = Object.freeze({ calendar: Object.freeze(['calendar']), tasks: Object.freeze(['tasks']), workspace: Object.freeze(['gmail', 'drive', 'docs', 'sheets']) })
export const GOOGLE_SERVICES = Object.freeze(Object.keys(GOOGLE_SERVICE_SCOPES))
// workspace-mcp validates the bearer through Google userinfo, so its services also need identity.
const NEEDS_IDENTITY = new Set(['gmail', 'drive', 'docs', 'sheets'])
const ALIASES = { email: `${G}userinfo.email`, profile: `${G}userinfo.profile` }
export const parseScopes = value => [...new Set(String(value ?? '').split(/\s+/).filter(Boolean).map(scope => ALIASES[scope] ?? scope))].sort()
export function requestedScopes(services) {
  return [...new Set([...GOOGLE_IDENTITY_SCOPES, ...services.flatMap(service => GOOGLE_SERVICE_SCOPES[service])])]
}
/** A service counts as granted only when every scope it needs was granted. */
export function grantedServices(scopes) {
  const set = new Set(scopes), identity = GOOGLE_IDENTITY_SCOPES.every(scope => set.has(scope))
  return GOOGLE_SERVICES.filter(service => GOOGLE_SERVICE_SCOPES[service].every(scope => set.has(scope)) && (!NEEDS_IDENTITY.has(service) || identity))
}
export function expandServiceGroups(groups) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 3 || new Set(groups).size !== groups.length || groups.some(group => !Object.hasOwn(GOOGLE_SERVICE_GROUPS, group))) throw googleError('GOOGLE_CONNECT_INPUT')
  return GOOGLE_SERVICES.filter(service => groups.some(group => GOOGLE_SERVICE_GROUPS[group].includes(service)))
}

const base64url = buffer => buffer.toString('base64url')
export function createPkce() {
  const verifier = base64url(randomBytes(48)) // 64 chars, within RFC 7636's 43-128
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()), method: 'S256' }
}
export const createState = () => base64url(randomBytes(32))
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y) && a.length === b.length
}
export const accountKeyOf = sub => createHash('sha256').update(sub).digest('hex')
export const clientKeyOf = clientId => createHash('sha256').update(`google-client:${clientId}`).digest('hex').slice(0, 32)

export function authorizeUrl(endpoint, { clientId, redirectUri, scopes, state, challenge, loginHint }) {
  const url = new URL(endpoint)
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: challenge, code_challenge_method: 'S256',
    ...(loginHint ? { login_hint: loginHint } : {}) }).toString()
  return url.href
}

const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Frame-Options': 'DENY' }
const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body></html>`
export const CALLBACK_PAGES = Object.freeze({
  connected: page('已连接 Google', '已连接，可关闭此页并回到 Pidot。'),
  denied: page('未连接', '你拒绝了授权。可关闭此页，回到 Pidot 重新连接。'),
  failed: page('未连接', '这次授权没有完成。可关闭此页，回到 Pidot 重新连接。'),
  invalid: page('链接无效', '这不是当前这次连接的跳转，或连接已失效。请回到 Pidot 重新连接。'),
})

/**
 * One-time callback listener on 127.0.0.1:<random>. Accepts only GET / on the exact Host; the
 * handler decides; nothing from the query string is ever written into the page or a log.
 */
export async function listenForCallback(onCallback) {
  let port, closed = false
  async function close() { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())) }
  const server = createServer(async (req, res) => {
    const reply = (status, html) => { if (!res.headersSent) { res.writeHead(status, PAGE_HEADERS); res.end(html) } }
    try {
      req.resume()
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}`) return reply(400, CALLBACK_PAGES.invalid)
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (url.pathname !== '/') return reply(404, CALLBACK_PAGES.invalid)
      const result = await onCallback(url.searchParams)
      // A decided callback is the listener's only use: close once this page has been sent.
      if (result !== 'invalid') res.once('finish', () => { void close() })
      reply(result === 'invalid' ? 400 : 200, CALLBACK_PAGES[result] ?? CALLBACK_PAGES.failed)
    } catch { reply(500, CALLBACK_PAGES.failed) }
  })
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.maxHeadersCount = 50
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  port = server.address().port
  return { port, redirectUri: `http://127.0.0.1:${port}`, get closed() { return closed }, close }
}

/** Accepts only http://127.0.0.1:<port>/?… with no credentials or fragment-borne parameters. */
export function parsePastedRedirect(text, redirectUri) {
  if (typeof text !== 'string' || text.length > 8192) throw googleError('GOOGLE_REDIRECT_INVALID')
  let url, expected
  try { url = new URL(text.trim()); expected = new URL(redirectUri) } catch { throw googleError('GOOGLE_REDIRECT_INVALID') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== expected.port || url.pathname !== '/' || url.username || url.password) throw googleError('GOOGLE_REDIRECT_INVALID')
  if (!url.searchParams.has('state') || !url.searchParams.has('code') && !url.searchParams.has('error')) throw googleError('GOOGLE_REDIRECT_INVALID')
  return url.searchParams
}

function decodeIdToken(idToken, clientId) {
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) throw new Error('shape')
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    // The token comes straight from the fixed HTTPS token endpoint (§4.2 step 7); no signature check.
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== clientId) throw new Error('claims')
    if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) throw new Error('sub')
    const email = typeof claims.email === 'string' && claims.email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(claims.email) ? claims.email : null
    return { sub: claims.sub, email }
  } catch { throw googleError('GOOGLE_AUTH_FAILED') }
}

/** Token endpoint calls. Never retried: a lost code exchange or refresh is reported, not replayed. */
export function createGoogleOAuth({ endpoints, fetchImpl, timeoutMs = 10000 }) {
  const send = createGoogleTransport({ fetchImpl, timeoutMs, maxBytes: 64 * 1024 })
  async function post(url, form, signal) {
    return send(url, { method: 'POST', write: true, signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form).toString() })
  }
  const tokenFields = data => {
    if (!data || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 4096 || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400 ||
      (data.token_type !== undefined && !/^bearer$/i.test(data.token_type)) || (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 4096))) throw googleError('GOOGLE_INVALID_RESPONSE')
    return { accessToken: data.access_token, expiresIn: data.expires_in, refreshToken: data.refresh_token ?? null, scopes: data.scope === undefined ? null : parseScopes(data.scope) }
  }
  const tokenError = result => {
    const code = result.data?.error
    if (code === 'invalid_grant') return googleError('GOOGLE_NEEDS_AUTH', { providerStatus: result.status })
    if (code === 'invalid_client' || code === 'unauthorized_client') return googleError('GOOGLE_CLIENT_INVALID', { providerStatus: result.status })
    return googleError(result.status >= 500 ? 'GOOGLE_PROVIDER_ERROR' : 'GOOGLE_AUTH_FAILED', { providerStatus: result.status })
  }
  return {
    async exchange({ client, code, verifier, redirectUri, signal }) {
      const result = await post(endpoints.token, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.clientId, client_secret: client.clientSecret }, signal).catch(() => { throw googleError('GOOGLE_AUTH_FAILED') })
      if (!result.ok) throw result.data?.error === 'invalid_grant' ? googleError('GOOGLE_AUTH_FAILED') : tokenError(result)
      const fields = tokenFields(result.data)
      if (typeof result.data.id_token !== 'string' || result.data.id_token.length > 16384) throw googleError('GOOGLE_AUTH_FAILED')
      return { ...fields, identity: decodeIdToken(result.data.id_token, client.clientId) }
    },
    async refresh({ client, refreshToken, signal }) {
      const result = await post(endpoints.token, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, signal)
      if (!result.ok) throw tokenError(result)
      return tokenFields(result.data)
    },
    /** true = Google confirmed (or the token was already invalid); false = unknown/failed. */
    async revoke({ token, signal }) {
      try {
        const result = await post(endpoints.revoke, { token }, signal)
        return result.ok || result.status === 400 && result.data?.error === 'invalid_token'
      } catch { return false }
    },
  }
}
