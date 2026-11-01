import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { createSessionActionHandlers } from './session-lifecycle-client.mjs'
import { publishCapabilityChange, subscribeCapabilityChanges } from './capabilities-changed.mjs'

// Real TSX handlers and the real refresh hook/controller; only DOM layout and child rendering are adapted.
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...(node.type === 'stub-EditorDialog' && !node.props.open ? [] : [...nodes(node.props.children), ...nodes(node.props.footer)])]
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
const find = (tree, type, match = () => true) => nodes(tree).find(node => node.type === type && match(node.props))
const button = (tree, label) => find(tree, 'button', props => text(props.children) === label)
const tick = () => new Promise(resolve => setImmediate(resolve))
const response = data => ({ ok: true, status: 200, json: async () => ({ data }) })
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const capability = (overrides = {}) => ({ id: 'mcp:fixture', kind: 'mcp', name: 'Fixture connection', description: 'fixture', status: 'ready', revision: 'catalog-1', enabledForBot: false, ...overrides })
const catalog = (botId = 'alpha', overrides = {}) => ({ botId, revision: 'bot-1', items: [capability()], ...overrides })

async function harness(t, filename, initialProps, fetchImpl = async () => response({})) {
  const hooksUrl = dataModule(`
    let cursor = 0, queue = [], writes = 0
    const slots = [], cleanup = []
    export function start() { cursor = 0 }
    export function writeCount() { return writes }
    export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { writes++; slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }
    export function useRef(initial) { return useState(() => ({ current: initial }))[0] }
    export function useId() { return useState(() => 'fixture-' + Math.random().toString(36).slice(2))[0] }
    export function useMemo(callback, deps) { const index = cursor++, previous = slots[index]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[index] = { deps, value: callback() }; return slots[index].value }
    export function useCallback(callback, deps) { return useMemo(() => callback, deps) }
    export function useEffect(callback, deps) { const index = cursor++, previous = slots[index]; if (!previous || !deps || deps.some((value, i) => value !== previous[i])) { slots[index] = deps; queue.push(() => { cleanup[index]?.(); cleanup[index] = callback() }) } }
    export const useLayoutEffect = useEffect
    export function flush() { const work = queue; queue = []; for (const callback of work) callback() }
    export function dispose() { for (const callback of cleanup) callback?.() }
    // ${Math.random()}
  `)
  const hooks = await import(hooksUrl)
  const lookUrl = dataModule('export const lookColors = [], accessories = [], accessoryLabels = {}; export function loadLook() { return {} } export function saveLook() {}')
  let hookUrl
  async function compile(name) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      fileName: name,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      transformers: { before: [context => root => ts.visitNode(root, function visit(node) {
        if (!ts.isImportDeclaration(node)) return ts.visitEachChild(node, visit, context)
        if (!node.importClause || node.importClause.isTypeOnly) return undefined
        const path = node.moduleSpecifier.text
        const module = path === 'react' ? hooksUrl : path === './useWorkspaceRefresh' ? hookUrl : path === './botLook' ? lookUrl : path.endsWith('.mjs') ? new URL(path, import.meta.url).href : null
        if (module) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, ts.factory.createStringLiteral(module), node.attributes)
        const names = [node.importClause.name?.text, ...(node.importClause.namedBindings?.elements ?? []).filter(item => !item.isTypeOnly).map(item => item.name.text)].filter(Boolean)
        return ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList(names.map(name => ts.factory.createVariableDeclaration(name, undefined, undefined, ts.factory.createStringLiteral(`stub-${name}`))), ts.NodeFlags.Const))
      })] },
    }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    return dataModule(compiled)
  }
  hookUrl = await compile('./useWorkspaceRefresh.ts')
  const Component = (await import(await compile(filename))).default
  const originals = new Map(), timers = new Map(), listeners = new Map()
  let timerId = 0, closed = false, props = { ...initialProps }
  function replace(key, value) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  const surface = name => ({ addEventListener(type, listener) { const key = `${name}:${type}`; if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(listener) }, removeEventListener(type, listener) { listeners.get(`${name}:${type}`)?.delete(listener) } })
  replace('fetch', fetchImpl)
  replace('document', { ...surface('document'), visibilityState: 'visible' })
  replace('window', surface('window'))
  replace('navigator', { onLine: true })
  replace('setTimeout', (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId })
  replace('clearTimeout', id => timers.delete(id))
  function close() {
    if (closed) return
    closed = true; hooks.dispose()
    for (const [key, previous] of originals) { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key] }
  }
  t.after(close)
  function render() { hooks.start(); let tree = Component(props); while (typeof tree.type === 'function') tree = tree.type(tree.props); hooks.flush(); return tree }
  async function settle() { for (let n = 0; n < 5; n++) { render(); await tick() } return render() }
  return { render, settle, close, writes: hooks.writeCount,
    update(next) { props = { ...props, ...next }; return render() },
    fireTimer(delay) { const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `missing timer ${delay}`); timers.delete(entry[0]); entry[1].callback() },
    timerCount: delay => [...timers.values()].filter(timer => timer.delay === delay).length }
}

