import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModelSettings } from './model-settings.mjs'
import { createModelReply } from './model-reply.mjs'
import { listBots, BOT_CONFIG_VERSION } from './bots.mjs'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'
import { BotDirectory } from './bot-directory.mjs'

const key = 'T02-fixture-secret-never-persist-in-db'
const rotated = 'T02-rotated-secret-never-return'
const first = { baseUrl: 'https://old.fixture.invalid/v1', model: 'pinned-model', apiKey: key }
const input = (changes = {}) => ({ requestId: 'model-settings-request-01', ...first, ...changes })
const errorCode = code => error => error.code === code && !error.message.includes(key) && !error.message.includes(rotated)
function sse(text = 'fixture reply') {
  const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', model: first.model,
    choices: [{ index: 0, delta, finish_reason }] })
  return new Response([chunk({ role: 'assistant', content: text }), chunk({}, 'stop'), {
    ...chunk({}), choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  }].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-t02-')), file = join(dir, 'task.sqlite')
  const settings = createModelSettings({ file, env: {}, envFiles: [], ...options })
  const stores = new Set()
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const open = async (extra = {}) => { const store = await openTaskStore({ file, modelSettings: settings, ...extra }); stores.add(store); return store }
  const close = async store => { await store.close(); stores.delete(store) }
  return { dir, file, settings, open, close }
}
async function settled(store, id) {
  for (let i = 0; i < 700; i++) {
    const task = await store.get(id)
    if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput') return task
    await delay(5)
  }
  assert.fail('model settings task did not settle')
}
async function api(t, store) {
  const logs = []
  const server = createApiServer({ token: 't02-api-fixture-token-not-provider-secret', tasks: store, onError: (...args) => logs.push(args) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const request = async (method = 'GET', body, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/settings/model`, {
      method, headers: { ...(auth ? { Authorization: 'Bearer t02-api-fixture-token-not-provider-secret' } : {}), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() }
  }
  return { request, logs }
}

test('T02 settings save is 0600, private, atomic, idempotent and preserves a blank key', async t => {
  const { dir, settings } = await fixture(t)
  assert.deepEqual(await settings.get(), { baseUrl: '', model: '', hasKey: false, contextWindow: 256000, source: 'none' })
  await assert.rejects(settings.save(input({ apiKey: '' })), errorCode('INVALID_MODEL_SETTINGS'))
  const saved = await settings.save(input())
  assert.deepEqual(saved, { baseUrl: first.baseUrl, model: first.model, hasKey: true, contextWindow: 256000, source: 'file' })
  assert.deepEqual(await settings.save(input()), saved)
  await assert.rejects(settings.save(input({ model: 'other' })), errorCode('MODEL_SETTINGS_REQUEST_CONFLICT'))
  assert.equal((await stat(join(dir, 'model-settings.json'))).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'model-settings.json'), 'utf8')), { ...first, contextWindow: 256000 })
  await settings.save(input({ requestId: 'model-blank-key-02', baseUrl: 'http://[::1]:9999/v1/', apiKey: '  ' }))
  assert.equal((await settings.read()).apiKey, key)
  assert.equal((await settings.read()).baseUrl, 'http://[::1]:9999/v1')
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
  await settings.save(input({ requestId: 'model-rotate-key-03', apiKey: rotated }))
  assert.equal((await settings.read()).apiKey, rotated)
  assert.equal(JSON.stringify(await settings.get()).includes(rotated), false)
})

test('T02 invalid input and unsafe URLs fail without overwriting a saved connection', async t => {
  const { settings } = await fixture(t)
  await settings.save(input())
  for (const baseUrl of ['not-url', 'ftp://host/v1', 'http://external.invalid/v1', 'https://user:pass@host/v1',
    'https://host/v1?key=secret', 'https://host/v1#fragment', `https://host/${key}`]) {
    await assert.rejects(settings.save(input({ requestId: 'invalid-url-request', baseUrl })), errorCode('INVALID_MODEL_SETTINGS'))
  }
  for (const changes of [{ apiKey: 'bad\nkey' }, { apiKey: false }, { model: '../bad?model' }, { model: key }, { requestId: '__proto__' }, { unknown: key }]) {
    await assert.rejects(settings.save(input({ requestId: 'invalid-input-request', ...changes })), errorCode('INVALID_MODEL_SETTINGS'))
  }
  assert.deepEqual(await settings.read(), { ...first, contextWindow: 256000 })
})

test('T02 process > app dotenv > root dotenv > saved file, with env changes read live', async t => {
  const { dir, file, settings } = await fixture(t)
  await settings.save(input())
  const app = join(dir, 'app.env'), root = join(dir, 'root.env')
  await writeFile(root, `base_url=https://root.fixture.invalid/v1\nOPENAI_API_KEY=${rotated}\nMODEL=root-model\n`)
  await writeFile(app, 'OPENAI_BASE_URL=https://app.fixture.invalid/v1\nMODEL=app-model\n')
  const env = { base_url: 'https://process.fixture.invalid/v1' }
  const live = createModelSettings({ file, env, envFiles: [app, root] })
  assert.deepEqual(await live.get(), { baseUrl: env.base_url, model: 'app-model', hasKey: true, contextWindow: 256000, source: 'env' })
  await assert.rejects(live.save(input()), errorCode('MODEL_SETTINGS_ENV_LOCKED'))
  env.OPENAI_BASE_URL = 'http://localhost:9090/v1'
  assert.equal((await live.get()).baseUrl, env.OPENAI_BASE_URL)
  delete env.OPENAI_BASE_URL; delete env.base_url
  assert.equal((await live.get()).baseUrl, 'https://app.fixture.invalid/v1')
  await writeFile(app, '')
  assert.equal((await live.get()).model, 'root-model')
  await writeFile(root, '')
  assert.equal((await live.get()).source, 'file')
  assert.deepEqual(await settings.read(), { ...first, contextWindow: 256000 })
  const isolated = createModelSettings({ file, env: { PIDOT_REPLY_MODE: 'test' }, envFiles: [app, root] })
  assert.equal(await isolated.read(), undefined)
  await assert.rejects(isolated.save(input()), errorCode('MODEL_SETTINGS_TEST_MODE'))
  await writeFile(app, 'PIDOT_REPLY_MODE=test\n')
  assert.equal(await live.read(), undefined)
  await assert.rejects(live.save(input()), errorCode('MODEL_SETTINGS_TEST_MODE'))
  await writeFile(app, 'OPENAI_API_KEY=partial-only\n')
  await assert.rejects(live.read(), error => error.message.startsWith('PIDOT_') && !error.message.includes('partial-only'))
})

test('T02 legacy Task ignores old provider/address, rotates key live and pins model across provider rejection', async t => {
  const { settings, open, dir } = await fixture(t)
  await settings.save(input())
  const calls = []
  let reject = false
  const bots = listBots(first).map(bot => ({ ...bot, defaults: { ...bot.defaults, model: { ...bot.defaults.model, provider: 'bb-api', baseUrl: first.baseUrl } } }))
  const store = await open({ bots, modelReply: createModelReply(settings.read, { fetch: async (url, init) => {
    calls.push({ url, key: init.headers.get('Authorization'), body: JSON.parse(init.body) })
    return reject ? new Response(JSON.stringify({ error: { message: key, code: 'model_not_found' } }), { status: 404 }) : sse(`safe ${calls.length > 1 ? rotated : ''} ${key}`)
  } }) })
  const task = await store.create({ botId: 'chief' }), refs = (await store.getBotConfiguration('chief')).bot.configRef
  await store.send(task.taskId, 'before'); await settled(store, task.taskId)
  await store.saveModelSettings(input({ requestId: 'live-change-request', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: rotated, model: 'new-default' }))
  await store.send(task.taskId, 'after')
  const updated = await settled(store, task.taskId)
  assert.deepEqual(updated.parameters, task.parameters)
  assert.deepEqual(updated.configRef, task.configRef)
  assert.deepEqual((await store.getBotConfiguration('chief')).bot.configRef, refs)
  assert.equal(calls[1].url, 'http://127.0.0.1:9999/v1/chat/completions')
  assert.equal(calls[1].key, `Bearer ${rotated}`)
  assert.equal(calls[1].body.model, first.model)
  assert.equal(JSON.stringify(updated).includes(key), false)
  assert.equal(JSON.stringify(updated).includes(rotated), false)
  for (const name of await readdir(dir)) {
    if (name === 'model-settings.json') continue
    const bytes = await readFile(join(dir, name))
    assert.equal(bytes.includes(Buffer.from(key)), false, name)
    assert.equal(bytes.includes(Buffer.from(rotated)), false, name)
  }
  reject = true
  await assert.rejects(createModelReply(settings.read, { fetch: async () => new Response('{}', { status: 404 }) })('input', { parameters: task.parameters }),
    error => error.code === 'MODEL_REJECTED' && error.message.includes('不会自动换模型'))
})

test('T02 saving after unconfigured startup enables new real Tasks without rewriting old Tasks, and survives restart', async t => {
  const { settings, open, close } = await fixture(t)
  const fetch = async () => sse()
  let store = await open({ modelReply: createModelReply(settings.read, { fetch }) })
  const old = await store.create({ botId: 'chief' })
  assert.equal(old.parameters.mode, 'test')
  const { request } = await api(t, store)
  assert.equal((await request('POST', input())).status, 200)
  const current = await store.create({ botId: 'chief' })
  assert.equal(current.parameters.mode, 'model')
  assert.equal(current.parameters.model.id, first.model)
  assert.equal((await store.get(old.taskId)).parameters.mode, 'test')
  await store.send(current.taskId, 'first real call')
  assert.equal((await settled(store, current.taskId)).messages.at(-1).mode, 'model')
  const botRef = (await store.getBotConfiguration('chief')).bot.configRef
  await close(store)
  store = await open({ modelReply: createModelReply(settings.read, { fetch }) })
  assert.deepEqual((await store.getBotConfiguration('chief')).bot.configRef, botRef)
  assert.deepEqual((await store.get(current.taskId)).configRef, current.configRef)
  assert.equal((await store.create({ botId: 'chief' })).parameters.mode, 'model')
})

test('T02 endpoint is authenticated, method-limited and never returns or logs keys', async t => {
  const { settings, open, dir } = await fixture(t)
  const store = await open(), { request, logs } = await api(t, store)
  assert.equal((await request('GET', undefined, false)).status, 401)
  assert.equal((await request('DELETE')).status, 405)
  const saved = await request('POST', input())
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.data, await settings.get())
  const bad = await request('POST', input({ requestId: 'invalid-api-request', baseUrl: key }))
  assert.equal(bad.status, 400)
  assert.equal(JSON.stringify([saved, bad, await request(), logs]).includes(key), false)
  const config = await store.getBotConfiguration('chief')
  const task = await store.create({ botId: 'chief' })
  assert.equal(JSON.stringify([config, task, await store.get(task.taskId)]).includes(key), false)
  for (const name of await readdir(dir)) {
    if (name === 'model-settings.json') continue
    assert.equal((await readFile(join(dir, name))).includes(Buffer.from(key)), false, name)
  }
})

