import test from 'node:test'
import assert from 'node:assert/strict'
import { MCP_LIMITS, boundedMcpJson, classifyMcpAddress, validateMcpResolvedAddresses, validateMcpConfig,
  projectMcpConfig, buildMcpStdioEnvironment, mapMcpTools, mcpToolAlias, publicMcpError } from './external-mcp-config.mjs'
import { externalMcpCatalog } from './external-mcp.mjs'

const http = { connectionId: 'security', name: 'Fixture', transport: 'streamable-http', url: 'https://mcp.vendor.com/mcp' }
const stdio = { connectionId: 'security', name: 'Fixture', transport: 'stdio', executable: '/opt/mcp/server' }
const tool = name => ({ name, inputSchema: { type: 'object', properties: {} } })
const reject = (fn, code) => assert.throws(fn, error => error.code === code)

test('HTTP rejects userinfo, query secrets, fragments, redirects-as-config and non-HTTPS public endpoints', () => {
  for (const url of ['http://mcp.vendor.com', 'ftp://mcp.vendor.com', 'https://user:secret@mcp.vendor.com', 'https://mcp.vendor.com?token=fixture',
    'https://mcp.vendor.com#fixture', 'https://mcp.vendor.com\\@127.0.0.1/', ' https://mcp.vendor.com', 'https://metadata.internal', 'https://single-label']) {
    reject(() => validateMcpConfig({ ...http, url }), 'MCP_UNSAFE_ENDPOINT')
  }
  reject(() => validateMcpConfig({ ...http, redirects: true }), 'MCP_INVALID_CONFIG')
})
test('loopback requires an explicit loopback-only configuration, not a general private-network bypass', () => {
  for (const url of ['http://127.0.0.1:7300/mcp', 'http://localhost:7300/mcp', 'http://[::1]:7300/mcp']) {
    reject(() => validateMcpConfig({ ...http, url }), 'MCP_UNSAFE_ENDPOINT')
    assert.equal(validateMcpConfig({ ...http, url, allowLoopback: true }).allowLoopback, true)
  }
  for (const url of ['https://10.0.0.1', 'https://192.168.1.2', 'https://169.254.169.254', 'https://[fc00::1]', 'https://mcp.vendor.com']) {
    reject(() => validateMcpConfig({ ...http, url, allowLoopback: true }), 'MCP_UNSAFE_ENDPOINT')
  }
  reject(() => validateMcpConfig({ ...http, url: 'http://2130706433' }), 'MCP_UNSAFE_ENDPOINT')
})
test('public address classification blocks reserved, private, mapped and transition destinations', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '198.18.0.1',
    '192.0.2.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::ffff:127.0.0.1', '64:ff9b::808:808', 'fc00::1',
    'fe80::1', 'ff02::1', '2001:db8::1', '2001::1', '2001:20::1', '2002:0808:0808::1', '3fff::1', 'not-an-address']) {
    assert.equal(classifyMcpAddress(address), 'blocked', address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(classifyMcpAddress(address), 'public', address)
  for (const address of ['127.42.1.2', '::1']) assert.equal(classifyMcpAddress(address), 'loopback')
})
test('DNS guard validates every answer, rejects mixed/rebound destinations and requires socket pinning downstream', () => {
  const config = validateMcpConfig(http)
  assert.deepEqual(validateMcpResolvedAddresses(config, ['8.8.8.8', { address: '1.1.1.1' }]), ['8.8.8.8', '1.1.1.1'])
  for (const answers of [[], ['8.8.8.8', '127.0.0.1'], ['10.0.0.1'], Array(17).fill('8.8.8.8')]) reject(() => validateMcpResolvedAddresses(config, answers), 'MCP_UNSAFE_ENDPOINT')
  const local = validateMcpConfig({ ...http, url: 'http://localhost/mcp', allowLoopback: true })
  assert.deepEqual(validateMcpResolvedAddresses(local, ['127.0.0.1', '::1']), ['127.0.0.1', '::1'])
  reject(() => validateMcpResolvedAddresses(local, ['8.8.8.8']), 'MCP_UNSAFE_ENDPOINT')
  const literal = validateMcpConfig({ ...http, url: 'https://8.8.8.8/mcp' })
  reject(() => validateMcpResolvedAddresses(literal, ['1.1.1.1']), 'MCP_UNSAFE_ENDPOINT')
})
test('stdio rejects relative paths, installers, shells, network paths and inline eval', () => {
  for (const executable of ['node', './server', '/bin/sh', '/bin/bash', '/usr/bin/env', '/bin/busybox', '/usr/bin/npx', '/usr/bin/uvx',
    '/usr/bin/pip3', '/tmp/install.sh', 'C:\\Windows\\cmd.exe', 'C:\\install.cmd', '\\\\host\\server.exe', '//host/server']) {
    reject(() => validateMcpConfig({ ...stdio, executable }), 'MCP_UNSAFE_EXECUTABLE')
  }
  for (const args of [['-e', 'code'], ['-eevil'], ['--eval=code'], ['-c', 'cmd'], ['--token=fixture'], ['Bearer fixture']]) {
    reject(() => validateMcpConfig({ ...stdio, args }), 'MCP_INVALID_CONFIG')
  }
})
test('raw secrets, approval flags, headers, env overrides, and resource override fields are rejected', () => {
  for (const patch of [{ token: 'fixture' }, { apiKey: 'fixture' }, { approved: true }, { headers: { Authorization: 'fixture' } }, { env: { TOKEN: 'fixture' } },
    { shell: true }, { cwd: '/private' }, { maxPages: 999 }, { credentialRef: '/tmp/secret' }]) {
    reject(() => validateMcpConfig({ ...http, ...patch }), 'MCP_INVALID_CONFIG')
  }
})
test('environment cannot inherit process-wide secrets or loader/proxy/command settings', () => {
  for (const key of ['PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'BASH_ENV', 'COMSPEC', 'GIT_SSH_COMMAND', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    reject(() => validateMcpConfig({ ...stdio, secretEnvKeys: [key] }), 'MCP_UNSAFE_ENV')
    reject(() => validateMcpConfig({ ...stdio, envKeys: [key] }), 'MCP_UNSAFE_ENV')
  }
  reject(() => buildMcpStdioEnvironment({ ...stdio, secretEnvKeys: ['TOKEN'] }, {}, { OTHER_TOKEN: 'fixture' }), 'MCP_UNSAFE_ENV')
  let getterRuns = 0
  const inherited = Object.defineProperty({}, 'LANG', { get() { getterRuns++; return 'bad' } })
  reject(() => buildMcpStdioEnvironment({ ...stdio, envKeys: ['LANG'] }, inherited), 'MCP_UNSAFE_ENV')
  assert.equal(getterRuns, 0)
})
test('bounded JSON rejects cycles, prototype pollution, getters, sparse arrays, unsupported values and depth/size bombs', () => {
  const cycle = {}; cycle.self = cycle
  let getterRuns = 0
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { getterRuns++; return 'fixture' } })
  for (const input of [cycle, getter, new Date(), new Array(3), { x: undefined }, { x: () => {} }, { x: Infinity }, { x: 1n },
    JSON.parse('{"__proto__":{"polluted":true}}'), JSON.parse('{"constructor":{}}')]) reject(() => boundedMcpJson(input), 'MCP_INVALID_JSON')
  assert.equal(getterRuns, 0)
  let deep = {}; for (let n = 0; n < 20; n++) deep = { nested: deep }
  reject(() => boundedMcpJson(deep), 'MCP_LIMIT_EXCEEDED')
  reject(() => boundedMcpJson('a'.repeat(MCP_LIMITS.resultBytes + 1)), 'MCP_LIMIT_EXCEEDED')
  reject(() => boundedMcpJson({ x: Array(9000).fill(0) }), 'MCP_LIMIT_EXCEEDED')
  assert.equal({}.polluted, undefined)
})
test('tool collision, duplicate source names, schema size/depth, tool count and malformed schema fail closed', () => {
  reject(() => mapMcpTools('one', [tool('same'), tool('same')]), 'MCP_INVALID_TOOLS')
  reject(() => mapMcpTools('one', [tool('same')], { reservedNames: [mcpToolAlias('one', 'same')] }), 'MCP_INVALID_TOOLS')
  reject(() => mapMcpTools('one', Array.from({ length: 129 }, (_, i) => tool(`tool${i}`))), 'MCP_INVALID_TOOLS')
  reject(() => mapMcpTools('one', [{ name: 'bad', inputSchema: { type: 'array' } }]), 'MCP_INVALID_TOOLS')
  reject(() => mapMcpTools('one', [{ ...tool('big'), inputSchema: { type: 'object', description: 'x'.repeat(33000) } }]), 'MCP_LIMIT_EXCEEDED')
  reject(() => mapMcpTools('one', [tool('bad\nname')]), 'MCP_INVALID_TOOLS')
})
test('public errors and projections never echo raw exception payload, argv, endpoint or credential ref', () => {
  const secret = 'fixture-canary-not-real'
  const error = Object.assign(new Error(secret), { code: 'TOKEN_LEAK', stack: secret, cause: { token: secret } })
  assert.equal(JSON.stringify(publicMcpError(error)).includes(secret), false)
  assert.equal(JSON.stringify(publicMcpError({ code: 'MCP_UNSAFE_ENDPOINT', message: secret })).includes(secret), false)
  const config = { ...stdio, args: [secret], credentialRef: `mcpcred_${'a'.repeat(32)}` }
  const view = JSON.stringify(projectMcpConfig(config)), catalog = JSON.stringify(externalMcpCatalog([config]))
  for (const output of [view, catalog]) { assert.equal(output.includes(secret), false); assert.equal(output.includes('mcpcred_'), false); assert.equal(output.includes('/opt/mcp'), false) }
  assert.throws(() => externalMcpCatalog([http, http]))
})
