import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'

// Loopback stand-in for workspace-mcp 2.2.1 in external-OAuth stateless mode (the R3-05 run arguments).
// Tool names, input/output schemas and annotations are the real 2.2.1 catalog (fake-workspace-mcp-tools.json).
// Like the real server it validates every request's bearer through Google userinfo, here the fake-google
// one; it never talks to Google. Raw bearers are kept only as fingerprints so tests never print them.
export const WORKSPACE_MCP_CATALOG = JSON.parse(readFileSync(new URL('./fake-workspace-mcp-tools.json', import.meta.url), 'utf8'))
export const fingerprint = token => createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//
const json = (res, status, body, headers = {}) => { const text = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers }); res.end(text) }
const replies = {
  send_gmail_message: args => `Email sent! Message ID: fake-msg-${randomUUID().slice(0, 8)}${args.to ? ` to ${args.to}` : ''}`,
  draft_gmail_message: () => `Draft created! Draft ID: fake-draft-${randomUUID().slice(0, 8)}`,
  search_gmail_messages: args => `Found 1 messages matching '${args.query}':\n\n1. Message ID: fake-msg-0001\n   Thread ID: fake-thread-0001`,
  get_doc_content: args => `File: "Fake doc" (ID: ${args.document_id})\n\n--- CONTENT ---\nFixture document text.`,
  modify_doc_text: args => `Inserted text in document ${args.document_id}.`,
  create_spreadsheet: args => `Successfully created spreadsheet '${args.title}'. ID: fake-sheet-0001`,
}

/**
 * createFakeWorkspaceMcp({ userinfoUrl, verify }) → fake
 * - `userinfoUrl`: fake-google's userinfo (loopback only). Or `verify(token) → boolean` for unit tests.
 * - fake.calls: [{ name, arguments, bearer: fingerprint }]; fake.requests: [{ method, bearer, status }]
 * - Scripting: hang(name), rejectNext(n), toolError(name), echoBearer(name), clear()
 */
export async function createFakeWorkspaceMcp({ userinfoUrl, verify, tools = WORKSPACE_MCP_CATALOG.tools } = {}) {
  if (!verify && !LOOPBACK.test(userinfoUrl ?? '')) throw new Error('fake workspace-mcp validates bearers only against a loopback userinfo')
  const calls = [], requests = [], hanging = new Set(), failing = new Set(), echoing = new Set(), gates = new Set()
  let rejectCount = 0
  const validators = new Map(tools.map(tool => [tool.name, new AjvJsonSchemaValidator().getValidator(tool.inputSchema)]))
  async function valid(token) {
    if (verify) return verify(token)
    const response = await fetch(userinfoUrl, { headers: { authorization: `Bearer ${token}` } }).catch(() => null)
    const body = response?.ok ? await response.json().catch(() => null) : null
    return Boolean(body?.email)
  }
  function mcpServer(token) {
    const server = new Server({ name: 'google_workspace', version: '2.2.1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args = {} } = request.params
      if (!validators.has(name)) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
      if (!validators.get(name)(args).valid) return { isError: true, content: [{ type: 'text', text: `Input validation error for ${name}` }] }
      calls.push({ name, arguments: structuredClone(args), bearer: fingerprint(token) })
      if (hanging.has(name)) await new Promise(resolve => gates.add(resolve))
      if (failing.has(name)) return { isError: true, content: [{ type: 'text', text: `Error calling tool '${name}': fixture failure` }] }
      const text = echoing.has(name) ? `debug bearer ${token}` : (replies[name]?.(args) ?? `${name} completed.`)
      return { content: [{ type: 'text', text }], structuredContent: { result: text } }
    })
    return server
  }
  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { status: 'healthy', service: 'workspace-mcp', version: '2.2.1', transport: 'streamable-http' }); return }
    if (url.pathname !== '/mcp') { json(res, 404, { error: 'not_found' }); return }
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const entry = { method: req.method, bearer: token ? fingerprint(token) : null, status: 0 }
    requests.push(entry)
    const challenge = { 'WWW-Authenticate': 'Bearer error="invalid_token"' }
    if (!token) { entry.status = 401; json(res, 401, { error: 'invalid_token' }, challenge); return }
    if (req.method === 'POST' && rejectCount > 0) { rejectCount--; entry.status = 401; json(res, 401, { error: 'invalid_token' }, challenge); return }
    if (!await valid(token)) { entry.status = 401; json(res, 401, { error: 'invalid_token' }, challenge); return }
    // Stateless HTTP (WORKSPACE_MCP_STATELESS_MODE=true): POST only, one server per request, no session id.
    if (req.method !== 'POST') { entry.status = 405; res.writeHead(405, { Allow: 'POST, DELETE' }); res.end(); return }
    const server = mcpServer(token), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void transport.close(); void server.close() })
    try { await server.connect(transport); await transport.handleRequest(req, res) }
    catch { if (!res.headersSent) json(res, 500, { error: 'fixture failure' }) }
    entry.status = res.statusCode
  })
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const base = `http://127.0.0.1:${http.address().port}`
  return {
    url: `${base}/mcp`, base, calls, requests,
    count: name => calls.filter(call => call.name === name).length,
    hang(name) { hanging.add(name) }, toolError(name) { failing.add(name) }, echoBearer(name) { echoing.add(name) },
    rejectNext(times = 1) { rejectCount = times },
    clear() { hanging.clear(); failing.clear(); echoing.clear(); rejectCount = 0 },
    async close() { for (const release of gates) release(); gates.clear(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)) },
  }
}

/**
 * R3-05 test setup: fake Google + a connected Pidot Google account (paste flow) + fake workspace-mcp.
 * `services` are the settings-page rows; `clock` ({ t }) drives Pidot's token expiry.
 */
export async function googleWorkspaceSetup({ dataDirectory, clock, services = ['calendar', 'tasks', 'workspace'] }) {
  const { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT } = await import('./fake-google.mjs')
  const { openGoogleConnection } = await import('../google-connection.mjs')
  const fake = await createFakeGoogle(), guard = guardGoogleNetwork()
  const google = await openGoogleConnection({ dataDirectory, env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch, ...(clock ? { now: () => clock.t } : {}) })
  await google.saveClient({ requestId: 'client-r3-05-0001', ...FAKE_GOOGLE_CLIENT })
  const started = await google.start({ services })
  await google.paste({ redirectUrl: await fake.approve(started.attempt.authorizeUrl) })
  const workspace = await createFakeWorkspaceMcp({ userinfoUrl: fake.userinfoUrl })
  return { fake, guard, google, workspace, async close() { await workspace.close(); await google.close(); await fake.close() } }
}

/** A loopback server that answers /health but is not workspace-mcp (wrong process on the port). */
export async function createImpostorHealth() {
  const http = createServer((req, res) => json(res, 200, { status: 'ok', service: 'something-else' }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, close: () => new Promise(resolve => { http.closeAllConnections(); http.close(resolve) }) }
}
