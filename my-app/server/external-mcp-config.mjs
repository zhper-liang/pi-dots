import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { posix, win32 } from 'node:path'

// These are resource ceilings, not protocol support or authorization decisions.
export const MCP_LIMITS = Object.freeze({ configBytes: 16384, schemaBytes: 32768, catalogBytes: 524288,
  resultBytes: 262144, maxDepth: 16, maxNodes: 8192, maxTools: 128, maxPages: 8,
  maxPageTools: 64, stderrBytes: 4096, timeoutMs: 30000, maxTimeoutMs: 60000 })
export const MCP_ENV_ALLOWLIST = Object.freeze(['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR'])
const codes = Object.freeze({
  MCP_INVALID_CONFIG: 'MCP 配置字段无效。', MCP_UNSAFE_ENDPOINT: 'MCP 端点不在允许的网络边界内。',
  MCP_UNSAFE_EXECUTABLE: '只接受用户信任的已安装绝对可执行路径；不运行 shell 或安装器。',
  MCP_UNSAFE_ENV: 'MCP 环境变量不在显式允许范围内。', MCP_INVALID_JSON: 'MCP 数据必须是有界的普通 JSON。',
  MCP_LIMIT_EXCEEDED: 'MCP 数据超出大小、数量或深度上限。', MCP_INVALID_TOOLS: 'MCP 工具目录无效或存在名称冲突。',
  MCP_MISSING_DEPENDENCY: 'MCP SDK 尚不可用；连接未验证。', MCP_TRANSPORT_PENDING: 'MCP transport 尚未接入或验证。',
  MCP_INVALID_CREDENTIAL: 'MCP 凭据输入或引用无效。', MCP_CREDENTIAL_UNAVAILABLE: 'MCP 凭据尚未安全保存或不可读取。',
  MCP_CONNECTION_NOT_FOUND: 'MCP 连接不存在。', MCP_CONNECTION_UNAVAILABLE: 'MCP 连接未就绪或已禁用，请显式检查连接。',
  MCP_CONNECTION_FAILED: 'MCP 握手或工具发现失败。', MCP_AUTH_REQUIRED: 'MCP 连接需要凭据或重新授权。',
  MCP_TIMEOUT: 'MCP 操作超时。', MCP_CANCELLED: 'MCP 操作已取消。', MCP_REDIRECT_BLOCKED: 'MCP 请求不跟随跳转。',
  MCP_INVALID_ARGUMENTS: 'MCP 工具参数不符合已登记 schema。', MCP_INVALID_RESULT: 'MCP 工具返回值不符合已登记 schema。',
  MCP_NOT_AUTHORIZED: '当前 Bot 未获准调用此 MCP 工具。', MCP_INVOCATION_UNKNOWN: 'MCP 调用结果未核实；不会自动重试，请核对原执行。',
  MCP_CONFIG_CONFLICT: 'MCP 配置已变更或 requestId 被用于不同操作。', MCP_STORAGE_FAILED: 'MCP 配置或凭据文件无法安全读写。',
})
export class ExternalMcpError extends Error {
  constructor(code, status = 400) { super(codes[code] ?? 'MCP 操作未确认成功。'); this.name = 'ExternalMcpError'; this.code = code; this.status = status }
}
const fail = code => { throw new ExternalMcpError(code) }
export function publicMcpError(error) {
  const code = Object.hasOwn(codes, error?.code) ? error.code : 'MCP_OPERATION_FAILED'
  return { code, message: codes[code] ?? 'MCP 操作未确认成功；请检查连接状态，不要盲目重试写入。' }
}
const byteLength = value => Buffer.byteLength(value, 'utf8')
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) && !['constructor', 'prototype'].includes(value)
export const validMcpCredentialRef = value => typeof value === 'string' && /^mcpcred_[a-f0-9]{32}$/.test(value)
const hasControl = value => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !hasControl(value)
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const allowedKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key))
const secretEnvKey = key => typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(key) &&
  !MCP_ENV_ALLOWLIST.includes(key) && /(?:^|_)(?:TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|AUTHORIZATION)$/.test(key) && !/^(?:PATH|HOME|USERPROFILE|COMSPEC|PATHEXT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_.+|LD_.+|DYLD_.+|PYTHON.+|RUBY.+|PERL.+|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS|CDPATH|ZDOTDIR|GIT_.+|NPM_.+|PNPM_.+|UV_.+)$/i.test(key)

