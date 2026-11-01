import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { cardView, cardActions, canAlways } from './system-cards.mjs'
import { createCapabilitySetupClient, capabilityManagerNotice } from './capability-setup.mjs'

// Execute real TSX handlers. Hooks, child frames and browser layout are deterministic adapters.
const dataModule = value => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !node.props) return []
  if (typeof node.type === 'function' && node.type.name === 'CapabilityApprovalParameters') return nodes(node.type(node.props))
  return [node, ...nodes(node.props.children), ...nodes(node.props.actions), ...nodes(node.props.home)]
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''
const find = (tree, type, predicate = () => true) => nodes(tree).find(node => node.type === type && predicate(node.props))
const button = (tree, label) => find(tree, 'button', props => text(props.children) === label)
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const receipt = (change = {}) => ({ setupId: 'setup-fixture', requestId: 'setup-request', operationId: 'operation-fixture', kind: 'mcp', action: 'add', taskId: 1, inputId: 10,
  targetBotId: 'alpha', name: 'Fixture MCP', description: '已登记的测试能力', state: 'needs_auth', capabilityId: 'mcp:fixture', enabledForBot: false, connectionId: 'fixture',
  verification: { status: 'needs_auth', summary: '需要安全输入凭据', checkedAt: '2026-10-29T01:00:00Z' }, missing: [{ kind: 'credential', id: 'fixture', message: '请通过安全入口输入凭据' }],
  affectedBotIds: [], approvalId: null, credentialEntry: { kind: 'mcp-credential', connectionId: 'fixture' }, canResume: true, replayed: false, error: null, ...change })
const readyReceipt = (change = {}) => receipt({ state: 'ready', enabledForBot: true, verification: { status: 'ready', summary: '绑定与依赖已真实核验', checkedAt: '2026-10-29T02:00:00Z' }, missing: [], credentialEntry: null, canResume: false, ...change })
const source = { connectionId: 'fixture', revision: 'source-1', name: 'Fixture MCP', description: '', transport: 'streamable-http', enabled: true, credentialRequired: true, hasCredential: false, status: 'needs_auth' }

async function harness(t, filename, props, fetchImpl = async () => { throw new Error('unexpected fetch') }) {
  const hooksUrl = dataModule(`
    let cursor = 0, queue = []
    const slots = [], cleanup = []
    export function start() { cursor = 0 }
    export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }
    export function useRef(initial) { return useState(() => ({ current: initial }))[0] }
    export function useMemo(callback, deps) { const index = cursor++, prior = slots[index]; if (!prior || deps.some((value, i) => value !== prior.deps[i])) slots[index] = { deps, value: callback() }; return slots[index].value }
    export function useCallback(callback, deps) { return useMemo(() => callback, deps) }
    export function useEffect(callback, deps) { const index = cursor++, prior = slots[index]; if (!prior || !deps || deps.some((value, i) => value !== prior[i])) { slots[index] = deps; queue.push(() => { cleanup[index]?.(); cleanup[index] = callback() }) } }
    export function flush() { const work = queue; queue = []; for (const callback of work) callback() }
    export function dispose() { for (const callback of cleanup) callback?.() }
    // ${Math.random()}
  `)
  const hooks = await import(hooksUrl), replacements = new Map([['react', hooksUrl]])
  replacements.set('./useDrawer', dataModule('export function useDrawer() {} export function useMediaQuery() { return false }'))
  replacements.set('./automation', dataModule('export async function setAutomationPaused() {}'))
  async function compile(name) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      fileName: name, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      transformers: { before: [context => root => ts.visitNode(root, function visit(node) {
        if (!ts.isImportDeclaration(node)) return ts.visitEachChild(node, visit, context)
        if (!node.importClause || node.importClause.isTypeOnly) return undefined
        const path = node.moduleSpecifier.text, module = replacements.get(path) ?? (path.endsWith('.mjs') ? new URL(path, import.meta.url).href : null)
        if (module) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, ts.factory.createStringLiteral(module), node.attributes)
        const names = [node.importClause.name?.text, ...(node.importClause.namedBindings?.elements ?? []).filter(item => !item.isTypeOnly).map(item => item.name.text)].filter(Boolean)
        return ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList(names.map(name => ts.factory.createVariableDeclaration(name, undefined, undefined, ts.factory.createStringLiteral(`stub-${name}`))), ts.NodeFlags.Const))
      })] },
    }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    return dataModule(compiled)
  }
  for (const name of ['taskPath', 'taskStatus']) replacements.set(`./${name}`, await compile(`./${name}.ts`))
  const cardUrl = await compile('./CapabilitySetupCard.tsx')
  if (filename === './App.tsx') replacements.set('./CapabilitySetupCard', cardUrl)
  const module = await import(filename === './CapabilitySetupCard.tsx' ? cardUrl : await compile(filename))
  const originals = new Map(), storage = new Map([['pidot.api-token', 'fixture-api-token']])
  const replace = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  const location = { hash: '#bot=chief&task=1' }
  replace('fetch', fetchImpl); replace('location', location)
  replace('sessionStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) })
  replace('document', { documentElement: { scrollHeight: 0 }, body: {}, getElementById() { return null }, addEventListener() {}, removeEventListener() {} })
  replace('window', { history: { pushState(a, b, hash) { location.hash = hash }, replaceState(a, b, hash) { location.hash = hash } }, addEventListener() {}, removeEventListener() {} })
  replace('ResizeObserver', class { observe() {} disconnect() {} }); replace('innerHeight', 0); replace('scrollY', 0)
  replace('setTimeout', () => 1); replace('clearTimeout', () => {}); replace('requestAnimationFrame', callback => { callback(); return 1 })
  t.after(() => { hooks.dispose(); for (const [key, previous] of originals) { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key] } })
  let currentProps = { ...props }
  function render() { hooks.start(); let tree = module.default(currentProps); while (typeof tree.type === 'function') tree = tree.type(tree.props); hooks.flush(); return tree }
  async function settle() { for (let n = 0; n < 6; n++) { render(); await tick() } return render() }
  return { render, settle, update(next) { currentProps = { ...currentProps, ...next }; return render() }, module, cardModule: await import(cardUrl), storage }
}

