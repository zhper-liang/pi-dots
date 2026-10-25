import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createModelReply, readModelConfig, modelParameters, ModelReplyError } from './model-reply.mjs'
import { listBots } from './bots.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { createApiServer } from './app.mjs'

const secret = 'provider-secret-DO-NOT-PERSIST-iss4'
const config = { baseUrl: 'https://provider.example/v1', apiKey: secret, model: 'deepseek-v4.1-flash' }
const parameters = modelParameters(config)
function sse(text = '真实模型文本', finish = 'stop', responseModel = config.model) {
  const chunk = (delta, reason = null) => ({ id: 'chat-test', object: 'chat.completion.chunk', model: responseModel,
    choices: [{ index: 0, delta, finish_reason: reason }] })
  return new Response([chunk({ role: 'assistant', content: text }), chunk({}, finish), {
    ...chunk({}), choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  }].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-model-'))
  const file = join(dir, 'test.sqlite')
  const stores = []
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const open = async (more = {}) => {
    const store = await openTaskStore({ file, bots: listBots(config),
      modelReply: createModelReply(config, { fetch: async () => sse() }), ...extra, ...more })
    stores.push(store)
    return store
  }
  return { file, open, store: await open() }
}
async function settled(store, id) {
  for (let i = 0; i < 500; i++) {
    const task = await store.get(id)
    if (task.activeInputId === null) return task
    await delay(5)
  }
  assert.fail('Model task did not settle')
}

test('server-only config supports root dotenv, environment overrides and explicit test isolation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-model-env-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, '.env')
  await writeFile(file, `base_url = "https://provider.example/v1/"\nOPENAI_API_KEY = '${secret}'\nMODEL = deepseek-v4.1-flash\n`, { mode: 0o600 })
  assert.deepEqual(await readModelConfig({ file, env: {} }), config)
  assert.equal((await readModelConfig({ file, env: { OPENAI_BASE_URL: 'https://other.example/v1', MODEL: 'pinned-next' } })).model, 'pinned-next')
  assert.equal((await readModelConfig({ file, env: { OPENAI_BASE_URL: 'https://other.example/v1' } })).baseUrl, 'https://other.example/v1')
  assert.equal(await readModelConfig({ file, env: { PIDOT_REPLY_MODE: 'test' } }), undefined)
  assert.equal(await readModelConfig({ file: join(dir, 'missing'), env: {} }), undefined)
  await assert.rejects(readModelConfig({ file: join(dir, 'missing'), env: { PIDOT_REPLY_MODE: 'model' } }), /PIDOT_/)
  for (const env of [{ OPENAI_API_KEY: '' }, { MODEL: '' }, { OPENAI_BASE_URL: 'http://external.example/v1' },
    { OPENAI_BASE_URL: 'https://user:password@example.com/v1' }, { OPENAI_BASE_URL: 'https://example.com/v1?key=secret' },
    { OPENAI_BASE_URL: 'not-a-url' }, { PIDOT_REPLY_MODE: 'invalid' }]) {
    await assert.rejects(readModelConfig({ file, env }), (error) => !error.message.includes(secret) && error.message.includes('PIDOT_'))
  }
})

test('Pi sends exact fixed model and explicit disabled thinking, only header contains key; response is allowlisted', async () => {
  let request
  const reply = createModelReply(config, { fetch: async (url, init) => {
    request = { url, body: JSON.parse(init.body), headers: new Headers(init.headers), redirect: init.redirect }
    return sse(`结果 <script>不执行</script> ${secret}`)
  } })
  const result = await reply('本轮消息', { parameters: { ...parameters, model: { ...parameters.model, id: 'old-pinned-model' } } })
  assert.equal(request.url, `${config.baseUrl}/chat/completions`)
  assert.equal(request.headers.get('Authorization'), `Bearer ${secret}`)
  assert.equal(request.redirect, 'error')
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '本轮消息' }])
  assert.equal(JSON.stringify(request.body).includes(secret), false)
  assert.equal(request.body.model, 'old-pinned-model')
  assert.deepEqual(request.body.thinking, { type: 'disabled' })
  assert.equal(request.body.stream, true)
  for (const key of ['tools', 'reasoning_effort']) assert.equal(Object.hasOwn(request.body, key), false)
  assert.equal(request.body.max_tokens ?? request.body.max_completion_tokens, 4096)
  assert.equal(result.execution.maxRetries, 0)
  assert.equal(result.execution.model, 'old-pinned-model')
  assert.equal(result.execution.responseModel, config.model)
  assert.deepEqual(result.execution.usage, { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16 })
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.match(result.reply.content, /已隐藏凭证/)
  assert.equal(Object.hasOwn(result.execution, 'cost'), false)
})