/** Reject before stringify: no accessors, cycles, class instances, sparse arrays or executable values. */
export function boundedMcpJson(value, { maxBytes = MCP_LIMITS.resultBytes, maxDepth = MCP_LIMITS.maxDepth, maxNodes = MCP_LIMITS.maxNodes } = {}) {
  const seen = new WeakSet(), stack = [{ value, depth: 0 }]
  let nodes = 0, bytes = 0
  while (stack.length) {
    const item = stack.pop(), v = item.value
    if (++nodes > maxNodes || item.depth > maxDepth) fail('MCP_LIMIT_EXCEEDED')
    if (v === null || typeof v === 'boolean') bytes += 5
    else if (typeof v === 'number') { if (!Number.isFinite(v)) fail('MCP_INVALID_JSON'); bytes += 24 }
    else if (typeof v === 'string') bytes += byteLength(v) + 2
    else if (typeof v === 'object') {
      if ((!Array.isArray(v) && !plain(v)) || seen.has(v)) fail('MCP_INVALID_JSON')
      seen.add(v)
      const descriptors = Object.getOwnPropertyDescriptors(v), entries = Object.entries(descriptors)
      if (Object.getOwnPropertySymbols(v).length) fail('MCP_INVALID_JSON')
      if (entries.length > maxNodes) fail('MCP_LIMIT_EXCEEDED')
      if (Array.isArray(v) && entries.length !== v.length + 1) fail('MCP_INVALID_JSON')
      for (const [key, descriptor] of entries) {
        if (Array.isArray(v) && key === 'length') continue
        if (Array.isArray(v) && !/^(?:0|[1-9][0-9]*)$/.test(key)) fail('MCP_INVALID_JSON')
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('MCP_INVALID_JSON')
        bytes += byteLength(key) + 4
        stack.push({ value: descriptor.value, depth: item.depth + 1 })
      }
    } else fail('MCP_INVALID_JSON')
    if (bytes > maxBytes) fail('MCP_LIMIT_EXCEEDED')
  }
  const encoded = JSON.stringify(value)
  if (byteLength(encoded) > maxBytes) fail('MCP_LIMIT_EXCEEDED')
  return JSON.parse(encoded)
}

function ipv6Number(address) {
  if (address.includes('.') || address.includes('%')) return null
  const halves = address.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : []
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  if (parts.length !== 8) return null
  return parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n)
}
const ipv4Number = address => address.split('.').reduce((n, part) => n * 256 + Number(part), 0)
const in4 = (n, base, bits) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits))
export function classifyMcpAddress(address) {
  if (isIP(address) === 4) {
    const n = ipv4Number(address)
    if (in4(n, '127.0.0.0', 8)) return 'loopback'
    const denied = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12],
      ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
    return denied.some(([base, bits]) => in4(n, base, bits)) ? 'blocked' : 'public'
  }
  if (isIP(address) === 6) {
    const n = ipv6Number(address)
    if (n === 1n) return 'loopback'
    // Fail closed for mapped, compatible, NAT64, ULA, link-local and transition ranges.
    if (n === null || n >> 125n !== 1n || n >> 96n === 0x20010db8n || n >> 112n === 0x2002n || n >> 105n === (0x2001n << 7n) || n >> 108n === 0x3fff0n) return 'blocked'
    return 'public'
  }
  return 'blocked'
}
function endpoint(value, allowLoopback) {
  if (!text(value, 2048) || value !== value.trim() || /\\/.test(value)) fail('MCP_UNSAFE_ENDPOINT')
  let url
  try { url = new URL(value) } catch { fail('MCP_UNSAFE_ENDPOINT') }
  if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol)) fail('MCP_UNSAFE_ENDPOINT')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = host === 'localhost' || classifyMcpAddress(host) === 'loopback'
  if (allowLoopback && !loopback || loopback && !allowLoopback || url.protocol !== 'https:' && !loopback) fail('MCP_UNSAFE_ENDPOINT')
  if (!loopback && (isIP(host) ? classifyMcpAddress(host) !== 'public' :
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || /\.(?:local|localhost|internal|invalid|test|example)$/.test(host))) fail('MCP_UNSAFE_ENDPOINT')
  return url.href
}
/** This validates all answers only. The future connector MUST pin these addresses in its actual socket lookup. */
export function validateMcpResolvedAddresses(config, answers) {
  const url = new URL(endpoint(config.url, config.allowLoopback === true))
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!Array.isArray(answers) || !answers.length || answers.length > 16) fail('MCP_UNSAFE_ENDPOINT')
  const expected = config.allowLoopback ? 'loopback' : 'public'
  const result = answers.map(answer => typeof answer === 'string' ? answer : answer?.address)
  if (result.some(address => classifyMcpAddress(address) !== expected || isIP(host) && address !== host)) fail('MCP_UNSAFE_ENDPOINT')
  return [...new Set(result)]
}