function system(tree) { return find(tree, 'stub-SystemCard').props }

test('capability setup kind has attention labels but never grants ordinary approval or always actions', () => {
  const view = cardView({ kind: 'capability-setup', state: 'needs_auth' })
  assert.equal(view.kind, 'capability-setup'); assert.equal(view.label, '能力配置'); assert.equal(view.tone, 'attention')
  assert.equal(view.state, '等待安全输入凭据')
  for (const state of ['pending', 'needs_auth', 'needs_confirmation', 'missing_dependency', 'ready', 'unknown']) assert.deepEqual(cardActions({ kind: 'capability-setup', state }), [])
  assert.equal(canAlways({ kind: 'capability-setup', state: 'pending' }), false)
})

test('ready state and bound switch appear only after GET of the original setup, never from an initial tool success flag', async t => {
  const read = deferred(), calls = []
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: readyReceipt(), client: {
    get(original) { calls.push(['GET', original.setupId, original.requestId]); return read.promise }, async resume() { throw new Error('unexpected resume') } } })
  let tree = h.render()
  assert.match(system(tree).state, /尚未核查/)
  assert.equal(find(tree, 'stub-Switch'), undefined)
  read.resolve(readyReceipt()); tree = await h.settle()
  assert.equal(system(tree).state, '已启用并通过校验')
  assert.equal(find(tree, 'stub-Switch').props.checked, true)
  assert.equal(find(tree, 'stub-Switch').props.disabled, true)
  assert.deepEqual(calls, [['GET', 'setup-fixture', 'setup-request']])
})

test('inconsistent ready receipts and missing dependencies never display management success', async t => {
  const current = readyReceipt({ enabledForBot: false, verification: { status: 'missing_dependency', summary: '还缺少工作区读取工具', checkedAt: null }, missing: [{ kind: 'tool', id: 'workspace.list', message: '缺少 workspace.list' }] })
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: current, client: { async get() { return current }, async resume() { throw new Error('unexpected resume') } } })
  const tree = await h.settle()
  assert.match(system(tree).state, /尚未确认/)
  assert.equal(find(tree, 'stub-Switch').props.checked, false)
  assert.match(text(tree), /缺少 workspace.list/)
  assert.equal(button(tree, '继续原配置'), undefined)
})

