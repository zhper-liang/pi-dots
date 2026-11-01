import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModelSettings } from './model-settings.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { openTaskStore, ChatInput, ChatQueue } from './tasks.mjs'
import { BotDirectory } from './bot-directory.mjs'

// Random, disposable credentials only. Compare booleans so failures cannot print credentials.
const secret = () => randomUUID()
const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
const idle = view => view.activeInputId === null && view.queueLength === 0 && view.runtime.checkpoint?.phase === 'awaitInput'
async function until(read, check) {
  for (let i = 0; i < 1200; i++) { const result = await read(); if (check(result)) return result; await delay(5) }
  assert.fail('T12 isolated loopback boundary timed out')
}
function assertPrivate(value, secrets) {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value)
  assert.equal(secrets.some(value => encoded.includes(value)), false, 'credential escaped the isolated server boundary')
}
async function stopServer(server) {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
}
async function provider(t, label, credential, { hold = () => false, reject = () => false } = {}) {
  const calls = [], pending = new Set(), errors = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      try {
        const body = JSON.parse(raw)
        const last = body.messages?.filter(item => item.role === 'user').at(-1)?.content
        const message = typeof last === 'string' ? last : last?.map(item => item.text ?? '').join('') ?? ''
        // Never store raw authorization, headers, request bodies, or keys in diagnostics.
        const call = { label, path: req.url, model: body.model, authenticated: req.headers.authorization === `Bearer ${credential}`, message }
        calls.push(call)
        if (reject(call)) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          // A hostile provider may echo its key. This is never a real credential.
          res.end(JSON.stringify({ error: { code: 'model_not_found', message: credential } }))
          return
        }
        const reply = () => {
          pending.delete(reply)
          if (res.destroyed) return
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const chunk = (delta, finish_reason = null) => ({ id: `t12-${calls.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })
          res.end([chunk({ role: 'assistant', content: `${label}:${body.model}:isolated reply` }), chunk({}, 'stop'), { ...chunk({}), choices: [], usage }].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n')
        }
        if (hold(call)) { pending.add(reply); res.on('close', () => pending.delete(reply)) } else reply()
      } catch { errors.push('invalid isolated provider request'); res.writeHead(400); res.end('{}') }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => stopServer(server))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls, errors, release: () => { for (const reply of [...pending]) reply() } }
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-t12-model-')), file = join(dir, 'isolated.sqlite')
  const stores = new Set()
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const settings = () => createModelSettings({ file, env: {}, envFiles: [] })
  const open = async (options = {}) => {
    const modelSettings = options.modelSettings ?? settings()
    const config = await modelSettings.read()
    const bots = listBots(config)
    bots.find(bot => bot.id === 'calendar').defaults.model.id = 'model-b'
    const store = await openTaskStore({ file, bots, modelSettings, memoryOptions: { enabled: false }, workspaceScheduleOptions: { autoStart: false }, ...options })
    stores.add(store); return store
  }
  const close = async store => { await store.close(); stores.delete(store) }
  return { dir, file, settings, open, close }
}
async function api(t, store, secrets) {
  const token = secret(), logs = [], responses = []
  const server = createApiServer({ token, tasks: store, onError: (...args) => {
    const text = JSON.stringify(args, (_name, value) => value instanceof Error ? { message: value.message, stack: value.stack, code: value.code } : value)
    // Retain only the audit result, never raw provider diagnostics in test output.
    logs.push({ private: [...secrets, token].some(value => text.includes(value)) })
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => stopServer(server))
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = { status: response.status, body: await response.json() }
    assertPrivate(result, [...secrets, token]); responses.push(result)
    return result
  }
  return { request, logs, responses }
}
async function assertDiskPrivate(dir, secrets) {
  for (const name of await readdir(dir)) {
    if (name === 'model-settings.json') { assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600); continue }
    const path = join(dir, name), info = await stat(path)
    if (info.isDirectory()) { await assertDiskPrivate(path, secrets); continue }
    const bytes = await readFile(path)
    assert.equal(secrets.some(value => bytes.includes(Buffer.from(value))), false, 'credential entered a non-credential file')
  }
}
// Delivery state is a live projection; compare the durable user entry fields separately.
const durableMessage = ({ deliveryStatus: _deliveryStatus, queuePosition: _queuePosition, ...entry }) => entry
function identity(view) {
  return { taskId: view.taskId, conversationId: view.conversationId, bot: view.bot, configRef: view.configRef, createdAt: view.createdAt, taskState: view.taskState }
}

// Actual sockets + the production provider adapter: no injected modelReply or fetch stub.
test('T12 loopback saved connection rotates old Task address/key live while model, identity, historical messages and usage stay pinned across restart', { timeout: 20000 }, async t => {
  const oldKey = secret(), newKey = secret(), secrets = [oldKey, newKey]
  const f = await fixture(t)
  const old = await provider(t, 'old', oldKey), next = await provider(t, 'next', newKey)
  await f.settings().save({ requestId: 't12-initial-model-settings', baseUrl: old.baseUrl, model: 'model-a', apiKey: oldKey })
  let store = await f.open()
  const firstApi = await api(t, store, secrets)
  const task = await store.create({ botId: 'chief', title: 'T12 old Task' })
  await store.send(task.taskId, 'before-connection-save')
  const before = await until(() => store.get(task.taskId), idle)
  assert.equal(before.messages.at(-1).execution.model, 'model-a')
  assert.equal(before.callUsage.totalTokens, 8)
  const refs = (await store.getBotConfiguration('chief')).bot.configRef
  const save = await firstApi.request('/api/settings/model', 'POST', { requestId: 't12-rotate-model-settings', baseUrl: next.baseUrl, model: 'new-default', apiKey: newKey })
  assert.equal(save.status, 200)
  assert.deepEqual(Object.keys(save.body.data).sort(), ['baseUrl', 'contextWindow', 'hasKey', 'model', 'source'])
  const unchanged = await store.get(task.taskId)
  assert.deepEqual(unchanged.messages, before.messages)
  assert.deepEqual(unchanged.callUsage, before.callUsage)
  assert.deepEqual(unchanged.parameters, before.parameters)
  assert.deepEqual(identity(unchanged), identity(before))
  assert.deepEqual((await store.getBotConfiguration('chief')).bot.configRef, refs)
  await store.send(task.taskId, 'after-connection-save')
  const after = await until(() => store.get(task.taskId), idle)
  assert.deepEqual(old.calls.map(call => [call.label, call.model, call.authenticated, call.path]), [['old', 'model-a', true, '/v1/chat/completions']])
  assert.deepEqual(next.calls.map(call => [call.label, call.model, call.authenticated, call.path]), [['next', 'model-a', true, '/v1/chat/completions']])
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages)
  assert.deepEqual(after.parameters, before.parameters)
  assert.deepEqual(identity(after), identity(before))
  assert.equal(after.callUsage.modelCalls, 2); assert.equal(after.callUsage.totalTokens, 16); assert.equal(after.callUsage.unknownTokenCalls, 0)
  const snapshot = structuredClone(after)
  await f.close(store)
  store = await f.open()
  const restored = await store.get(task.taskId)
  assert.deepEqual(identity(restored), identity(snapshot))
  assert.deepEqual(restored.messages, snapshot.messages)
  assert.deepEqual(restored.parameters, snapshot.parameters)
  assert.deepEqual(restored.callUsage, snapshot.callUsage)
  await store.send(task.taskId, 'after-store-restart')
  const final = await until(() => store.get(task.taskId), idle)
  assert.equal(old.calls.length, 1); assert.equal(next.calls.length, 2)
  assert.ok(next.calls.every(call => call.authenticated && call.model === 'model-a'))
  assert.equal(final.callUsage.modelCalls, 3); assert.equal(final.callUsage.totalTokens, 24)
  assert.deepEqual(final.messages.slice(0, snapshot.messages.length), snapshot.messages)
  assertPrivate([final, firstApi.responses, firstApi.logs], secrets)
  assert.deepEqual(old.errors, []); assert.deepEqual(next.errors, [])
  await assertDiskPrivate(f.dir, secrets)
})

test('T12 SIGKILL main input FIFO preserves each model id, original entries, lifetime usage and identities while recovery uses saved live connection', { timeout: 20000 }, async t => {
  const oldKey = secret(), newKey = secret(), secrets = [oldKey, newKey]
  const f = await fixture(t)
  const old = await provider(t, 'before-crash', oldKey, { hold: call => call.message === 'recovery-active' })
  let releaseRecovered = false
  const next = await provider(t, 'after-crash', newKey, { hold: () => !releaseRecovered })
  await f.settings().save({ requestId: 't12-recovery-before-crash', baseUrl: old.baseUrl, model: 'model-a', apiKey: oldKey })
  // Only the temporary directory is passed to the child. No secrets in argv/env/output.
  const child = spawn(process.execPath, [new URL('./fixtures/model-selection-recovery-process.mjs', import.meta.url).pathname, f.dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', chunk => { output.push(chunk.toString()) })
  child.stderr.on('data', chunk => { output.push(chunk.toString()) })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } })
  const checkpoint = await until(async () => {
    assertPrivate(output.join(''), secrets)
    if (child.exitCode !== null) assert.fail('isolated recovery child exited before checkpoint')
    try { return JSON.parse(await readFile(join(f.dir, 'checkpoint.json'), 'utf8')) } catch { return null }
  }, Boolean)
  await until(async () => old.calls, calls => calls.some(call => call.message === 'recovery-active'))
  const { history, saved, independent, mainSessions } = checkpoint
  const id = saved.taskId
  assert.equal(saved.queueLength, 3)
  const savedUsers = saved.messages.filter(message => message.role === 'user')
  assert.deepEqual(savedUsers.map(message => message.model.id), ['model-a', 'model-a', 'model-b', 'model-a', 'model-b'])
  assert.deepEqual(savedUsers.slice(-3).map(message => message.id), saved.queuedInputIds)
  assert.equal(saved.callUsage.lifetime.totalTokens, 8)
  assert.equal(saved.callUsage.modelCalls, 1); assert.equal(saved.callUsage.unknownTokenCalls, 1)
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  assertPrivate(output.join(''), secrets)
  await f.settings().save({ requestId: 't12-recovery-live-rotation', baseUrl: next.baseUrl, model: 'new-default', apiKey: newKey })
  const store = await f.open()
  await until(async () => next.calls.length, count => count === 1)
  const paused = await store.get(id)
  assert.deepEqual(identity(paused), identity(saved))
  assert.deepEqual(paused.messages, saved.messages)
  // Recovery reserves exactly one additional model attempt; it cannot erase the unknown crash attempt.
  assert.equal(paused.callUsage.modelCalls, saved.callUsage.modelCalls + 1)
  assert.equal(paused.callUsage.unknownTokenCalls, saved.callUsage.unknownTokenCalls + 1)
  assert.equal(paused.callUsage.totalTokens, saved.callUsage.totalTokens)
  assert.deepEqual(paused.callUsage.lifetime, saved.callUsage.lifetime)
  assert.equal(paused.activeInputId, saved.activeInputId)
  assert.deepEqual(paused.queuedInputIds, saved.queuedInputIds)
  assert.deepEqual(await store.mainSessions(), mainSessions)
  assert.deepEqual((await store.get(independent.taskId)).parameters, independent.parameters)
  assert.deepEqual(identity(await store.get(independent.taskId)), identity(independent))
  const audit = paused.recoveryHistory.at(-1)
  assert.equal(audit.taskId, id)
  assert.equal(audit.uncertainAttempt.kind, 'model')
  assert.equal(audit.messageControl.activeInputId, saved.activeInputId)
  assert.deepEqual(audit.messageControl.queuedInputIds, saved.queuedInputIds)
  releaseRecovered = true; next.release()
  const done = await until(() => store.get(id), idle)
  assert.deepEqual(next.calls.map(call => [call.model, call.authenticated, call.message]), [
    ['model-a', true, 'recovery-active'], ['model-b', true, 'recovery-queued-model-b'], ['model-a', true, 'recovery-queued-model-a'], ['model-b', true, 'recovery-queued-model-b'],
  ])
  assert.equal(old.calls.length, 2)
  assert.deepEqual(done.messages.filter(message => message.role === 'user').map(durableMessage), savedUsers.map(durableMessage))
  assert.deepEqual(done.messages.slice(0, history.messages.length), history.messages)
  const assistant = done.messages.filter(message => message.role === 'assistant')
  assert.equal(assistant.length, 5)
  assert.deepEqual(assistant.map(message => message.inReplyTo), savedUsers.map(message => message.id))
  assert.deepEqual(assistant.map(message => message.execution.model), ['model-a', 'model-a', 'model-b', 'model-a', 'model-b'])
  assert.equal(done.callUsage.lifetime.totalTokens + done.callUsage.totalTokens, 40)
  assert.equal(done.callUsage.lifetime.modelCalls + done.callUsage.modelCalls, 6)
  assert.equal(done.callUsage.lifetime.unknownTokenCalls + done.callUsage.unknownTokenCalls, 1)
  assert.equal(done.callUsage.lifetime.totalTokens, 32)
  assert.deepEqual(identity(done), identity(saved))
  assert.deepEqual(await store.mainSessions(), mainSessions)
  const third = structuredClone(done)
  await f.close(store)
  const reopened = await f.open()
  const stable = await reopened.get(id)
  assert.deepEqual(stable.messages, third.messages)
  assert.deepEqual(stable.callUsage, third.callUsage)
  assert.deepEqual(identity(stable), identity(third))
  assert.deepEqual(stable.parameters, third.parameters)
  assert.equal(stable.parameters.model.id, 'model-b')
  assert.equal(next.calls.length, 4)
  // Original slot and queue Documents remain the only input scheduler state.
  assert.equal((await reopened.harness.snapshot(ChatInput, id, context)).entryId, null)
  assert.deepEqual((await reopened.harness.snapshot(ChatQueue, id, context)).entryIds, [])
  assertPrivate([checkpoint, stable, next.calls, output.join('')], secrets)
  await assertDiskPrivate(f.dir, secrets)
})

test('T12 environment settings are read-only across API restart; responses, errors, logs and persisted documents never reveal keys', { timeout: 15000 }, async t => {
  const envKey = secret(), attemptedKey = secret(), secrets = [envKey, attemptedKey]
  const f = await fixture(t), endpoint = await provider(t, 'env', envKey)
  const modelSettings = () => createModelSettings({ file: f.file, envFiles: [], env: { OPENAI_BASE_URL: endpoint.baseUrl, MODEL: 'model-a', OPENAI_API_KEY: envKey } })
  let store = await f.open({ modelSettings: modelSettings() })
  const first = await api(t, store, secrets)
  const read = await first.request('/api/settings/model')
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.data, { baseUrl: endpoint.baseUrl, model: 'model-a', hasKey: true, contextWindow: 256000, source: 'env' })
  const before = await store.harness.snapshot(BotDirectory, undefined, context)
  const refused = await first.request('/api/settings/model', 'POST', { requestId: 't12-env-write-refused', baseUrl: 'http://127.0.0.1:9/v1', model: 'not-applied', apiKey: attemptedKey })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'MODEL_SETTINGS_ENV_LOCKED')
  assert.deepEqual(await store.harness.snapshot(BotDirectory, undefined, context), before)
  assert.equal((await first.request('/api/settings/model')).body.data.source, 'env')
  await assert.rejects(readFile(join(f.dir, 'model-settings.json')), error => error.code === 'ENOENT')
  const task = await store.create({ botId: 'chief', title: 'T12 environment Task' })
  const accepted = await first.request(`/api/tasks/${task.taskId}/messages`, 'POST', { message: 'env-loopback' })
  assert.equal(accepted.status, 202)
  const done = await until(() => store.get(task.taskId), idle)
  assert.deepEqual(endpoint.calls.map(call => [call.model, call.authenticated]), [['model-a', true]])
  await f.close(store)
  store = await f.open({ modelSettings: modelSettings() })
  const second = await api(t, store, secrets)
  assert.deepEqual((await second.request('/api/settings/model')).body, read.body)
  const restored = (await second.request(`/api/tasks/${task.taskId}`)).body.task
  assert.deepEqual(identity(restored), identity(done))
  assert.deepEqual(restored.messages, done.messages)
  assert.deepEqual(restored.callUsage, done.callUsage)
  assert.equal((await second.request('/api/settings/model', 'POST', { requestId: 't12-env-after-restart', baseUrl: endpoint.baseUrl, model: 'model-b' })).status, 409)
  assertPrivate([first.responses, second.responses, first.logs, second.logs, restored], secrets)
  assert.deepEqual(first.logs, []); assert.deepEqual(second.logs, [])
  await assertDiskPrivate(f.dir, secrets)
})

test('T12 loopback provider rejection keeps the old model id, preserves history/identity and redacts echoed credentials without fallback', { timeout: 15000 }, async t => {
  const oldKey = secret(), newKey = secret(), secrets = [oldKey, newKey]
  const f = await fixture(t)
  const old = await provider(t, 'accepted', oldKey)
  const next = await provider(t, 'rejected', newKey, { reject: () => true })
  await f.settings().save({ requestId: 't12-rejection-initial-save', baseUrl: old.baseUrl, model: 'model-a', apiKey: oldKey })
  const store = await f.open(), http = await api(t, store, secrets)
  const task = await store.create({ botId: 'chief', title: 'T12 unavailable pinned model' })
  await store.send(task.taskId, 'accepted-model-a')
  const before = await until(() => store.get(task.taskId), idle)
  assert.equal(before.callUsage.totalTokens, 8)
  assert.equal((await http.request('/api/settings/model', 'POST', { requestId: 't12-rejection-live-save', baseUrl: next.baseUrl, model: 'model-b', apiKey: newKey })).status, 200)
  await store.send(task.taskId, 'unsupported-model-a')
  const failed = await until(() => store.get(task.taskId), idle)
  assert.equal(failed.messages.at(-1).role, 'error')
  assert.equal(failed.messages.at(-1).errorCode, 'MODEL_REJECTED')
  assert.deepEqual(failed.messages.slice(0, before.messages.length), before.messages)
  assert.deepEqual(failed.parameters, before.parameters)
  assert.deepEqual(identity(failed), identity(before))
  assert.equal(failed.callUsage.totalTokens, before.callUsage.totalTokens)
  assert.equal(failed.callUsage.modelCalls, before.callUsage.modelCalls + 1)
  assert.equal(failed.callUsage.unknownTokenCalls, before.callUsage.unknownTokenCalls + 1)
  assert.deepEqual(next.calls.map(call => [call.model, call.authenticated]), [['model-a', true]])
  assert.equal(old.calls.length, 1)
  assert.equal((await http.request(`/api/tasks/${task.taskId}`)).status, 200)
  assertPrivate([failed, http.responses], secrets)
  assert.ok(http.logs.every(log => !log.private))
  await assertDiskPrivate(f.dir, secrets)
})

test('T12 completed idle main selection and per-input usage remain byte-for-byte stable after store reopen', { timeout: 15000 }, async t => {
  const credential = secret(), secrets = [credential]
  const f = await fixture(t), endpoint = await provider(t, 'idle', credential)
  await f.settings().save({ requestId: 't12-idle-main-selection', baseUrl: endpoint.baseUrl, model: 'model-a', apiKey: credential })
  let store = await f.open()
  const id = (await store.mainSessions()).chief
  await store.send(id, 'idle-main-a')
  await until(() => store.get(id), idle)
  await store.send(id, 'idle-main-b', undefined, { model: { id: 'model-b' } })
  const before = await until(() => store.get(id), idle)
  const sessions = await store.mainSessions()
  assert.equal(before.parameters.model.id, 'model-b')
  assert.equal(before.callUsage.totalTokens, 8)
  assert.equal(before.callUsage.lifetime.totalTokens, 8)
  const refs = (await store.getBotConfiguration('chief')).bot.configRef
  await f.close(store)
  store = await f.open()
  const after = await store.get(id)
  assert.deepEqual(identity(after), identity(before))
  assert.deepEqual(after.parameters, before.parameters)
  assert.deepEqual(after.messages, before.messages)
  assert.deepEqual(after.callUsage, before.callUsage)
  assert.deepEqual(after.recoveryHistory, before.recoveryHistory)
  assert.deepEqual(await store.mainSessions(), sessions)
  assert.deepEqual((await store.getBotConfiguration('chief')).bot.configRef, refs)
  assert.equal(endpoint.calls.length, 2)
  // With no new explicit choice, the current selected model stays pinned for the next input.
  await store.send(id, 'idle-main-continue')
  const done = await until(() => store.get(id), idle)
  assert.deepEqual(endpoint.calls.map(call => [call.model, call.authenticated]), [['model-a', true], ['model-b', true], ['model-b', true]])
  assert.deepEqual(done.messages.slice(0, before.messages.length), before.messages)
  assert.equal(done.callUsage.totalTokens + done.callUsage.lifetime.totalTokens, 24)
  assertPrivate(done, secrets)
  await assertDiskPrivate(f.dir, secrets)
})