export function validateMcpConfig(input) {
  const v = boundedMcpJson(input, { maxBytes: MCP_LIMITS.configBytes })
  if (!plain(v) || !validId(v.connectionId) || !text(v.name, 200) || v.name !== v.name.trim() ||
    v.description !== undefined && (typeof v.description !== 'string' || v.description.length > 4000 || hasControl(v.description)) ||
    !['streamable-http', 'stdio'].includes(v.transport) || v.credentialRef !== undefined && !validMcpCredentialRef(v.credentialRef) ||
    v.credentialRequired !== undefined && typeof v.credentialRequired !== 'boolean' ||
    v.timeoutMs !== undefined && (!Number.isInteger(v.timeoutMs) || v.timeoutMs < 1000 || v.timeoutMs > MCP_LIMITS.maxTimeoutMs)) fail('MCP_INVALID_CONFIG')
  const common = ['connectionId', 'name', 'description', 'transport', 'credentialRef', 'credentialRequired', 'timeoutMs']
  const result = { connectionId: v.connectionId, name: v.name, description: v.description ?? '', transport: v.transport,
    credentialRequired: v.credentialRequired ?? false, timeoutMs: v.timeoutMs ?? MCP_LIMITS.timeoutMs,
    ...(v.credentialRef ? { credentialRef: v.credentialRef } : {}) }
  if (v.transport === 'streamable-http') {
    if (!allowedKeys(v, [...common, 'url', 'allowLoopback']) || v.allowLoopback !== undefined && typeof v.allowLoopback !== 'boolean') fail('MCP_INVALID_CONFIG')
    return { ...result, url: endpoint(v.url, v.allowLoopback === true), allowLoopback: v.allowLoopback ?? false }
  }
  if (!allowedKeys(v, [...common, 'executable', 'args', 'envKeys', 'secretEnvKeys'])) fail('MCP_INVALID_CONFIG')
  if (!text(v.executable, 2048) || (!posix.isAbsolute(v.executable) && !win32.isAbsolute(v.executable)) ||
    v.executable.startsWith('\\\\') || v.executable.startsWith('//') || /[\r\n]/.test(v.executable)) fail('MCP_UNSAFE_EXECUTABLE')
  const basename = v.executable.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '')
  if (/\.(?:sh|bash|zsh|fish|cmd|bat|ps1)$/i.test(basename) ||
    /^(?:sh|bash|dash|zsh|fish|csh|ksh|busybox|env|cmd|powershell|pwsh|npx|npm|pnpm|yarn|corepack|uv|uvx|pip|pip3|pipx|curl|wget|osascript)$/.test(basename)) fail('MCP_UNSAFE_EXECUTABLE')
  const args = v.args ?? [], envKeys = v.envKeys ?? [], secretEnvKeys = v.secretEnvKeys ?? []
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 2048 || hasControl(arg)) ||
    args.some(arg => /^(?:-[epc]|--eval|--print|--command)/i.test(arg) || /(?:^|[?&])(?:api[_-]?key|access[_-]?token|password|secret)=|^--?(?:token|password|secret|api[_-]?key|bearer|authorization|access[_-]?token|client[_-]?secret|key)(?:=|$)|^bearer /i.test(arg))) fail('MCP_INVALID_CONFIG')
  if (!Array.isArray(envKeys) || envKeys.length > MCP_ENV_ALLOWLIST.length || new Set(envKeys).size !== envKeys.length || envKeys.some(key => !MCP_ENV_ALLOWLIST.includes(key)) ||
    !Array.isArray(secretEnvKeys) || secretEnvKeys.length > 16 || new Set(secretEnvKeys).size !== secretEnvKeys.length || secretEnvKeys.some(key => !secretEnvKey(key))) fail('MCP_UNSAFE_ENV')
  return { ...result, credentialRequired: result.credentialRequired || secretEnvKeys.length > 0, executable: v.executable, args, envKeys, secretEnvKeys }
}