function list(tree) { return find(tree, 'stub-CapabilityPicker')?.props }

test('same Bot capabilities load on visible entry and refresh through the existing bounded controller without remounting', async t => {
  let current = catalog(), reads = 0
  const h = await harness(t, './BotCapabilities.tsx', { token: 'fixture-token', botId: 'alpha', readOnly: false, active: false }, async () => {
    reads++
    return response(structuredClone(current))
  })
  await h.settle(); assert.equal(reads, 0)
  h.update({ active: true }); await h.settle()
  assert.deepEqual(list(h.render()).items.map(item => item.id), ['mcp:fixture'])
  current = catalog('alpha', { revision: 'bot-2', items: [capability(), capability({ id: 'mcp:new', name: 'Newly registered' })] })
  h.fireTimer(15000); await h.settle()
  assert.deepEqual(list(h.render()).items.map(item => item.id), ['mcp:fixture', 'mcp:new'])
  h.update({ active: false }); await h.settle()
  const hiddenReads = reads
  assert.equal(h.timerCount(15000), 0)
  current = catalog('alpha', { revision: 'bot-3', items: [capability({ id: 'mcp:after-check', status: 'needs_auth' })] })
  h.update({ active: true }); await h.settle()
  assert.ok(reads > hiddenReads)
  assert.equal(list(h.render()).items[0].id, 'mcp:after-check')
  assert.equal(list(h.render()).items[0].status, 'needs_auth')
})

test('capability changes silently reconcile server state without resending mutations', async t => {
  let current = catalog(), reads = 0, posts = 0
  const changes = []
  const unsubscribe = subscribeCapabilityChanges(change => changes.push(change))
  t.after(unsubscribe)
  const h = await harness(t, './BotCapabilities.tsx', { token: 'fixture-token', botId: 'alpha', readOnly: false, active: true }, async (_path, init) => {
    if (init.method === 'POST') { posts++; current = catalog('alpha', { revision: 'bot-2', items: [capability({ enabledForBot: true })] }); return response({}) }
    reads++
    return response(structuredClone(current))
  })
  await h.settle()
  assert.equal(button(h.render(), '刷新状态'), undefined)
  current = catalog('alpha', { revision: 'external-change', items: [capability({ id: 'mcp:new' })] })
  publishCapabilityChange({ botId: 'alpha', revision: 'external-change' })
  await h.settle()
  assert.equal(list(h.render()).items[0].id, 'mcp:new')
  const before = reads
  h.fireTimer(15000)
  await h.settle()
  assert.ok(reads > before)
  assert.equal(posts, 0)
  list(h.render()).onToggle('mcp:new', true)
  await h.settle()
  assert.equal(posts, 1)
  assert.equal(changes.at(-1).botId, 'alpha')
  assert.ok(text(h.render()).includes('当前会话从下一步使用最新能力'))
})

