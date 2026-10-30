import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export function createFixtureMcpServer({ onCall = () => {}, wait = async () => {}, beforeList = async () => {}, environment = {}, transformResult = value => value } = {}) {
  const server = new Server({ name: 'pidot-sdk-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    await beforeList(request.params?.cursor)
    return request.params?.cursor === 'page-two'
    ? { tools: [{ name: 'records.write', description: 'Benign fixture write', inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false } }] }
    : { tools: [{ name: 'greeting.echo', description: 'Echo a fixture string', inputSchema: schema,
      outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'], additionalProperties: false } },
    { name: 'fixture.environment', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], nextCursor: 'page-two' }
  })
  server.setRequestHandler(CallToolRequestSchema, async request => {
    await onCall(request.params.name, request.params.arguments)
    if (request.params.name === 'records.write') await wait()
    if (request.params.name === 'fixture.environment') return { content: [{ type: 'text', text: JSON.stringify(environment) }] }
    const echoed = request.params.arguments.text
    return transformResult({ content: [{ type: 'text', text: echoed }], structuredContent: { echoed } })
  })
  return server
}
