#!/usr/bin/env node
// Stateless local stdio relay. Deliberately imports no storage, Task or env loader.
import { pathToFileURL } from 'node:url'
import { MCP_MAX_BYTES } from './workspace-mcp-protocol.mjs'
export function relayTarget(value) {
  let url
  try { url = new URL(value) } catch { throw Error('Invalid loopback target') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/', '/api/workspace/mcp-dispatch'].includes(url.pathname)) throw Error('Invalid loopback target')
  url.pathname = '/api/workspace/mcp-dispatch'
  return url.href
}
export async function runStdio({ input = process.stdin, output = process.stdout, diagnostics = process.stderr, env = process.env, fetchImpl = fetch } = {}) {
  const target = relayTarget(env.PIDOT_MCP_URL ?? 'http://127.0.0.1:8787')
  const token = env.PIDOT_MCP_TOKEN
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw Error('Restricted client credential required')
  let buffer = Buffer.alloc(0), sessionId, closed = false
  const inFlight = new Set()
  const send = message => { if (message && !closed) output.write(`${JSON.stringify(message)}\n`) }
  const dispatch = async message => {
    try {
      const response = await fetchImpl(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35000), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(sessionId ? { 'x-pidot-mcp-session': sessionId } : {}) }, body: JSON.stringify({ message }) })
      if (!response.ok) throw Error('Relay denied')
      const data = await response.json()
      if (data.sessionId) sessionId = data.sessionId
      send(data.message)
    } catch {
      // No credential, raw body, external text, arguments or arbitrary exception logs.
      diagnostics.write('pidot MCP relay: request unavailable; query durable status before retrying changes\n')
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Local relay unavailable or authorization denied' } })
    }
  }
  try {
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      let end
      while ((end = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1)
        if (line.length > MCP_MAX_BYTES) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } }); return }
        let message
        try { message = JSON.parse(line.toString('utf8')) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue }
        // Lifecycle is serialized; operational calls may overlap to admit cancellation.
        if (!sessionId || message.method === 'notifications/initialized') await dispatch(message)
        else { const work = dispatch(message).finally(() => inFlight.delete(work)); inFlight.add(work); if (inFlight.size >= 16) await Promise.race(inFlight) }
      }
      if (buffer.length > MCP_MAX_BYTES) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } }); return }
    }
    if (buffer.length) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Incomplete message' } })
    await Promise.allSettled(inFlight)
  } finally {
    closed = true
    if (sessionId) try { await fetchImpl(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-pidot-mcp-session': sessionId }, body: JSON.stringify({ close: true }) }) } catch { /* no retry or credentials in logs */ }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runStdio().catch(() => { process.stderr.write('pidot MCP relay: invalid configuration or closed transport\n'); process.exitCode = 1 })
