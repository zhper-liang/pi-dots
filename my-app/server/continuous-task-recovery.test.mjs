import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'continuous-fixture', apiKey: 'fixture-only', contextWindow: 65536 }
async function until(fn, predicate = Boolean) {
  for (let n = 0; n < 1000; n++) { const value = await fn(); if (predicate(value)) return value; await delay(5) }
  assert.fail('continuous recovery did not settle')
}
async function killed(t, scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-continuous-kill-'))
  const child = spawn(process.execPath, [new URL('./fixtures/continuous-recovery-process.mjs', import.meta.url).pathname, dir, scenario], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }; await rm(dir, { recursive: true, force: true }) })
  const checkpoint = await until(async () => {
    if (child.exitCode !== null) throw new Error(output)
    try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null }
  })
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  assert.equal((await readFile(join(dir, 'calls.log'), 'utf8')).split('\n').filter(line => line === 'tool').length, 1)
  return { id: checkpoint.taskId, file: join(dir, 'task.sqlite') }
}
const finishReview = options => {
  const state = JSON.parse(options.context.continuous.prompt.split('\n').at(-1))
  const call = { type: 'toolCall', id: 'review-final', name: 'work_complete', arguments: {
    requestId: 'review-final', goalRevision: 1, planRevision: 1, stepId: 'execute-1', submissionRevision: 1,
    criteriaEvidence: [{ index: 0, verdict: 'satisfied', reason: '回执与摘要一致，逐条确认来源。', evidenceRefs: state.evidence.map(item => item.ref) }], summary: '恢复后的最终摘要',
  } }
  return { mode: 'model', reply: { content: '' }, toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() }, execution: { usage: { totalTokens: 5 } } }
}

test('LR01 SIGKILL before stage receipt preserves same root and unknown usage, without replaying successful tools', { timeout: 15000 }, async t => {
  const { id, file } = await killed(t, 'before-stage')
  let calls = 0
  const store = await openTaskStore({ file, bots: listBots(config), modelReply: async () => { calls++; throw new Error('must not retry unknown model') } })
  t.after(() => store.close())
  const task = await until(() => store.get(id), task => task.continuous.state === 'limited')
  assert.equal(calls, 0)
  assert.equal(task.executionPolicy.rootTaskId, id)
  assert.equal(task.callUsage.modelCalls, 2)
  assert.equal(task.callUsage.unknownTokenCalls, 1)
  assert.equal(task.messages.filter(message => message.intermediate).length, 0)
  assert.equal(task.messages.filter(message => message.toolName === 'calendar_read_schedule').length, 1)
  assert.equal(task.continuous.finalOutcome, null)
})

test('LR01 SIGKILL after stage commit resumes verification at the original input and delivers once', { timeout: 15000 }, async t => {
  const { id, file } = await killed(t, 'after-stage')
  let calls = 0, tools = 0
  let store = await openTaskStore({ file, bots: listBots(config), modelReply: async (_message, options) => { calls++; return finishReview(options) }, toolImpl: async () => { tools++; throw new Error('successful read must not repeat') } })
  t.after(() => store.close())
  const done = await until(() => store.get(id), task => task.continuous.state === 'completed')
  assert.deepEqual([calls, tools], [1, 0])
  assert.equal(done.callUsage.modelCalls, 3)
  assert.equal(done.messages.filter(message => message.intermediate && message.content === '已保存的阶段成果，不代表整个目标完成。').length, 1)
  assert.equal(done.messages.filter(message => message.role === 'assistant' && !message.intermediate && !message.assistant).length, 1)
  const rootInputId = done.executionPolicy.rootInputId
  await store.close()
  store = await openTaskStore({ file, bots: listBots(config), modelReply: async () => { calls++; throw new Error('completed cannot resume') } })
  await delay(50)
  assert.equal(calls, 1)
  assert.equal((await store.get(id)).executionPolicy.rootInputId, rootInputId)
})

test('LR01 disabling on restart parks saved progress without model polling; re-enable resumes same checkpoint', { timeout: 15000 }, async t => {
  const { id, file } = await killed(t, 'after-stage')
  let calls = 0
  let store = await openTaskStore({ file, bots: listBots(config), continuousEnabled: false, modelReply: async () => { calls++; throw new Error('disabled') } })
  t.after(() => store.close())
  const paused = await until(() => store.get(id), task => task.continuous.state === 'paused')
  assert.equal(paused.continuous.waitingReason, 'feature-disabled')
  assert.equal(paused.activeInputId, paused.executionPolicy.rootInputId)
  await delay(30); assert.equal(calls, 0)
  await store.close()
  store = await openTaskStore({ file, bots: listBots(config), modelReply: async (_message, options) => { calls++; return finishReview(options) } })
  const done = await until(() => store.get(id), task => task.continuous.state === 'completed')
  assert.equal(calls, 1)
  assert.equal(done.continuous.steps[0].outputEntryId, paused.continuous.steps[0].outputEntryId)
})