test('resume response is reread before showing ready and unknown outcomes only query the original setup', async t => {
  let current = receipt({ state: 'missing_dependency', credentialEntry: null }), lose = true
  const calls = []
  const client = {
    async get(original) { calls.push(['GET', original.setupId, original.requestId]); return current },
    async resume(original) { calls.push(['POST', original.setupId, original.requestId, original.taskId, original.inputId]); if (lose) throw new Error('response lost'); current = readyReceipt(); return current },
  }
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: current, client })
  await h.settle(); button(h.render(), '继续原配置').props.onClick(); let tree = await h.settle()
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
  assert.equal(button(tree, '继续原配置'), undefined)
  current = receipt({ state: 'unknown', canResume: true })
  button(tree, '核查原配置').props.onClick(); tree = await h.settle()
  assert.equal(button(tree, '继续原配置'), undefined)
  assert.equal(button(tree, '安全输入凭据'), undefined)
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
  current = receipt({ state: 'missing_dependency', credentialEntry: null }); lose = false
  button(tree, '核查原配置').props.onClick(); await h.settle()
  button(h.render(), '继续原配置').props.onClick(); tree = await h.settle()
  assert.equal(system(tree).state, '已启用并通过校验')
  assert.deepEqual(calls.slice(-2).map(call => call[0]), ['POST', 'GET'])
  assert.ok(calls.every(call => call[1] === 'setup-fixture' && call[2] === 'setup-request'))
})

test('safe credential save resumes the same setup using only genuine receipt Task/input identity and rereads its result', async t => {
  let current = receipt()
  const calls = [], saved = [], changed = []
  const client = {
    async get(original) { calls.push(['GET', original.setupId, original.taskId, original.inputId]); return current },
    async resume(original) { calls.push(['RESUME', original.setupId, original.taskId, original.inputId]); current = readyReceipt(); return current },
  }
  const mcpClient = { async connections() { return [source] }, async saveCredential(input) { saved.push(input); return { connectionId: 'fixture', revision: 'source-2', status: 'configured', saved: true } }, async requestStatus() { return null } }
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: current, client, mcpClient, onChanged: () => changed.push(true) })
  await h.settle(); button(h.render(), '安全输入凭据').props.onClick(); await h.settle()
  const form = find(h.render(), 'stub-McpCredentialForm').props
  assert.equal(form.expectedRevision, 'source-1')
  const savedReceipt = await form.onSave({ requestId: 'credential-request', connectionId: 'fixture', expectedRevision: 'source-1', credential: { bearerToken: 'synthetic-ui-only' } }, new AbortController().signal)
  form.onSaved(savedReceipt); const tree = await h.settle()
  assert.equal(calls.filter(call => call[0] === 'RESUME').length, 1)
  assert.deepEqual(calls.find(call => call[0] === 'RESUME'), ['RESUME', 'setup-fixture', 1, 10])
  assert.deepEqual(calls.slice(-2).map(call => call[0]), ['RESUME', 'GET'])
  assert.equal(saved[0].credential.bearerToken, 'synthetic-ui-only')
  assert.equal(JSON.stringify(calls).includes('synthetic-ui-only'), false)
  assert.equal([...h.storage.values()].includes('synthetic-ui-only'), false)
  assert.equal(system(tree).state, '已启用并通过校验')
  assert.ok(changed.length > 0)
})

test('credentials cannot fabricate a new input or auto-resume when host says the original slot cannot continue', async t => {
  let canResume = true, resumed = 0
  const client = { async get() { return receipt({ canResume }) }, async resume() { resumed++; return readyReceipt() } }
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: receipt(), client,
    mcpClient: { async connections() { return [source] }, async saveCredential() { return {} }, async requestStatus() { return null } } })
  await h.settle(); button(h.render(), '安全输入凭据').props.onClick(); await h.settle()
  canResume = false
  find(h.render(), 'stub-McpCredentialForm').props.onSaved({ saved: true }); const tree = await h.settle()
  assert.equal(resumed, 0)
  assert.match(text(tree), /请回原会话继续/)
  assert.equal(button(tree, '继续原配置'), undefined)
})

test('confirmation button only opens the exact existing approval and discloses other affected Bots', async t => {
  const opened = [], resumed = []
  const current = receipt({ state: 'needs_confirmation', approvalId: '76', credentialEntry: null, affectedBotIds: ['alpha', 'beta'], canResume: false })
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: current, botNames: { beta: '第二个 Bot' }, client: {
    async get() { return current }, async resume(value) { resumed.push(value); return readyReceipt() } }, onOpenApproval: id => opened.push(id) })
  await h.settle(); button(h.render(), '查看对应确认').props.onClick()
  assert.deepEqual(opened, ['76'])
  assert.deepEqual(resumed, [])
  assert.match(text(h.render()), /第二个 Bot/)
  assert.equal(button(h.render(), '同意'), undefined)
  assert.equal(button(h.render(), '以后直接做'), undefined)
})

