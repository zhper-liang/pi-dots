import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'

// Loopback stand-in for accounts.google.com, oauth2.googleapis.com, Calendar v3 and Tasks v1.
// Tests only: it never proxies anywhere. Every issued secret starts with a FAKE_GOOGLE_SECRET_PREFIXES
// entry so secret-scan tests can grep logs, files, HTTP bodies and Task history for them.
export const FAKE_GOOGLE_CLIENT = Object.freeze({ clientId: 'fake-client-1.apps.googleusercontent.com', clientSecret: 'GOCSPX-fake-client-secret-0001' })
export const FAKE_GOOGLE_SECRET_PREFIXES = Object.freeze(['ya29.fake-access-', '1//fake-refresh-', '4/fake-code-', 'GOCSPX-fake-', 'fake-verifier-unused'])
const G = 'https://www.googleapis.com/auth/'
const SCOPE_NEEDS = { calendar: [`${G}calendar.events`, `${G}calendar.calendarlist.readonly`], tasks: [`${G}tasks`] }
const REAL_HOSTS = /(^|\.)googleapis\.com$|^accounts\.google\.com$|(^|\.)google\.com$/
const json = (res, status, body, headers = {}) => { const text = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers }); res.end(text) }
const gError = (status, reason, message = reason) => ({ error: { code: status, message, errors: [{ reason, message }], status: reason } })
const token = prefix => `${prefix}${randomBytes(18).toString('base64url')}`
const etagOf = n => `"fake-etag-${n}"`
const pageOf = (items, query, max) => {
  const size = Math.min(Number(query.get('maxResults') ?? max) || max, max), offset = query.get('pageToken') ? Number(Buffer.from(query.get('pageToken'), 'base64url').toString()) : 0
  const slice = items.slice(offset, offset + size), next = offset + size < items.length ? Buffer.from(String(offset + size)).toString('base64url') : undefined
  return { items: slice, ...(next ? { nextPageToken: next } : {}) }
}

/**
 * Wrap a fetch so any request to a real Google host fails the test (§7). Returns the wrapped fetch
 * and the list of blocked URLs; assert `blocked.length === 0` at the end of every test.
 */
export function guardGoogleNetwork(fetchImpl = globalThis.fetch) {
  const blocked = []
  const guarded = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (REAL_HOSTS.test(url.hostname)) { blocked.push(url.origin); throw new Error('Real Google network access is forbidden in tests') }
    return fetchImpl(input, init)
  }
  return { fetch: guarded, blocked }
}

/**
 * createFakeGoogle(options) → fake. See plans/active/r3-google-workspace/CONTRACTS.md §3.
 * options: { client, sub, email, pageSize: { calendar, tasks }, tasksIfMatch, accessTtl, routes }
 * routes: [{ method?, path: RegExp, handler(req, res, ctx) }] — extra authorized Calendar/Tasks endpoints
 * added from a ticket's own test file; ctx = { url, body(), json(res, status, data), error(status, reason), token, state, fake }.
 */
