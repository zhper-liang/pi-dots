import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import { ExternalMcpError, validateMcpConfig, validateMcpResolvedAddresses, GOOGLE_WORKSPACE_MCP_TEMPLATE, GOOGLE_WORKSPACE_SERVICES, GOOGLE_WORKSPACE_DEFAULTS } from './external-mcp-config.mjs'
import { resolveBounded } from './external-mcp-transport.mjs'

// R3-05: Gmail/Drive/Docs/Sheets via a locally running workspace-mcp 2.2.1 in external-OAuth mode.
// Pidot is the only party that signs in to Google; each MCP request carries its current access token.
export { GOOGLE_WORKSPACE_MCP_TEMPLATE, GOOGLE_WORKSPACE_SERVICES, GOOGLE_WORKSPACE_DEFAULTS }
export const WORKSPACE_MCP_URL_ENV = 'PIDOT_WORKSPACE_MCP_URL'
export const WORKSPACE_MCP_DEFAULT_URL = 'http://127.0.0.1:8000/mcp'
export const WORKSPACE_MCP_VERSION = '2.2.1'
const PROBE_TIMEOUT_MS = 1500, PROBE_BYTES = 4096

/** One-sentence setup input for `mcp_manage` add: the server expands it; no URL or secret is accepted. */
export const googleWorkspaceMcpTemplate = () => ({ template: GOOGLE_WORKSPACE_MCP_TEMPLATE })

/**
 * Endpoint from configuration only: explicit option, then PIDOT_WORKSPACE_MCP_URL, then the default
 * port workspace-mcp itself uses. Loopback http(s) only; anything else fails closed as invalid.
 */
export function resolveWorkspaceMcpEndpoint({ url, env = process.env } = {}) {
  const descriptor = env ? Object.getOwnPropertyDescriptor(env, WORKSPACE_MCP_URL_ENV) : undefined
  const fromEnv = descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && descriptor.value.trim() ? descriptor.value.trim() : undefined
  const candidate = url ?? fromEnv ?? WORKSPACE_MCP_DEFAULT_URL
  try {
    const checked = validateMcpConfig({ connectionId: 'workspace-mcp-endpoint', name: 'workspace-mcp', transport: 'streamable-http', url: candidate, allowLoopback: true })
    return { url: checked.url, custom: candidate !== WORKSPACE_MCP_DEFAULT_URL, invalid: false }
  } catch { return { url: null, custom: true, invalid: true } }
}

const connectionRefused = error => ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(error?.code)
/**
 * Unauthenticated GET <origin>/health (workspace-mcp's own health route). No token, no redirects,
 * pinned loopback socket, tiny body cap. → { state: 'running' | 'not_running' | 'no_response' | 'unexpected', version }
 */
export async function probeWorkspaceMcp(endpointUrl, { lookup = dnsLookup, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const config = validateMcpConfig({ connectionId: 'workspace-mcp-probe', name: 'workspace-mcp', transport: 'streamable-http', url: endpointUrl, allowLoopback: true, timeoutMs: 1000 })
  const target = new URL('/health', config.url), host = target.hostname.replace(/^\[|\]$/g, '')
  const signal = AbortSignal.timeout(timeoutMs)
  let pinned
  try {
    const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveBounded(host, lookup, signal, timeoutMs)
    pinned = validateMcpResolvedAddresses(config, answers)
  } catch { return { state: 'unexpected', version: null } }
  if (target.protocol !== 'http:') return { state: 'unexpected', version: null }
  return new Promise(resolve => {
    let settled = false
    const done = value => { if (!settled) { settled = true; resolve(value) } }
    const request = httpRequest(target, { method: 'GET', agent: false, autoSelectFamily: false, headers: { accept: 'application/json' },
      lookup: (_name, options, callback) => options.all ? callback(null, pinned.map(address => ({ address, family: isIP(address) }))) : callback(null, pinned[0], isIP(pinned[0])) }, response => {
      const chunks = []; let size = 0
      response.on('data', chunk => { size += chunk.length; if (size > PROBE_BYTES) { response.destroy(); done({ state: 'unexpected', version: null }) } else chunks.push(chunk) })
      response.on('error', () => done({ state: 'unexpected', version: null }))
      response.on('end', () => {
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not workspace-mcp */ }
        const ok = response.statusCode === 200 && body?.status === 'healthy' && body?.service === 'workspace-mcp'
        const version = ok && typeof body.version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(body.version) ? body.version : null
        done(ok ? { state: 'running', version } : { state: 'unexpected', version: null })
      })
    })
    request.setTimeout(timeoutMs, () => { request.destroy(); done({ state: 'no_response', version: null }) })
    request.on('error', error => done(connectionRefused(error) ? { state: 'not_running', version: null } : { state: settled ? 'unexpected' : 'no_response', version: null }))
    request.end()
  })
}

/**
 * Adapt the frozen Google token API (CONTRACTS §4) to createMcpFetch's per-request bearer.
 * Failures before any request is sent are definite (`notSent`), never "unknown".
 */
export function googleBearer({ accessToken, rejectToken, services, remember = () => {} }) {
  const failure = (error, signal) => Object.assign(new ExternalMcpError(signal?.aborted || error?.code === 'GOOGLE_CANCELLED' ? 'MCP_CANCELLED'
    : ['needs_auth', 'config'].includes(error?.kind) ? 'MCP_GOOGLE_NOT_CONNECTED' : 'MCP_GOOGLE_TOKEN_UNAVAILABLE', 409), { notSent: true })
  return {
    async token(signal) {
      let value
      try { value = await accessToken({ services: [...services], ...(signal ? { signal } : {}) }) } catch (error) { throw failure(error, signal) }
      if (typeof value !== 'string' || !value || value.length > 8192 || /\s/.test(value)) throw failure(null, signal)
      remember(value)
      return value
    },
    reject(value) { try { rejectToken?.(value) } catch { /* the next accessToken() still decides */ } },
  }
}