test('setup client scopes GET and resume to the original IDs and rejects a different target without echoing raw errors', async () => {
  const calls = []
  const client = createCapabilitySetupClient({ token: 'fixture-api', fetchImpl: async (path, init) => { calls.push({ path, ...init }); return { ok: true, json: async () => ({ data: readyReceipt({ inputId: 11 }) }) } } })
  const fresh = await client.get(receipt())
  await client.resume(fresh)
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST'])
  assert.equal(calls[0].path, '/api/capability-setups/setup-fixture?taskId=1')
  assert.deepEqual(JSON.parse(calls[1].body), { taskId: 1, inputId: 11 })
  assert.equal(calls[1].path, '/api/capability-setups/setup-fixture/resume')
  assert.equal(Object.hasOwn(JSON.parse(calls[1].body), 'approved'), false)
  const wrong = createCapabilitySetupClient({ token: 'fixture-api', fetchImpl: async () => ({ ok: true, json: async () => ({ data: readyReceipt({ targetBotId: 'other' }) }) }) })
  await assert.rejects(wrong.get(receipt()), /没有对应上/)
})

test('real external approval uses trusted connection/original name and keeps the existing exact approval endpoint', async t => {
  const requests = [], updated = []
  const task = { taskId: 1, bot: { id: 'chief' }, runtime: { status: 'running' }, approvals: { activeId: 76, items: [{ id: 76, taskId: 1, toolName: 'mcp_long_hashed_alias', binding: 'native-binding', simulated: false,
    externalMcp: { connectionId: 'fixture', connectionName: 'Friendly connection', originalName: 'greeting.echo', description: 'Fixture tool' }, arguments: { text: 'hello' }, status: 'pending', createdAt: '2026-10-29T01:00:00Z', decision: null, receipt: null, before: null, allowAlways: true }] } }
  const h = await harness(t, './TaskApprovalControls.tsx', { token: 'fixture-api', task, scope: 'open', onUpdated: value => updated.push(value), onError: error => { throw error } }, async (path, init) => {
    requests.push({ path, ...init }); return { ok: true, json: async () => ({ task }) }
  })
  let tree = h.render(), card = system(tree)
  assert.match(card.title, /Friendly connection.*greeting.echo/)
  assert.equal(card.title.includes('mcp_long_hashed_alias'), false)
  assert.equal(find(tree, 'section').props['aria-label'], '操作确认')
  assert.equal(button(tree, '以后直接做'), undefined)
  button(tree, '同意').props.onClick(); tree = await h.settle()
  assert.match(requests[0].path, /\/approvals\/76\/decide$/)
  assert.deepEqual(JSON.parse(requests[0].body), { decision: 'approved', reason: '' })
  assert.equal(updated.length, 1)
})

test('App groups one latest host setup card and never promotes provider content, model prose or foreign-input receipts', async t => {
  const bots = [{ id: 'chief', name: 'Chief', description: '', configRef: { botId: 'chief', version: '1' } }, { id: 'alpha', name: 'Alpha', description: '', configRef: { botId: 'alpha', version: '1' } }]
  const message = (id, role, extra = {}) => ({ id, role, content: '', createdAt: '2026-10-29T01:00:00Z', ...extra })
  const messages = [
    message(10, 'user', { content: '把 fixture MCP 配给 Alpha' }),
    message(11, 'user', { content: '继续原配置' }),
    message(20, 'tool', { toolName: 'mcp_manage', inReplyTo: 10, arguments: { action: 'add', operationId: 'operation-fixture' }, result: { ok: true, data: receipt() } }),
    message(21, 'tool', { toolName: 'mcp_provider_alias', inReplyTo: 10, result: { ok: true, data: readyReceipt({ setupId: 'provider-forged' }) } }),
    message(22, 'assistant', { content: JSON.stringify(readyReceipt({ setupId: 'model-prose' })) }),
    message(23, 'tool', { toolName: 'skill_manage', inReplyTo: 99, result: { ok: true, data: readyReceipt({ setupId: 'foreign-input', inputId: 99 }) } }),
    message(24, 'tool', { toolName: 'mcp_manage', inReplyTo: 11, arguments: { action: 'resume', operationId: 'operation-fixture' }, result: { ok: true, data: readyReceipt() } }),
  ]
  const task = { taskId: 1, conversationId: 1, kind: 'main', title: 'Chief main', bot: bots[0], configRef: bots[0].configRef, createdAt: '2026-10-29T01:00:00Z', messages, parameters: { mode: 'test' }, parameterSources: {}, activeInputId: null,
    capabilitySetups: [readyReceipt({ inputId: 11 }), readyReceipt({ setupId: 'wrong-task', taskId: 999 })], runtime: { status: 'running', checkpoint: { phase: 'awaitInput' } } }
  const h = await harness(t, './App.tsx', {}, async (path) => {
    const body = path === '/api/bots' ? { bots, mainSessions: { chief: 1, alpha: 2 } } : path === '/api/tasks' ? { tasks: [] } : /\/configuration$/.test(path) ? { toolLabels: {} } : /\/tasks\/1$/.test(path) ? { task } : null
    assert.ok(body, `unexpected App read ${path}`)
    return { ok: true, json: async () => body }
  })
  const tree = await h.settle()
  const cards = nodes(tree).filter(node => node.type === h.cardModule.default)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].props.receipt.setupId, 'setup-fixture')
  assert.equal(cards[0].props.receipt.inputId, 11)
  assert.equal(cards[0].props.receipt.state, 'ready')
  // Only the original setup's earlier receipt points at its card; forged and foreign receipts say nothing.
  assert.equal(text(tree).match(/最新状态见下方的配置卡/g)?.length, 1)
})

