import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MODEL_SETTINGS_NOTICE, modelChoices, modelSettingsPayload, publicModelSettings } from './model-settings-ui.mjs'

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
  assert.match(MODEL_SETTINGS_NOTICE, /对所有会话的下一次调用生效/)
  assert.match(MODEL_SETTINGS_NOTICE, /Task.*模型名快照/)
})

test('T10 choices preserve snapshot, remove duplicates and reject malformed ids', () => {
  assert.deepEqual(modelChoices('snapshot', [{ id: 'new-model' }, { id: 'snapshot' }, { id: '<invalid>' }]), ['snapshot', 'new-model'])
  assert.deepEqual(modelChoices(''), [])
})

// The project has no browser test dependency. Compile these two TSX components using
// the installed TypeScript transpiler, then exercise React SSR without running effects.
async function component(name) {
  const { readFile } = await import('node:fs/promises')
  const ts = await import('typescript')
  const source = (await readFile(new URL(`./${name}.tsx`, import.meta.url), 'utf8'))
    .replace(/^import '\.\/model-settings\.css'\n/m, '')
    .replaceAll("'./model-settings-ui.mjs'", JSON.stringify(new URL('./model-settings-ui.mjs', import.meta.url).href))
    .replace(/from 'react'/g, `from ${JSON.stringify(import.meta.resolve('react'))}`)
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
