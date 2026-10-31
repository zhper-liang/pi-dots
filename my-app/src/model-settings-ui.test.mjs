import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MODEL_SETTINGS_NOTICE, modelSettingsAttempt, modelSettingsSummary, modelChoices, modelSettingsPayload, publicModelSettings } from './model-settings-ui.mjs'

// Deliberately synthetic values, never read host environment or credential files.
test('T10 public projection strips unexpected fields and rejects missing public settings', () => {
  const view = publicModelSettings({ baseUrl: 'https://fixture.invalid/v1', model: 'model-a', hasKey: true, source: 'file', apiKey: 'synthetic-discarded' })
  assert.deepEqual(Object.keys(view), ['baseUrl', 'model', 'hasKey', 'source'])
  assert.equal(JSON.stringify(view).includes('synthetic-discarded'), false)
  assert.throws(() => publicModelSettings({ source: 'file' }), /暂时不可用/)
})

test('T10 payload trims ordinary inputs, omits blank key and carries replacement only when supplied', () => {
  assert.deepEqual(modelSettingsPayload({ baseUrl: ' https://fixture.invalid/v1 ', model: ' model-a ', apiKey: '  ' }, 'fixture-request-id'), {
    requestId: 'fixture-request-id', baseUrl: 'https://fixture.invalid/v1', model: 'model-a',
  })
  assert.equal(Object.hasOwn(modelSettingsPayload({ baseUrl: '', model: '', apiKey: 'synthetic-replacement' }, 'fixture-request-id'), 'apiKey'), true)
  assert.equal(MODEL_SETTINGS_NOTICE, '改完后，之后的对话用新设置。')
  assert.doesNotMatch(MODEL_SETTINGS_NOTICE, /Task|快照/)
})

test('T10 choices preserve snapshot, remove duplicates and reject malformed ids', () => {
  assert.deepEqual(modelChoices('snapshot', [{ id: 'new-model' }, { id: 'snapshot' }, { id: '<invalid>' }]), ['snapshot', 'new-model'])
  assert.deepEqual(modelChoices(''), [])
})

// The project has no browser test dependency. Compile these two TSX components using
// the installed TypeScript transpiler, then exercise React SSR without running effects.
async function component(name, reactModule = import.meta.resolve('react')) {
  const { readFile } = await import('node:fs/promises')
  const ts = await import('typescript')
  const source = (await readFile(new URL(`./${name}.tsx`, import.meta.url), 'utf8'))
    .replace(/^import '\.\/model-settings\.css'\n/m, '')
    .replaceAll("'./model-settings-ui.mjs'", JSON.stringify(new URL('./model-settings-ui.mjs', import.meta.url).href))
    .replace(/from 'react'/g, `from ${JSON.stringify(reactModule)}`)
    .replace("import EditorDialog from './EditorDialog'", "const EditorDialog = 'editor-dialog'")
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  const compiled = outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  return (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)).default
}

test('T10 model picker renders main selection but standalone Task only renders its frozen snapshot', async () => {
  const Picker = await component('ModelPicker')
  const task = { taskId: 1, kind: 'main', bot: { id: 'chief' }, parameters: { mode: 'model', model: { id: 'snapshot' } } }
  const props = { token: 'fixture-ui-token', task, value: { id: 'selected' }, onChange() {} }
  const main = renderToStaticMarkup(createElement(Picker, props))
  assert.match(main, /<select/)
  assert.match(main, /selected/)
  const child = renderToStaticMarkup(createElement(Picker, { ...props, task: { ...task, kind: 'chat' } }))
  assert.doesNotMatch(child, /<select/)
  assert.match(child, /snapshot/)
  assert.doesNotMatch(child, /selected/)
  assert.doesNotMatch(renderToStaticMarkup(createElement(Picker, { ...props, task: { ...task, kind: 'group', group: {} } })), /<select/)
})

test('R1-05 summary contains configuration truth without URL secrets or a false health check', () => {
  const summary = modelSettingsSummary({ baseUrl: 'https://user:synthetic-password@fixture.invalid/secret-path?key=synthetic-query#synthetic-fragment', model: 'model-a', hasKey: true, source: 'env' })
  assert.deepEqual(summary, { model: 'model-a', address: 'https://fixture.invalid', key: '已配置', status: '已配置 · 未验证连接', readOnly: true })
  assert.doesNotMatch(JSON.stringify(summary), /synthetic|secret-path/)
  assert.equal(modelSettingsSummary({ baseUrl: '', model: '', hasKey: false, source: 'none' }).status, '待配置')
  assert.equal(modelSettingsSummary({ baseUrl: 'not a URL', model: '', hasKey: false, source: 'file' }).address, '地址无效')
})

test('R1-05 choices tolerate malformed directory entries without inventing a model', () => {
  assert.deepEqual(modelChoices('snapshot', [null, {}, { id: 'actual-model' }, { id: 'actual-model' }, { id: '<unsafe>' }]), ['snapshot', 'actual-model'])
  assert.deepEqual(modelChoices('', null), [])
})

