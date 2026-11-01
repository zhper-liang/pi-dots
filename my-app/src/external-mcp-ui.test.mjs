import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { createExternalMcpClient, McpRequestError, mcpConfigInput } from './external-mcp-client.mjs'

// Execute the real component event handlers with hook and transport adapters. Browser layout is not mounted.
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...(node.type === 'stub-EditorDialog' && !node.props.open ? [] : [...nodes(node.props.children), ...nodes(node.props.footer)])]
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''
const find = (tree, type, match = () => true) => nodes(tree).find(node => node.type === type && match(node.props))
const button = (tree, label) => find(tree, 'button', props => text(props.children) === label)
const tick = () => new Promise(resolve => setImmediate(resolve))

async function harness(t, filename, props) {
  const hooksUrl = dataModule(`
    let cursor = 0, queue = []
    const slots = [], cleanup = []
    export function start() { cursor = 0 }
    export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }
    export function useRef(initial) { return useState(() => ({ current: initial }))[0] }
    export function useId() { return useState(() => 'fixture-' + Math.random().toString(36).slice(2))[0] }
    export function useMemo(callback, deps) { const index = cursor++, previous = slots[index]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[index] = { deps, value: callback() }; return slots[index].value }
    export function useEffect(callback, deps) { const index = cursor++, previous = slots[index]; if (!previous || !deps || deps.some((value, i) => value !== previous[i])) { slots[index] = deps; queue.push(() => { cleanup[index]?.(); cleanup[index] = callback() }) } }
    export function flush() { const work = queue; queue = []; for (const callback of work) callback() }
    export function dispose() { for (const callback of cleanup) callback?.() }
    // identity ${Math.random()}
  `)
  const hooks = await import(hooksUrl)
  const source = await readFile(new URL(filename, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [context => root => ts.visitNode(root, function visit(node) {
      if (!ts.isImportDeclaration(node)) return ts.visitEachChild(node, visit, context)
      if (!node.importClause || node.importClause.isTypeOnly) return undefined
      const path = node.moduleSpecifier.text
      const module = path === 'react' ? hooksUrl : path.endsWith('.mjs') ? new URL(path, import.meta.url).href : null
      if (module) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, ts.factory.createStringLiteral(module), node.attributes)
      const names = [node.importClause.name?.text, ...(node.importClause.namedBindings?.elements ?? []).filter(item => !item.isTypeOnly).map(item => item.name.text)].filter(Boolean)
      return ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList(names.map(name => ts.factory.createVariableDeclaration(name, undefined, undefined, ts.factory.createStringLiteral(`stub-${name}`))), ts.NodeFlags.Const))
    })] },
  }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  const Component = (await import(dataModule(compiled))).default
  t.after(() => hooks.dispose())
  const form = { values: new Map(), resets: 0, reset() { this.values.clear(); this.resets++ } }
  function render() {
    hooks.start()
    let tree = Component(props)
    while (typeof tree.type === 'function') tree = tree.type(tree.props)
    for (const node of nodes(tree)) if (node.type === 'form' && node.props.ref?.current !== undefined) node.props.ref.current = form
    hooks.flush()
    return tree
  }
  async function settle() { for (let i = 0; i < 4; i++) { render(); await tick() } return render() }
  return { render, settle, form }
}
const publicConnection = (overrides = {}) => ({ connectionId: 'fixture-mcp', revision: '1', name: 'Fixture MCP', description: '测试连接', transport: 'streamable-http', enabled: true,
  credentialRequired: false, hasCredential: false, status: 'configured', toolCount: 0, lastCheck: null, ...overrides })
