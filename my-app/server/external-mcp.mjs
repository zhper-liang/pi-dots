import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, lstat, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import { boundedMcpJson, projectMcpConfig, validateMcpConfig, validMcpCredentialRef, mapMcpTools, publicMcpError, mcpSourceRevision, ExternalMcpError, MCP_LIMITS } from './external-mcp-config.mjs'
import { externalMcpTransportStatus, createExternalMcpTransport } from './external-mcp-transport.mjs'
import { resolveWorkspaceMcpEndpoint, probeWorkspaceMcp, googleBearer, WORKSPACE_MCP_VERSION } from './external-mcp-google.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const fail = (code, status = 400) => { throw new ExternalMcpError(code, status) }
const requestIdValid = value => typeof value === 'string' && /^[\w:-]{1,160}$/.test(value)
const revisionOf = record => hash([record.config, record.tools, record.enabled, record.version])
const catalogRevisionOf = record => hash([{ transport: record.config.transport, url: record.config.url, executable: record.config.executable,
  args: record.config.args, envKeys: record.config.envKeys, secretEnvKeys: record.config.secretEnvKeys,
  credentialSource: record.config.credentialSource, googleServices: record.config.googleServices }, [...record.tools].sort((a, b) => a.name.localeCompare(b.name))])
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const hasControl = value => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const emptyState = () => ({ version: 1, connections: {}, removed: {}, requests: {} })
const secretValues = credential => [credential?.bearerToken, ...Object.values(credential?.env ?? {})]
  .filter(value => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length)
function containsSecret(value, known) {
  if (!known.length) return false
  if (value === null || typeof value !== 'object') return known.some(secret => String(value).includes(secret))
  return Object.entries(value).some(([key, item]) => known.some(secret => key.includes(secret)) || containsSecret(item, known))
}
function redactResult(value, known) {
  let redacted = false
  const marker = known.some(secret => '[redacted]'.includes(secret)) ? '' : '[redacted]'
  const visit = item => {
    if (item === null || typeof item !== 'object') {
      const text = String(item)
      if (!known.some(secret => text.includes(secret))) return item
      redacted = true
      return known.reduce((result, secret) => result.replaceAll(secret, marker), text)
    }
    if (Array.isArray(item)) return item.map(visit)
    const result = {}
    for (const [key, child] of Object.entries(item)) {
      // Secret-bearing field names cannot be renamed without silently changing semantics.
      if (known.some(secret => key.includes(secret))) fail('MCP_INVALID_RESULT')
      result[key] = visit(child)
    }
    return result
  }
  const result = visit(value)
  if (redacted) result._meta = { ...(result._meta ?? {}), 'pidot/credential-redacted': true }
  return result
}


// Static configuration projection remains available to old callers; it never claims a handshake.
export function externalMcpCatalog(configurations) {
  const configs = boundedMcpJson(configurations, { maxBytes: MCP_LIMITS.catalogBytes })
  if (!Array.isArray(configs) || configs.length > 64) fail('MCP_INVALID_CONFIG')
  const ids = new Set()
  return configs.map(input => {
    const config = validateMcpConfig(input), view = projectMcpConfig(config)
    if (ids.has(config.connectionId)) fail('MCP_INVALID_CONFIG')
    ids.add(config.connectionId)
    return { id: `mcp:${config.connectionId}`, kind: 'mcp', name: view.name, description: view.description,
      status: view.credentialRequired && !view.hasCredential ? 'needs_auth' : externalMcpTransportStatus().status,
      revision: hash(config), version: 'config-1', toolNames: [],
      requirements: view.credentialRequired && !view.hasCredential ? ['credential'] : [], lastCheck: null }
  })
}

/**
 * Single-user configuration service. The caller's Harness still owns all execution/grant receipts.
 * R3-05: `googleAccessToken` / `googleRejectToken` are the frozen Google token API (CONTRACTS §4);
 * connections with credentialSource 'google' use them per request and store no bearer.
 * `workspaceMcpUrl` overrides PIDOT_WORKSPACE_MCP_URL (tests); it is never read from a connection.
 */
