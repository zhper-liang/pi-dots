import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createFixtureMcpServer } from './external-mcp-sdk-server.mjs'

if (process.argv[2] === 'exit') process.exit(0)

// CLI fixture only: protocol stdout belongs solely to the official SDK transport.
const server = createFixtureMcpServer({ environment: { hasHome: Boolean(process.env.HOME), hasPath: Boolean(process.env.PATH),
  hasUnselected: Boolean(process.env.PIDOT_FIXTURE_UNSELECTED), hasFixtureSecret: Boolean(process.env.MCP_FIXTURE_TOKEN), language: process.env.LANG ?? null } })
process.stderr.write('isolated fixture diagnostic; content must remain private\n')
await server.connect(new StdioServerTransport())
