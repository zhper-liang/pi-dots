import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createModelSettings } from './model-settings.mjs'
import { createModelReply } from './model-reply.mjs'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'

const a = { providerId: 'provider-a', baseUrl: 'https://a.fixture.invalid/v1', model: 'shared-model', apiKey: 'synthetic-registry-key-a' }
const b = { providerId: 'provider-b', baseUrl: 'https://b.fixture.invalid/v1', model: 'shared-model', apiKey: 'synthetic-registry-key-b' }
async function fixture(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-model-registry-')), file = join(dir, 'task.sqlite')
  const settings = createModelSettings({ file, envFiles: [], env })
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, file, settings }
}
const code = expected => error => error.code === expected
async function settled(store, id) {
  for (let i = 0; i < 500; i++) {
    const card = await store.get(id)
    if (card.activeInputId === null && card.runtime.checkpoint?.phase === 'awaitInput') return card
    await delay(5)
  }
  assert.fail('registered model did not settle')
}
const sse = () => new Response('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'registry reply' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })

test('registered models keep separate keys, replay edits and survive restart privately', async t => {
  const { settings, dir, file } = await fixture(t)
  const savedA = await settings.saveRegistration({ ...a, requestId: 'registry-create-a' })
  const savedB = await settings.saveRegistration({ ...b, requestId: 'registry-create-b' })
  assert.notEqual(savedA.selectionId, savedB.selectionId)
  assert.deepEqual(await settings.saveRegistration({ ...a, requestId: 'registry-create-a' }), savedA)
  await assert.rejects(settings.saveRegistration({ ...b, requestId: 'registry-create-a' }), code('MODEL_SETTINGS_REQUEST_CONFLICT'))
  await assert.rejects(settings.saveRegistration({ ...a, requestId: 'registry-duplicate' }), code('MODEL_REGISTRATION_EXISTS'))
  await assert.rejects(settings.saveRegistration({ ...a, apiKey: '', providerId: 'new-provider', requestId: 'registry-no-key' }), code('INVALID_MODEL_SETTINGS'))
  await settings.saveRegistration({ ...a, id: savedA.id, apiKey: 'synthetic-registry-rotated', requestId: 'registry-rotate-a' })
  await settings.saveRegistration({ ...a, id: savedA.id, apiKey: '', providerId: 'renamed-provider', baseUrl: 'https://changed.fixture.invalid/v1', requestId: 'registry-edit-a' })
  const fresh = createModelSettings({ file, envFiles: [], env: {} })
  assert.equal((await fresh.read({ id: savedA.selectionId })).apiKey, 'synthetic-registry-rotated')
  assert.equal((await fresh.read({ id: savedB.selectionId })).apiKey, b.apiKey)
  assert.equal((await stat(join(dir, 'model-registrations.json'))).mode & 0o777, 0o600)
  assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp')), false)
  assert.doesNotMatch(JSON.stringify(await fresh.list()), /synthetic-registry/)
})

test('renamed model invalidates old selection; unsafe input and unknown ids never fall back', async t => {
  const { settings } = await fixture(t)
  const saved = await settings.saveRegistration({ ...a, requestId: 'registry-initial' })
  for (const changes of [{ baseUrl: 'https://user:pass@fixture.invalid' }, { providerId: '../bad' }, { model: '?invalid' }, { apiKey: 123 }, { unknown: true }]) {
    await assert.rejects(settings.saveRegistration({ ...a, ...changes, id: saved.id, requestId: 'registry-invalid' }), code('INVALID_MODEL_SETTINGS'))
  }
  await settings.saveRegistration({ ...a, id: saved.id, model: 'renamed-model', requestId: 'registry-rename' })
  assert.equal(await settings.read({ id: saved.selectionId }), undefined)
  assert.equal(await settings.read({ id: 'registered:unknown' }), undefined)
  await assert.rejects(createModelReply(settings.read)('message', { parameters: { mode: 'model', model: { id: saved.selectionId } } }), code('MODEL_CONFIG_UNAVAILABLE'))
})

test('environment default coexists with registrations; test mode prevents all real configuration', async t => {
  const env = { OPENAI_BASE_URL: a.baseUrl, OPENAI_API_KEY: a.apiKey, MODEL: a.model }
  const { settings } = await fixture(t, env)
  const saved = await settings.saveRegistration({ ...b, requestId: 'registry-alongside-env' })
  assert.equal((await settings.list()).length, 2)
  assert.equal((await settings.get()).source, 'env')
  assert.equal((await settings.read({ id: saved.selectionId })).apiKey, b.apiKey)
  env.PIDOT_REPLY_MODE = 'test'
  assert.deepEqual(await settings.list(), [])
  assert.equal(await settings.read({ id: saved.selectionId }), undefined)
  await assert.rejects(settings.saveRegistration({ ...a, requestId: 'registry-test-mode' }), code('MODEL_SETTINGS_TEST_MODE'))
})

test('authenticated API and Bot creation route same-named models to their own URL/key across restart', async t => {
  const { settings, file, dir } = await fixture(t)
  const calls = []
  const reply = () => createModelReply(settings.read, { fetch: async (url, init) => { calls.push({ url, key: init.headers.get('Authorization'), model: JSON.parse(init.body).model }); return sse() } })
  let store = await openTaskStore({ file, modelSettings: settings, modelReply: reply() })
  t.after(() => store.close())
  const server = createApiServer({ token: 'registry-api-test-token', tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  async function request(path, method = 'GET', body, authorized = true) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { ...(authorized ? { Authorization: 'Bearer registry-api-test-token' } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await request('/api/settings/models', 'GET', undefined, false)).status, 401)
  assert.equal((await request('/api/settings/models', 'DELETE')).status, 405)
  const saved = []
  const mainIds = []
  for (const [index, entry] of [a, b].entries()) {
    const result = await request('/api/settings/models', 'POST', { ...entry, requestId: `registry-api-save-${index}` })
    assert.equal(result.status, 200)
    const config = result.body.data
    saved.push(config)
    const created = await request('/api/bots', 'POST', { name: `Model Bot ${index}`, requestId: `registry-api-bot-${index}`, parameters: { model: { id: config.selectionId } } })
    assert.equal(created.status, 201)
    assert.equal(created.body.bot.defaults.model.id, config.selectionId)
    mainIds.push(created.body.mainTaskId)
    await store.send(created.body.mainTaskId, 'test the selected connection')
    await settled(store, created.body.mainTaskId)
  }
  assert.deepEqual(calls, [a, b].map(entry => ({ url: `${entry.baseUrl}/chat/completions`, key: `Bearer ${entry.apiKey}`, model: entry.model })))
  await store.send(mainIds[0], 'switch this input to the other provider', undefined, { model: { id: saved[1].selectionId } })
  await settled(store, mainIds[0])
  assert.deepEqual(calls.at(-1), { url: `${b.baseUrl}/chat/completions`, key: `Bearer ${b.apiKey}`, model: b.model })
  const catalog = await store.getBotConfiguration('chief')
  assert.equal(catalog.models.filter(model => model.name === a.model).length, 2)
  assert.doesNotMatch(JSON.stringify([catalog, await request('/api/settings/models')]), /synthetic-registry/)
  await store.close()
  store = await openTaskStore({ file, modelSettings: settings, modelReply: reply() })
  const created = await store.createBot({ name: 'After restart', requestId: 'registry-after-restart', parameters: { model: { id: saved[1].selectionId } } })
  await store.send(created.mainTaskId, 'after restart'); await settled(store, created.mainTaskId)
  assert.equal(calls.at(-1).key, `Bearer ${b.apiKey}`)
  const rotated = 'synthetic-registry-live-rotation'
  await store.saveModelRegistration({ ...b, id: saved[1].id, apiKey: rotated, baseUrl: 'https://rotated.fixture.invalid/v1', requestId: 'registry-live-rotation' })
  await store.send(created.mainTaskId, 'after rotation'); await settled(store, created.mainTaskId)
  assert.deepEqual(calls.at(-1), { url: 'https://rotated.fixture.invalid/v1/chat/completions', key: `Bearer ${rotated}`, model: b.model })
  assert.equal((await store.get(created.mainTaskId)).parameters.model.id, saved[1].selectionId)
  for (const name of await readdir(dir)) {
    if (name === 'model-registrations.json') continue
    const bytes = await readFile(join(dir, name))
    assert.equal(bytes.includes(Buffer.from(a.apiKey)), false, name)
    assert.equal(bytes.includes(Buffer.from(b.apiKey)), false, name)
    assert.equal(bytes.includes(Buffer.from(rotated)), false, name)
  }
})