test('T02 seed version excludes connections and legacy persisted versions do not trigger migration', async t => {
  for (let i = 0; i < listBots(first).length; i++) {
    assert.deepEqual(listBots(first)[i].configRef, listBots({ ...first, baseUrl: 'https://next.fixture.invalid/v1', apiKey: rotated })[i].configRef)
  }
  const { settings, open, close } = await fixture(t)
  await settings.save(input())
  const legacy = listBots(first).map(bot => {
    const defaults = { ...bot.defaults, model: { provider: 'bb-api', api: 'openai-completions', id: first.model, baseUrl: first.baseUrl } }
    const version = `${BOT_CONFIG_VERSION}.${createHash('sha256').update(JSON.stringify(defaults)).digest('hex').slice(0, 16)}`
    return { ...bot, defaults, configRef: { botId: bot.id, version } }
  })
  let store = await open({ bots: legacy })
  const task = await store.create({ botId: 'chief' })
  const before = await store.harness.commit(async tx => JSON.parse(JSON.stringify((await tx.doc(BotDirectory)).items.map(bot => bot.configRef))), context)
  await store.saveModelSettings(input({ requestId: 'live-version-check', baseUrl: 'https://live.fixture.invalid/v1', apiKey: rotated }))
  for (const ref of before) assert.deepEqual((await store.getBotConfiguration(ref.botId)).bot.configRef, ref)
  await close(store)
  await settings.save(input({ requestId: 'restart-new-address', baseUrl: 'https://next.fixture.invalid/v1', apiKey: rotated }))
  store = await open({ bots: listBots(await settings.read()) })
  for (const ref of before) assert.deepEqual((await store.getBotConfiguration(ref.botId)).bot.configRef, ref)
  assert.deepEqual((await store.get(task.taskId)).configRef, task.configRef)
  await assert.rejects(store.previewMigration(task.taskId), errorCode('MIGRATION_NOT_NEEDED'))
  await store.updateBotConfiguration('chief', { requestId: 'legacy-edit-request', expectedVersion: task.configRef.version,
    description: 'legacy model edits remain allowed', tools: [], resources: [] })
})