for (const [status, code] of [[401, 'MODEL_AUTH_FAILED'], [403, 'MODEL_AUTH_FAILED'], [408, 'MODEL_TIMEOUT'],
  [429, 'MODEL_RATE_LIMITED'], [503, 'MODEL_UNAVAILABLE'], [504, 'MODEL_TIMEOUT'], [400, 'MODEL_REJECTED']]) {
  test(`HTTP ${status} is visible, redacted and never retried automatically`, async () => {
    let calls = 0
    const reply = createModelReply(config, { fetch: async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: `PRIVATE ${secret}`, type: 'api_error' } }), {
        status, headers: { 'Content-Type': 'application/json' },
      })
    } })
    await assert.rejects(reply('input', { parameters }), (error) => error.code === code && !error.message.includes(secret) && !error.message.includes('PRIVATE'))
    assert.equal(calls, 1)
  })
}

test('deadline aborts a hanging transport or a hanging body; never persists partial text', async () => {
  for (const bodyStall of [false, true]) {
    let signal
    const reply = createModelReply(config, { fetch: async (_url, init) => {
      signal = init.signal
      if (!bodyStall) return new Promise(() => {})
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'))
        signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
    } })
    await assert.rejects(reply('slow', { parameters: { ...parameters, requestTimeoutMs: 80 } }), (error) => error.code === 'MODEL_TIMEOUT')
    assert.equal(signal.aborted, true)
  }
})

test('network faults, invalid SSE, empty output and incomplete finish do not fabricate success', async () => {
  for (const fetch of [async () => { throw new Error(secret) }, async () => new Response('not SSE'),
    async () => sse(''), async () => sse('partial', 'length'), async () => sse('partial', 'tool_calls')]) {
    await assert.rejects(createModelReply(config, { fetch })('input', { parameters }),
      (error) => ['MODEL_FAILED', 'MODEL_INVALID_REPLY', 'MODEL_OUTPUT_LIMIT'].includes(error.code) && !error.message.includes(secret))
  }
})

test('missing credentials, unknown thinking or a changed endpoint fails closed instead of using test/model fallback', async () => {
  let calls = 0
  const reply = createModelReply(config, { fetch: async () => { calls++; return sse() } })
  for (const p of [{ ...parameters, thinkingLevel: 'high' }, { ...parameters, requestTimeoutMs: 0 },
    { ...parameters, model: { ...parameters.model, baseUrl: 'https://other.example/v1' } },
    { ...parameters, model: { ...parameters.model, id: '../bad?model' } }]) {
    await assert.rejects(reply('input', { parameters: p }), (error) => error.code === 'MODEL_CONFIG_UNAVAILABLE')
  }
  await assert.rejects(createModelReply()('input', { parameters }), (error) => error.code === 'MODEL_CONFIG_UNAVAILABLE')
  assert.equal(calls, 0)
})

test('model preset version fingerprints non-secret settings, not credentials', () => {
  const before = listBots(config)[0]
  assert.equal(JSON.stringify(before).includes(secret), false)
  assert.equal(listBots({ ...config, apiKey: 'rotated' })[0].configRef.version, before.configRef.version)
  assert.notEqual(listBots({ ...config, model: 'other' })[0].configRef.version, before.configRef.version)
  assert.notEqual(listBots({ ...config, baseUrl: 'https://other.example/v1' })[0].configRef.version, before.configRef.version)
})

test('native model Task stores replies and actual parameters, reopens with fixed model and excludes secrets from all records', async (t) => {
  const calls = []
  const nextConfig = { ...config, model: 'new-default-model' }
  const modelReply = createModelReply(nextConfig, { fetch: async (_url, init) => { calls.push(JSON.parse(init.body)); return sse() } })
  const { store, open, file } = await fixture(t, { modelReply })
  const task = await store.create({ botId: 'chief' })
  await store.send(task.taskId, '第一轮')
  const first = await settled(store, task.taskId)
  assert.deepEqual(first.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(first.messages[1].byTaskId, task.taskId)
  assert.equal(first.messages[1].mode, 'model')
  assert.equal(first.messages[1].execution.model, config.model)
  await store.close()
  const reopened = await open({ bots: listBots(nextConfig), modelReply })
  assert.deepEqual((await reopened.get(task.taskId)).messages, first.messages)
  await reopened.send(task.taskId, '第二轮')
  const second = await settled(reopened, task.taskId)
  assert.deepEqual(second.parameters, task.parameters)
  assert.deepEqual(second.configRef, task.configRef)
  assert.equal(calls[1].model, config.model)
  assert.equal(second.messages.length, 4)
  assert.equal((await reopened.create({ botId: 'chief' })).parameters.model.id, config.model)
  const db = new DatabaseSync(file)
  try {
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      assert.equal(JSON.stringify(rows).includes(secret), false, name)
    }
  } finally { db.close() }
})