test('background capability reads cannot overwrite the original in-flight mutation or its unknown retry', async t => {
  let current = catalog(), delayedRead, delayNextRead = false
  const firstPost = deferred(), posts = []
  const h = await harness(t, './BotCapabilities.tsx', { token: 'fixture-token', botId: 'alpha', readOnly: false, active: true }, async (_path, init) => {
    if (init.method === 'POST') {
      posts.push(JSON.parse(init.body))
      if (posts.length === 1) return firstPost.promise
      current = catalog('alpha', { revision: 'bot-2', items: [capability({ enabledForBot: true })] })
      return response({ enabledForBot: true })
    }
    if (delayNextRead) { delayNextRead = false; delayedRead = deferred(); return delayedRead.promise }
    return response(structuredClone(current))
  })
  await h.settle(); delayNextRead = true
  h.fireTimer(15000); await tick()
  assert.ok(delayedRead)
  list(h.render()).onToggle('mcp:fixture', true)
  await h.settle()
  assert.equal(posts.length, 1)
  assert.equal(list(h.render()).pendingId, 'mcp:fixture')
  delayedRead.resolve(response(catalog('alpha', { revision: 'stale', items: [capability({ id: 'mcp:stale' })] })))
  await h.settle()
  assert.equal(list(h.render()).items[0].id, 'mcp:fixture')
  firstPost.reject(new Error('fixture response lost'))
  await h.settle(); h.update({ active: false }); h.update({ active: true }); await h.settle()
  assert.equal(h.timerCount(15000), 0)
  assert.ok(button(h.render(), '重试'))
  button(h.render(), '重试').props.onClick()
  await h.settle()
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1], posts[0])
  assert.equal(posts[0].expectedRevision, 'bot-1')
  assert.equal(posts[0].expectedCatalogRevision, 'catalog-1')
  assert.deepEqual(list(h.render()).enabled, ['mcp:fixture'])
})

test('late capability reads from a disposed Bot cannot update a newly mounted Bot', async t => {
  const oldRead = deferred()
  const first = await harness(t, './BotCapabilities.tsx', { token: 'old-token', botId: 'alpha', readOnly: false, active: true }, async () => oldRead.promise)
  await tick(); first.render(); await tick(); first.close()
  const oldWrites = first.writes()
  const next = await harness(t, './BotCapabilities.tsx', { token: 'new-token', botId: 'beta', readOnly: false, active: true }, async () => response(catalog('beta', { items: [capability({ id: 'mcp:beta' })] })))
  await next.settle()
  oldRead.resolve(response(catalog('alpha', { items: [capability({ id: 'mcp:old-alpha' })] })))
  await next.settle()
  assert.equal(first.writes(), oldWrites)
  assert.equal(list(next.render()).items[0].id, 'mcp:beta')
})

test('Bot settings activate the capability reader only when the capability tab is visible', async t => {
  const props = { bot: { id: 'alpha', name: 'Alpha', description: '', configRef: { botId: 'alpha', version: '1' } }, token: 'fixture-token',
    active: false, tab: 'capabilities', mainTaskId: 1, onTab() {}, onChat() {}, onSaved() {}, onDeactivate() {} }
  const h = await harness(t, './BotTemplatePage.tsx', props)
  assert.equal(find(h.render(), 'stub-BotCapabilities').props.active, false)
  h.update({ active: true })
  assert.equal(find(h.render(), 'stub-BotCapabilities').props.active, true)
  h.update({ tab: 'memory' })
  assert.equal(find(h.render(), 'stub-BotCapabilities').props.active, false)
})

const target = { taskId: 44, botId: 'alpha', kind: 'session', title: 'Fixture session' }
const deletion = requestId => ({ taskId: 44, botId: 'alpha', action: 'delete', deleted: true, deletedAt: '2026-10-29T01:00:00Z', replacementTaskId: null, requestId, replayed: false })
async function openConfirmation(h) { button(h.render(), '⋯').props.onClick(); button(h.render(), '删除会话').props.onClick(); return h.render() }