test('R1-05 retries an unchanged draft with the original id and changes id only for a changed body', () => {
  const draft = { baseUrl: ' https://fixture.invalid/v1 ', model: ' model-a ', apiKey: 'synthetic-input-key' }
  let ids = 0
  const id = () => `fixture-request-${++ids}`
  const first = modelSettingsAttempt(draft, null, id)
  assert.equal(modelSettingsAttempt(draft, first, id), first)
  assert.equal(ids, 1)
  assert.equal(modelSettingsAttempt({ ...draft, model: 'model-b' }, first, id).requestId, 'fixture-request-2')
  assert.equal(ids, 2)
})

// Drive component event handlers with deterministic hooks, not a copied UI implementation.
// This checks draft/request lifecycles; actual DOM focus/layout belongs to R1-02/browser QA.
async function settingsHarness(t, fetcher, name = 'ModelSettings', props = { token: 'fixture-token' }) {
  const hookUrl = `data:text/javascript;base64,${Buffer.from(`
    const slots = [], cleanups = []
    let cursor = 0, effects = []
    export function start() { cursor = 0 }
    export function useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    }
    export function useRef(initial) { return useState(() => ({ current: initial }))[0] }
    export function useId() { return useState('fixture-form')[0] }
    export function useEffect(callback, deps) {
      const index = cursor++, previous = slots[index]
      if (!previous || deps.some((value, i) => value !== previous[i])) {
        slots[index] = deps
        effects.push(() => { cleanups[index]?.(); cleanups[index] = callback() })
      }
    }
    export function flush() { const pending = effects; effects = []; for (const effect of pending) effect() }
    export function dispose() { for (const cleanup of cleanups) cleanup?.() }
    // ${Math.random()}
  `).toString('base64')}`
  const hooks = await import(hookUrl), Settings = await component(name, hookUrl)
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window
  globalThis.fetch = fetcher
  const listeners = new Map()
  globalThis.window = { dispatchEvent(event) { listeners.get(event.type)?.() }, addEventListener(type, callback) { listeners.set(type, callback) }, removeEventListener(type) { listeners.delete(type) } }
  t.after(() => { hooks.dispose(); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow })
  return {
    render() { hooks.start(); const tree = Settings(props); hooks.flush(); return tree },
    async idle() { await new Promise(resolve => setImmediate(resolve)) },
  }
}

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...elements(node.props.children)]
}
const element = (tree, type, predicate = () => true) => elements(tree).find(node => node.type === type && predicate(node.props))
const publicFixture = { baseUrl: 'https://fixture.invalid/v1', model: 'model-a', hasKey: true, source: 'file' }
const publicResponse = (data = publicFixture) => ({ ok: true, json: async () => ({ data: { ...data, apiKey: 'synthetic-never-display' } }) })
const submit = tree => element(tree, 'form').props.onSubmit({ preventDefault() {} })
const change = (tree, predicate, value) => element(tree, 'input', predicate).props.onChange({ target: { value } })

test('R1-05 cancel never writes; failure retains the whole draft; success clears the editor secret', async t => {
  const requests = [], sent = []
  let succeed = false
  const harness = await settingsHarness(t, async (url, options) => {
    requests.push(options.method ?? 'GET')
    if (!options.method) return publicResponse()
    sent.push(JSON.parse(options.body))
    return succeed ? publicResponse() : { ok: false, status: 400, json: async () => ({ error: 'synthetic-key-in-backend-error' }) }
  })
  harness.render(); await harness.idle()
  let tree = harness.render()
  assert.equal(element(tree, 'editor-dialog').props.open, false)
  element(tree, 'button').props.onClick()
  tree = harness.render()
  change(tree, props => props.type === 'password', 'synthetic-cancelled-key')
  element(tree, 'editor-dialog').props.onClose()
  tree = harness.render()
  assert.deepEqual(requests, ['GET'])
  element(tree, 'button').props.onClick()
  tree = harness.render()
  assert.equal(element(tree, 'input', props => props.type === 'password').props.value, '')
  change(tree, props => props.type === 'url', 'https://changed.fixture.invalid/v1')
  change(tree, props => props.type === 'password', 'synthetic-replacement-key')
  tree = harness.render(); submit(tree); await harness.idle(); tree = harness.render()
  assert.equal(element(tree, 'editor-dialog').props.open, true)
  assert.equal(element(tree, 'input', props => props.type === 'url').props.value, 'https://changed.fixture.invalid/v1')
  assert.equal(element(tree, 'input', props => props.type === 'password').props.value, 'synthetic-replacement-key')
  assert.doesNotMatch(element(tree, 'editor-dialog').props.error, /synthetic/)
  succeed = true
  submit(tree); await harness.idle(); tree = harness.render()
  assert.equal(sent[0].requestId, sent[1].requestId)
  assert.equal(element(tree, 'editor-dialog').props.open, false)
  assert.equal(element(tree, 'input', props => props.type === 'password').props.value, '')
  element(tree, 'button').props.onClick(); tree = harness.render()
  assert.equal(element(tree, 'input', props => props.type === 'password').props.value, '')
  assert.doesNotMatch(JSON.stringify(tree), /synthetic-never-display/)
})