const publicReceipt = (overrides = {}) => ({ connectionId: 'fixture-mcp', revision: '2', status: 'configured', replayed: false, ...overrides })
function fakeClient(initial = []) {
  let items = structuredClone(initial)
  const calls = [], checks = []
  const client = {
    async connections() { return structuredClone(items) },
    async mutate(operation, input) {
      calls.push({ operation, input: structuredClone(input) })
      if (operation === 'configure') {
        const config = input.config
        const item = publicConnection({ connectionId: config.connectionId, name: config.name, description: config.description, transport: config.transport,
          secretEnvKeys: config.secretEnvKeys, credentialRequired: config.credentialRequired, revision: '2' })
        items = [...items.filter(entry => entry.connectionId !== item.connectionId), item]
        return publicReceipt({ connectionId: item.connectionId })
      }
      const item = items.find(entry => entry.connectionId === input.connectionId)
      if (operation === 'remove') { items = items.filter(entry => entry !== item); return publicReceipt({ connectionId: item.connectionId, status: 'removed', removed: true }) }
      const next = { ...item, revision: '2', ...(operation === 'disable' ? { status: 'disabled', enabled: false } : { status: 'ready', toolCount: 2 }) }
      items = items.map(entry => entry === item ? next : entry)
      return publicReceipt({ connectionId: item.connectionId, status: next.status, toolCount: next.toolCount })
    },
    async saveCredential(input) { calls.push({ operation: 'credential', input }); return publicReceipt({ connectionId: input.connectionId, saved: true }) },
    async requestStatus(requestId) { checks.push(requestId); return null },
  }
  return { client, calls, checks, setItems(next) { items = next } }
}
function changeField(h, prefix, value, type = 'input') {
  const node = find(h.render(), type, props => props.id?.startsWith(prefix))
  assert.ok(node, `missing field ${prefix}`)
  node.props.onChange({ target: { value } })
}
function replaceGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key] })
}

test('R4-06 settings has five sections, a shared connection list and no Agent credential issuance', async t => {
  const h = await harness(t, './SettingsPage.tsx', { token: 'fixture-ui' })
  const tree = h.render()
  const sections = tree.props.children.filter(Boolean)
  assert.deepEqual(sections.map(section => text(find(section, 'h2'))), ['连接', '模型', '自动化', '偏好', '高级'])
  const connections = sections[0].props.children.filter(node => node?.type === 'details')
  assert.deepEqual(connections.map(node => text(node.props.children[0]).replace('读取中…', '')), ['Google', 'MCP 连接'])
  assert.ok(find(sections[0], 'a', props => props.href === '#bot=chief&tab=capabilities'))
  assert.equal(find(sections[0], 'stub-ExternalWorkspace'), undefined)
  assert.equal(find(sections[4], 'stub-WorkspaceStatus').props.active, false)
  assert.ok(find(sections[0], 'stub-ExternalMcpConnections'))
  assert.equal(find(sections[0], 'stub-StdioCredentials'), undefined)
  assert.equal(find(tree, 'stub-StdioCredentials'), undefined)
  assert.ok(find(sections[4], 'details', props => props.className === 'tech-info'))
  for (const [type, summary] of [['GoogleConnection', 'me@example.test'], ['ExternalMcpConnections', '2 个']]) {
    find(tree, `stub-${type}`).props.onSummary(summary)
  }
  assert.deepEqual(h.render().props.children[0].props.children.filter(node => node?.type === 'details').map(node => text(find(node, 'span'))), ['me@example.test', '2 个'])
})

test('external MCP component saves form configuration only, then explicitly checks and disables the connection', async t => {
  const f = fakeClient(), summaries = []
  const h = await harness(t, './ExternalMcpConnections.tsx', { token: 'fixture-ui', client: f.client, onSummary: value => summaries.push(value) })
  await h.settle()
  assert.deepEqual(summaries, ['未添加'])
  button(h.render(), '添加 MCP 连接').props.onClick()
  changeField(h, 'mcp-name-', 'Local fixture')
  changeField(h, 'mcp-description-', '正常连接测试', 'textarea')
  changeField(h, 'mcp-url-', 'https://example.com/mcp')
  find(h.render(), 'form').props.onSubmit({ preventDefault() {} })
  let tree = await h.settle()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].operation, 'configure')
  assert.equal(f.calls[0].input.config.transport, 'streamable-http')
  assert.equal(f.calls[0].input.config.url, 'https://example.com/mcp')
  assert.equal(Object.hasOwn(f.calls[0].input, 'expectedRevision'), false)
  assert.match(text(tree), /已保存，待检查/)
  assert.equal(summaries.at(-1), '1 个')
  assert.doesNotMatch(text(tree), /连接检查完成/)
  button(tree, '检查连接').props.onClick()
  tree = await h.settle()
  assert.equal(f.calls[1].operation, 'check')
  assert.equal(f.calls[1].input.expectedRevision, '2')
  assert.match(text(tree), /已就绪/)
  button(tree, '停用').props.onClick()
  tree = await h.settle()
  assert.equal(f.calls[2].operation, 'disable')
  assert.match(text(tree), /已停用/)
  assert.equal(button(tree, '检查连接').props.disabled, true)
  assert.equal(f.calls.some(call => call.operation === 'credential'), false)
})

