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
import { createApiServer } from './app.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'message-control-fixture', apiKey: 'fixture-only' }
const answer = (text) => ({ mode: 'model', reply: { content: `恢复后的答案：${text}` }, execution: { usage: { totalTokens: 7, input: 5, output: 2 } } })
async function until(read, predicate = Boolean) {
  for (let n = 0; n < 800; n++) { const value = await read(); if (predicate(value)) return value; await delay(10) }
  assert.fail('ISS19 did not reach expected boundary')
}
async function fixture(t, scenario, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss19-')), file = join(dir, 'task.sqlite'), stores = []
  const child = spawn(process.execPath, [new URL('./fixtures/message-control-process.mjs', import.meta.url).pathname, dir, scenario], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', (x) => { output += x }); child.stderr.on('data', (x) => { output += x })
  const exited = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    for (const store of stores) await store.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  const saved = await until(async () => {
    if (child.exitCode !== null) throw new Error(output)
    try { return JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) } catch { return null }
  })
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
  const before = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const requests = []
  const open = async (extra = {}) => {
    const store = await openTaskStore({ file, bots: listBots(config), modelReply: async (message, opts) => {
      requests.push({ message, context: opts.context }); return answer(message)
    }, ...options, ...extra }); stores.push(store); return store
  }
  return { store: await open(), open, file, saved, before, requests }
}
const idle = (task) => task.activeInputId === null && task.queueLength === 0 && task.runtime.disposition === 'idle'
for (const scenario of ['direct-pending', 'direct-applied', 'converted-pending', 'converted-applied']) {
  test(`ISS19 SIGKILL ${scenario}: original -> FIFO, isolated queued context, exactly one steer`, { timeout: 20000 }, async (t) => {
    const { store, open, saved, before, requests } = await fixture(t, scenario)
    const done = await until(() => store.get(saved.taskId), idle)
    assert.deepEqual(requests.map((x) => x.message), before.map((x) => x.message).concat(['第二输入：整理下午方案', '第三输入：总结最终安排']))
    assert.equal(done.taskId, saved.taskId); assert.equal(done.conversationId, saved.conversationId)
    assert.deepEqual(done.taskState.constraints, ['原有限制', saved.directive])
    assert.equal(done.taskStateHistory.filter((x) => x.source === 'user-steer').length, 1)
    assert.deepEqual(done.messageControl.appliedSteerIds, [saved.steer])
    assert.deepEqual(done.messageControl.pendingSteers, []); assert.deepEqual(done.queuedInputIds, [])
    assert.equal(done.messages.filter((x) => x.id === saved.steer).length, 1)
    assert.equal(done.messages.find((x) => x.id === saved.steer).deliveryStatus, 'steer-applied')
    for (const id of [saved.original, ...saved.queued]) assert.equal(done.messages.find((x) => x.id === id).deliveryStatus, 'completed')
    assert.equal(done.messages.filter((x) => x.inReplyTo === saved.original && !x.intermediate && x.role === 'assistant').length, 1)
    const recovered = done.recoveryHistory[0].messageControl
    assert.equal(recovered.activeInputId, saved.original); assert.deepEqual(recovered.queuedInputIds, saved.queued)
    assert.deepEqual(recovered.pendingSteers, scenario.endsWith('pending') ? [{ entryId: saved.steer, targetInputId: saved.original }] : [])
    assert.deepEqual(recovered.appliedSteerIds, scenario.endsWith('applied') ? [saved.steer] : [])
    for (const ctx of [before[0].context, requests[0].context]) {
      const text = JSON.stringify(ctx.messages)
      assert.doesNotMatch(text, /第二输入|第三输入/)
    }
    assert.doesNotMatch(before[0].context.systemPrompt, /只允许提出下午方案/)
    assert.ok(requests[0].context.systemPrompt.includes(saved.directive))
    assert.equal(requests[0].context.messages.filter((x) => x.role === 'user' && x.content === saved.directive).length, 1)
    assert.doesNotMatch(JSON.stringify(requests[1].context.messages), /第三输入/)
    assert.match(JSON.stringify(requests[2].context.messages), /第二输入/)
    assert.equal(done.callUsage.modelCalls, 4); assert.equal(done.callUsage.unknownTokenCalls, scenario.endsWith('pending') ? 1 : 0)
    await store.close(); requests.length = 0
    const reopened = await open(); await delay(70)
    assert.equal(requests.length, 0); assert.deepEqual((await reopened.get(saved.taskId)).messageControl, done.messageControl)
  })
}

test('ISS19 consumed result and promoted FIFO are one checkpoint; original is never admitted again', { timeout: 20000 }, async (t) => {
  const { store, saved, requests } = await fixture(t, 'consumed')
  const done = await until(() => store.get(saved.taskId), idle)
  assert.deepEqual(requests.map((x) => x.message), ['第二输入：整理下午方案', '第三输入：总结最终安排'])
  assert.equal(done.messages.filter((x) => x.inReplyTo === saved.original && x.role === 'assistant').length, 1)
  assert.deepEqual(done.recoveryHistory[0].messageControl.queuedInputIds, [saved.queued[1]])
  assert.equal(done.recoveryHistory[0].messageControl.activeInputId, saved.queued[0])
  assert.match(JSON.stringify(requests[0].context.messages), /原进程已保存答案/)
  assert.equal(done.callUsage.modelCalls, 3); assert.equal(done.callUsage.totalTokens, 19)
})