test('model failures are durable errors, clean slot atomically, preserve failure checkpoint and allow a new turn', async (t) => {
  let fail = true
  const { store, open } = await fixture(t, { modelReply: createModelReply(config, { fetch: async () => {
    if (fail) { fail = false; return new Response(secret, { status: 401 }) }
    return sse()
  } }) })
  const task = await store.create({ botId: 'todo' })
  await store.send(task.taskId, 'fail')
  const first = await settled(store, task.taskId)
  assert.equal(first.messages[1].role, 'error')
  assert.equal(first.messages[1].errorCode, 'MODEL_AUTH_FAILED')
  assert.equal(first.runtime.checkpoint.lastOutcome, 'failed')
  assert.equal(first.activeInputId, null)
  assert.equal(JSON.stringify(first).includes(secret), false)
  await store.close()
  const reopened = await open()
  assert.deepEqual((await reopened.get(task.taskId)).messages, first.messages)
  await reopened.send(task.taskId, 'retry explicitly')
  assert.equal((await settled(reopened, task.taskId)).messages.at(-1).role, 'assistant')
})

test('test conversations never call the model, model conversations never fall back to test', async (t) => {
  const { store, open } = await fixture(t, { bots: listBots(), modelReply: async () => { assert.fail('old test must not call model') } })
  const old = await store.create({ botId: 'chief' })
  await store.close()
  let calls = 0
  const reopened = await open({ bots: listBots(config), modelReply: async () => { calls++; throw new ModelReplyError('MODEL_UNAVAILABLE') } })
  await reopened.send(old.taskId, 'old')
  assert.equal((await settled(reopened, old.taskId)).messages[1].mode, 'test')
  assert.equal(calls, 0)
  // Changing startup seeds does not silently reconfigure the persisted directory.
  assert.equal((await reopened.create({ botId: 'chief' })).parameters.mode, 'test')
  const { store: modelStore } = await fixture(t, { modelReply: async () => { calls++; throw new ModelReplyError('MODEL_UNAVAILABLE') } })
  const real = await modelStore.create({ botId: 'chief' })
  await modelStore.send(real.taskId, 'real')
  const result = await settled(modelStore, real.taskId)
  assert.equal(calls, 1)
  assert.equal(result.messages[1].role, 'error')
  assert.equal(result.messages[1].mode, 'model')
})

