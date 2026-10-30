import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMcpConfig, projectMcpConfig, mapMcpTools, mcpToolAlias, buildMcpStdioEnvironment } from './external-mcp-config.mjs'
import { externalMcpCatalog, externalMcpTransportStatus } from './external-mcp.mjs'

const http = { connectionId: 'fixture-http', name: 'Fixture', transport: 'streamable-http', url: 'https://mcp.vendor.com/mcp' }
const stdio = { connectionId: 'fixture-stdio', name: 'Local fixture', transport: 'stdio', executable: '/opt/mcp/bin/server', args: ['--mode', 'local'] }
const tool = name => ({ name, description: 'Untrusted provider data', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } })

test('HTTP normalization is configuration-only; no secrets or DNS access', () => {
  const view = validateMcpConfig(http)
  assert.equal(view.url, http.url)
  assert.equal(view.timeoutMs, 30000)
  assert.equal(view.allowLoopback, false)
  assert.equal(view.credentialRequired, false)
  assert.deepEqual(projectMcpConfig(view), { connectionId: http.connectionId, name: 'Fixture', description: '', transport: 'streamable-http', hasCredential: false, credentialRequired: false })
})
test('stdio accepts only absolute installed executable configuration, including Windows form', () => {
  assert.deepEqual(validateMcpConfig(stdio).args, ['--mode', 'local'])
  assert.equal(validateMcpConfig({ ...stdio, executable: 'C:\\Mcp\\server.exe' }).executable, 'C:\\Mcp\\server.exe')
  assert.deepEqual(validateMcpConfig({ connectionId: 'local', name: 'Local', transport: 'stdio', executable: '/opt/mcp/bin/server' }).args, [])
})
test('stdio environment contains only explicitly selected benign keys and scoped secret bindings', () => {
  const config = { ...stdio, envKeys: ['LANG'], secretEnvKeys: ['MCP_API_TOKEN'] }
  const env = buildMcpStdioEnvironment(config, { LANG: 'C.UTF-8', HOME: '/private', NODE_OPTIONS: '--require=evil', AWS_SECRET: 'not-inherited' }, { MCP_API_TOKEN: 'fixture-secret' })
  assert.deepEqual({ ...env }, { LANG: 'C.UTF-8', MCP_API_TOKEN: 'fixture-secret' })
  assert.equal(Object.getPrototypeOf(env), null)
})
test('tool aliases are deterministic, provider-compatible, exact and connection-scoped', () => {
  const names = ['calendar/read', 'calendar.read', 'calendar_read', '工具:读取', 'READ', 'read']
  const mapped = mapMcpTools('one', names.map(tool))
  assert.equal(new Set(mapped.map(t => t.name)).size, names.length)
  for (const item of mapped) {
    assert.match(item.name, /^mcp_[a-f0-9]{56}$/)
    assert.ok(item.name.length <= 64)
    assert.equal(item.name, mcpToolAlias('one', item.originalName))
    assert.notEqual(item.name, mcpToolAlias('two', item.originalName))
    assert.equal(item.connectionId, 'one')
  }
  assert.deepEqual(mapMcpTools('one', [...names].reverse().map(tool)).map(t => t.name).reverse(), mapped.map(t => t.name))
})
test('mapping preserves complete bounded input schema, not annotations-based permission', () => {
  const original = { ...tool('write'), annotations: { readOnlyHint: true, destructiveHint: false }, extra: 'ignored' }
  const [mapped] = mapMcpTools('one', [original])
  assert.deepEqual(mapped.inputSchema, original.inputSchema)
  assert.equal(Object.hasOwn(mapped, 'annotations'), false)
  assert.equal(Object.hasOwn(mapped, 'enabled'), false)
  original.inputSchema.properties.query.type = 'number'
  assert.equal(mapped.inputSchema.properties.query.type, 'string')
})
test('catalog matches R1-08 projection shape without claiming discovered tools or ready', () => {
  const [catalog] = externalMcpCatalog([http])
  assert.equal(catalog.id, `mcp:${http.connectionId}`)
  assert.equal(catalog.kind, 'mcp')
  assert.equal(catalog.name, 'Fixture')
  assert.equal(catalog.revision.length, 64)
  assert.deepEqual(catalog.toolNames, [])
  assert.equal(catalog.lastCheck, null)
  assert.equal(catalog.status, externalMcpTransportStatus().status)
  assert.notEqual(catalog.status, 'ready')
  assert.deepEqual(externalMcpCatalog([http]), externalMcpCatalog([http]))
  assert.notEqual(catalog.revision, externalMcpCatalog([{ ...http, timeoutMs: 1000 }])[0].revision)
})
test('missing credential takes needs_auth precedence and cannot be promoted by a supplied ref', () => {
  assert.equal(externalMcpCatalog([{ ...http, credentialRequired: true }])[0].status, 'needs_auth')
  const [catalog] = externalMcpCatalog([{ ...http, credentialRequired: true, credentialRef: `mcpcred_${'a'.repeat(32)}` }])
  assert.notEqual(catalog.status, 'ready')
  assert.equal(JSON.stringify(catalog).includes('mcpcred_'), false)
})
test('SDK transport availability remains separate from a verified external connection', () => {
  const state = externalMcpTransportStatus()
  assert.equal(state.verified, false)
  assert.equal(state.status, 'configured')
  assert.deepEqual(state.requirements, [])
})