test('external MCP editor maps installed stdio program and argv without installing or providing env values', async t => {
  const f = fakeClient(), h = await harness(t, './ExternalMcpConnections.tsx', { token: 'fixture-ui', client: f.client })
  await h.settle(); button(h.render(), '添加 MCP 连接').props.onClick()
  changeField(h, 'mcp-name-', 'Installed fixture')
  changeField(h, 'mcp-transport-', 'stdio', 'select')
  changeField(h, 'mcp-executable-', '/usr/local/bin/fixture-mcp')
  changeField(h, 'mcp-args-', '/tmp/fixture-server.mjs\n--mode\nread', 'textarea')
  changeField(h, 'mcp-secret-keys-', 'SERVICE_API_KEY')
  find(h.render(), 'form').props.onSubmit({ preventDefault() {} })
  await h.settle()
  const config = f.calls[0].input.config
  assert.deepEqual(config.args, ['/tmp/fixture-server.mjs', '--mode', 'read'])
  assert.equal(config.executable, '/usr/local/bin/fixture-mcp')
  assert.deepEqual(config.secretEnvKeys, ['SERVICE_API_KEY'])
  assert.deepEqual(config.envKeys, [])
  assert.equal(Object.hasOwn(config, 'env'), false)
  const credential = find(h.render(), 'stub-McpCredentialForm')
  assert.deepEqual(credential.props.secretEnvKeys, ['SERVICE_API_KEY'])
})

test('external MCP component preserves the original unknown request and verifies without another mutation', async t => {
  const f = fakeClient()
  f.client.mutate = async (operation, input) => {
    f.calls.push({ operation, input: structuredClone(input) })
    throw new McpRequestError('MCP_RESPONSE_UNKNOWN', { unknown: true })
  }
  f.client.requestStatus = async requestId => {
    f.checks.push(requestId)
    const config = f.calls[0].input.config
    f.setItems([publicConnection({ connectionId: config.connectionId, name: config.name, revision: '2' })])
    return { requestId, operation: 'configure', state: 'succeeded', result: publicReceipt({ connectionId: config.connectionId }) }
  }
  const h = await harness(t, './ExternalMcpConnections.tsx', { token: 'fixture-ui', client: f.client })
  await h.settle(); button(h.render(), '添加 MCP 连接').props.onClick()
  changeField(h, 'mcp-name-', 'Unknown fixture'); changeField(h, 'mcp-url-', 'https://example.com/mcp')
  find(h.render(), 'form').props.onSubmit({ preventDefault() {} })
  let tree = await h.settle()
  assert.equal(button(tree, '添加 MCP 连接').props.disabled, true)
  assert.ok(button(tree, '核对上次操作'))
  assert.match(find(tree, 'stub-EditorDialog').props.error, /上次操作没确认结果/)
  assert.equal(find(tree, 'stub-EditorDialog').props.pending, false)
  const requestId = f.calls[0].input.requestId
  // The pending notice is one sentence; the request id stays internal.
  const shown = nodes(tree).map(node => typeof node.props.children === 'string' ? node.props.children : '').join(' ')
  assert.match(shown, /上次操作的结果还没确认/)
  assert.doesNotMatch(shown, new RegExp(requestId))
  button(tree, '核对上次操作').props.onClick()
  tree = await h.settle()
  assert.deepEqual(f.checks, [requestId])
  assert.equal(f.calls.length, 1)
  assert.equal(find(tree, 'stub-EditorDialog').props.open, false)
  assert.match(text(tree), /Unknown fixture/)
  assert.equal(button(tree, '核对上次操作'), undefined)
})