test('R1-05 unknown saves lock editing, keep recovery usable and replay the identical request', async t => {
  const sent = []
  const harness = await settingsHarness(t, async (url, options) => {
    if (!options.method) return publicResponse()
    sent.push(JSON.parse(options.body))
    if (sent.length === 1) throw new Error('synthetic-network-failure')
    return publicResponse()
  })
  harness.render(); await harness.idle()
  element(harness.render(), 'button').props.onClick()
  let tree = harness.render()
  submit(tree); await harness.idle(); tree = harness.render()
  const dialog = element(tree, 'editor-dialog')
  assert.equal(dialog.props.pending, false)
  assert.equal(dialog.props.disabled, true)
  const recovery = element(dialog.props.footer, 'button', props => props.children === '重试')
  assert.equal(recovery.props.type, 'button')
  recovery.props.onClick(); await harness.idle(); tree = harness.render()
  assert.deepEqual(sent[1], sent[0])
  assert.equal(element(tree, 'editor-dialog').props.open, false)
})

test('R1-05 environment settings are read-only and never render a saved key', async t => {
  let writes = 0
  const harness = await settingsHarness(t, async (url, options) => {
    if (options.method) writes++
    return publicResponse({ ...publicFixture, source: 'env' })
  })
  harness.render(); await harness.idle()
  element(harness.render(), 'button').props.onClick()
  const tree = harness.render(), dialog = element(tree, 'editor-dialog')
  assert.equal(dialog.props.disabled, true)
  assert.equal(element(dialog.props.footer, 'button', props => props.type === 'submit'), undefined)
  assert.equal(element(tree, 'input', props => props.type === 'password').props.value, '')
  submit(tree); await harness.idle()
  assert.equal(writes, 0)
})

test('R1-05 pending save prevents duplicate requests and dismissal until the receipt arrives', async t => {
  let complete, writes = 0
  const harness = await settingsHarness(t, async (url, options) => {
    if (!options.method) return publicResponse()
    writes++
    return new Promise(resolve => { complete = resolve })
  })
  harness.render(); await harness.idle()
  element(harness.render(), 'button').props.onClick()
  let tree = harness.render()
  submit(tree); submit(tree); tree = harness.render()
  assert.equal(writes, 1)
  assert.equal(element(tree, 'editor-dialog').props.pending, true)
  element(tree, 'editor-dialog').props.onClose()
  assert.equal(element(harness.render(), 'editor-dialog').props.open, true)
  complete(publicResponse()); await harness.idle()
  assert.equal(element(harness.render(), 'editor-dialog').props.open, false)
})

test('R1-05 picker offers only real catalog ids, preserves rejected snapshot and ignores stale refreshes', async t => {
  const pending = [], changes = []
  const props = { token: 'fixture-token', task: { taskId: 1, kind: 'main', bot: { id: 'chief' }, parameters: { mode: 'model', model: { id: 'old-snapshot' } } }, onChange(value) { changes.push(value) } }
  const harness = await settingsHarness(t, () => new Promise(resolve => pending.push(resolve)), 'ModelPicker', props)
  assert.equal(element(harness.render(), 'select').props.disabled, true)
  pending.shift()({ ok: true, json: async () => ({ models: [null, { id: 'actual-model' }, { id: 'actual-model' }, { id: '<unsafe>' }] }) })
  await harness.idle()
  let tree = harness.render(), select = element(tree, 'select')
  assert.equal(select.props.value, 'old-snapshot')
  assert.equal(element(tree, 'option', item => item.value === 'old-snapshot').props.disabled, true)
  assert.equal(element(tree, 'option', item => item.value === 'actual-model').props.disabled, false)
  assert.deepEqual(changes, [])
  select.props.onChange({ target: { value: 'invented-model' } })
  select.props.onChange({ target: { value: 'actual-model' } })
  assert.deepEqual(changes, [{ id: 'actual-model' }])
  window.dispatchEvent(new Event('pidot:model-settings-updated'))
  window.dispatchEvent(new Event('pidot:model-settings-updated'))
  const older = pending.shift(), newer = pending.shift()
  newer({ ok: true, json: async () => ({ models: [{ id: 'newest-model' }] }) }); await harness.idle()
  older({ ok: true, json: async () => ({ models: [{ id: 'stale-model' }] }) }); await harness.idle()
  tree = harness.render()
  assert.ok(element(tree, 'option', item => item.value === 'newest-model'))
  assert.equal(element(tree, 'option', item => item.value === 'stale-model'), undefined)
})
