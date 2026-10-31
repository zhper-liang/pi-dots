import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { applyMention, buildMentionCandidates, findMentionToken } from './mentions.mjs'

// Execute the real App and its handlers with deterministic hook/transport adapters.
// Child component shells and browser layout are not mounted: these are NOT browser tests.
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const bots = [
  { id: 'chief', name: 'Chief', description: '', status: 'active', configRef: { botId: 'chief', version: 'v1' } },
  { id: 'alpha', name: '同名', description: '', status: 'active', configRef: { botId: 'alpha', version: 'v1' } },
  { id: 'beta', name: '同名', description: '', status: 'active', configRef: { botId: 'beta', version: 'v1' } },
]
function task(taskId, botId, group = false) {
  const bot = bots.find(item => item.id === botId)
  return { taskId, conversationId: taskId, title: `fixture-${taskId}`, bot, kind: group ? 'group' : 'main', ...(group ? { groupId: 'fixture-group', group: { adminBotId: 'chief', members: bots } } : {}),
    configRef: bot.configRef, createdAt: '2026-10-29T00:00:00Z', messages: [], activeInputId: null, parameters: { mode: 'test' }, parameterSources: {}, runtime: { status: 'running', checkpoint: { phase: 'awaitInput' } } }
}
const tasks = [task(1, 'chief'), task(2, 'alpha'), task(3, 'chief', true), task(4, 'beta')]
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...nodes(node.props.children), ...nodes(node.props.home)]
}
const find = (tree, type, match = () => true) => nodes(tree).find(node => node.type === type && match(node.props))

