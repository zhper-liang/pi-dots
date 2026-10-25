import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { readMockSchedule } from './tools.mjs'
import { ToolResults } from './tool-results.mjs'
import { executionDisposition } from './execution-recovery.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'recovery-fixture', apiKey: 'fixture-only' }
const answer = { mode: 'model', reply: { content: '基于已保存的三项会议：10:00–10:30重叠30分钟；上午不可改，待用户决定。' }, execution: { usage: { totalTokens: 11, input: 9, output: 2 } } }
async function until(fn, predicate) {
  for (let n = 0; n < 600; n++) { const value = await fn(); if (predicate(value)) return value; await delay(10) }
  throw new Error('Recovery did not reach expected checkpoint')
}
async function killed(t, scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss18-'))
  const child = spawn(process.execPath, [new URL('./fixtures/recovery-process.mjs', import.meta.url).pathname, dir, scenario], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk }); child.stderr.on('data', (chunk) => { output += chunk })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }; await rm(dir, { recursive: true, force: true }) })
  const checkpoint = await until(async () => {
    if (child.exitCode !== null) throw new Error(output)
    try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null }
  }, Boolean)
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  const log = JSON.parse('[' + (await readFile(join(dir, 'invocations.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).join(',') + ']')
  let calls = 0, toolCalls = 0; const contexts = []
  const bots = listBots(config); bots.find((bot) => bot.id === 'calendar').configRef.version = 'changed-after-restart'
  const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots, ...(scenario === 'missing-skill' ? { skillDirectory: join(dir, 'missing-skills') } : {}),
    modelReply: async (_message, options) => { calls++; contexts.push(options); return answer },
    toolImpl: async (args) => { toolCalls++; return readMockSchedule(args) } })
  t.after(() => store.close())
  return { store, id: checkpoint.taskId, checkpoint, log, contexts, counts: () => ({ calls, toolCalls }) }
}
for (const scenario of ['saved-tool', 'compacted']) test(`SIGKILL at ${scenario}: same identity, frozen context and receipt; resume without repeating query`, { timeout: 20000 }, async (t) => {
  const { store, id, contexts, counts, log } = await killed(t, scenario)
  const final = await until(() => store.get(id), (task) => task.activeInputId === null)
  assert.deepEqual(counts(), { calls: 1, toolCalls: 0 })
  assert.equal(log.filter((x) => x.kind === 'schedule').length, 1)
  assert.equal(final.taskId, id); assert.equal((await store.list()).length, 1)
  assert.notEqual(final.configRef.version, 'changed-after-restart')
  assert.equal(final.callUsage.modelCalls, 2); assert.equal(final.callUsage.toolCalls, 1)
  assert.equal(final.callUsage.totalTokens, 16); assert.equal(final.callUsage.unknownTokenCalls, 0)
  assert.equal(final.callUsage.input, 13); assert.equal(final.callUsage.output, 3)
  assert.match(contexts[0].context.systemPrompt, /上午会议不能调整/)
  assert.match(contexts[0].context.systemPrompt, /日程冲突分析 v1.1.0/)
  assert.match(JSON.stringify(contexts[0].context.messages), /mock-20261020-1/)
  assert.equal(final.skillState.active.length, 0)
  assert.equal(final.runtime.disposition, 'idle')
  assert.equal(final.recoveryHistory.length, 1); assert.equal(final.recoveryHistory[0].disposition, 'resumable')
  if (scenario === 'compacted') { assert.equal(final.compaction.revision, 1); assert.match(JSON.stringify(contexts[0]), /未解决事项是核实下午是否空闲/) }
})
for (const scenario of ['final', 'failed', 'cancelled']) test(`SIGKILL after ${scenario}: never replay completed input`, { timeout: 20000 }, async (t) => {
  const { store, id, counts, contexts } = await killed(t, scenario)
  await delay(80)
  const task = await store.get(id)
  assert.deepEqual(counts(), { calls: 0, toolCalls: 0 })
  if (scenario === 'cancelled') {
    assert.equal(task.runtime.status, 'terminal'); assert.equal(task.runtime.disposition, 'ended')
    await assert.rejects(store.send(id, '不得复活'), { code: 'TASK_CANCELLED' })
  } else {
    assert.equal(task.runtime.checkpoint.lastOutcome, scenario === 'failed' ? 'failed' : 'completed')
    assert.equal(task.callUsage.totalTokens, scenario === 'failed' ? 7 : 5)
    assert.equal(task.callUsage.unknownTokenCalls, 0); assert.equal(task.skillState.active.length, 0)
    assert.equal(task.recoveryHistory.length, 0)
    await store.send(id, '无关追问')
    const next = await until(() => store.get(id), (task) => task.activeInputId === null)
    assert.equal(next.callUsage.modelCalls, 2)
    assert.doesNotMatch(contexts[0].context.systemPrompt, /活动 Skill（固定完整版本）/)
  }
})
for (const scenario of ['limited', 'blocker']) test(`SIGKILL at ${scenario}: retain original wait without model polling`, { timeout: 20000 }, async (t) => {
  const { store, id, counts } = await killed(t, scenario)
  await delay(100)
  const task = await store.get(id)
  assert.deepEqual(counts(), { calls: 0, toolCalls: 0 }); assert.equal(task.runtime.disposition, 'waiting')
  assert.equal(task.skillState.active.length, 1)
  if (scenario === 'limited') assert.equal(task.runtime.checkpoint.lastOutcome, 'limited')
  else assert.ok(task.blockers.activeId)
})
test('in-flight model unknown usage survives crash and token threshold prevents automatic retry', { timeout: 20000 }, async (t) => {
  const { store, id, counts } = await killed(t, 'model-flight')
  const task = await until(() => store.get(id), (task) => task.runtime.checkpoint.lastOutcome === 'limited')
  assert.deepEqual(counts(), { calls: 0, toolCalls: 0 })
  assert.equal(task.callUsage.modelCalls, 1); assert.equal(task.callUsage.unknownTokenCalls, 1)
  assert.equal(task.recoveryHistory[0].uncertainAttempt.kind, 'model')
  assert.equal(task.messages.filter((x) => x.role === 'assistant').length, 0)
})
test('interrupted read is uncertain, retry consumes a new attempt and only its real result succeeds', { timeout: 20000 }, async (t) => {
  const { store, id, counts, log } = await killed(t, 'tool-flight')
  const task = await until(() => store.get(id), (task) => task.activeInputId === null)
  assert.equal(log.filter((x) => x.kind === 'schedule').length, 1)
  assert.deepEqual(counts(), { calls: 1, toolCalls: 1 })
  assert.equal(task.callUsage.toolCalls, 2)
  assert.equal(task.recoveryHistory[0].uncertainAttempt.kind, 'read-tool')
  assert.equal(task.messages.filter((x) => x.role === 'tool' && x.result.ok).length, 1)
})
test('disposition distinguishes Harness terminal outcomes and execution waits', () => {
  for (const status of ['succeeded', 'failed', 'aborted']) assert.equal(executionDisposition({ state: { status: 'terminal', outcome: { status } } }, {}, null), 'ended')
  assert.equal(executionDisposition({ state: { status: 'waiting' } }, {}, null), 'waiting')
})

