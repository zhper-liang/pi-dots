import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { publishCapabilityChange } from './capabilities-changed.mjs'

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
  replace('window', { ...surface('window'), matchMedia: () => ({ ...surface('media'), matches: false }) })
  replace('navigator', { onLine: true })
  replace('setTimeout', (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId })
  replace('clearTimeout', id => timers.delete(id))
  replace('setInterval', (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId })
  replace('clearInterval', id => timers.delete(id))
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

const configuration = () => ({ bot: { description: '保持职责', configRef: { version: 'saved-1' } }, assigned: { tools: ['workspace.list', 'workspace.get'], resources: ['workspace:local', 'feishu:original', 'workspace:feishu:work'] }, resources: ['workspace:local', 'feishu:original', 'workspace:feishu:work'] })
const raw = body => ({ ok: true, status: 200, json: async () => body })

test('schedule sources combine Feishu addresses into one choice and preserve every unrelated setting', async t => {
  let current = configuration(), changes = 0
  const writes = []
  const h = await harness(t, './ScheduleSources.tsx', { token: 'fixture', botId: 'alpha', active: true, readOnly: false, enabled: true, onChanged: () => changes++ }, async (path, init = {}) => {
    if (path === '/api/feishu/status') return response({ configured: true, binding: { summary: '工作', resource: 'feishu:original' } })
    if (init.method === 'POST') { const input = JSON.parse(init.body); writes.push(input); current = { ...current, assigned: { ...current.assigned, resources: input.resources } }; return raw({}) }
    return raw(current)
  })
  let tree = await h.settle()
  assert.equal(nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 2)
  const feishu = find(tree, 'input', props => props['aria-label'] === '使用飞书日历')
  assert.equal(feishu.props.checked, true)
  feishu.props.onChange(); feishu.props.onChange()
  tree = await h.settle()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].expectedVersion, 'saved-1')
  assert.equal(writes[0].description, '保持职责')
  assert.deepEqual(writes[0].tools, ['workspace.list', 'workspace.get'])
  assert.deepEqual(writes[0].resources, ['workspace:local'])
  assert.equal(Object.hasOwn(writes[0], 'parameters'), false)
  assert.equal(changes, 1)
  assert.equal(find(tree, 'input', props => props['aria-label'] === '使用飞书日历').props.checked, false)
})