test('a newer host projection queues a fresh GET and an older in-flight response cannot become verified state', async t => {
  const old = deferred(), fresh = deferred(), reads = []
  const client = { get(original) { reads.push([original.setupId, original.requestId]); return reads.length === 1 ? old.promise : fresh.promise }, async resume() { throw new Error('unexpected resume') } }
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: receipt(), client })
  h.render()
  h.update({ receipt: readyReceipt(), refreshKey: 1 })
  old.resolve(receipt())
  await h.settle()
  assert.equal(reads.length, 2)
  assert.equal(find(h.render(), 'stub-Switch'), undefined)
  assert.match(system(h.render()).state, /尚未核查/)
  fresh.resolve(readyReceipt())
  const tree = await h.settle()
  assert.equal(system(tree).state, '已启用并通过校验')
  assert.equal(find(tree, 'stub-Switch').props.checked, true)
  assert.deepEqual(reads, [['setup-fixture', 'setup-request'], ['setup-fixture', 'setup-request']])
})

test('credential completion waits for a fresh queued GET before resuming the unchanged setup', async t => {
  const previousRead = deferred(), events = []
  let reads = 0, current = receipt()
  const client = {
    async get(original) { events.push(`GET-${++reads}`); assert.equal(original.requestId, 'setup-request'); if (reads === 2) return previousRead.promise; return current },
    async resume(original) { events.push('RESUME'); assert.equal(original.inputId, 10); current = readyReceipt(); return current },
  }
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: current, client,
    mcpClient: { async connections() { return [source] }, async saveCredential() { return {} }, async requestStatus() { return null } } })
  await h.settle(); button(h.render(), '安全输入凭据').props.onClick(); await h.settle()
  const fields = find(h.render(), 'stub-McpCredentialForm').props
  h.update({ refreshKey: 1 }); await tick()
  assert.equal(reads, 2)
  fields.onSaved({ saved: true })
  previousRead.resolve(receipt())
  const tree = await h.settle()
  assert.deepEqual(events, ['GET-1', 'GET-2', 'GET-3', 'RESUME', 'GET-4'])
  assert.equal(system(tree).state, '已启用并通过校验')
})

test('host reconciliation can expose pending plus canResume, and only an explicit click resumes it', async t => {
  let current = receipt({ state: 'unknown' }), resumed = 0
  const client = { async get() { return current }, async resume(original) { resumed++; assert.equal(original.requestId, 'setup-request'); current = readyReceipt(); return current } }
  const h = await harness(t, './CapabilitySetupCard.tsx', { token: 'fixture', receipt: current, client })
  await h.settle()
  assert.equal(button(h.render(), '继续原配置'), undefined)
  current = receipt({ state: 'pending', credentialEntry: null, verification: { status: 'pending', summary: '原子请求回执已确认，等待明确续办', checkedAt: '2026-10-29T03:00:00Z' }, canResume: true })
  button(h.render(), '核查原配置').props.onClick(); await h.settle()
  assert.equal(resumed, 0)
  assert.ok(button(h.render(), '继续原配置'))
  button(h.render(), '继续原配置').props.onClick(); const tree = await h.settle()
  assert.equal(resumed, 1)
  assert.equal(system(tree).state, '已启用并通过校验')
})