test('session definite failure retains the row and exposes a separate explicit retry with the same target and request', async t => {
  const calls = [], completed = []
  const handlers = createSessionActionHandlers(async (path, init) => {
    calls.push({ path, ...init })
    if (init.method === 'GET') return { data: { taskId: 44, action: 'delete', state: 'failed', code: 'SESSION_STOP_FAILED' } }
    if (calls.filter(call => call.method === 'POST').length === 1) throw Object.assign(new Error('fixture stop failed'), { status: 409, code: 'SESSION_STOP_FAILED' })
    return { data: deletion(JSON.parse(init.body).requestId) }
  })
  const h = await harness(t, './SessionActions.tsx', { target, onAction: handlers.action, onVerify: handlers.verify, onComplete: result => completed.push(result) })
  await openConfirmation(h); button(h.render(), '删除会话').props.onClick()
  await h.settle()
  assert.equal(completed.length, 0)
  assert.ok(button(h.render(), '重试'))
  button(h.render(), '核对删除结果').props.onClick(); await h.settle()
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET'])
  assert.equal(completed.length, 0)
  button(h.render(), '重试').props.onClick(); await h.settle()
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'POST'])
  assert.equal(calls[2].path, calls[0].path)
  assert.equal(calls[2].body, calls[0].body)
  assert.equal(completed.length, 1)
  assert.equal(completed[0].requestId, JSON.parse(calls[0].body).requestId)
})

test('pending session deletion remains query-only; a durable unknown outcome permits only a separate user retry', async t => {
  const calls = [], completed = []
  let state = 'pending'
  const handlers = createSessionActionHandlers(async (path, init) => {
    calls.push({ path, ...init })
    if (init.method === 'GET') return { data: { taskId: 44, action: 'delete', state, code: 'SESSION_STOP_UNKNOWN' } }
    if (calls.filter(call => call.method === 'POST').length === 1) throw new Error('fixture response lost')
    return { data: deletion(JSON.parse(init.body).requestId) }
  })
  const h = await harness(t, './SessionActions.tsx', { target, onAction: handlers.action, onVerify: handlers.verify, onComplete: result => completed.push(result) })
  await openConfirmation(h); button(h.render(), '删除会话').props.onClick(); await h.settle()
  assert.equal(button(h.render(), '重试'), undefined)
  button(h.render(), '核对删除结果').props.onClick(); await h.settle()
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET'])
  assert.equal(button(h.render(), '重试'), undefined)
  state = 'unknown'
  button(h.render(), '核对删除结果').props.onClick(); await h.settle()
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'GET'])
  assert.equal(completed.length, 0)
  button(h.render(), '重试').props.onClick(); await h.settle()
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'GET', 'POST'])
  assert.equal(calls[3].body, calls[0].body)
  assert.equal(completed.length, 1)
})

test('a missing original session request offers explicit retry and GET never performs the mutation', async t => {
  const calls = [], completed = []
  const handlers = createSessionActionHandlers(async (path, init) => {
    calls.push({ path, ...init })
    if (init.method === 'GET') throw Object.assign(new Error('not found'), { status: 404, code: 'SESSION_REQUEST_NOT_FOUND' })
    if (calls.length === 1) throw new Error('fixture network failure')
    return { data: deletion(JSON.parse(init.body).requestId) }
  })
  const h = await harness(t, './SessionActions.tsx', { target, onAction: handlers.action, onVerify: handlers.verify, onComplete: result => completed.push(result) })
  await openConfirmation(h); button(h.render(), '删除会话').props.onClick(); await h.settle()
  button(h.render(), '核对删除结果').props.onClick(); await h.settle()
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET'])
  assert.equal(completed.length, 0)
  assert.ok(button(h.render(), '重试'))
  button(h.render(), '重试').props.onClick(); await h.settle()
  assert.equal(calls[2].body, calls[0].body)
  assert.equal(completed.length, 1)
})