export async function createExternalMcpService({ dataDirectory, inheritedEnv = process.env, lookup,
  transportFactory = createExternalMcpTransport, googleAccessToken, googleRejectToken, workspaceMcpUrl } = {}) {
  if (typeof dataDirectory !== 'string' || !dataDirectory || typeof transportFactory !== 'function' ||
    googleAccessToken !== undefined && typeof googleAccessToken !== 'function' || googleRejectToken !== undefined && typeof googleRejectToken !== 'function') fail('MCP_INVALID_CONFIG')
  const workspaceEndpoint = resolveWorkspaceMcpEndpoint({ url: workspaceMcpUrl, env: inheritedEnv })
  // Short-lived Google tokens seen this process: redacted from results, never persisted.
  const googleTokens = []
  const rememberGoogleToken = token => { if (!googleTokens.includes(token)) { googleTokens.push(token); if (googleTokens.length > 8) googleTokens.shift() } }
  const googleOptions = config => config.credentialSource !== 'google' ? undefined : {
    url: workspaceEndpoint.url ?? undefined,
    bearer: googleAccessToken ? googleBearer({ accessToken: googleAccessToken, rejectToken: googleRejectToken, services: config.googleServices, remember: rememberGoogleToken }) : undefined,
  }
  const knownSecrets = (config, credential) => config.credentialSource === 'google'
    ? [...new Set([...secretValues(credential), ...googleTokens])].sort((a, b) => b.length - a.length) : secretValues(credential)
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  if (!(await lstat(dataDirectory)).isDirectory() || (await lstat(dataDirectory)).isSymbolicLink()) fail('MCP_STORAGE_FAILED', 500)
  await chmod(dataDirectory, 0o700)
  const configFile = join(dataDirectory, 'connections.json'), credentialFile = join(dataDirectory, 'credentials.json')
  const storageBytes = 8 * 1024 * 1024
  async function read(path, fallback) {
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || info.size > storageBytes || (info.mode & 0o077)) fail('MCP_STORAGE_FAILED', 500)
      return boundedMcpJson(JSON.parse(await handle.readFile('utf8')), { maxBytes: storageBytes, maxNodes: 200000, maxDepth: 24 })
    } catch (error) { if (error.code === 'ENOENT') return fallback; throw new ExternalMcpError('MCP_STORAGE_FAILED', 500) }
    finally { await handle?.close() }
  }
  async function write(path, value) {
    const temporary = join(dataDirectory, `.mcp-${randomUUID()}.tmp`)
    try {
      const encoded = JSON.stringify(value)
      if (Buffer.byteLength(encoded) > storageBytes) fail('MCP_LIMIT_EXCEEDED')
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
      await rename(temporary, path)
      const directory = await open(dataDirectory, constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    } catch { throw new ExternalMcpError('MCP_STORAGE_FAILED', 500) }
    finally { await rm(temporary, { force: true }).catch(() => {}) }
  }
  let state = await read(configFile, emptyState()), secrets = await read(credentialFile, { version: 1, items: {} })
  if (state.version !== 1 || !plain(state.connections) || !plain(state.removed) || !plain(state.requests) ||
    secrets.version !== 1 || !plain(secrets.items) || Object.keys(state.connections).length > 64) fail('MCP_STORAGE_FAILED', 500)
  for (const [id, record] of Object.entries(state.connections)) {
    record.config = validateMcpConfig(record.config)
    if (record.config.connectionId !== id || !Array.isArray(record.tools) || !Number.isSafeInteger(record.version) || typeof record.enabled !== 'boolean' ||
      !['configured', 'ready', 'needs_auth', 'disabled', 'error', 'missing_dependency'].includes(record.status)) fail('MCP_STORAGE_FAILED', 500)
    record.tools = mapMcpTools(id, record.tools.map(tool => ({ ...tool, name: tool.originalName })))
    record.revision = revisionOf(record)
  }
  const channels = new Map(), checks = new Map(), pendingControllers = new Map()
  let queue = Promise.resolve(), closed = false
  const serial = action => { const operation = queue.then(action); queue = operation.catch(() => {}); return operation }
  const get = id => { const record = typeof id === 'string' && Object.hasOwn(state.connections, id) ? state.connections[id] : null; if (!record) fail('MCP_CONNECTION_NOT_FOUND', 404); return record }
  const effectiveStatus = record => {
    if (!record.enabled) return 'disabled'
    if (record.config.credentialRequired && !secrets.items[record.config.credentialRef]) return 'needs_auth'
    if (record.status === 'ready') {
      const channel = channels.get(record.config.connectionId)
      if (!channel) return 'configured'
      if (channel.transport.closed) return 'error'
    }
    return record.status
  }
  const view = record => ({ ...projectMcpConfig(record.config), hasCredential: Boolean(secrets.items[record.config.credentialRef]),
    secretEnvKeys: [...(record.config.secretEnvKeys ?? [])], enabled: record.enabled, status: effectiveStatus(record), revision: record.revision, catalogRevision: catalogRevisionOf(record), sourceRevision: mcpSourceRevision(record.config),
    toolCount: record.tools.length, lastCheck: copy(record.lastCheck) })
  const receipt = record => ({ connectionId: record.config.connectionId, revision: record.revision, catalogRevision: catalogRevisionOf(record), sourceRevision: mcpSourceRevision(record.config), status: effectiveStatus(record) })
  const invalidate = async id => {
    for (const controller of pendingControllers.get(id) ?? []) controller.abort()
    pendingControllers.delete(id)
    const channel = channels.get(id); channels.delete(id); if (channel) { channel.controller.abort(); await channel.transport.close().catch(() => {}) } }
  function request(input, operation, allowed) {
    const value = boundedMcpJson(input, { maxBytes: MCP_LIMITS.configBytes * 5 })
    if (!plain(value) || !requestIdValid(value.requestId) || Object.keys(value).some(key => !allowed.includes(key))) fail('MCP_INVALID_CONFIG')
    const key = `request:${value.requestId}`, signature = hash([operation, value]), previous = state.requests[key]
    if (previous && previous.signature !== signature) fail('MCP_CONFIG_CONFLICT', 409)
    if (!previous && Object.keys(state.requests).length >= 4096) fail('MCP_LIMIT_EXCEEDED')
    return { value, key, signature, previous }
  }
  const compare = (record, expected) => { if (typeof expected !== 'string' || !expected || expected !== record.revision) fail('MCP_CONFIG_CONFLICT', 409) }
  async function commitRequest(next, req, operation, result) {
    next.requests[req.key] = { requestId: req.value.requestId, operation, signature: req.signature, state: 'succeeded', result: copy(result) }
    await write(configFile, next); state = next
    return { ...copy(result), replayed: false }
  }
  const replay = req => req.previous?.state === 'succeeded' ? { ...copy(req.previous.result), replayed: true } : null
  function checkCredential(record, credential) {
    const value = boundedMcpJson(credential, { maxBytes: MCP_LIMITS.configBytes * 5 })
    if (!plain(value) || Object.keys(value).some(key => !['bearerToken', 'env'].includes(key))) fail('MCP_INVALID_CREDENTIAL')
    if (record.config.transport === 'streamable-http') {
      if (Object.keys(value).length !== 1 || typeof value.bearerToken !== 'string' || !value.bearerToken || value.bearerToken.length > 8192 || /\s/.test(value.bearerToken) || hasControl(value.bearerToken)) fail('MCP_INVALID_CREDENTIAL')
    } else {
      if (Object.keys(value).length !== 1 || !plain(value.env) || Object.keys(value.env).sort().join('\0') !== [...record.config.secretEnvKeys].sort().join('\0') ||
        Object.values(value.env).some(item => typeof item !== 'string' || !item || item.length > 4096 || hasControl(item))) fail('MCP_INVALID_CREDENTIAL')
    }
    return value
  }
  async function configure(input) {
    return serial(async () => {
      const req = request(input, 'configure', ['requestId', 'expectedRevision', 'config']), prior = replay(req)
      if (prior) return prior
      if (closed) fail('MCP_CONNECTION_UNAVAILABLE', 409)
      const config = validateMcpConfig(req.value.config), id = config.connectionId, existing = state.connections[id]
      if (state.removed[id]) fail('MCP_CONFIG_CONFLICT', 409)
      if (existing) compare(existing, req.value.expectedRevision)
      else if (req.value.expectedRevision !== undefined || Object.keys(state.connections).length >= 64) fail('MCP_CONFIG_CONFLICT', 409)
      // Credential refs belong to this registration; JSON cannot bind another connection's secret.
      if (config.credentialRef && config.credentialRef !== existing?.config.credentialRef) fail('MCP_INVALID_CREDENTIAL')
      // One Google-sourced connection: the settings slot and the Google token have a single owner.
      if (config.credentialSource === 'google' && Object.values(state.connections).some(item => item.config.credentialSource === 'google' && item.config.connectionId !== id)) fail('MCP_GOOGLE_SOURCE_CONFLICT', 409)
      if (existing?.config.credentialRef) config.credentialRef = existing.config.credentialRef
      if (containsSecret(config, secretValues(secrets.items[config.credentialRef]))) fail('MCP_INVALID_CONFIG')
      await invalidate(id)
      const next = copy(state), record = { config, enabled: true, version: (existing?.version ?? 0) + 1, tools: [], status: config.credentialRequired && !secrets.items[config.credentialRef] ? 'needs_auth' : 'configured', lastCheck: null }
      record.revision = revisionOf(record); next.connections[id] = record
      return commitRequest(next, req, 'configure', receipt(record))
    })
  }
  async function saveCredential(input) {
    return serial(async () => {
      const req = request(input, 'credential', ['connectionId', 'requestId', 'expectedRevision', 'credential']), prior = replay(req)
      if (prior) return prior
      if (closed) fail('MCP_CONNECTION_UNAVAILABLE', 409)
      const record = get(req.value.connectionId); compare(record, req.value.expectedRevision)
      // The Google connection is the only credential of a Google-sourced connection.
      if (record.config.credentialSource) fail('MCP_INVALID_CREDENTIAL')
      const credential = checkCredential(record, req.value.credential), ref = record.config.credentialRef ?? `mcpcred_${randomUUID().replaceAll('-', '')}`
      if (!validMcpCredentialRef(ref) || containsSecret([record.config, record.tools], secretValues(credential))) fail('MCP_INVALID_CREDENTIAL')
      await invalidate(record.config.connectionId)
      const nextSecrets = copy(secrets); nextSecrets.items[ref] = credential
      await write(credentialFile, nextSecrets); secrets = nextSecrets
      const next = copy(state), changed = next.connections[record.config.connectionId]
      changed.config.credentialRef = ref; changed.version++; changed.status = 'configured'; changed.lastCheck = null; changed.revision = revisionOf(changed)
      return commitRequest(next, req, 'credential', { ...receipt(changed), saved: true })
    })
  }
  async function changeState(input, remove) {
    return serial(async () => {
      const operation = remove ? 'remove' : 'disable', req = request(input, operation, ['connectionId', 'requestId', 'expectedRevision']), prior = replay(req)
      if (prior) return prior
      if (closed) fail('MCP_CONNECTION_UNAVAILABLE', 409)
      const record = get(req.value.connectionId); compare(record, req.value.expectedRevision)
      await invalidate(record.config.connectionId)
      const next = copy(state), changed = next.connections[record.config.connectionId]
      changed.enabled = false; changed.status = 'disabled'; changed.version++; changed.revision = revisionOf(changed)
      const result = { ...receipt(changed), ...(remove ? { removed: true } : {}) }
      if (remove) { next.removed[record.config.connectionId] = { revision: changed.revision }; delete next.connections[record.config.connectionId] }
      const response = await commitRequest(next, req, operation, result)
      if (remove && record.config.credentialRef) {
        const nextSecrets = copy(secrets); delete nextSecrets.items[record.config.credentialRef]
        await write(credentialFile, nextSecrets); secrets = nextSecrets
      }
      return response
    })
  }
  async function check(connectionId, options = {}, operationKind = 'check') {
    const requestId = options.requestId ?? `check-${randomUUID()}`, signature = hash([operationKind, connectionId, options.expectedRevision ?? null])
    if (checks.has(requestId)) {
      const running = checks.get(requestId)
      if (running.signature !== signature) fail('MCP_CONFIG_CONFLICT', 409)
      return running.promise
    }
    const operation = (async () => {
      let snapshot, req
      const controller = new AbortController(), signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
      const previous = await serial(async () => {
        req = request({ connectionId, requestId, ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) }, operationKind, ['connectionId', 'requestId', 'expectedRevision'])
        const prior = replay(req)
        if (prior) return { ...prior, status: effectiveStatus(get(connectionId)) }
        const record = get(connectionId); compare(record, options.expectedRevision)
        if (!record.enabled || closed) fail('MCP_CONNECTION_UNAVAILABLE', 409)
        if (record.config.credentialRequired && !secrets.items[record.config.credentialRef]) fail('MCP_CREDENTIAL_UNAVAILABLE', 409)
        await invalidate(connectionId)
        snapshot = copy(record)
        const next = copy(state); next.connections[connectionId].status = 'configured'
        next.requests[req.key] = { requestId, operation: operationKind, signature: req.signature, state: 'pending' }
        await write(configFile, next); state = next
        pendingControllers.set(connectionId, new Set([controller]))
        return null
      })
      if (previous) return previous
      let transport, validators
      const credential = copy(secrets.items[snapshot.config.credentialRef] ?? {}), known = () => knownSecrets(snapshot.config, credential)
      const deadline = setTimeout(() => controller.abort(new ExternalMcpError('MCP_TIMEOUT', 504)), snapshot.config.timeoutMs)
      try {
        signal.throwIfAborted()
        const google = googleOptions(snapshot.config)
        transport = await transportFactory(snapshot.config, { credential, inheritedEnv, lookup, signal, ...(google ? { google } : {}) })
        const tools = [], cursors = new Set()
        let cursor
        for (let page = 0; page < MCP_LIMITS.maxPages; page++) {
          const result = boundedMcpJson(await transport.listTools(cursor ? { cursor } : {}, { signal }), { maxBytes: MCP_LIMITS.catalogBytes })
          if (containsSecret(result.tools, known())) fail('MCP_INVALID_TOOLS')
          if (!Array.isArray(result.tools) || result.tools.length > MCP_LIMITS.maxPageTools) fail('MCP_INVALID_TOOLS')
          tools.push(...result.tools)
          if (tools.length > MCP_LIMITS.maxTools) fail('MCP_LIMIT_EXCEEDED')
          if (!result.nextCursor) { cursor = null; break }
          if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) fail('MCP_INVALID_TOOLS')
          cursors.add(result.nextCursor); cursor = result.nextCursor
        }
        if (cursor) fail('MCP_LIMIT_EXCEEDED')
        const mapped = mapMcpTools(connectionId, tools), provider = new AjvJsonSchemaValidator()
        validators = new Map(mapped.map(tool => [tool.name, { input: provider.getValidator(tool.inputSchema), ...(tool.outputSchema ? { output: provider.getValidator(tool.outputSchema) } : {}) }]))
        return await serial(async () => {
          const current = state.connections[connectionId]
          if (!current || !current.enabled || current.version !== snapshot.version || closed || signal.aborted) fail('MCP_CONNECTION_UNAVAILABLE', 409)
          const next = copy(state), record = next.connections[connectionId]
          record.tools = mapped; record.status = 'ready'; record.lastCheck = { status: 'ready', checkedAt: new Date().toISOString(), ...(transport.diagnostics ? { diagnostics: transport.diagnostics() } : {}) }; record.revision = revisionOf(record)
          pendingControllers.get(connectionId)?.delete(controller)
          channels.set(connectionId, { transport, controller, validators, version: record.version })
          try { return await commitRequest(next, req, operationKind, { ...receipt(record), toolCount: mapped.length, lastCheck: record.lastCheck }) }
          catch (error) { channels.delete(connectionId); throw error }
        })
      } catch (error) {
        pendingControllers.get(connectionId)?.delete(controller)
        const wasAborted = signal.aborted, timedOut = controller.signal.reason?.code === 'MCP_TIMEOUT'
        controller.abort(); await transport?.close().catch(() => {})
        const safe = error instanceof ExternalMcpError ? error : new ExternalMcpError(error?.name === 'UnauthorizedError' || error?.code === 401 ? 'MCP_AUTH_REQUIRED' : timedOut ? 'MCP_TIMEOUT' : wasAborted ? 'MCP_CANCELLED' : error?.code === -32001 ? 'MCP_TIMEOUT' : 'MCP_CONNECTION_FAILED', 409)
        await serial(async () => {
          const current = state.connections[connectionId], next = copy(state)
          if (current && current.version === snapshot.version && current.enabled) {
            next.connections[connectionId].status = safe.code === 'MCP_AUTH_REQUIRED' ? 'needs_auth' : safe.code === 'MCP_MISSING_DEPENDENCY' ? 'missing_dependency' : 'error'
            next.connections[connectionId].lastCheck = { status: next.connections[connectionId].status, checkedAt: new Date().toISOString(), error: publicMcpError(safe) }
          }
          if (next.requests[req.key]?.state !== 'succeeded') next.requests[req.key] = { requestId, operation: operationKind, signature: req.signature, state: 'failed', error: publicMcpError(safe) }
          await write(configFile, next); state = next
        })
        throw safe
      } finally { clearTimeout(deadline) }
    })()
    checks.set(requestId, { signature, promise: operation })
    try { return await operation } finally { if (checks.get(requestId)?.promise === operation) checks.delete(requestId) }
  }
  async function invoke({ connectionId, toolName, arguments: args, signal, authorize } = {}) {
    if (typeof authorize !== 'function') fail('MCP_NOT_AUTHORIZED', 403)
    const record = get(connectionId), entry = channels.get(connectionId)
    if (closed || effectiveStatus(record) !== 'ready' || !entry || entry.version !== record.version) fail('MCP_CONNECTION_UNAVAILABLE', 409)
    const tool = record.tools.find(tool => tool.name === toolName), validator = entry.validators.get(toolName)
    if (!tool || !validator) fail('MCP_INVALID_TOOLS')
    const input = boundedMcpJson(args ?? {}, { maxBytes: MCP_LIMITS.resultBytes })
    if (!validator.input(input).valid) fail('MCP_INVALID_ARGUMENTS')
    if (await authorize({ connectionId, toolName, originalName: tool.originalName }) !== true) fail('MCP_NOT_AUTHORIZED', 403)
    if (get(connectionId).version !== record.version || !record.enabled || channels.get(connectionId) !== entry || closed) fail('MCP_CONNECTION_UNAVAILABLE', 409)
    if (signal?.aborted) fail('MCP_CANCELLED', 409)
    try {
      const result = boundedMcpJson(await entry.transport.callTool({ name: tool.originalName, arguments: input }, { signal }), { maxBytes: MCP_LIMITS.resultBytes })
      if (validator.output && !result.isError && (!result.structuredContent || !validator.output(result.structuredContent).valid)) fail('MCP_INVALID_RESULT')
      // Known secrets are read after the call: a Google token is only fetched while the request is sent.
      return boundedMcpJson(redactResult(result, knownSecrets(record.config, secrets.items[record.config.credentialRef])), { maxBytes: MCP_LIMITS.resultBytes })
    } catch (error) {
      // Definite: the request never reached a tool (no Google token, or a pre-dispatch 401 twice).
      if (error instanceof ExternalMcpError && error.notSent === true) throw error
      const unknown = new ExternalMcpError('MCP_INVOCATION_UNKNOWN', 409)
      unknown.unknown = true; unknown.retryable = false; unknown.causeCode = error?.code === -32001 ? 'MCP_TIMEOUT' : signal?.aborted || entry.controller.signal.aborted ? 'MCP_CANCELLED' : publicMcpError(error).code
      throw unknown
    }
  }
  return {
    configure, saveCredential, check: (id, options) => check(id, options), reconnect: (id, options) => check(id, options, 'reconnect'), invoke,
    disable: input => changeState(input, false), remove: input => changeState(input, true),
    connections: async () => Object.values(state.connections).map(view),
    catalog: async () => Object.values(state.connections).map(record => ({ id: `mcp:${record.config.connectionId}`, kind: 'mcp', name: record.config.name,
      description: record.config.description, status: effectiveStatus(record), revision: catalogRevisionOf(record), version: `config-${record.version}`,
      toolNames: record.tools.map(tool => tool.name), requirements: effectiveStatus(record) === 'needs_auth' ? ['credential'] : [], lastCheck: copy(record.lastCheck) })),
    toolCatalog: async ({ connectionId } = {}) => Object.values(state.connections).filter(record => (!connectionId || record.config.connectionId === connectionId) && effectiveStatus(record) === 'ready')
      .flatMap(record => record.tools.map(tool => ({ ...copy(tool), catalogRevision: catalogRevisionOf(record), writeMode: 'ask' }))),
    /**
     * Settings slot (R3-05): is workspace-mcp running at the configured address, and what is the
     * Google-sourced connection's live state. Read-only: never sends a token, never changes a record.
     */
    async googleWorkspaceStatus() {
      const runtime = workspaceEndpoint.invalid ? { state: 'invalid_config', version: null } : await probeWorkspaceMcp(workspaceEndpoint.url, { lookup })
      const record = Object.values(state.connections).find(item => item.config.credentialSource === 'google')
      return { runtime: { state: runtime.state, version: runtime.version, expectedVersion: WORKSPACE_MCP_VERSION, customAddress: workspaceEndpoint.custom },
        googleTokenSource: Boolean(googleAccessToken),
        connection: record ? { connectionId: record.config.connectionId, name: record.config.name, revision: record.revision, enabled: record.enabled,
          status: effectiveStatus(record), toolCount: record.tools.length, googleServices: [...record.config.googleServices],
          lastCheck: record.lastCheck ? { status: record.lastCheck.status, checkedAt: record.lastCheck.checkedAt, ...(record.lastCheck.error?.code ? { error: { code: record.lastCheck.error.code } } : {}) } : null } : null }
    },
    requestStatus: async requestId => {
      if (!requestIdValid(requestId)) fail('MCP_INVALID_CONFIG')
      const record = state.requests[`request:${requestId}`]
      return record ? copy(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'signature'))) : null
    },
    async close() { closed = true; await Promise.all([...new Set([...channels.keys(), ...pendingControllers.keys()])].map(invalidate)); await Promise.allSettled([...checks.values()].map(check => check.promise)); await queue },
  }
}

export { validateMcpConfig, projectMcpConfig, mapMcpTools, publicMcpError, mcpSourceRevision } from './external-mcp-config.mjs'
export { createExternalMcpTransport, externalMcpTransportStatus } from './external-mcp-transport.mjs'
export { googleWorkspaceMcpTemplate, resolveWorkspaceMcpEndpoint, WORKSPACE_MCP_URL_ENV, WORKSPACE_MCP_DEFAULT_URL } from './external-mcp-google.mjs'