function approvalTask(item) {
  return { taskId: 1, bot: { id: 'chief' }, runtime: { status: 'running' }, approvals: { activeId: item.id, items: [item] } }
}
const approvalItem = (change = {}) => ({ id: 76, taskId: 1, toolName: 'skill_manage', callId: 'native-call', inReplyTo: 10, binding: 'native-binding', simulated: false,
  arguments: { action: 'add', operationId: 'operation-fixture', targetBotId: 'alpha', source: { kind: 'local', path: '/tmp/fixture-skill' } },
  status: 'pending', createdAt: '2026-10-29T01:00:00Z', decision: null, receipt: null, before: null, allowAlways: false, ...change })

test('secondary Skill confirmation shows the tools it turns on and the affected Bots, not internal ids or the original add scope', async t => {
  const item = approvalItem({ capabilitySetupSpec: { setupId: 'setup-fixture', taskId: 1, inputId: 10, targetBotId: 'alpha', scope: 'skill-mechanisms', sourceFingerprint: 'frozen-source', capabilityId: 'skill:fixture',
    affectedBotIds: ['alpha', 'beta'], tools: ['skill_activate', 'skill_deactivate', 'skill_read_resource'] } })
  const h = await harness(t, './TaskApprovalControls.tsx', { token: 'fixture', task: approvalTask(item), scope: 'open', onUpdated() {}, onError() {} })
  const tree = h.render(), shown = nodes(tree).map(text).join(' ')
  assert.match(shown, /使用 Skill 需要的工具/)
  for (const name of ['启用技能', '停用技能', '读取技能资料']) assert.ok(shown.includes(name))
  assert.match(shown, /alpha、beta/)
  assert.doesNotMatch(shown, /frozen-source|setup-fixture/)
  assert.equal(button(tree, '以后直接做'), undefined)
})

test('an approved manager operation without provider capabilities renders its setup status instead of mounting calendar recovery', async t => {
  const item = approvalItem({ status: 'dispatching', decision: { decision: 'approved', reason: '', source: 'authenticated-user', createdAt: '2026-10-29T01:00:00Z' },
    operation: { id: 'manager-operation', intentEntryId: 91, taskId: 1, approvalId: 76, inReplyTo: 10, toolName: 'skill_manage', binding: 'native-binding', retryable: false, createdAt: '2026-10-29T01:00:00Z' } })
  const h = await harness(t, './TaskApprovalControls.tsx', { token: 'fixture', task: approvalTask(item), scope: 'open', onUpdated() {}, onError() {} })
  const tree = h.render()
  assert.equal(find(tree, 'stub-ActionOutcomeControls'), undefined)
  assert.match(text(tree), /原配置操作已登记/)
  assert.match(system(tree).state, /已发出，等结果/)
  const settled = { ...item, status: 'setup-pending', receipt: { id: 92, createdAt: '2026-10-29T01:00:00Z', result: { ok: true, data: receipt() } } }
  h.update({ task: approvalTask(settled), scope: 'settled' })
  const afterReceipt = h.render()
  assert.equal(find(afterReceipt, 'stub-ActionOutcomeControls'), undefined)
  assert.match(system(afterReceipt).state, /配置已完成/)
})

test('legacy calendar operations retain their original recovery component and capability metadata', async t => {
  const operation = { id: 'calendar-operation', intentEntryId: 91, createdAt: '2026-10-29T01:00:00Z', capabilities: { stableIdempotency: true, reliableQuery: false } }
  const item = approvalItem({ toolName: 'calendar_reschedule_event', operation, status: 'outcome-unknown', arguments: { resource: 'mock:personal', title: 'Fixture event', start: '2026-10-29T01:00:00Z', end: '2026-10-29T02:00:00Z' },
    decision: { decision: 'approved', reason: '', source: 'authenticated-user', createdAt: '2026-10-29T01:00:00Z' } })
  const h = await harness(t, './TaskApprovalControls.tsx', { token: 'fixture', task: approvalTask(item), scope: 'open', onUpdated() {}, onError() {} })
  const tree = h.render(), recovery = find(tree, 'stub-ActionOutcomeControls')
  assert.ok(recovery)
  assert.equal(recovery.props.item.operation, operation)
  assert.equal(recovery.props.item.operation.capabilities.stableIdempotency, true)
})