for (const scenario of ['cancelled-request', 'cancelled-terminal', 'cancelled-late']) {
  test(`ISS19 SIGKILL ${scenario}: durable cancel, old queue and late receipt never resurrect execution`, { timeout: 20000 }, async (t) => {
    const { store, open, saved, requests } = await fixture(t, scenario)
    const done = await until(() => store.get(saved.taskId), (x) => x.runtime.status === 'terminal')
    assert.equal(done.runtime.outcome.status, 'aborted'); assert.ok(done.cancellation)
    assert.equal(done.messageControl.cancellationEntryId, done.cancellation.entryId)
    assert.deepEqual(done.queuedInputIds, saved.queued); assert.equal(done.activeInputId, saved.original)
    assert.equal(requests.length, 0)
    assert.equal(done.messages.find((x) => x.id === saved.original).deliveryStatus, 'cancelled')
    for (const id of saved.queued) assert.equal(done.messages.find((x) => x.id === id).deliveryStatus, 'queued')
    const late = done.messages.filter((x) => x.afterCancellation)
    assert.equal(late.length, saved.lateReceived ? 1 : 0)
    if (scenario === 'cancelled-late') assert.equal(late.length, 1)
    assert.deepEqual(done.messageControl.pendingSteers, [{ entryId: saved.steer, targetInputId: saved.original }])
    assert.equal(done.messages.find((x) => x.id === saved.steer).deliveryStatus, 'steer-pending')
    assert.equal(done.callUsage.unknownTokenCalls, late.length ? 0 : 1)
    for (const op of [() => store.send(saved.taskId, '不要复活'), () => store.steer(saved.taskId, { message: '不要复活' }), () => store.raiseLimits(saved.taskId, { modelCalls: 50 })]) await assert.rejects(op(), { code: 'TASK_CANCELLED' })
    await store.cancel(saved.taskId, {}); assert.equal((await store.get(saved.taskId)).cancellation.entryId, done.cancellation.entryId)
    await store.close(); const reopened = await open(); await delay(70)
    assert.equal(requests.length, 0); assert.deepEqual((await reopened.get(saved.taskId)).messageControl, done.messageControl)
  })
}

for (const scenario of ['limited', 'limited-pending']) test(`ISS19 ${scenario}: restart never resumes limited wait via queue or steering`, { timeout: 20000 }, async (t) => {
  const { store, saved, requests } = await fixture(t, scenario)
  await delay(80)
  const waiting = await store.get(saved.taskId)
  assert.equal(requests.length, 0); assert.equal(waiting.runtime.disposition, 'waiting')
  assert.equal(waiting.messageControl.waitingInputId, saved.original)
  assert.deepEqual(waiting.queuedInputIds, saved.queued)
  assert.deepEqual(waiting.messageControl.appliedSteerIds, scenario === 'limited' ? [saved.steer] : [])
  assert.deepEqual(waiting.messageControl.pendingSteers, scenario === 'limited-pending' ? [{ entryId: saved.steer, targetInputId: saved.original }] : [])
  await store.raiseLimits(saved.taskId, { modelCalls: 8, toolCalls: 10 })
  const done = await until(() => store.get(saved.taskId), idle)
  assert.deepEqual(requests.map((x) => x.message), ['原输入：分析2026-10-20日程', '第二输入：整理下午方案', '第三输入：总结最终安排'])
  assert.equal(done.taskStateHistory.filter((x) => x.source === 'user-steer').length, 1)
})

test('ISS19 authenticated HTTP after hard restart exposes actual executing, queued and inserted input states', { timeout: 20000 }, async (t) => {
  let release, entered
  const held = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { entered = resolve })
  t.after(() => release())
  const { store, saved } = await fixture(t, 'converted-pending', { modelReply: async (message) => { entered(); await held; return answer(message) } })
  await started
  const token = 'iss19-http-test-only'
  const server = createApiServer({ token, tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${saved.taskId}`
  assert.equal((await fetch(url)).status, 401)
  const get = async () => (await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()).task
  for (let n = 0; n < 2; n++) {
    const task = await get()
    assert.equal(task.messages.find((x) => x.id === saved.original).deliveryStatus, 'processing')
    assert.equal(task.messages.find((x) => x.id === saved.steer).deliveryStatus, 'steer-applied')
    assert.deepEqual(saved.queued.map((id) => task.messages.find((x) => x.id === id).queuePosition), [1, 2])
    assert.deepEqual(task.messageControl.queuedInputIds, saved.queued)
  }
  release(); await until(() => store.get(saved.taskId), idle)
})

for (const scenario of ['tools-pending', 'tools-applied']) {
  test(`ISS19 SIGKILL ${scenario}: old planned tools skipped once and never executed after steer`, { timeout: 20000 }, async (t) => {
    let toolCalls = 0
    const { store, saved, requests } = await fixture(t, scenario, { toolImpl: async () => { toolCalls++; throw new Error('Old plan must not run') } })
    const done = await until(() => store.get(saved.taskId), idle)
    assert.equal(toolCalls, 0); assert.equal(done.callUsage.toolCalls, 0)
    const receipts = done.messages.filter((x) => x.role === 'tool')
    assert.deepEqual(receipts.map((x) => x.callId), ['old-call-1', 'old-call-2'])
    assert.ok(receipts.every((x) => x.result.error.code === 'TOOL_SKIPPED_STEER'))
    assert.equal(done.taskStateHistory.filter((x) => x.source === 'user-steer').length, 1)
    assert.deepEqual(done.messageControl.appliedSteerIds, [saved.steer])
    assert.deepEqual(requests.map((x) => x.message), ['原输入：分析2026-10-20日程', '第二输入：整理下午方案', '第三输入：总结最终安排'])
    assert.match(JSON.stringify(requests[0].context.messages), /TOOL_SKIPPED_STEER/)
    assert.equal(done.callUsage.unknownTokenCalls, 0)
  })
}