test('authenticated HTTP Task flow exposes saved real reply/parameters but rejects ad hoc top-level model overrides', async (t) => {
  const { store } = await fixture(t)
  const token = 'iss4-local-test-token-not-provider-key'
  const server = createApiServer({ token, tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  assert.equal((await fetch(base + '/api/tasks')).status, 401)
  assert.equal((await request('/api/tasks', { botId: 'chief', model: 'override' })).status, 400)
  const { task } = await (await request('/api/tasks', { botId: 'chief' })).json()
  assert.equal((await request(`/api/tasks/${task.taskId}/messages`, { message: 'hello', reasoning_effort: 'high' })).status, 400)
  assert.equal((await request(`/api/tasks/${task.taskId}/messages`, { message: 'hello' })).status, 202)
  await settled(store, task.taskId)
  const result = await (await request(`/api/tasks/${task.taskId}`)).json()
  assert.equal(result.task.messages[1].mode, 'model')
  assert.deepEqual(result.task.messages[1].execution.thinking, { type: 'disabled' })
  for (const path of ['/api/bots', '/api/tasks', `/api/tasks/${task.taskId}`]) assert.equal((await (await request(path)).text()).includes(secret), false)
})

test('production CLI reads server config, real transport and restart reuse the same Task/response', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-model-cli-'))
  const file = join(dir, 'cli.sqlite')
  const requests = []
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    const response = sse('CLI 模型回复')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(await response.text())
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve))
  const token = 'iss4-cli-auth-token-not-provider-secret'
  let child
  t.after(async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close') }
    await new Promise((resolve) => provider.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env,
      PIDOT_REPLY_MODE: 'model', PIDOT_API_TOKEN: token, PIDOT_API_PORT: String(port), PIDOT_DB_PATH: file,
      OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, OPENAI_API_KEY: secret, MODEL: config.model } })
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    for (let i = 0; i < 500 && !output.includes('Pidot：http'); i++) {
      if (child.exitCode !== null) assert.fail(output)
      await delay(5)
    }
    assert.match(output, /新会话使用真实模型/)
    assert.equal(output.includes(secret), false)
  }
  const request = async (path, body) => (await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json()
  await start()
  const { task } = await request('/api/tasks', { botId: 'chief' })
  await request(`/api/tasks/${task.taskId}/messages`, { message: 'CLI 输入' })
  let completed
  for (let i = 0; i < 500; i++) { completed = (await request(`/api/tasks/${task.taskId}`)).task; if (completed.activeInputId === null) break; await delay(5) }
  assert.equal(completed.messages[1]?.content, 'CLI 模型回复')
  assert.equal(requests[0].path, '/v1/chat/completions')
  assert.equal(requests[0].auth, `Bearer ${secret}`)
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' })
  child.kill('SIGTERM'); assert.equal((await once(child, 'close'))[0], 0)
  await start()
  assert.deepEqual((await request(`/api/tasks/${task.taskId}`)).task.messages, completed.messages)
  await request(`/api/tasks/${task.taskId}/messages`, { message: 'CLI 重启后续聊' })
  for (let i = 0; i < 500; i++) { completed = (await request(`/api/tasks/${task.taskId}`)).task; if (completed.activeInputId === null) break; await delay(5) }
  assert.equal(completed.messages.length, 4)
  assert.deepEqual(requests[1].body.messages.map((message) => message.role), ['system', 'user', 'assistant', 'user'])
  assert.deepEqual(requests[1].body.messages.slice(1).map((message) => message.content), ['CLI 输入', 'CLI 模型回复', 'CLI 重启后续聊'])
  assert.ok(requests[1].body.messages[0].content[0].text.includes('Chief'))
  assert.equal(requests.length, 2)
  assert.equal((await readFile(file)).includes(Buffer.from(secret)), false)
})

test('truncated SSE with partial text and missing finish_reason is not a successful reply', async () => {
  const reply = createModelReply(config, { fetch: async () => new Response(
    'data: {"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  ) })
  await assert.rejects(reply('input', { parameters }), (error) => error.code === 'MODEL_FAILED' && !error.message.includes('partial'))
})

test('caller cancellation propagates to transport without returning partial success', async () => {
  const controller = new AbortController()
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  let transportSignal
  const reply = createModelReply(config, { fetch: async (_url, init) => {
    transportSignal = init.signal
    started()
    return new Promise((_, reject) => {
      if (init.signal.aborted) { reject(new Error(secret)); return }
      init.signal.addEventListener('abort', () => reject(new Error(secret)), { once: true })
    })
  } })
  const result = reply('input', { parameters, signal: controller.signal })
  await startedPromise
  controller.abort()
  await assert.rejects(result, (error) => error.code === 'MODEL_ABORTED' && !error.message.includes(secret))
  assert.equal(transportSignal.aborted, true)
})

test('V2 MCP dotted names map explicitly to provider-safe aliases and restore canonical results', async () => {
  const call = { id: 'mcp-call', type: 'function', function: { name: 'workspace_prepare_change', arguments: JSON.stringify({ sourceId: 'local', requestId: 'alias-proof', action: 'create', change: { type: 'Todo', data: { title: 'test' } } }) } }
  let payload
  const reply = createModelReply(config, { fetch: async (_u, init) => {
    payload = JSON.parse(init.body)
    return new Response([{ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }].map(c => `data: ${JSON.stringify({ id: 'alias', model: config.model, ...c })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  const result = await reply('只准备', { parameters, context: { tools: [{ name: 'workspace.prepare_change', description: 'prepare only', parameters: { type: 'object' } }], messages: [{ role: 'user', content: 'only prepare', timestamp: Date.now() }] } })
  assert.equal(payload.tools[0].function.name, 'workspace_prepare_change')
  assert.equal(result.toolCalls[0].name, 'workspace.prepare_change'); assert.equal(result.assistant.content[0].name, 'workspace.prepare_change')
})