test('T02 concurrent writes serialize key retention and cannot let an old retry overwrite a newer connection', async t => {
  const { settings } = await fixture(t)
  await settings.save(input())
  const a = input({ requestId: 'concurrent-settings-a', baseUrl: 'https://a.fixture.invalid/v1', apiKey: rotated })
  const b = input({ requestId: 'concurrent-settings-b', baseUrl: 'https://b.fixture.invalid/v1', apiKey: '' })
  await Promise.all([settings.save(a), settings.save(b)])
  assert.equal((await settings.read()).apiKey, rotated)
  assert.equal((await settings.read()).baseUrl, b.baseUrl)
  await settings.save(a)
  assert.equal((await settings.read()).baseUrl, b.baseUrl)
})


test('T02 direct settings-file updates are visible without restart and malformed files fail closed', async t => {
  const { settings, open, dir } = await fixture(t)
  const store = await open()
  await writeFile(join(dir, 'model-settings.json'), JSON.stringify(first), { mode: 0o600 })
  const enabled = await store.getBotConfiguration('chief')
  assert.equal(enabled.bot.defaults.mode, 'model')
  const refs = enabled.bot.configRef
  await writeFile(join(dir, 'model-settings.json'), JSON.stringify({ ...first, model: 'file-changed-model', apiKey: rotated }))
  const refreshed = await store.getBotConfiguration('chief')
  assert.equal(refreshed.models.some(model => model.id === 'file-changed-model'), true)
  assert.deepEqual(refreshed.bot.configRef, refs)
  await writeFile(join(dir, 'model-settings.json'), '{invalid')
  await assert.rejects(settings.get(), error => error.message === 'PIDOT_模型设置文件无效或不可读取。')
  await assert.rejects(createModelReply(settings.read)('fixture', { parameters: enabled.bot.defaults }), errorCode('MODEL_CONFIG_UNAVAILABLE'))
})
