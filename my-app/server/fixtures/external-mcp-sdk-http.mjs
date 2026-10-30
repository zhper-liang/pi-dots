import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createFixtureMcpServer } from './external-mcp-sdk-server.mjs'

export async function createFixtureMcpHttp(options = {}) {
  const sessions = new Map(), calls = [], addresses = []
  const server = createServer(async (request, response) => {
    addresses.push(request.socket.remoteAddress)
    if (options.bearerToken && request.headers.authorization !== `Bearer ${options.bearerToken}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'fixture authentication required' })); return
    }
    try {
      let entry = sessions.get(request.headers['mcp-session-id'])
      if (!entry) {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
          onsessioninitialized: id => { sessions.set(id, entry) } })
        const mcp = createFixtureMcpServer({ ...options, onCall: async (name, args) => { calls.push({ name, args }); await options.onCall?.(name, args) } })
        entry = { transport, mcp }
        await mcp.connect(transport)
      }
      await entry.transport.handleRequest(request, response)
    } catch { if (!response.headersSent) response.writeHead(500); response.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls, addresses,
    async close() { await Promise.all([...sessions.values()].map(entry => entry.mcp.close())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