test('external MCP removal requires confirmation and does not hide a row before the receipt and list reread', async t => {
  let confirmed = false, release
  replaceGlobal(t, 'window', { confirm: () => confirmed })
  const f = fakeClient([publicConnection()]), normal = f.client.mutate
  f.client.mutate = async (...args) => { await new Promise(resolve => { release = resolve }); return normal(...args) }
  const h = await harness(t, './ExternalMcpConnections.tsx', { token: 'fixture-ui', client: f.client })
  await h.settle(); button(h.render(), '移除').props.onClick()
  assert.equal(release, undefined)
  confirmed = true; button(h.render(), '移除').props.onClick()
  assert.match(text(h.render()), /Fixture MCP/)
  release(); const tree = await h.settle()
  assert.equal(f.calls[0].input.confirmGlobal, true)
  assert.equal(f.calls[0].input.expectedRevision, '1')
  assert.equal(find(tree, 'ul', props => props['aria-label'] === '外部 MCP 连接'), undefined)
  assert.match(text(tree), /还没有 MCP 连接/)
})

test('credential form clears synthetic secrets immediately and verifies an unknown request without resubmitting', async t => {
  replaceGlobal(t, 'FormData', class { constructor(form) { this.values = new Map(form.values) } get(key) { return this.values.get(key) ?? null } })
  const posts = [], reads = [], saved = [], pending = []
  let h
  const props = { connectionId: 'fixture-mcp', expectedRevision: '1', transport: 'streamable-http', hasCredential: false,
    async onSave(input) { assert.equal(h.form.values.size, 0); posts.push(input); throw new McpRequestError('MCP_RESPONSE_UNKNOWN', { unknown: true }) },
    async onVerify(requestId) { reads.push(requestId); return { requestId, operation: 'credential', state: 'succeeded', result: publicReceipt({ saved: true, bearerToken: 'must-not-escape' }) } },
    onSaved: value => saved.push(value), onPendingChange: value => pending.push(value) }
  h = await harness(t, './McpCredentialForm.tsx', props)
  h.render(); h.form.values.set('bearer', 'synthetic-test-only')
  find(h.render(), 'form').props.onSubmit({ preventDefault() {}, currentTarget: h.form })
  let tree = await h.settle()
  assert.equal(h.form.resets, 1)
  assert.deepEqual(posts[0].credential, { bearerToken: 'synthetic-test-only' })
  assert.doesNotMatch(text(tree), /synthetic-test-only/)
  assert.equal(find(tree, 'fieldset').props.disabled, true)
  button(tree, '核对上次操作').props.onClick()
  tree = await h.settle()
  assert.deepEqual(reads, [posts[0].requestId])
  assert.equal(posts.length, 1)
  assert.deepEqual(pending, [true, false])
  assert.deepEqual(saved, [publicReceipt({ saved: true })])
  assert.equal(button(tree, '核对上次操作'), undefined)
  assert.doesNotMatch(text(tree), /must-not-escape/)
  assert.equal(find(tree, 'input').props.value, undefined)
})

test('stdio credential form only submits the declared secret variable names, never the ordinary config path', async t => {
  replaceGlobal(t, 'FormData', class { constructor(form) { this.values = new Map(form.values) } get(key) { return this.values.get(key) ?? null } })
  const posts = []
  const h = await harness(t, './McpCredentialForm.tsx', { connectionId: 'fixture-mcp', expectedRevision: '7', transport: 'stdio', secretEnvKeys: ['SERVICE_API_KEY'], hasCredential: true,
    async onSave(input) { posts.push(input); return publicReceipt({ revision: '8', saved: true }) }, async onVerify() { return null } })
  h.render(); h.form.values.set('SERVICE_API_KEY', 'isolated-fixture-secret')
  find(h.render(), 'form').props.onSubmit({ preventDefault() {}, currentTarget: h.form })
  const tree = await h.settle()
  assert.deepEqual(posts[0].credential, { env: { SERVICE_API_KEY: 'isolated-fixture-secret' } })
  assert.equal(posts[0].expectedRevision, '7')
  assert.equal(h.form.values.size, 0)
  assert.match(text(tree), /已有凭据，永不回显/)
  assert.doesNotMatch(text(tree), /isolated-fixture-secret/)
})