export async function createFakeGoogle(options = {}) {
  const client = options.client ?? FAKE_GOOGLE_CLIENT
  const state = { calendars: new Map(), events: new Map(), taskLists: new Map(), tasks: new Map(), codes: new Map(), access: new Map(), refresh: new Map() }
  const requests = [], rules = []
  let grant = { scopes: null, deny: false, refreshToken: true, sub: options.sub ?? 'fake-sub-0001', email: options.email ?? 'owner@example.test' }
  let counter = 0, version = 0
  const pageSize = { calendar: options.pageSize?.calendar ?? 250, tasks: options.pageSize?.tasks ?? 100 }
  const accessTtl = options.accessTtl ?? 3600
  const now = () => Date.now()
  const issueAccess = (scope, sub, refreshToken = null) => { const value = token('ya29.fake-access-'); state.access.set(value, { scope, sub, expiresAt: now() + accessTtl * 1000, refreshToken, revoked: false }); return value }
  const bearer = req => {
    const value = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1], entry = value && state.access.get(value)
    return entry && !entry.revoked && entry.expiresAt > now() && !(entry.refreshToken && state.refresh.get(entry.refreshToken)?.revoked) ? entry : null
  }
  const tick = () => ++version

  async function body(req) {
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('too large'); chunks.push(chunk) }
    return Buffer.concat(chunks).toString('utf8')
  }
  function match(req, url) {
    const index = rules.findIndex(rule => (rule.method === undefined || rule.method === req.method) && (typeof rule.path === 'string' ? url.pathname === rule.path || url.pathname.endsWith(rule.path) : rule.path.test(url.pathname)))
    if (index < 0) return null
    const rule = rules[index]
    if (--rule.times <= 0) rules.splice(index, 1)
    return rule
  }
  async function effect(rule, res) {
    if (rule.delayMs) await new Promise(resolve => setTimeout(resolve, rule.delayMs))
    if (rule.hang) return new Promise(() => {})
    if (rule.disconnect) { res.socket?.destroy(); return }
    if (rule.huge) { const pad = 'x'.repeat(rule.huge); json(res, 200, { items: [], pad }); return }
    if (rule.oauthError) { json(res, rule.status ?? 400, { error: rule.oauthError, error_description: 'fake provider text that must never be shown' }); return }
    json(res, rule.status ?? 500, rule.body ?? gError(rule.status ?? 500, rule.reason ?? 'backendError'), rule.headers)
  }

  async function oauth(req, res, url) {
    if (url.pathname === '/o/oauth2/v2/auth') {
      const q = url.searchParams
      if (q.get('client_id') !== client.clientId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(q.get('redirect_uri') ?? '') || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) { json(res, 400, { error: 'invalid_request' }); return }
      const redirect = new URL(q.get('redirect_uri')); redirect.searchParams.set('state', q.get('state'))
      if (grant.deny) { redirect.searchParams.set('error', 'access_denied'); res.writeHead(302, { Location: redirect.href }); res.end(); return }
      const requested = (q.get('scope') ?? '').split(' ').filter(Boolean), scopes = grant.scopes ? requested.filter(scope => grant.scopes.includes(scope)) : requested
      const code = token('4/fake-code-')
      state.codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), scopes, sub: grant.sub, email: grant.email, used: false, expiresAt: now() + 600000 })
      redirect.searchParams.set('code', code); redirect.searchParams.set('scope', scopes.join(' '))
      res.writeHead(302, { Location: redirect.href }); res.end(); return
    }
    if (req.method !== 'POST') { json(res, 405, { error: 'invalid_request' }); return }
    const form = new URLSearchParams(await body(req))
    if (url.pathname === '/token') {
      if (form.get('client_id') !== client.clientId || form.get('client_secret') !== client.clientSecret) { json(res, 401, { error: 'invalid_client' }); return }
      if (form.get('grant_type') === 'authorization_code') {
        const entry = state.codes.get(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? '', challenge = createHash('sha256').update(verifier).digest('base64url')
        if (!entry || entry.used || entry.expiresAt < now() || entry.redirectUri !== form.get('redirect_uri') || entry.challenge !== challenge) { json(res, 400, { error: 'invalid_grant' }); return }
        entry.used = true
        const scope = entry.scopes.join(' '), refreshToken = grant.refreshToken ? token('1//fake-refresh-') : null
        if (refreshToken) state.refresh.set(refreshToken, { scope, sub: entry.sub, email: entry.email, revoked: false })
        const accessToken = issueAccess(scope, entry.sub, refreshToken)
        const claims = { iss: 'https://accounts.google.com', aud: client.clientId, sub: entry.sub, ...(entry.scopes.includes(`${G}userinfo.email`) ? { email: entry.email, email_verified: true } : {}), iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 3600 }
        const idToken = [Buffer.from('{"alg":"RS256","kid":"fake"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'fake-signature'].join('.')
        json(res, 200, { access_token: accessToken, expires_in: accessTtl, token_type: 'Bearer', scope, id_token: idToken, ...(refreshToken ? { refresh_token: refreshToken } : {}) }); return
      }
      if (form.get('grant_type') === 'refresh_token') {
        const entry = state.refresh.get(form.get('refresh_token') ?? '')
        if (!entry || entry.revoked) { json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }); return }
        json(res, 200, { access_token: issueAccess(entry.scope, entry.sub, form.get('refresh_token')), expires_in: accessTtl, token_type: 'Bearer', scope: entry.scope }); return
      }
      json(res, 400, { error: 'unsupported_grant_type' }); return
    }
    if (url.pathname === '/revoke') {
      const value = form.get('token') ?? '', refresh = state.refresh.get(value), access = state.access.get(value)
      if (refresh) { refresh.revoked = true; for (const entry of state.access.values()) if (entry.refreshToken === value) entry.revoked = true }
      else if (access) access.revoked = true
      else { json(res, 400, { error: 'invalid_token' }); return }
      json(res, 200, {}); return
    }
    json(res, 404, { error: 'not_found' })
  }

  function calendarEvent(calendarId, input, id) {
    return { kind: 'calendar#event', id, status: input.status ?? 'confirmed', summary: input.summary ?? '', description: input.description ?? '', start: input.start, end: input.end,
      ...(input.recurrence ? { recurrence: input.recurrence } : {}), ...(input.recurringEventId ? { recurringEventId: input.recurringEventId } : {}),
      created: new Date(now()).toISOString(), updated: new Date(now()).toISOString(), etag: etagOf(tick()), organizer: { email: calendarId, self: true } }
  }
  async function calendar(req, res, url) {
    const parts = url.pathname.replace(/^\/calendar\/v3/, '').split('/').filter(Boolean).map(decodeURIComponent), q = url.searchParams
    if (parts[0] === 'users' && parts[1] === 'me' && parts[2] === 'calendarList' && parts.length === 3 && req.method === 'GET') {
      json(res, 200, { kind: 'calendar#calendarList', ...pageOf([...state.calendars.values()].map(c => ({ kind: 'calendar#calendarListEntry', ...c })), q, pageSize.calendar) }); return
    }
    if (parts[0] !== 'calendars' || !state.calendars.has(parts[1])) { json(res, 404, gError(404, 'notFound')); return }
    const calendarId = parts[1], events = state.events.get(calendarId)
    if (parts.length === 2 && req.method === 'GET') { const c = state.calendars.get(calendarId); json(res, 200, { kind: 'calendar#calendar', id: c.id, summary: c.summary, timeZone: c.timeZone }); return }
    if (parts[2] !== 'events') { json(res, 404, gError(404, 'notFound')); return }
    if (parts.length === 3 && req.method === 'GET') {
      const min = q.get('timeMin') ? Date.parse(q.get('timeMin')) : -Infinity, max = q.get('timeMax') ? Date.parse(q.get('timeMax')) : Infinity
      const at = t => Date.parse(t.dateTime ?? `${t.date}T00:00:00Z`)
      const items = [...events.values()].filter(e => (q.get('showDeleted') === 'true' || e.status !== 'cancelled') && at(e.end) > min && at(e.start) < max)
      json(res, 200, { kind: 'calendar#events', summary: state.calendars.get(calendarId).summary, timeZone: state.calendars.get(calendarId).timeZone, ...pageOf(items, q, pageSize.calendar) }); return
    }
    if (parts.length === 3 && req.method === 'POST') {
      const input = JSON.parse(await body(req) || '{}'), id = input.id ?? `fake${(++counter).toString(32)}`
      if (events.has(id)) { json(res, 409, gError(409, 'duplicate', 'The requested identifier already exists.')); return }
      const event = calendarEvent(calendarId, input, id); events.set(id, event); json(res, 200, event); return
    }
    const event = events.get(parts[3])
    if (!event || parts.length !== 4) { json(res, 404, gError(404, 'notFound')); return }
    if (req.method === 'GET') { json(res, 200, event); return }
    const ifMatch = req.headers['if-match']
    if (ifMatch && ifMatch !== event.etag) { json(res, 412, gError(412, 'conditionNotMet', 'Precondition Failed')); return }
    if (req.method === 'DELETE') { if (event.status === 'cancelled') { json(res, 410, gError(410, 'deleted')); return } Object.assign(event, { status: 'cancelled', etag: etagOf(tick()), updated: new Date(now()).toISOString() }); res.writeHead(204); res.end(); return }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const input = JSON.parse(await body(req) || '{}')
      const next = req.method === 'PUT' ? calendarEvent(calendarId, input, event.id) : { ...event, ...input, id: event.id, etag: etagOf(tick()), updated: new Date(now()).toISOString() }
      events.set(event.id, next); json(res, 200, next); return
    }
    json(res, 405, gError(405, 'methodNotAllowed'))
  }

  const dueDate = value => typeof value === 'string' && value ? `${value.slice(0, 10)}T00:00:00.000Z` : undefined // Google drops the time of day
  function task(input, id, parent) { return { kind: 'tasks#task', id, title: input.title ?? '', notes: input.notes, status: input.status ?? 'needsAction', ...(dueDate(input.due) ? { due: dueDate(input.due) } : {}), ...(input.status === 'completed' ? { completed: new Date(now()).toISOString() } : {}), ...(parent ? { parent } : {}), updated: new Date(now()).toISOString(), etag: etagOf(tick()), position: String(++counter).padStart(20, '0') } }
  async function tasks(req, res, url) {
    const parts = url.pathname.replace(/^\/tasks\/v1/, '').split('/').filter(Boolean).map(decodeURIComponent), q = url.searchParams
    if (parts[0] === 'users' && parts[1] === '@me' && parts[2] === 'lists' && parts.length === 3 && req.method === 'GET') { json(res, 200, { kind: 'tasks#taskLists', ...pageOf([...state.taskLists.values()], q, pageSize.tasks) }); return }
    if (parts[0] !== 'lists' || !state.taskLists.has(parts[1]) || parts[2] !== 'tasks') { json(res, 404, gError(404, 'notFound')); return }
    const items = state.tasks.get(parts[1])
    if (parts.length === 3 && req.method === 'GET') {
      const list = [...items.values()].filter(t => !t.deleted && (q.get('showCompleted') !== 'false' || t.status !== 'completed') && (q.get('showHidden') === 'true' || !t.hidden))
      json(res, 200, { kind: 'tasks#tasks', ...pageOf(list, q, pageSize.tasks) }); return
    }
    if (parts.length === 3 && req.method === 'POST') { const input = JSON.parse(await body(req) || '{}'), id = `task${(++counter).toString(32)}`, created = task(input, id, q.get('parent')); items.set(id, created); json(res, 200, created); return }
    const current = items.get(parts[3])
    if (!current || current.deleted || parts.length !== 4) { json(res, 404, gError(404, 'notFound')); return }
    if (req.method === 'GET') { json(res, 200, current); return }
    if (options.tasksIfMatch && req.headers['if-match'] && req.headers['if-match'] !== current.etag) { json(res, 412, gError(412, 'conditionNotMet')); return }
    if (req.method === 'DELETE') { current.deleted = true; res.writeHead(204); res.end(); return }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const input = JSON.parse(await body(req) || '{}')
      const next = { ...current, ...input, id: current.id, ...(input.due !== undefined ? { due: dueDate(input.due) } : {}), ...(input.status === 'completed' && current.status !== 'completed' ? { completed: new Date(now()).toISOString() } : input.status === 'needsAction' ? { completed: undefined } : {}), updated: new Date(now()).toISOString(), etag: etagOf(tick()) }
      items.set(current.id, next); json(res, 200, next); return
    }
    json(res, 405, gError(405, 'methodNotAllowed'))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), ifMatch: req.headers['if-match'] ?? null, at: now() })
    try {
      const rule = match(req, url)
      if (rule && !rule.after) return await effect(rule, res)
      if (rule?.after) {
        // Apply the real effect first, then delay, drop or replace the response (lost-response scenarios).
        const realEnd = res.end.bind(res), realHead = res.writeHead.bind(res)
        let head = null
        res.writeHead = (...args) => { head = args; return res }
        res.end = (...args) => {
          res.writeHead = realHead; res.end = realEnd
          void (async () => {
            if (rule.delayMs) await new Promise(resolve => setTimeout(resolve, rule.delayMs))
            if (rule.disconnect) { res.socket?.destroy(); return }
            if (rule.status || rule.body || rule.oauthError || rule.huge || rule.hang) return effect({ ...rule, delayMs: 0 }, res)
            if (head) realHead(...head)
            realEnd(...args)
          })()
          return res
        }
      }
      if (url.pathname.startsWith('/o/oauth2/') || url.pathname === '/token' || url.pathname === '/revoke') return await oauth(req, res, url)
      if (url.pathname === '/oauth2/v3/userinfo' || url.pathname === '/oauth2/v2/userinfo') {
        const entry = bearer(req)
        if (!entry) { json(res, 401, { error: 'invalid_token' }); return }
        json(res, 200, { sub: entry.sub, ...(entry.scope.includes(`${G}userinfo.email`) ? { email: state.refresh.get(entry.refreshToken)?.email ?? grant.email, email_verified: true } : {}) }); return
      }
      const service = url.pathname.startsWith('/calendar/v3/') ? 'calendar' : url.pathname.startsWith('/tasks/v1/') ? 'tasks' : null
      if (!service) { json(res, 404, gError(404, 'notFound')); return }
      const entry = bearer(req)
      if (!entry) { json(res, 401, gError(401, 'authError', 'Invalid Credentials')); return }
      if (!SCOPE_NEEDS[service].some(scope => entry.scope.split(' ').includes(scope))) { json(res, 403, gError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.')); return }
      const extra = (options.routes ?? []).find(route => (route.method === undefined || route.method === req.method) && route.path.test(url.pathname))
      if (extra) return await extra.handler(req, res, { url, body: () => body(req), json, error: (status, reason) => gError(status, reason), token: entry, state, fake })
      return await (service === 'calendar' ? calendar(req, res, url) : tasks(req, res, url))
    } catch { if (!res.headersSent) json(res, 500, gError(500, 'backendError')); else res.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  let fake
  fake = {
    base, client, requests, state,
    /** Pass as openGoogleConnection({ endpoints }) — the only way to leave the fixed Google hosts. */
    endpoints: { authorize: `${base}/o/oauth2/v2/auth`, token: `${base}/token`, revoke: `${base}/revoke`, calendar: `${base}/calendar/v3`, tasks: `${base}/tasks/v1` },
    userinfoUrl: `${base}/oauth2/v3/userinfo`,
    /** Script the next `times` matching requests: { method?, path, times=1, status, reason, body, headers, oauthError, delayMs, hang, disconnect, huge, after }. */
    fail(rule) { if (!rule || !rule.path) throw new Error('fake-google rule needs a path'); rules.push({ times: 1, ...rule }); return fake },
    clearFailures() { rules.length = 0 },
    /** Consent screen behaviour for the next authorizations: { scopes (subset granted), deny, refreshToken, sub, email }. */
    setGrant(next) { grant = { ...grant, ...next }; return fake },
    revokeAll() { for (const entry of state.refresh.values()) entry.revoked = true; for (const entry of state.access.values()) entry.revoked = true },
    expireAccessTokens() { for (const entry of state.access.values()) entry.expiresAt = 0 },
    count: (path, method) => requests.filter(r => (method === undefined || r.method === method) && r.path.endsWith(path)).length,
    /** Follow the authorize URL like a browser that approves consent; returns the callback URL. */
    async approve(authorizeUrl) {
      const response = await fetch(authorizeUrl, { redirect: 'manual' })
      if (response.status !== 302) throw new Error('fake-google authorize was rejected')
      return response.headers.get('location')
    },
    addCalendar({ id, summary = id, accessRole = 'owner', timeZone = 'Asia/Shanghai', primary = false }) { state.calendars.set(id, { id, summary, accessRole, timeZone, ...(primary ? { primary: true } : {}) }); state.events.set(id, state.events.get(id) ?? new Map()); return fake },
    addEvent(calendarId, input) { const event = calendarEvent(calendarId, input, input.id ?? `fake${(++counter).toString(32)}`); state.events.get(calendarId).set(event.id, event); return event },
    addTaskList({ id, title = id }) { state.taskLists.set(id, { kind: 'tasks#taskList', id, title, updated: new Date(now()).toISOString(), etag: etagOf(tick()) }); state.tasks.set(id, state.tasks.get(id) ?? new Map()); return fake },
    addTask(listId, input) { const created = task(input, input.id ?? `task${(++counter).toString(32)}`, input.parent); state.tasks.get(listId).set(created.id, created); return created },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())) },
  }
  return fake
}
