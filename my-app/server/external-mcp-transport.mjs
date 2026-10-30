import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isIP } from 'node:net'
import { Readable, Transform } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ExternalMcpError, MCP_LIMITS, validateMcpConfig, validateMcpResolvedAddresses, buildMcpStdioEnvironment } from './external-mcp-config.mjs'

export const EXTERNAL_MCP_SDK = Object.freeze({ package: '@modelcontextprotocol/sdk', version: '1.32.2', zod: '4.6.7' })
export function externalMcpTransportStatus() {
  return { status: 'configured', requirements: [], verified: false }
}

async function resolveBounded(host, lookup, signal, timeoutMs) {
  if (signal.aborted) throw new ExternalMcpError('MCP_CANCELLED', 409)
  let timer, abort
  const interrupted = new Promise((_resolve, reject) => {
    abort = () => reject(new ExternalMcpError('MCP_CANCELLED', 409))
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => reject(new ExternalMcpError('MCP_TIMEOUT', 504)), timeoutMs)
  })
  try { return await Promise.race([Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })), interrupted]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

// The SDK owns MCP framing. This fetch adapter owns only HTTP connection policy:
// every DNS answer is checked and the actual socket uses those same checked answers.
export function createMcpFetch(input, { lookup = dnsLookup } = {}) {
  const config = validateMcpConfig(input), endpoint = new URL(config.url)
  return async (input, init = {}) => {
    const request = new Request(input, init), target = new URL(request.url)
    if (target.href !== endpoint.href || !['GET', 'POST', 'DELETE'].includes(request.method)) throw new ExternalMcpError('MCP_UNSAFE_ENDPOINT')
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveBounded(host, lookup, request.signal, config.timeoutMs)
    if (request.signal.aborted) throw new ExternalMcpError('MCP_CANCELLED', 409)
    const pinned = validateMcpResolvedAddresses(config, answers)
    const bytes = request.body ? Buffer.from(await request.arrayBuffer()) : null
    if (bytes && bytes.length > MCP_LIMITS.resultBytes) throw new ExternalMcpError('MCP_LIMIT_EXCEEDED')
    return new Promise((resolve, reject) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest
      let response
      const abort = () => { const error = new ExternalMcpError('MCP_CANCELLED', 409); response?.destroy(error); socketRequest.destroy(error) }
      const socketRequest = send(target, {
        method: request.method, headers: Object.fromEntries(request.headers), agent: false, autoSelectFamily: false,
        lookup: (_hostname, options, callback) => {
          const records = pinned.map(address => ({ address, family: isIP(address) }))
          if (options.all) callback(null, records)
          else callback(null, records[0].address, records[0].family)
        },
      }, incoming => {
        response = incoming
        if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
          incoming.resume(); reject(new ExternalMcpError('MCP_REDIRECT_BLOCKED', 409)); return
        }
        let received = 0
        const bounded = new Transform({ transform(chunk, _encoding, callback) {
          received += chunk.length
          callback(received > MCP_LIMITS.catalogBytes * 2 ? new ExternalMcpError('MCP_LIMIT_EXCEEDED') : null, chunk)
        } })
        incoming.on('error', error => bounded.destroy(error))
        bounded.on('error', () => incoming.destroy())
        incoming.pipe(bounded)
        const headers = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
        const body = [204, 205, 304].includes(incoming.statusCode) ? null : Readable.toWeb(bounded)
        if (!body) bounded.resume()
        resolve(new Response(body, { status: incoming.statusCode, headers }))
      })
      socketRequest.on('error', reject)
      socketRequest.on('close', () => request.signal.removeEventListener('abort', abort))
      socketRequest.setTimeout(config.timeoutMs, () => socketRequest.destroy(new ExternalMcpError('MCP_TIMEOUT', 504)))
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) { abort(); return }
      if (bytes) socketRequest.write(bytes)
      socketRequest.end()
    })
  }
}

export async function createExternalMcpTransport(input, { credential = {}, inheritedEnv = process.env, lookup, signal } = {}) {
  const config = validateMcpConfig(input), controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let transport, stderrBytes = 0, closed = false
  if (config.transport === 'stdio') {
    let executable
    try {
      executable = await realpath(config.executable)
      validateMcpConfig({ ...config, executable })
      if (!(await stat(executable)).isFile()) throw new Error('not a file')
      await access(executable, constants.X_OK)
    } catch { throw new ExternalMcpError('MCP_MISSING_DEPENDENCY', 409) }
    const inherited = {}
    for (const key of config.envKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(inheritedEnv, key)
      if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new ExternalMcpError('MCP_UNSAFE_ENV')
      if (descriptor?.value !== undefined) inherited[key] = descriptor.value
    }
    const selected = buildMcpStdioEnvironment(config, inherited, credential.env ?? {})
    // SDK merges getDefaultEnvironment() into env. Explicit undefined values ensure
    // Node omits every unselected SDK default instead of inheriting HOME/PATH/etc.
    const env = { ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, undefined])), ...selected }
    transport = new StdioClientTransport({ command: executable, args: config.args, env, stderr: 'pipe', maxBufferSize: MCP_LIMITS.catalogBytes * 2 })
    transport.stderr?.on('data', chunk => { stderrBytes = Math.min(MCP_LIMITS.stderrBytes + 1, stderrBytes + chunk.length) })
  } else {
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      fetch: createMcpFetch(config, { lookup }), redirectPolicy: 'same-origin',
      requestInit: { redirect: 'error', ...(credential.bearerToken ? { headers: { Authorization: `Bearer ${credential.bearerToken}` } } : {}) },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    })
  }
  const client = new Client({ name: 'pidot-external-mcp', version: '1.0.0' }, { capabilities: {} })
  client.onclose = () => { closed = true }
  const options = extra => ({ timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs, resetTimeoutOnProgress: false,
    signal: extra?.signal ? AbortSignal.any([combined, extra.signal]) : combined })
  try { await client.connect(transport, options()) }
  catch (error) { controller.abort(); await client.close().catch(() => {}); throw error }
  return {
    listTools: (params, extra) => client.listTools(params, options(extra)),
    callTool: (params, extra) => client.callTool(params, undefined, options(extra)),
    diagnostics: () => ({ stderrReceived: stderrBytes > 0, stderrTruncated: stderrBytes > MCP_LIMITS.stderrBytes }),
    get closed() { return closed },
    async close() { if (closed) return; closed = true; controller.abort(); await client.close() },
  }
}