test('external MCP client uses the authenticated frozen routes and whitelists public responses', async () => {
  const calls = []
  const client = createExternalMcpClient({ token: 'isolated-ui-token', fetchImpl: async (path, init) => {
    calls.push({ path, ...init })
    const data = path === '/api/external-mcp' ? { items: [publicConnection({ bearerToken: 'never-project', args: ['never-project'] })] } : path.includes('/requests/') ? {
      requestId: 'fixture-request', operation: 'credential', state: 'succeeded', result: publicReceipt({ saved: true, credential: { bearerToken: 'never-project' } }), config: { secret: 'never-project' },
    } : publicReceipt({ saved: path.endsWith('/credentials') })
    return { ok: true, status: 200, json: async () => ({ data }) }
  } })
  assert.equal(JSON.stringify(await client.connections()).includes('never-project'), false)
  await client.mutate('check', { requestId: 'fixture-check', connectionId: 'fixture-mcp', expectedRevision: '1' })
  await client.saveCredential({ requestId: 'fixture-request', connectionId: 'fixture-mcp', expectedRevision: '1', credential: { bearerToken: 'synthetic-only' } })
  assert.equal(JSON.stringify(await client.requestStatus('fixture-request')).includes('never-project'), false)
  assert.deepEqual(calls.map(call => call.path), ['/api/external-mcp', '/api/external-mcp/check', '/api/external-mcp/credentials', '/api/external-mcp/requests/fixture-request'])
  assert.ok(calls.every(call => call.headers.authorization === 'Bearer isolated-ui-token'))
  assert.equal(JSON.parse(calls[2].body).credential.bearerToken, 'synthetic-only')
  assert.equal(calls[3].method, 'GET')
  assert.equal(calls[3].body, undefined)
})

test('normal MCP form validation keeps credentials separate and preserves literal argv without shell parsing', () => {
  const base = { name: 'Fixture', description: '', transport: 'streamable-http', url: 'https://example.com/mcp', allowLoopback: false, credentialRequired: false,
    executable: '', args: '', envKeys: [], secretEnvKeys: '' }
  assert.equal(mcpConfigInput(base, 'fixture').config.transport, 'streamable-http')
  assert.equal(typeof mcpConfigInput({ ...base, name: '' }, 'fixture').error, 'string')
  assert.equal(typeof mcpConfigInput({ ...base, url: 'https://example.com/mcp?api_key=synthetic' }, 'fixture').error, 'string')
  assert.deepEqual(mcpConfigInput({ ...base, transport: 'stdio', executable: '/usr/bin/fixture', args: 'one argument\n second argument ', secretEnvKeys: 'SERVICE_API_KEY' }, 'fixture').config.args,
    ['one argument', ' second argument '])
})

test('external MCP edit retains the current revision, requires a new source value and displays dependency/auth failures honestly', async t => {
  const f = fakeClient([
    publicConnection({ status: 'needs_auth', credentialRequired: true }),
    publicConnection({ connectionId: 'dependency', name: 'Missing dependency', status: 'missing_dependency', transport: 'stdio' }),
  ])
  const h = await harness(t, './ExternalMcpConnections.tsx', { token: 'fixture-ui', client: f.client })
  let tree = await h.settle()
  assert.match(text(tree), /需要凭据/)
  assert.match(text(tree), /缺少依赖/)
  assert.equal(f.calls.length, 0)
  button(tree, '修改配置').props.onClick()
  assert.equal(find(h.render(), 'input', props => props.id?.startsWith('mcp-url-')).props.value, '')
  changeField(h, 'mcp-url-', 'https://example.com/new-mcp')
  find(h.render(), 'form').props.onSubmit({ preventDefault() {} })
  tree = await h.settle()
  assert.equal(f.calls[0].input.expectedRevision, '1')
  assert.equal(f.calls[0].input.config.connectionId, 'fixture-mcp')
  assert.equal(f.calls[0].input.config.url, 'https://example.com/new-mcp')
  assert.equal(Object.hasOwn(f.calls[0].input.config, 'credential'), false)
  assert.match(text(tree), /已保存，待检查/)
})

