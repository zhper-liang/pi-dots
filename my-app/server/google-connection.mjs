import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { createHash } from 'node:crypto'
import { GOOGLE_ENDPOINTS, googleEndpoints, googleError, GoogleError, createGoogleClient } from './google-client.mjs'
import { openGoogleCredentials, validGoogleClient } from './google-credentials.mjs'
import { GOOGLE_SERVICES, createGoogleOAuth, createPkce, createState, authorizeUrl, listenForCallback, parsePastedRedirect, sameSecret,
  requestedScopes, grantedServices, expandServiceGroups, accountKeyOf, clientKeyOf } from './google-oauth.mjs'

const ATTEMPT_MS = 5 * 60 * 1000, EARLY_REFRESH_MS = 60 * 1000
const DEFAULT_ENV_FILES = [new URL('../.env', import.meta.url), new URL('../../.env', import.meta.url)]
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * The single Google account (§4). Secrets live only in the 0600 file and this process's memory.
 * Public projections carry connected/status/email/services; nothing here is ever logged.
 * Test-only seams (endpoints, fetchImpl, now, attemptMs) are in-process options, never HTTP/env.
 */
export async function openGoogleConnection({ dataDirectory, env = process.env, envFiles = DEFAULT_ENV_FILES, endpoints, fetchImpl = globalThis.fetch,
  now = Date.now, attemptMs = ATTEMPT_MS, timeoutMs = 10000, sleep } = {}) {
  const hosts = endpoints === undefined ? GOOGLE_ENDPOINTS : googleEndpoints(endpoints)
  const store = await openGoogleCredentials({ dataDirectory })
  const oauth = createGoogleOAuth({ endpoints: hosts, fetchImpl, timeoutMs })
  const listeners = new Set(), saves = new Map(), recent = []
  let attempt = null, lastResult = null, disconnecting = false, generation = 0, cache = null, closed = false, starting = Promise.resolve()
  const refreshing = new Map()
  const remember = token => { if (typeof token === 'string' && token) { recent.push(token); if (recent.length > 32) recent.shift() } }

  async function envClient() {
    const sources = [env]
    for (const file of envFiles) { try { sources.push(parseEnv(await readFile(file, 'utf8'))) } catch (error) { if (error.code !== 'ENOENT') return { invalid: true } } }
    const get = name => sources.map(source => source[name]).find(value => value !== undefined)
    const clientId = get('GOOGLE_OAUTH_CLIENT_ID'), clientSecret = get('GOOGLE_OAUTH_CLIENT_SECRET')
    if (clientId === undefined && clientSecret === undefined) return null
    const client = { clientId: String(clientId ?? '').trim(), clientSecret: String(clientSecret ?? '') }
    return validGoogleClient(client) ? { client } : { invalid: true }
  }
  // ADR-016 order: process env, my-app/.env, root .env, then the settings-page file. A partial or
  // invalid env configuration fails closed instead of silently falling back to the file.
  async function resolveClient() {
    const fromEnv = await envClient()
    if (fromEnv?.invalid) return { source: 'env', client: null, invalid: true }
    if (fromEnv) return { source: 'env', client: fromEnv.client }
    const saved = store.get().client
    return saved ? { source: 'file', client: saved } : { source: 'none', client: null }
  }
  function accountState(resolved, account = store.get().account) {
    if (!account) return 'disconnected'
    if (account.status !== 'connected' || !resolved.client || account.clientKey !== clientKeyOf(resolved.client.clientId)) return 'needs_auth'
    return 'connected'
  }
  const grantedOf = account => account ? grantedServices(account.scopes) : []
  async function status() {
    const resolved = await resolveClient(), account = store.get().account, state = accountState(resolved, account)
    const live = attempt && !attempt.consumed && !attempt.expired && now() < attempt.expiresAt
    return { connected: state === 'connected', status: state, email: account?.email ?? null, services: state === 'connected' ? grantedOf(account) : [],
      requested: account?.requested ?? [], client: { configured: !!resolved.client, source: resolved.source, invalid: !!resolved.invalid, editable: resolved.source !== 'env' },
      attempt: live ? { active: true, expiresAt: new Date(attempt.expiresAt).toISOString(), authorizeUrl: attempt.authorizeUrl } : null, lastResult: lastResult ? { ...lastResult } : null }
  }
  /** View for the durable GoogleAccount mirror: no email, no tokens. */
  async function accountView() {
    const resolved = await resolveClient(), account = store.get().account, state = accountState(resolved, account)
    return { status: state, accountKey: account?.accountKey ?? null, services: state === 'connected' ? grantedOf(account) : [] }
  }
  async function notify() { await Promise.allSettled([...listeners].map(listener => listener())) }
  function dropToken() { cache = null; generation++ }

  async function saveClient(input) {
    if (!plain(input) || Object.keys(input).some(key => !['requestId', 'clientId', 'clientSecret'].includes(key)) || typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) ||
      typeof input.clientId !== 'string' || input.clientSecret !== undefined && typeof input.clientSecret !== 'string') throw googleError('GOOGLE_CLIENT_INPUT')
    const resolved = await resolveClient()
    if (resolved.source === 'env') throw googleError('GOOGLE_CLIENT_ENV_LOCKED')
    const sig = signature([input.clientId.trim(), input.clientSecret ?? ''])
    const prior = saves.get(input.requestId)
    if (prior) { if (prior !== sig) throw googleError('GOOGLE_CLIENT_REQUEST_CONFLICT'); return status() }
    const client = { clientId: input.clientId.trim(), clientSecret: input.clientSecret?.length ? input.clientSecret : resolved.client?.clientSecret ?? '' }
    if (!validGoogleClient(client)) throw googleError('GOOGLE_CLIENT_INPUT')
    const changedId = resolved.client && resolved.client.clientId !== client.clientId
    await store.update(state => ({ ...state, client, account: changedId && state.account ? { ...state.account, status: 'needs_auth', refreshToken: null } : state.account }))
    saves.set(input.requestId, sig)
    if (changedId) { dropToken(); await notify() }
    return status()
  }

  async function closeAttempt() { const current = attempt; if (!current) return; clearTimeout(current.timer); await current.listener.close().catch(() => {}) }
  // Serialized so two quick clicks never leave an orphaned callback listener.
  function start(input) { const run = starting.then(() => startOnce(input)); starting = run.catch(() => {}); return run }
  async function startOnce(input) {
    if (!plain(input) || Object.keys(input).some(key => key !== 'services')) throw googleError('GOOGLE_CONNECT_INPUT')
    const services = expandServiceGroups(input.services)
    const resolved = await resolveClient()
    if (resolved.invalid) throw googleError('GOOGLE_CLIENT_INVALID')
    if (!resolved.client) throw googleError('GOOGLE_NOT_CONFIGURED')
    if (disconnecting || closed) throw googleError('GOOGLE_BUSY')
    await closeAttempt(); attempt = null
    const pkce = createPkce(), state = createState()
    let current = null
    const listener = await listenForCallback(params => current && current === attempt ? consume(current, params) : 'invalid')
    current = { state, verifier: pkce.verifier, redirectUri: listener.redirectUri, services, clientKey: clientKeyOf(resolved.client.clientId), listener, consumed: false, expired: false, expiresAt: now() + attemptMs }
    current.authorizeUrl = authorizeUrl(hosts.authorize, { clientId: resolved.client.clientId, redirectUri: listener.redirectUri, scopes: requestedScopes(services), state, challenge: pkce.challenge, loginHint: store.get().account?.email ?? undefined })
    current.timer = setTimeout(() => { if (attempt === current && !current.consumed) { current.expired = true; lastResult = { result: 'expired', code: 'GOOGLE_ATTEMPT_EXPIRED', at: new Date(now()).toISOString() } } void listener.close() }, attemptMs)
    current.timer.unref?.()
    attempt = current; lastResult = null
    return status()
  }

  // Both the loopback callback and the pasted redirect end here; the first one wins.
  async function consume(current, params) {
    if (current.consumed || current.expired || now() >= current.expiresAt) return 'invalid'
    if (!sameSecret(params.get('state'), current.state)) return 'invalid'
    current.consumed = true; clearTimeout(current.timer)
    const at = () => new Date(now()).toISOString()
    if (params.has('error')) {
      const denied = params.get('error') === 'access_denied'
      lastResult = { result: denied ? 'denied' : 'failed', code: denied ? 'GOOGLE_ACCESS_DENIED' : 'GOOGLE_AUTH_FAILED', at: at() }
      return denied ? 'denied' : 'failed'
    }
    const code = params.get('code'), began = generation
    try {
      if (typeof code !== 'string' || !code || code.length > 4096) throw googleError('GOOGLE_AUTH_FAILED')
      const resolved = await resolveClient()
      if (!resolved.client || clientKeyOf(resolved.client.clientId) !== current.clientKey) throw googleError('GOOGLE_CLIENT_INVALID')
      const tokens = await oauth.exchange({ client: resolved.client, code, verifier: current.verifier, redirectUri: current.redirectUri })
      remember(tokens.accessToken)
      if (!tokens.refreshToken) { void oauth.revoke({ token: tokens.accessToken }); throw googleError('GOOGLE_NO_REFRESH_TOKEN') }
      remember(tokens.refreshToken)
      // A disconnect (or another change) during the exchange wins: revoke the new grant, store nothing.
      if (generation !== began || disconnecting || closed) { await oauth.revoke({ token: tokens.refreshToken }); throw googleError('GOOGLE_BUSY') }
      const accountKey = accountKeyOf(tokens.identity.sub), previous = store.get().account
      // A different Google account replaces the old grant; the same account keeps its one grant.
      if (previous?.refreshToken && previous.accountKey !== accountKey) await oauth.revoke({ token: previous.refreshToken })
      dropToken()
      const mine = generation
      await store.update(state => ({ ...state, account: { status: 'connected', sub: tokens.identity.sub, email: tokens.identity.email, accountKey,
        scopes: tokens.scopes ?? [], refreshToken: tokens.refreshToken, clientKey: current.clientKey, requested: current.services, connectedAt: at() } }))
      cache = { accessToken: tokens.accessToken, expiresAt: now() + tokens.expiresIn * 1000, accountKey, generation: mine }
      lastResult = { result: 'connected', code: null, at: at() }
      await notify()
      return 'connected'
    } catch (error) {
      lastResult = { result: 'failed', code: error instanceof GoogleError ? error.code : 'GOOGLE_AUTH_FAILED', at: at() }
      return 'failed'
    }
  }
  async function paste(input) {
    if (!plain(input) || Object.keys(input).some(key => key !== 'redirectUrl') || typeof input.redirectUrl !== 'string') throw googleError('GOOGLE_REDIRECT_INVALID')
    const current = attempt
    if (!current) throw googleError('GOOGLE_ATTEMPT_MISSING')
    const params = parsePastedRedirect(input.redirectUrl, current.redirectUri)
    if (current.consumed) throw googleError('GOOGLE_ATTEMPT_USED')
    if (current.expired || now() >= current.expiresAt) throw googleError('GOOGLE_ATTEMPT_EXPIRED')
    if (!sameSecret(params.get('state'), current.state)) throw googleError('GOOGLE_STATE_MISMATCH')
    const result = await consume(current, params)
    void current.listener.close()
    if (result === 'invalid') throw googleError('GOOGLE_ATTEMPT_USED')
    if (result !== 'connected') throw googleError(lastResult?.code ?? 'GOOGLE_AUTH_FAILED')
    return status()
  }

  async function markNeedsAuth() {
    dropToken()
    await store.update(state => state.account ? { ...state, account: { ...state.account, status: 'needs_auth', refreshToken: null } } : state).catch(() => {})
    await notify()
  }
  async function refresh(account, client) {
    const mine = generation
    let tokens
    try { tokens = await oauth.refresh({ client, refreshToken: account.refreshToken }) }
    catch (error) {
      if (generation !== mine) throw googleError('GOOGLE_NEEDS_AUTH')
      if (error.code === 'GOOGLE_NEEDS_AUTH') await markNeedsAuth()
      throw error.code === 'GOOGLE_NEEDS_AUTH' ? googleError('GOOGLE_NEEDS_AUTH') : error
    }
    // A refresh that raced a disconnect/reconnect is discarded, never cached.
    if (generation !== mine || store.get().account?.accountKey !== account.accountKey) throw googleError('GOOGLE_NEEDS_AUTH')
    remember(tokens.accessToken); if (tokens.refreshToken) remember(tokens.refreshToken)
    cache = { accessToken: tokens.accessToken, expiresAt: now() + tokens.expiresIn * 1000, accountKey: account.accountKey, generation: mine }
    const scopes = tokens.scopes
    if (scopes && JSON.stringify(scopes) !== JSON.stringify(account.scopes) || tokens.refreshToken) {
      await store.update(state => state.account?.accountKey === account.accountKey ? { ...state, account: { ...state.account, ...(scopes ? { scopes } : {}), ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) } } : state).catch(() => {})
      if (scopes && JSON.stringify(grantedServices(scopes)) !== JSON.stringify(grantedServices(account.scopes))) await notify()
    }
    return tokens.accessToken
  }
  /**
   * FROZEN (CONTRACTS.md §4): a currently valid access token for the connected account.
   * Refreshes ~60 s before expiry; one refresh per account at a time; throws GoogleError
   * (kind 'needs_auth' for GOOGLE_NOT_CONNECTED / GOOGLE_NEEDS_AUTH / GOOGLE_SCOPE_MISSING).
   */
  async function accessToken({ services = [], signal } = {}) {
    if (!Array.isArray(services) || services.some(service => !GOOGLE_SERVICES.includes(service))) throw googleError('GOOGLE_INPUT')
    if (signal?.aborted) throw googleError('GOOGLE_CANCELLED')
    if (disconnecting || closed) throw googleError('GOOGLE_NOT_CONNECTED')
    const resolved = await resolveClient(), account = store.get().account
    if (!account) throw googleError('GOOGLE_NOT_CONNECTED')
    if (accountState(resolved, account) !== 'connected') throw googleError('GOOGLE_NEEDS_AUTH')
    const granted = grantedOf(account)
    if (services.some(service => !granted.includes(service))) throw googleError('GOOGLE_SCOPE_MISSING')
    if (cache && cache.generation === generation && cache.accountKey === account.accountKey && cache.expiresAt - now() > EARLY_REFRESH_MS) return cache.accessToken
    const key = `${account.accountKey}:${generation}`
    let pending = refreshing.get(key)
    if (!pending) {
      pending = refresh(account, resolved.client).finally(() => { if (refreshing.get(key) === pending) refreshing.delete(key) })
      refreshing.set(key, pending)
    }
    if (!signal) return pending
    return Promise.race([pending, new Promise((_, reject) => signal.addEventListener('abort', () => reject(googleError('GOOGLE_CANCELLED')), { once: true }))])
  }
  /** After a 401 with `token`, the next accessToken() call refreshes instead of reusing it. */
  function rejectToken(token) { if (cache?.accessToken === token) cache = null }

  async function disconnect(input = {}) {
    if (!plain(input) || Object.keys(input).length) throw googleError('GOOGLE_INPUT')
    if (disconnecting) throw googleError('GOOGLE_BUSY')
    disconnecting = true
    try {
      await closeAttempt(); attempt = null; dropToken()
      const account = store.get().account
      const revoked = account?.refreshToken ? await oauth.revoke({ token: account.refreshToken }) : null
      // Local credentials go regardless of the revoke result; the client config stays for reconnecting.
      await store.update(state => ({ ...state, account: null }))
      lastResult = null
      await notify()
      return { disconnected: true, revoked: account?.refreshToken ? revoked : null }
    } finally { disconnecting = false }
  }

  const client = createGoogleClient({ fetchImpl, endpoints: hosts, timeoutMs, ...(sleep ? { sleep } : {}), token: accessToken, rejectToken })
  return {
    status, accountView, saveClient, start, paste, disconnect, accessToken, rejectToken,
    /** Authorized Calendar/Tasks REST call; see google-client.mjs for retry and error rules. */
    api: client.api,
    /** Replace every known secret (client secret, refresh/access tokens) in a string. */
    redact(text) {
      let value = String(text)
      const known = [store.get().client?.clientSecret, store.get().account?.refreshToken, cache?.accessToken, ...recent].filter(item => typeof item === 'string' && item.length >= 8)
      for (const secret of known.sort((a, b) => b.length - a.length)) value = value.split(secret).join('[已隐藏凭证]')
      return value
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async close() { closed = true; await closeAttempt(); attempt = null; dropToken(); listeners.clear() },
  }
}