export function buildMcpStdioEnvironment(config, inherited = {}, secrets = {}) {
  const v = validateMcpConfig(config)
  if (v.transport !== 'stdio' || !plain(inherited) || !plain(secrets)) fail('MCP_UNSAFE_ENV')
  const output = Object.create(null)
  for (const key of v.envKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(inherited, key)
    if (descriptor && !Object.hasOwn(descriptor, 'value')) fail('MCP_UNSAFE_ENV')
    if (descriptor?.value !== undefined) {
      if (typeof descriptor.value !== 'string' || descriptor.value.length > 4096 || descriptor.value.includes('\0')) fail('MCP_UNSAFE_ENV')
      output[key] = descriptor.value
    }
  }
  const values = boundedMcpJson(secrets, { maxBytes: MCP_LIMITS.configBytes })
  if (Object.keys(values).some(key => !v.secretEnvKeys.includes(key)) ||
    Object.values(values).some(value => !text(value, 4096))) fail('MCP_UNSAFE_ENV')
  Object.assign(output, values)
  return output
}

export function mcpSourceRevision(input) {
  const config = validateMcpConfig(input)
  const source = config.transport === 'streamable-http'
    ? { transport: config.transport, url: config.url, allowLoopback: config.allowLoopback }
    : { transport: config.transport, executable: config.executable, args: config.args,
      envKeys: [...config.envKeys].sort(), secretEnvKeys: [...config.secretEnvKeys].sort() }
  return createHash('sha256').update(JSON.stringify(source)).digest('hex')
}

export function projectMcpConfig(input) {
  const config = validateMcpConfig(input)
  return { connectionId: config.connectionId, name: config.name, description: config.description,
    transport: config.transport, hasCredential: Boolean(config.credentialRef), credentialRequired: config.credentialRequired }
}
export function mcpToolAlias(connectionId, originalName) {
  if (!validId(connectionId) || !text(originalName, 256)) fail('MCP_INVALID_TOOLS')
  return `mcp_${createHash('sha256').update(JSON.stringify([connectionId, originalName])).digest('hex').slice(0, 56)}`
}
export function mapMcpTools(connectionId, input, { reservedNames = [] } = {}) {
  const tools = boundedMcpJson(input, { maxBytes: MCP_LIMITS.catalogBytes })
  if (!Array.isArray(tools) || tools.length > MCP_LIMITS.maxTools) fail('MCP_INVALID_TOOLS')
  const originals = new Set(), names = new Set(reservedNames)
  return tools.map(tool => {
    if (!plain(tool) || !plain(tool.inputSchema) || tool.inputSchema.type !== 'object' ||
      tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 4000)) fail('MCP_INVALID_TOOLS')
    const name = mcpToolAlias(connectionId, tool.name)
    if (originals.has(tool.name) || names.has(name)) fail('MCP_INVALID_TOOLS')
    originals.add(tool.name); names.add(name)
    return { name, connectionId, originalName: tool.name, description: tool.description ?? '',
      inputSchema: boundedMcpJson(tool.inputSchema, { maxBytes: MCP_LIMITS.schemaBytes }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: boundedMcpJson(tool.outputSchema, { maxBytes: MCP_LIMITS.schemaBytes }) }) }
  })
}