test('reconnect unknown outcome reconciles the service check ledger and never starts another check automatically', async t => {
  const f = fakeClient([publicConnection()])
  f.client.mutate = async (operation, input) => { f.calls.push({ operation, input }); throw new McpRequestError('MCP_RESPONSE_UNKNOWN', { unknown: true }) }
  f.client.requestStatus = async requestId => {
    f.checks.push(requestId)
    f.setItems([publicConnection({ revision: '2', status: 'ready', toolCount: 2 })])
    return { requestId, operation: 'check', state: 'succeeded', result: publicReceipt({ status: 'ready', toolCount: 2 }) }
  }
  const h = await harness(t, './ExternalMcpConnections.tsx', { token: 'fixture-ui', client: f.client })
  await h.settle(); button(h.render(), '重新连接').props.onClick()
  let tree = await h.settle()
  assert.match(text(tree), /操作结果待核查/)
  button(tree, '核对上次操作').props.onClick()
  tree = await h.settle()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].operation, 'reconnect')
  assert.deepEqual(f.checks, [f.calls[0].input.requestId])
  assert.match(text(tree), /已就绪/)
  assert.equal(button(tree, '核对上次操作'), undefined)
})

test('definitively failed MCP operation exposes an explicit retry with the identical request and payload', async t => {
  const f = fakeClient([publicConnection()]), normal = f.client.mutate
  f.client.mutate = async (operation, input) => {
    if (f.calls.length === 0) { f.calls.push({ operation, input: structuredClone(input) }); throw new McpRequestError('MCP_CONNECTION_FAILED', { status: 409 }) }
    return normal(operation, input)
  }
  const h = await harness(t, './ExternalMcpConnections.tsx', { token: 'fixture-ui', client: f.client })
  await h.settle(); button(h.render(), '检查连接').props.onClick()
  let tree = await h.settle()
  assert.equal(f.calls.length, 1)
  assert.ok(button(tree, '重试'))
  assert.equal(button(tree, '核对上次操作'), undefined)
  assert.match(text(tree), /上次操作未完成/)
  button(tree, '重试').props.onClick()
  tree = await h.settle()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1], f.calls[0])
  assert.match(text(tree), /已就绪/)
})

test('a credential retry after verified failure reads a new form input and preserves only the original metadata', async t => {
  replaceGlobal(t, 'FormData', class { constructor(form) { this.values = new Map(form.values) } get(key) { return this.values.get(key) ?? null } })
  const posts = []
  const h = await harness(t, './McpCredentialForm.tsx', { connectionId: 'fixture-mcp', expectedRevision: '1', transport: 'streamable-http', hasCredential: false,
    async onSave(input) { posts.push(input); if (posts.length === 1) throw new McpRequestError('MCP_RESPONSE_UNKNOWN', { unknown: true }); return publicReceipt({ saved: true }) },
    async onVerify(requestId) { return { requestId, operation: 'credential', state: 'failed' } } })
  h.render(); h.form.values.set('bearer', 'first-synthetic-input')
  find(h.render(), 'form').props.onSubmit({ preventDefault() {}, currentTarget: h.form })
  let tree = await h.settle()
  button(tree, '核对上次操作').props.onClick()
  tree = await h.settle()
  assert.equal(posts.length, 1)
  assert.equal(h.form.values.size, 0)
  assert.equal(find(tree, 'fieldset').props.disabled, false)
  assert.ok(button(tree, '重试'))
  h.form.values.set('bearer', 'reentered-synthetic-input')
  find(h.render(), 'form').props.onSubmit({ preventDefault() {}, currentTarget: h.form })
  tree = await h.settle()
  assert.equal(posts[1].requestId, posts[0].requestId)
  assert.equal(posts[1].expectedRevision, posts[0].expectedRevision)
  assert.deepEqual(posts[1].credential, { bearerToken: 'reentered-synthetic-input' })
  assert.equal(h.form.values.size, 0)
  assert.doesNotMatch(text(tree), /first-synthetic-input|reentered-synthetic-input/)
})

