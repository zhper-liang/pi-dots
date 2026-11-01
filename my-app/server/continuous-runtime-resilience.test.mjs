import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { ModelReplyError } from './model-reply.mjs'
import { TaskProgress } from './continuous-task.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'resilience-fixture', apiKey: 'fixture-only', contextWindow: 65536 }
const limits = { modelCalls: 60, toolCalls: 50, totalTokens: 1000000, durationMs: 60000 }
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 5 } } })
const failure = (code, known = true) => Object.assign(new ModelReplyError(code), known ? { execution: { usage: { totalTokens: 5 } } } : {})
const blockedModel = signal => new Promise((_, reject) => {
  const abort = () => reject(signal.reason ?? new Error('aborted'))
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
})
async function until(read, predicate, description = 'continuous state') {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const value = await read()
    if (predicate(value)) return value
    await delay(5)
  }
  assert.fail(`Timed out waiting for ${description}`)
}
async function fixture(t, modelReply, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-continuous-resilience-'))
  const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply, ...options })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const root = await store.startContinuous({ requestId: 'resilience-start', origin: { kind: 'main', taskId: (await store.mainSessions()).calendar },
    goal: '形成有实际证据的工作成果', completionCriteria: ['产物存在且已核验'], limits: options.limits ?? limits })
  return { store, id: root.rootTaskId, dir }
}

test('LR04 a known transient model failure retries in the original task and counts both attempts', { timeout: 10000 }, async t => {
  let calls = 0
  const { store, id } = await fixture(t, async (_message, { signal }) => {
    if (++calls === 1) throw failure('MODEL_RATE_LIMITED')
    return blockedModel(signal)
  })
  const waiting = await until(() => store.harness.snapshot(TaskProgress, id, context), progress => progress.retry?.attempts === 1, 'durable retry')
  assert.equal(calls, 1)
  assert.ok(Date.parse(waiting.retry.nextAttemptAt) > Date.now() - 100)
  await until(async () => calls, count => count === 2, 'second model dispatch')
  const task = await store.get(id)
  assert.equal(task.callUsage.modelCalls, 2)
  assert.equal(task.continuous.usage.modelCalls, 2)
  assert.equal(task.executionPolicy.rootInputId, task.activeInputId)
  await store.cancel(id, {})
})

test('LR04 unknown model usage blocks retry without erasing the failed attempt', async t => {
  let calls = 0
  const { store, id } = await fixture(t, async () => { calls++; throw failure('MODEL_TIMEOUT', false) })
  const task = await until(() => store.get(id), value => value.continuous.state === 'limited')
  assert.equal(calls, 1)
  assert.equal(task.continuous.usage.unknownTokenCalls, 1)
  assert.equal(task.continuous.usage.modelCalls, 1)
  assert.equal(task.continuous.finalOutcome, null)
})

test('LR04 authentication errors fail once and cannot be reclassified as retryable by text', async t => {
  let calls = 0
  const { store, id } = await fixture(t, async () => { calls++; throw failure('MODEL_AUTH_FAILED') })
  const task = await until(() => store.get(id), value => value.continuous.state === 'failed')
  assert.equal(calls, 1)
  assert.notEqual(task.continuous.finalOutcome?.status, 'completed')
})

test('LR04 cancel during persisted backoff prevents another model dispatch', { timeout: 10000 }, async t => {
  let calls = 0
  const { store, id } = await fixture(t, async () => { calls++; throw failure('MODEL_RATE_LIMITED') })
  await until(() => store.harness.snapshot(TaskProgress, id, context), progress => Boolean(progress.retry))
  await store.cancel(id, {})
  await delay(1100)
  assert.equal(calls, 1)
  assert.equal((await store.get(id)).continuous.state, 'cancelled')
})

test('LR04 pause persists through retry deadline and only explicit resume admits the retry', { timeout: 10000 }, async t => {
  let calls = 0
  const { store, id } = await fixture(t, async (_message, { signal }) => {
    if (++calls === 1) throw failure('MODEL_RATE_LIMITED')
    return blockedModel(signal)
  })
  await until(() => store.harness.snapshot(TaskProgress, id, context), progress => Boolean(progress.retry))
  const task = await store.get(id)
  await store.controlContinuous(id, { requestId: 'pause-retry', expectedVersion: task.continuous.version, action: 'pause' })
  await delay(1100)
  assert.equal(calls, 1)
  const paused = await store.get(id)
  assert.equal(paused.continuous.state, 'paused')
  await store.controlContinuous(id, { requestId: 'resume-retry', expectedVersion: paused.continuous.version, action: 'resume' })
  await until(async () => calls, count => count === 2)
  assert.equal((await store.get(id)).executionPolicy.rootInputId, task.executionPolicy.rootInputId)
  await store.cancel(id, {})
})

test('LR04 a retry cannot extend the original deadline', async t => {
  let calls = 0
  const { store, id } = await fixture(t, async () => {
    calls++
    throw Object.assign(failure('MODEL_RATE_LIMITED'), { retryMetadata: { retryAfterMs: 60000 } })
  })
  const task = await until(() => store.get(id), value => value.continuous.state === 'limited')
  assert.equal(calls, 1)
  assert.match(task.continuous.waitingReason, /deadline/)
})

test('LR04 repeated completion claims without observable progress become blocked, not completed', async t => {
  let calls = 0
  const { store, id } = await fixture(t, async () => { calls++; return text('我已经完成了，继续改写进展说明。') })
  const task = await until(() => store.get(id), value => value.continuous.state === 'blocked')
  assert.equal(task.continuous.finalOutcome?.status === 'completed', false)
  assert.ok(calls < limits.modelCalls)
  const snapshot = calls
  await delay(60)
  assert.equal(calls, snapshot)
})

test('LR04 SIGKILL during backoff keeps its nextAttemptAt and retry counter', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-continuous-retry-kill-'))
  const child = spawn(process.execPath, [new URL('./fixtures/continuous-retry-process.mjs', import.meta.url).pathname, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', store
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const exited = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    await store?.close()
    await rm(dir, { recursive: true, force: true })
  })
  const checkpoint = await until(async () => {
    if (child.exitCode !== null) throw new Error(output)
    try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null }
  }, Boolean, 'persisted retry checkpoint in child')
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  let calls = 0
  store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async (_message, { signal }) => { calls++; return blockedModel(signal) } })
  const saved = await store.harness.snapshot(TaskProgress, checkpoint.taskId, context)
  assert.equal(saved.retry.attempts, checkpoint.retry.attempts)
  assert.equal(saved.retry.nextAttemptAt, checkpoint.retry.nextAttemptAt)
  await until(async () => calls, value => value === 1)
  const task = await store.get(checkpoint.taskId)
  assert.equal(task.continuous.usage.modelCalls, 2)
  assert.equal(task.executionPolicy.rootInputId, checkpoint.rootInputId)
  await store.cancel(checkpoint.taskId, {})
})