test('schedule source entry is read-only when its toolset is off and stops reads when hidden', async t => {
  const calls = []
  const h = await harness(t, './ScheduleSources.tsx', { token: 'fixture', botId: 'alpha', active: false, readOnly: false, enabled: false }, async (path, init = {}) => { calls.push({ path, init }); return path === '/api/feishu/status' ? response({ configured: false, binding: null }) : raw(configuration()) })
  await h.settle(); assert.equal(calls.length, 0)
  h.update({ active: true })
  const tree = await h.settle()
  assert.match(text(tree), /已选范围会保留/)
  assert.ok(nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').every(node => node.props.disabled && node.props.checked))
  find(tree, 'input', props => props.type === 'checkbox').props.onChange()
  await h.settle()
  assert.equal(calls.some(call => call.init.method === 'POST'), false)
  h.update({ active: false }); await h.settle()
  assert.equal(h.timerCount(15000), 0)
})

test('source updates silently retain successful rows during slow and failed reads, then recover automatically', async t => {
  let fail = false, pending, delay = false
  const current = configuration()
  const h = await harness(t, './ScheduleSources.tsx', { token: 'fixture', botId: 'alpha', active: true, readOnly: false, enabled: true }, async path => {
    if (path === '/api/feishu/status') return response({ configured: true, binding: { summary: '工作', resource: 'feishu:original' } })
    if (delay) return new Promise(resolve => { pending = resolve })
    if (fail) throw new Error('offline')
    return raw(structuredClone(current))
  })
  let tree = await h.settle()
  assert.equal(button(tree, '刷新状态'), undefined)
  assert.equal(button(tree, '重新读取'), undefined)
  delay = true
  publishCapabilityChange({ botId: 'alpha' })
  tree = await h.settle()
  assert.ok(pending)
  assert.equal(find(tree, 'input', props => props['aria-label'] === '使用本地日程与待办').props.checked, true)
  assert.doesNotMatch(text(tree), /正在读取来源/)
  pending(raw(structuredClone(current))); delay = false
  await h.settle()
  fail = true; h.fireTimer(15000)
  tree = await h.settle()
  assert.match(text(tree), /将自动重试/)
  assert.equal(find(tree, 'input', props => props['aria-label'] === '使用本地日程与待办').props.checked, true)
  assert.ok(button(tree, '重新读取'))
  fail = false; current.assigned.resources = ['workspace:local']
  h.fireTimer(15000)
  tree = await h.settle()
  assert.equal(find(tree, 'input', props => props['aria-label'] === '使用飞书日历').props.checked, false)
  assert.equal(button(tree, '重新读取'), undefined)
  h.update({ botId: 'beta', active: false })
  tree = h.render()
  assert.equal(find(tree, 'input', props => props['aria-label'] === '使用本地日程与待办'), undefined)
})

test('source scope is nested under its scheduling capability and searches keep that hierarchy', async t => {
  const items = [
    { id: 'tool:todos', kind: 'tool', name: '日程与待办', description: '', status: 'ready' },
    { id: 'tool:collaboration', kind: 'tool', name: '机器人协作', description: '', status: 'ready' },
  ]
  const h = await harness(t, './CapabilityPicker.tsx', { items, enabled: ['tool:todos'], partial: ['tool:todos'], onToggle() {}, sourceContext: { token: 'fixture', botId: 'alpha', active: true, readOnly: false } })
  let tree = h.render()
  const source = find(tree, 'stub-ScheduleSources')
  const row = find(tree, 'li', props => text(props.children).includes('日程与待办'))
  assert.ok(nodes(row).includes(source))
  assert.equal(source.props.enabled, true)
  assert.match(text(row), /已启用部分工具/)
  assert.equal(find(row, 'stub-Switch').props.onText, '部分')
  find(tree, 'input', props => props.type === 'search').props.onChange({ target: { value: '飞书' } })
  tree = h.render()
  assert.equal(nodes(tree).filter(node => node.type === 'li').length, 1)
  assert.ok(find(tree, 'stub-ScheduleSources'))
  find(tree, 'button', props => props.role === 'tab' && text(props.children).trim() === 'Skills').props.onClick()
  assert.equal(find(h.render(), 'stub-ScheduleSources'), undefined)
})

test('diagnostics load on entry and preserve local status when an external source is unavailable', async t => {
  const calls = []
  const h = await harness(t, './WorkspaceStatus.tsx', { token: 'fixture', active: false }, async (path, init = {}) => {
    calls.push({ path, init })
    if (path.endsWith('external-sources')) throw new Error('offline')
    return response({ enabled: true, schemaVersion: 4, sources: [{ id: 'local', authority: 'local', authorized: true }], notice: '本地业务存储正常' })
  })
  await h.settle(); assert.equal(calls.length, 0)
  h.update({ active: true })
  let tree = await h.settle()
  assert.match(text(tree), /本地业务存储正常/)
  assert.match(text(tree), /外部来源暂不可达/)
  assert.equal(find(tree, 'stub-WorkspaceIdentity').props.sourceId, 'local')
  button(tree, '重新读取').props.onClick()
  tree = await h.settle()
  assert.equal(calls.filter(call => call.path === '/api/workspace/status').length, 2)
  assert.ok(calls.every(call => call.init.body === undefined || call.init.body === '{}'))
})

test('diagnostics keep their content during invalidation and outages and recover without a refresh action', async t => {
  let fail = false
  const h = await harness(t, './WorkspaceStatus.tsx', { token: 'fixture', active: true }, async path => {
    if (fail) throw new Error('offline')
    return response(path.endsWith('external-sources') ? { sources: [{ id: 'work', authority: 'external', authorized: true }] } : { enabled: true, schemaVersion: 4, sources: [{ id: 'local', authority: 'local', authorized: true }], notice: '本地业务存储正常' })
  })
  let tree = await h.settle()
  assert.equal(button(tree, '刷新状态'), undefined)
  assert.equal(button(tree, '重新读取'), undefined)
  fail = true
  publishCapabilityChange({ botId: 'alpha' })
  tree = h.render()
  assert.match(text(tree), /本地业务存储正常/)
  tree = await h.settle()
  assert.match(text(tree), /将自动重试/)
  assert.equal(nodes(tree).filter(node => node.type === 'stub-WorkspaceIdentity').length, 2)
  fail = false; h.fireTimer(15000)
  tree = await h.settle()
  assert.match(text(tree), /本地业务存储正常/)
  assert.equal(button(tree, '重新读取'), undefined)
})

test('source rows remain available if only Feishu status fails', async t => {
  const h = await harness(t, './ScheduleSources.tsx', { token: 'fixture', botId: 'alpha', active: true, readOnly: false, enabled: true }, async path => {
    if (path === '/api/feishu/status') throw new Error('offline')
    return raw(configuration())
  })
  const tree = await h.settle()
  assert.ok(find(tree, 'input', props => props['aria-label'] === '使用本地日程与待办'))
  assert.match(text(tree), /本地来源仍可使用/)
})

test('shared Feishu editor checks actual Bot assignments and binds only an explicitly selected calendar', async t => {
  const calls = [], mutations = []
  let changes = 0
  const h = await harness(t, './FeishuConnection.tsx', { token: 'fixture', active: true, readOnly: false, status: { configured: true, connectionId: 'old', authorizationVersion: 1, binding: { calendarId: 'old-calendar', summary: '旧日历', resource: 'feishu:old' } }, onChanged: () => changes++ }, async (path, init = {}) => {
    calls.push(path)
    if (path === '/api/bots') return raw({ bots: [{ id: 'alpha', name: '日程机器人', defaults: { toolResources: [] } }] })
    if (path === '/api/bots/alpha/configuration') return raw({ assigned: { resources: ['workspace:feishu:actual'] } })
    if (path === '/api/feishu/calendars') return response({ complete: true, items: [{ calendarId: 'selected', summary: '工作日历' }] })
    if (path === '/api/feishu/manage') { mutations.push(JSON.parse(init.body)); return response({}) }
    throw new Error('Unexpected route')
  })
  let tree = await h.settle()
  assert.match(text(tree), /断开后受影响的机器人：日程机器人/)
  assert.equal(mutations.length, 0)
  button(tree, '选择日历').props.onClick()
  tree = await h.settle()
  find(tree, 'select').props.onChange({ target: { value: 'selected' } })
  publishCapabilityChange({ botId: 'alpha' })
  tree = await h.settle()
  assert.equal(find(tree, 'select').props.value, 'selected')
  button(h.render(), '绑定所选日历').props.onClick()
  await h.settle()
  assert.deepEqual(mutations, [{ action: 'bind', calendarId: 'selected', confirm: true }])
  assert.equal(changes, 1)
  assert.ok(calls.every(path => !path.includes('/events') && !path.includes('/read')))
})

test('a legacy partial Feishu assignment is shown as enabled so turning it off revokes every address', async t => {
  const current = configuration()
  current.assigned.resources = ['workspace:local', 'feishu:original']
  const writes = []
  const h = await harness(t, './ScheduleSources.tsx', { token: 'fixture', botId: 'alpha', active: true, readOnly: false, enabled: true }, async (path, init = {}) => {
    if (path === '/api/feishu/status') return response({ configured: true, binding: { summary: '工作', resource: 'feishu:original' } })
    if (init.method === 'POST') { const input = JSON.parse(init.body); writes.push(input); current.assigned.resources = input.resources; return raw({}) }
    return raw(current)
  })
  const tree = await h.settle()
  assert.doesNotMatch(text(tree), /部分开启/)
  const control = find(tree, 'input', props => props['aria-label'] === '使用飞书日历')
  assert.equal(control.props.checked, true)
  control.props.onChange()
  await h.settle()
  assert.deepEqual(writes[0].resources, ['workspace:local'])
})

test('calendar renders local, Feishu and Google together with visible source labels in every view', async t => {
  const { getLocalTimezone } = await import('./local-time.mjs')
  const { dayKey, addDays } = await import('./calendar-layout.mjs')
  const today = dayKey(Date.now(), getLocalTimezone())
  const timed = (title, sourceId) => ({ id: 'same-event-id', sourceId, title, start: `${today}T09:00:00`, end: `${today}T10:00:00`, version: 1 })
  const allDay = { id: 'all-day', sourceId: 'google-calendar:work', title: 'Google 全天', start: today, end: addDays(today, 1), version: 1 }
  const todo = sourceId => ({ id: 'same-todo-id', sourceId, title: '待办截止', due: today, version: 1 })
  const sources = [
    { id: 'feishu:work', provider: 'feishu', title: '工作', authorized: true, readScope: 'full' },
    { id: 'google-calendar:work', provider: 'google-calendar', title: '个人', authorized: true, readScope: 'full' },
    { id: 'google-tasks:work', provider: 'google-tasks', title: '清单', itemType: 'Todo', authorized: true, readScope: 'full' },
  ]
  const h = await harness(t, './CalendarBoard.tsx', { token: 'fixture', active: true }, async (path, init = {}) => {
    const input = init.body ? JSON.parse(init.body) : {}
    if (path.endsWith('/status')) return response({ sources: [{ id: 'local', authorized: true }] })
    if (path.endsWith('/external-sources')) return response({ sources })
    if (path.endsWith('/query')) return response({ items: input.type === 'Event' ? [timed('本地安排', 'local')] : [todo('local')] })
    if (path.endsWith('/external-query')) return response({ complete: true, items: input.sourceId === 'feishu:work' ? [timed('飞书安排', input.sourceId)] : input.sourceId === 'google-calendar:work' ? [timed('Google 安排', input.sourceId), allDay] : [todo(input.sourceId)] })
    throw new Error(`Unexpected route ${path}`)
  })
  for (const view of ['周', '日', '月']) {
    let tree = await h.settle()
    button(tree, view).props.onClick()
    tree = await h.settle()
    for (const [name, short, full] of [['本地安排', '本地', '本地日历'], ['飞书安排', '飞书', '飞书日历 · 工作'], ['Google 安排', 'Google', 'Google 日历 · 个人']]) {
      const event = find(tree, 'button', props => props['aria-label']?.startsWith(`${name}，`))
      assert.ok(event, `${view}: missing ${name}`)
      const badge = find(event, 'span', props => props.className === 'cal-source-badge')
      assert.equal(text(badge), short)
      assert.equal(badge.props.title, full)
    }
    const chip = find(tree, 'button', props => props['aria-label']?.startsWith('Google 全天，'))
    assert.equal(text(find(chip, 'span', props => props.className === 'cal-source-badge')), 'Google')
    const due = nodes(tree).filter(node => node.type === 'span' && node.props.className === 'cal-due')
    assert.equal(due.length, 2)
    assert.equal(new Set(due.map(node => node.key)).size, 2, 'same IDs from distinct sources remain separate')
    assert.deepEqual(due.map(node => text(find(node, 'span', props => props.className === 'cal-source-badge'))).sort(), ['Google', '本地'].sort())
  }
})