test('real MCP settings component consumes production authenticated routes and an isolated official SDK HTTP service', async t => {
  const { once } = await import('node:events')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const { createApiServer } = await import('../server/app.mjs')
  const { openTaskStore } = await import('../server/tasks.mjs')
  const { createExternalMcpService } = await import('../server/external-mcp.mjs')
  const { createFixtureMcpHttp } = await import('../server/fixtures/external-mcp-sdk-http.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'pidot-mcp-ui-http-')), token = randomUUID()
  const remote = await createFixtureMcpHttp({ bearerToken: 'synthetic-ui-service-only' })
  const service = await createExternalMcpService({ dataDirectory: join(directory, 'mcp') })
  let store, server
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    if (store) await store.close()
    else await service.close()
    await remote.close()
    await rm(directory, { recursive: true, force: true })
  })
  store = await openTaskStore({ file: join(directory, 'tasks.sqlite'), workspaceEnabled: false, calendarQueryEnabled: false, externalMcp: service })
  server = createApiServer({ token, tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  replaceGlobal(t, 'window', { confirm: () => true })
  const origin = `http://127.0.0.1:${server.address().port}`
  const client = createExternalMcpClient({ token, fetchImpl: (path, init) => fetch(`${origin}${path}`, init) })
  const h = await harness(t, './ExternalMcpConnections.tsx', { token, client })
  await h.settle(); button(h.render(), '添加 MCP 连接').props.onClick()
  changeField(h, 'mcp-name-', 'Production API fixture'); changeField(h, 'mcp-url-', remote.url)
  const checkboxes = nodes(h.render()).filter(node => node.type === 'input' && node.props.type === 'checkbox')
  checkboxes[0].props.onChange({ target: { checked: true } })
  checkboxes[1].props.onChange({ target: { checked: true } })
  find(h.render(), 'form').props.onSubmit({ preventDefault() {} })
  let tree
  for (let n = 0; n < 100; n++) { tree = await h.settle(); if (find(tree, 'stub-McpCredentialForm')) break; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.match(text(tree), /需要凭据/)
  const credential = find(tree, 'stub-McpCredentialForm')
  assert.ok(credential)
  const requestId = randomUUID()
  const saved = await credential.props.onSave({ requestId, connectionId: credential.props.connectionId, expectedRevision: credential.props.expectedRevision,
    credential: { bearerToken: 'synthetic-ui-service-only' } }, new AbortController().signal)
  assert.equal(saved.saved, true)
  credential.props.onSaved(saved)
  for (let n = 0; n < 100; n++) { tree = await h.settle(); if (find(tree, 'stub-McpCredentialForm').props.hasCredential) break; await new Promise(resolve => setTimeout(resolve, 5)) }
  button(tree, '检查连接').props.onClick()
  for (let n = 0; n < 100; n++) { tree = await h.settle(); if (text(tree).includes('3 个已发现工具')) break; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.match(text(tree), /已就绪/)
  assert.match(text(tree), /3 个已发现工具/)
  assert.doesNotMatch(text(tree), /synthetic-ui-service-only/)
  const response = await fetch(`${origin}/api/bots/calendar/capabilities`, { headers: { authorization: `Bearer ${token}` } })
  const capability = (await response.json()).data.items.find(item => item.id === `mcp:${credential.props.connectionId}`)
  assert.equal(capability.enabledForBot, false)
  assert.equal((await client.requestStatus(requestId)).result.saved, true)
  button(tree, '停用').props.onClick()
  for (let n = 0; n < 100; n++) { tree = await h.settle(); if (text(tree).includes('已停用') && !button(tree, '添加 MCP 连接').props.disabled) break; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.match(text(tree), /已停用/)
  button(tree, '移除').props.onClick()
  for (let n = 0; n < 100; n++) { tree = await h.settle(); if (text(tree).includes('还没有 MCP 连接')) break; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.deepEqual(await client.connections(), [])
})

test('settings capability shortcut invokes navigation even when its destination hash is already selected', async t => {
  let opened = 0, prevented = false
  const h = await harness(t, './SettingsPage.tsx', { token: 'fixture-ui', onOpenCapabilities: () => opened++ })
  const link = find(h.render(), 'a', props => props.href === '#bot=chief&tab=capabilities')
  link.props.onClick({ preventDefault() { prevented = true } })
  assert.equal(opened, 1)
  assert.equal(prevented, true)
})