async function harness(t, { initial = 3, failSend = false } = {}) {
  const hooksUrl = dataModule(`
    let cursor = 0, queue = []
    const slots = [], cleanup = []
    export function start() { cursor = 0 }
    export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }
    export function useRef(initial) { return useState(() => ({ current: initial }))[0] }
    export function useEffect(callback, deps) { const index = cursor++, previous = slots[index]; if (!previous || deps.some((value, i) => value !== previous[i])) { slots[index] = deps; queue.push(() => { cleanup[index]?.(); cleanup[index] = callback() }) } }
    export function flush() { const work = queue; queue = []; for (const callback of work) callback() }
    export function dispose() { for (const callback of cleanup) callback?.() }
    // unique ${Math.random()}
  `)
  const hooks = await import(hooksUrl)
  const replacements = new Map([['react', hooksUrl]])
  for (const name of ['taskPath', 'taskStatus']) {
    const text = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8')
    replacements.set(`./${name}`, dataModule(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText))
  }
  replacements.set('./useDrawer', dataModule('export function useDrawer() {} export function useMediaQuery() { return false }'))
  replacements.set('./automation', dataModule('export async function setAutomationPaused() {}'))
  const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [context => root => ts.visitNode(root, function visit(node) {
      if (!ts.isImportDeclaration(node)) return ts.visitEachChild(node, visit, context)
      const path = node.moduleSpecifier.text
      if (!node.importClause || node.importClause.isTypeOnly) return undefined
      const module = replacements.get(path) ?? (path.endsWith('.mjs') ? new URL(path, import.meta.url).href : null)
      if (module) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, ts.factory.createStringLiteral(module), node.attributes)
      const names = [node.importClause.name?.text, ...(node.importClause.namedBindings?.elements ?? []).filter(item => !item.isTypeOnly).map(item => item.name.text)].filter(Boolean)
      return ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList(names.map(name => ts.factory.createVariableDeclaration(name, undefined, undefined, ts.factory.createStringLiteral(`stub-${name}`))), ts.NodeFlags.Const))
    })] },
  }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  const App = (await import(dataModule(compiled))).default
  const originals = new Map(), replace = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  const requests = [], storage = new Map([['pidot.api-token', 'fixture-token']]), timers = [], rafs = []
  const location = { hash: `#bot=${initial === 3 ? 'groups' : tasks.find(item => item.taskId === initial).bot.id}&task=${initial}` }
  replace('location', location)
  replace('sessionStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) })
  replace('document', { documentElement: { scrollHeight: 0 }, body: {}, getElementById() { return null } })
  replace('innerHeight', 0); replace('scrollY', 0)
  replace('ResizeObserver', class { observe() {} disconnect() {} })
  replace('window', { history: { pushState(a, b, hash) { location.hash = hash }, replaceState(a, b, hash) { location.hash = hash } }, addEventListener() {}, removeEventListener() {}, confirm() { return true } })
  replace('setTimeout', callback => { timers.push(callback); return timers.length })
  replace('clearTimeout', () => {})
  replace('requestAnimationFrame', callback => { rafs.push(callback); return rafs.length })
  replace('fetch', async (url, options = {}) => {
    if (options.method === 'POST') {
      requests.push({ url, body: JSON.parse(options.body) })
      if (failSend) throw new Error('synthetic disconnect')
      return { ok: true, json: async () => ({}) }
    }
    let value
    if (url === '/api/bots') value = { bots, mainSessions: { chief: 1, alpha: 2, beta: 4 } }
    else if (url === '/api/tasks') value = { tasks }
    else if (/\/configuration$/.test(url)) value = { toolLabels: {} }
    else if (/\/tasks\/\d+$/.test(url)) value = { task: tasks.find(item => item.taskId === Number(url.split('/').at(-1))) }
    else throw new Error(`Unexpected test API ${url}`)
    return { ok: true, json: async () => value }
  })
  t.after(() => { hooks.dispose(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  let tree
  const input = { value: '', selectionStart: 0, selectionEnd: 0, dataset: {}, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } }
  function render() {
    hooks.start(); tree = App()
    const textarea = find(tree, 'textarea')
    if (textarea) { input.value = textarea.props.value; input.dataset.taskId = String(textarea.props['data-task-id']); textarea.props.ref.current = input }
    hooks.flush(); while (rafs.length) rafs.shift()()
    return tree
  }
  async function settle() { for (let i = 0; i < 4; i++) { render(); await new Promise(resolve => setImmediate(resolve)) } return render() }
  await settle()
  return { requests, render, settle, input,
    type(text, caret = text.length) { const textarea = find(render(), 'textarea'); input.value = text; input.selectionStart = caret; input.selectionEnd = caret; textarea.props.onChange({ currentTarget: input }); return render() },
    async submit() { find(render(), 'form', props => props.className === 'message-form shell-composer').props.onSubmit({ preventDefault() {} }); return settle() },
    async open(id) { find(render(), 'stub-UnifiedWorkspace').props.onOpenTask(id, id === 3 ? 'groups' : tasks.find(item => item.taskId === id).bot.id); return settle() },
  }
}

function pick(tree, botId) {
  const menu = find(tree, 'stub-MentionMenu'), props = menu.props
  const candidate = buildMentionCandidates(props.bots, props.context).find(item => item.botId === botId)
  const selected = applyMention(props.draft, findMentionToken(props.draft, props.selectionStart, props.selectionEnd), candidate, { bindings: props.bindings })
  assert.ok(selected)
  props.onPick(selected)
  return selected
}

test('R1 App sends selected stable same-name IDs in prose order, never expands literal names, includes empty targets', async t => {
  const h = await harness(t)
  pick(h.type('@'), 'beta')
  let tree = h.render()
  pick(h.type(find(tree, 'textarea').props.value + '@'), 'alpha')
  await h.submit()
  assert.deepEqual(h.requests[0].body.targetBotIds, ['beta', 'alpha'])
  assert.equal(Object.hasOwn(h.requests[0].body, 'targetBotId'), false)
  assert.ok(h.requests[0].body.requestId)
  h.type('手写 @同名 不是候选绑定')
  await h.submit()
  assert.deepEqual(h.requests[1].body.targetBotIds, [])
})

test('R1 App reconciles edited bindings, tracks selection, disables menus during IME and keeps slash Skill', async t => {
  const h = await harness(t)
  pick(h.type('@'), 'beta')
  h.type('binding removed @')
  let tree = h.render(), menu = find(tree, 'stub-MentionMenu')
  assert.deepEqual(menu.props.bindings, [])
  h.input.selectionStart = 2; h.input.selectionEnd = 2
  find(tree, 'textarea').props.onSelect({ currentTarget: h.input })
  assert.equal(find(h.render(), 'stub-MentionMenu').props.selectionStart, 2)
  tree = h.type('@')
  find(tree, 'textarea').props.onCompositionStart()
  tree = h.render()
  assert.equal(find(tree, 'stub-MentionMenu').props.disabled, true)
  assert.equal(find(tree, 'stub-CommandMenu').props.enabled, false)
  await h.submit(); assert.equal(h.requests.length, 0)
  find(h.render(), 'textarea').props.onCompositionEnd({ currentTarget: h.input })
  tree = h.type('/skill')
  assert.equal(find(tree, 'stub-MentionMenu').props.disabled, true)
  const before = find(tree, 'stub-CommandMenu').props.refreshKey
  await h.open(1)
  tree = h.type('/skill')
  find(tree, 'stub-CommandMenu').props.onPick({ kind: 'skill', id: 'skill:fixture', skillId: 'fixture', label: 'fixture' })
  h.type('use selected Skill')
  await h.submit()
  assert.equal(h.requests[0].body.skillId, 'fixture')
  assert.ok(find(h.render(), 'stub-CommandMenu').props.refreshKey > before)
})

test('R1 App private switch transfers only unsent draft, does not send/create/history-copy and isolates Task drafts', async t => {
  const h = await harness(t, { initial: 1 })
  await h.open(4); h.type('separate beta draft')
  await h.open(1)
  const selected = pick(h.type('未发送 @'), 'alpha')
  let tree = await h.settle()
  assert.equal(find(tree, 'textarea').props['data-task-id'], 2)
  assert.equal(find(tree, 'textarea').props.value, selected.draft)
  assert.match(JSON.stringify(tree), /仅携带未发送草稿/)
  assert.equal(h.requests.length, 0)
  await h.open(1); assert.equal(find(h.render(), 'textarea').props.value, '')
  await h.open(4); assert.equal(find(h.render(), 'textarea').props.value, 'separate beta draft')
})

test('R1 App failed group send preserves body and reuses its request ID', async t => {
  const h = await harness(t, { failSend: true })
  pick(h.type('@'), 'beta')
  await h.submit(); await h.submit()
  assert.deepEqual(h.requests[1], h.requests[0])
  assert.deepEqual(h.requests[0].body.targetBotIds, ['beta'])
  assert.ok(find(h.render(), 'textarea').props.value)
})

test('R1 App private switch refuses to overwrite a destination draft without confirmation', async t => {
  const h = await harness(t, { initial: 1 })
  await h.open(2); h.type('destination draft')
  await h.open(1)
  window.confirm = () => false
  pick(h.type('source @'), 'alpha')
  let tree = h.render()
  assert.equal(find(tree, 'textarea').props['data-task-id'], 1)
  assert.equal(find(tree, 'textarea').props.value, 'source @')
  await h.open(2)
  assert.equal(find(h.render(), 'textarea').props.value, 'destination draft')
  assert.equal(h.requests.length, 0)
})

test('R1 App task switch restores its own cursor and bindings and never leaks composition or another draft', async t => {
  const h = await harness(t)
  pick(h.type('@'), 'beta')
  let tree = h.render()
  const draft = find(tree, 'textarea').props.value
  h.input.selectionStart = 1; h.input.selectionEnd = 1
  find(tree, 'textarea').props.onSelect({ currentTarget: h.input })
  find(h.render(), 'textarea').props.onCompositionStart()
  await h.open(1); h.type('private separate')
  assert.equal(find(h.render(), 'stub-CommandMenu').props.enabled, true)
  await h.open(3); tree = h.render()
  assert.equal(find(tree, 'textarea').props.value, draft)
  assert.equal(find(tree, 'stub-MentionMenu').props.selectionStart, 1)
  assert.deepEqual(find(tree, 'stub-MentionMenu').props.bindings.map(binding => binding.botId), ['beta'])
  await h.submit()
  assert.deepEqual(h.requests[0].body.targetBotIds, ['beta'])
})

test('R1 App manual group checkboxes send an explicit multi-target array without implicit name routing', async t => {
  const h = await harness(t)
  let tree = h.type('message with literal @Chief')
  const checkboxes = nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkboxes.length, 3)
  checkboxes[2].props.onChange({ target: { checked: true } })
  tree = h.render()
  nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox')[1].props.onChange({ target: { checked: true } })
  await h.submit()
  assert.deepEqual(h.requests[0].body.targetBotIds, ['beta', 'alpha'])
})