async function appWithMessages(t, messages, approvals = { activeId: null, items: [] }) {
  const bots = [{ id: 'chief', name: 'Chief', description: '', configRef: { botId: 'chief', version: '1' } }, { id: 'alpha', name: 'Alpha', description: '', configRef: { botId: 'alpha', version: '1' } }]
  const task = { taskId: 1, conversationId: 1, kind: 'main', title: 'Chief main', bot: bots[0], configRef: bots[0].configRef, createdAt: '2026-10-29T01:00:00Z', messages,
    parameters: { mode: 'test' }, parameterSources: {}, activeInputId: 10, capabilitySetups: [], approvals, runtime: { status: 'running', checkpoint: { phase: approvals.activeId ? 'awaitApproval' : 'awaitInput' } } }
  return harness(t, './App.tsx', {}, async path => {
    const body = path === '/api/bots' ? { bots, mainSessions: { chief: 1, alpha: 2 } } : path === '/api/tasks' ? { tasks: [] } : /\/configuration$/.test(path) ? { toolLabels: {} } : /\/tasks\/1$/.test(path) ? { task } : null
    assert.ok(body, `unexpected App read ${path}`)
    return { ok: true, json: async () => body }
  })
}
const historyMessage = (id, role, extra = {}) => ({ id, role, content: '', createdAt: '2026-10-29T01:00:00Z', ...extra })

test('App renders a genuine initial manager approval as waiting, without creating a setup or reporting failed association', async t => {
  const args = { action: 'add', operationId: 'operation-fixture', targetBotId: 'alpha', expectedRevision: 'target-1', config: { connectionId: 'fixture', name: 'Fixture', transport: 'streamable-http', url: 'https://example.com/mcp' } }
  const item = approvalItem({ toolName: 'mcp_manage', arguments: args, capabilityIntent: { kind: 'mcp', proposal: args, sourceFingerprint: 'frozen-origin', scope: 'target-bot' } })
  const messages = [historyMessage(10, 'user', { content: '将这个 MCP 接给 Alpha' }), historyMessage(20, 'tool', { toolName: 'mcp_manage', inReplyTo: 10, callId: 'native-call', arguments: args,
    result: { ok: true, data: { approvalId: 76, taskId: 1, status: 'waiting-for-user-approval' } } })]
  const h = await appWithMessages(t, messages, { activeId: 76, items: [item] }), tree = await h.settle()
  assert.match(text(tree), /等你确认，还没配置/)
  assert.equal(button(tree, '查看确认').props.disabled, undefined)
  assert.doesNotMatch(text(tree), /未通过原 Task/)
  assert.equal(nodes(tree).filter(node => node.type === h.cardModule.default).length, 0)
  assert.equal(capabilityManagerNotice({ ...messages[1], toolName: 'mcp_provider_alias' }, 1, messages, [item]), null)
  assert.equal(capabilityManagerNotice(messages[1], 2, messages, [item]), null)
})

test('App manager inspect reports a read-only directory result and never turns ordinary provider output into setup success', async t => {
  const data = { kind: 'mcp', action: 'inspect', targetBotId: 'alpha', targetRevision: 'target-1', capabilities: [{ id: 'tool:calendar' }] }
  const messages = [historyMessage(10, 'user', { content: '检查 Alpha 的 MCP 目录' }), historyMessage(20, 'tool', { toolName: 'mcp_manage', inReplyTo: 10, callId: 'inspect-native', arguments: { action: 'inspect', targetBotId: 'alpha' }, result: { ok: true, data } })]
  const h = await appWithMessages(t, messages), tree = await h.settle()
  assert.match(text(tree), /已查看 Alpha 的 MCP（1 项）/)
  assert.ok(button(tree, '查看机器人能力'))
  assert.doesNotMatch(text(tree), /未通过原 Task/)
  assert.equal(nodes(tree).filter(node => node.type === h.cardModule.default).length, 0)
  assert.equal(capabilityManagerNotice({ ...messages[1], role: 'assistant' }, 1, messages), null)
  assert.equal(capabilityManagerNotice({ ...messages[1], toolName: 'mcp_provider_alias' }, 1, messages), null)
})

const externalApproval = (change = {}) => approvalItem({ toolName: 'mcp_fixture_greeting_echo', arguments: { text: 'hello fixture' },
  externalMcp: { connectionId: 'fixture', connectionName: 'SDK fixture', originalName: 'greeting.echo', catalogRevision: 'catalog-1' }, ...change })
const externalOperation = () => ({ id: 'external-operation-fixture', intentEntryId: 91, taskId: 1, approvalId: 76, inReplyTo: 10, binding: 'native-binding',
  toolName: 'mcp_fixture_greeting_echo', arguments: { text: 'hello fixture' }, createdAt: '2026-10-29T01:00:00Z', retryable: false })
const approvedDecision = () => ({ decision: 'approved', reason: '', source: 'authenticated-user', createdAt: '2026-10-29T01:00:00Z' })