test('partial tool turn resumes the next call index, not already committed calls', { timeout: 20000 }, async (t) => {
  const { store, id, counts, contexts } = await killed(t, 'partial-tools')
  const task = await until(() => store.get(id), (task) => task.activeInputId === null)
  assert.deepEqual(counts(), { calls: 1, toolCalls: 1 })
  assert.equal(task.callUsage.toolCalls, 2)
  const receipts = contexts[0].context.messages.filter((x) => x.role === 'toolResult')
  assert.equal(receipts.length, 2); assert.deepEqual(receipts.map((x) => x.toolCallId), ['call-1', 'call-2'])
})
test('oversized original tool artifacts survive hard restart under same Task ownership', { timeout: 20000 }, async (t) => {
  const { store, id, counts } = await killed(t, 'artifact')
  const task = await until(() => store.get(id), (task) => task.activeInputId === null)
  assert.equal(counts().toolCalls, 0)
  const receipt = task.messages.find((x) => x.role === 'tool')
  assert.ok(receipt.result.data.resultRef)
  const artifacts = await store.harness.snapshot(ToolResults, id, ctx)
  assert.match(JSON.stringify(artifacts), /mock-20261020-1/)
  assert.match(JSON.stringify(artifacts), /mock-20261031/)
})
test('missing live Skill source never replaces the saved active version', { timeout: 20000 }, async (t) => {
  const { store, id, contexts } = await killed(t, 'missing-skill')
  await until(() => store.get(id), (task) => task.activeInputId === null)
  assert.match(contexts[0].context.systemPrompt, /日程冲突分析 v1.1.0/)
})

test('storage failure rolls back final text AND usage; restart retains unknown attempt', async (t) => {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss18-atomic-')), file = join(dir, 'task.sqlite')
  const stores = []
  t.after(async () => { for (const store of stores) await store.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const store = await openTaskStore({ file, bots: listBots(config), modelReply: async () => answer }); stores.push(store)
  const task = await store.create({ botId: 'calendar', parameters: { callLimits: { totalTokens: 500 } } })
  const db = new DatabaseSync(file)
  db.exec("CREATE TRIGGER fail_final BEFORE INSERT ON entries WHEN json_extract(NEW.record, '$.kind') = 'pidot.model-reply' BEGIN SELECT RAISE(ABORT, 'test final receipt failure'); END")
  await store.send(task.taskId, '测试原子回复')
  await assert.rejects(until(() => store.get(task.taskId), () => false), { name: 'SessionFailed' })
  await store.close().catch(() => {})
  db.exec('DROP TRIGGER fail_final'); db.close()
  let calls = 0
  const reopened = await openTaskStore({ file, bots: listBots(config), modelReply: async () => { calls++; return answer } }); stores.push(reopened)
  const final = await until(() => reopened.get(task.taskId), (task) => task.runtime.checkpoint.lastOutcome === 'limited')
  assert.equal(calls, 0)
  assert.equal(final.callUsage.modelCalls, 1); assert.equal(final.callUsage.totalTokens, 0)
  assert.equal(final.callUsage.unknownTokenCalls, 1)
  assert.equal(final.messages.filter((x) => x.role === 'assistant').length, 0)
  assert.equal(final.messages.filter((x) => x.role === 'error').length, 1)
})