test('external MCP first confirmation renders its authenticated approval transition without calendar recovery assumptions', async t => {
  const item = externalApproval(), requests = []
  const approved = approvalTask({ ...item, decision: approvedDecision() })
  let h
  h = await harness(t, './TaskApprovalControls.tsx', { token: 'fixture', task: approvalTask(item), scope: 'open', onUpdated: task => h.update({ task }), onError: error => { throw error } }, async (path, init) => {
    requests.push({ path, ...init }); return { ok: true, json: async () => ({ task: approved }) }
  })
  assert.match(system(h.render()).state, /等你确认，还没执行/)
  assert.equal(find(h.render(), 'stub-ActionOutcomeControls'), undefined)
  button(h.render(), '同意').props.onClick()
  const tree = await h.settle()
  assert.deepEqual(JSON.parse(requests[0].body), { decision: 'approved', reason: '' })
  assert.match(system(tree).state, /已决定/)
  assert.equal(find(tree, 'stub-ActionOutcomeControls'), undefined)
  assert.equal(button(tree, '以后直接做'), undefined)
})

test('external MCP dispatching operation without calendar capabilities renders conservative pending evidence', async t => {
  const item = externalApproval({ status: 'dispatching', decision: approvedDecision(), operation: externalOperation() })
  const task = approvalTask(item); task.approvals.activeId = null
  const h = await harness(t, './TaskApprovalControls.tsx', { token: 'fixture', task, scope: 'open', onUpdated() {}, onError() {} })
  const tree = h.render()
  assert.equal(Object.hasOwn(item.operation, 'capabilities'), false)
  assert.equal(find(tree, 'stub-ActionOutcomeControls'), undefined)
  assert.match(system(tree).state, /等结果/)
  assert.match(text(tree), /外部调用已发出，等结果/)
  assert.match(text(tree), /不会自动重新调用/)
  assert.doesNotMatch(text(tree), /external-operation-fixture/)
  assert.doesNotMatch(text(tree), /请在日历中核对|稳定幂等恢复/)
})

test('settled external MCP result displays its real SDK receipt without creating calendar query or recovery controls', async t => {
  const item = externalApproval({ status: 'executed', decision: approvedDecision(), operation: externalOperation(),
    receipt: { id: 94, source: 'tool', createdAt: '2026-10-29T01:01:00Z', result: { ok: true, data: { content: [{ type: 'text', text: 'hello fixture' }], structuredContent: { echoed: 'hello fixture' } } } } })
  const task = approvalTask(item); task.approvals.activeId = null
  const h = await harness(t, './TaskApprovalControls.tsx', { token: 'fixture', task, scope: 'settled', onUpdated() {}, onError() {} })
  const tree = h.render()
  assert.equal(find(tree, 'stub-ActionOutcomeControls'), undefined)
  assert.equal(system(tree).state, '已完成')
  assert.match(text(tree), /外部调用完成/)
  // The card says one sentence; the raw SDK result stays in the conversation's tool-call row.
  assert.doesNotMatch(text(tree), /structuredContent/)
  assert.doesNotMatch(text(tree), /真实飞书操作API|请在日历中核对|稳定幂等恢复/)
})

test('external MCP unknown intent and saved unknown receipt both stay conservative without auto-query or retry controls', async t => {
  const operation = { ...externalOperation(), unknownAt: '2026-10-29T01:02:00Z' }
  const item = externalApproval({ status: 'outcome-unknown', decision: approvedDecision(), operation })
  const task = approvalTask(item); task.approvals.activeId = null
  const h = await harness(t, './TaskApprovalControls.tsx', { token: 'fixture', task, scope: 'open', onUpdated() {}, onError() {} })
  let tree = h.render()
  assert.equal(find(tree, 'stub-ActionOutcomeControls'), undefined)
  assert.equal(system(tree).state, '结果不明，不会自动重试')
  assert.match(text(tree), /没确认外部调用结果/)
  const recorded = { ...item, receipt: { id: 95, source: 'tool', createdAt: '2026-10-29T01:02:00Z',
    result: { ok: false, error: { code: 'MCP_INVOCATION_UNKNOWN', message: '原调用结果尚未核实', unknown: true, retryable: false } } } }
  h.update({ task: approvalTask(recorded), scope: 'settled' })
  tree = h.render()
  assert.equal(find(tree, 'stub-ActionOutcomeControls'), undefined)
  assert.equal(system(tree).state, '结果不明，不会自动重试')
  assert.match(text(tree), /请核对实际状态/)
  assert.doesNotMatch(text(tree), /请在日历中核对|稳定幂等恢复/)
})
