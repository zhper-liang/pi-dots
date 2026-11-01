import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { TaskProgress, ContinuousBudget } from './continuous-task.mjs'
import { MainSessions } from './main-session.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'continuous-fixture', apiKey: 'fixture-only', contextWindow: 65536 }
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 5 } } })
const turn = (name, args) => {
  const call = { type: 'toolCall', id: 'continuous-call', name, arguments: args }
  return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
}
const limits = { modelCalls: 8, toolCalls: 10, totalTokens: 100000, durationMs: 60000 }
const request = (taskId, more = {}) => ({ requestId: 'start-1', origin: { kind: 'main', taskId }, goal: '核对2026-10-20模拟日程', completionCriteria: ['读取模拟日程并给出有来源的摘要'], limits, ...more })
async function until(store, id, predicate) {
  for (let i = 0; i < 600; i++) {
    const value = await store.get(id).catch(async error => { throw new Error(JSON.stringify((await store.harness.getTask(id, context)).state) + error.message) })
    if (predicate(value)) return value
    await delay(5)
  }
  assert.fail(`continuous task did not settle: ${JSON.stringify(await store.get(id))}`)
}
async function fixture(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-continuous-'))
  let store
  try {
    store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => text('阶段产出'), ...options })
    await fn(store, (await store.mainSessions()).calendar, join(dir, 'task.sqlite'))
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }) }
}

let reviewId = 0
const review = (progress, evidence, overrides = {}) => turn('work_complete', {
  requestId: `review-${++reviewId}`, goalRevision: 1, planRevision: progress.planRevision, stepId: 'execute-1', submissionRevision: 1,
  criteriaEvidence: [{ index: 0, verdict: 'satisfied', reason: '已核对成功列表回执与阶段摘要，所列时间与来源相符。', evidenceRefs: evidence.map(ref => typeof ref === 'number' ? { taskId: 1, entryId: ref } : ref) }],
  summary: '已根据模拟日程回执核对并汇总。', ...overrides,
})

test('LR01 create is atomic, idempotent, origin-bound, finite and ordinary tasks remain ordinary', () => fixture(async (store, main) => {
  const [first, replay] = await Promise.all([store.startContinuous(request(main)), store.startContinuous(request(main))])
  assert.equal(first.rootTaskId, replay.rootTaskId)
  assert.equal(replay.replayed, true)
  await assert.rejects(store.startContinuous(request(main, { goal: 'other' })), { code: 'CONTINUOUS_REQUEST_CONFLICT' })
  await assert.rejects(store.startContinuous(request(999999, { requestId: 'missing' })), { code: 'TASK_NOT_FOUND' })
  await assert.rejects(store.startContinuous(request(main, { requestId: 'infinite', limits: { ...limits, modelCalls: null } })), { code: 'CONTINUOUS_LIMITS_REQUIRED' })
  const ordinary = await store.create({ botId: 'calendar' })
  assert.equal(ordinary.continuous, null)
  await assert.rejects(store.startContinuous(request(ordinary.taskId, { requestId: 'wrong-origin' })), { code: 'CONTINUOUS_ORIGIN_DENIED' })
  const root = await until(store, first.rootTaskId, value => value.continuous.state === 'limited')
  assert.equal(root.callUsage.modelCalls, 8)
  assert.equal(root.executionPolicy.rootInputId, root.runtime.checkpoint.lastInputId)
  assert.equal(root.taskState.goalRevision, 1)
  assert.equal(root.collaborations.length, 0)
  assert.equal(root.continuous.steps.some(step => step.status === 'verified'), false)
  assert.equal(root.continuous.finalOutcome, null)
  await assert.rejects(store.send(root.taskId, '继续'), { code: 'CONTINUOUS_INPUT_IMMUTABLE' })
  await assert.rejects(store.raiseLimits(root.taskId, { modelCalls: 10, totalTokens: null }), { code: 'INVALID_CALL_LIMITS' })
}))

test('LR01 early text is intermediate; execute and independent verify finish once with real evidence', async () => {
  let storeRef, calls = 0, stageSnapshot
  await fixture(async (store, main) => {
    storeRef = store
    const started = await store.startContinuous(request(main))
    const done = await until(store, started.rootTaskId, value => value.continuous.state === 'completed')
    assert.equal(calls, 3)
    assert.equal(stageSnapshot.activeInputId, done.executionPolicy.rootInputId)
    assert.equal(stageSnapshot.messages.filter(message => message.intermediate).length, 1)
    assert.equal(stageSnapshot.messages.some(message => message.role === 'assistant' && !message.intermediate && !message.assistant), false)
    assert.equal(stageSnapshot.continuous.steps[0].status, 'submitted')
    assert.equal(stageSnapshot.child.state, 'running')
    assert.deepEqual(done.continuous.steps.map(step => step.status), ['verified', 'verified'])
    assert.equal(done.continuous.finalOutcome.basis, 'model-review')
    assert.equal(done.activeInputId, null)
    assert.equal(done.messages.filter(message => message.role === 'assistant' && !message.intermediate && !message.assistant).length, 1)
    const mainView = await store.get(main)
    assert.equal(mainView.messages.filter(message => message.mirrorKind === 'continuous-event' && message.kind === 'completed').length, 1)
    await assert.rejects(store.send(done.taskId, '再做一轮'), { code: 'CONTINUOUS_INPUT_IMMUTABLE' })
  }, { modelReply: async (_message, options) => {
    calls++
    if (calls === 1) return turn('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' })
    if (calls === 2) return text('已经完成了日程读取；下面需要逐条核对摘要。')
    stageSnapshot = await storeRef.get(options.taskId)
    stageSnapshot.child = (await storeRef.harness.snapshot(MainSessions, undefined, context)).children[options.taskId]
    const progress = await storeRef.harness.snapshot(TaskProgress, options.taskId, context)
    const evidence = stageSnapshot.messages.filter(message => message.toolName === 'calendar_read_schedule' && message.result.ok).map(message => ({ taskId: options.taskId, entryId: message.id }))
    return review(progress, evidence)
  } })
})

test('LR01 invented or stale evidence and natural-language completion never settle success', () => fixture(async (store, main) => {
  const result = await store.startContinuous(request(main, { limits: { ...limits, modelCalls: 4 } }))
  const task = await until(store, result.rootTaskId, value => value.continuous.state === 'limited')
  assert.equal(task.continuous.finalOutcome, null)
  assert.equal(task.callUsage.modelCalls, 4)
  assert.ok(task.messages.some(message => message.toolName === 'work_complete' && message.result?.ok === false))
}, { modelReply: async () => review({ planRevision: 1 }, [999999]) }))

test('LR01 disabled creation refuses and cancellation archives the continuous Documents', () => fixture(async (store, main) => {
  await assert.rejects(store.startContinuous(request(main)), { code: 'CONTINUOUS_DISABLED' })
}, { continuousEnabled: false }))

test('LR01 cancellation keeps goal and budget readable and never resumes dispatch', () => fixture(async (store, main) => {
  const created = await store.startContinuous(request(main))
  await until(store, created.rootTaskId, value => value.continuous.state === 'limited')
  const cancelled = await store.cancel(created.rootTaskId, {})
  assert.equal(cancelled.continuous.state, 'cancelled')
  assert.equal(cancelled.continuous.goal, '核对2026-10-20模拟日程')
  assert.deepEqual(cancelled.continuous.limits, limits)
  assert.equal(cancelled.continuous.rootTaskId, created.rootTaskId)
  assert.equal(cancelled.callUsage.modelCalls, 8)
}))

test('LR01 active Skill survives stage output and deactivates only on final settlement', async () => {
  let storeRef, calls = 0, activeAtReview
  await fixture(async (store, main) => {
    storeRef = store
    const started = await store.startContinuous(request(main))
    const done = await until(store, started.rootTaskId, value => value.continuous.state === 'completed')
    assert.equal(activeAtReview.length, 1)
    assert.equal(done.skillState.active.length, 0)
  }, { modelReply: async (_message, options) => {
    calls++
    if (calls === 1) return turn('skill_activate', { skillId: 'calendar-conflict-analysis' })
    if (calls === 2) return turn('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' })
    if (calls === 3) return text('日程读取阶段完成，继续核验。')
    const view = await storeRef.get(options.taskId)
    activeAtReview = view.skillState.active
    return review(await storeRef.harness.snapshot(TaskProgress, options.taskId, context), view.messages.filter(message => message.toolName === 'calendar_read_schedule').map(message => ({ taskId: options.taskId, entryId: message.id })))
  } })
})

test('LR01 necessary blocker waits without polling and ordinary main messages do not answer it', async () => {
  let calls = 0
  await fixture(async (store, main) => {
    const started = await store.startContinuous(request(main))
    const waiting = await until(store, started.rootTaskId, value => value.runtime.checkpoint.phase === 'awaitBlocker')
    assert.equal(waiting.continuous.state, 'waiting')
    assert.equal(waiting.continuous.finalOutcome, null)
    const afterWaitCalls = calls
    await delay(30); assert.equal(calls, afterWaitCalls)
    await store.send(main, '无关的普通问题')
    await until(store, main, value => value.activeInputId === null)
    const stillWaiting = await store.get(started.rootTaskId)
    assert.equal(stillWaiting.blockers.activeId, waiting.blockers.activeId)
    assert.equal(stillWaiting.activeInputId, waiting.executionPolicy.rootInputId)
    await store.cancel(started.rootTaskId, {})
  }, { modelReply: async (_message, options) => {
    calls++
    if (options.context.continuous) return turn('report_blocker', { question: '需要哪个时区？', requiredInformation: '时区', assignee: 'user' })
    return text('普通会话继续。')
  } })
})

test('LR01 explicit main task_create and authenticated HTTP share the start service', async () => {
  const { createApiServer } = await import('./app.mjs')
  const { once } = await import('node:events')
  let mainId, mainCalls = 0
  await fixture(async (store, main) => {
    mainId = main
    await store.send(main, '明确启动持续目标，按给定额度推进')
    const replied = await until(store, main, value => value.activeInputId === null)
    const receipt = replied.messages.find(message => message.toolName === 'task_create').result
    assert.equal(receipt.ok, true)
    assert.equal((await store.get(receipt.data.taskId)).executionPolicy.kind, 'continuous')
    const server = createApiServer({ token: 'fixture-api-token', tasks: store })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const headers = { Authorization: 'Bearer fixture-api-token', 'Content-Type': 'application/json' }
      const url = `http://127.0.0.1:${server.address().port}/api/tasks/continuous`
      const body = JSON.stringify(request(main, { requestId: 'http-start', limits: { ...limits, modelCalls: 1 } }))
      const response = await fetch(url, { method: 'POST', headers, body })
      assert.equal(response.status, 201)
      const first = (await response.json()).data
      const replay = await fetch(url, { method: 'POST', headers, body })
      assert.equal(replay.status, 200)
      assert.equal((await replay.json()).data.rootTaskId, first.rootTaskId)
      assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401)
      assert.equal((await fetch(url, { headers })).status, 405)
      const detail = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${first.rootTaskId}`, { headers })
      assert.equal((await detail.json()).task.continuous.origin.originTaskId, main)
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
  }, { modelReply: async (_message, options) => {
    if (options.taskId === mainId && mainCalls++ === 0) return turn('task_create', {
      operationId: 'explicit-continuous', goal: '核对日程', completionCriteria: ['核对来源'], executionPolicy: { kind: 'continuous' }, limits: { ...limits, modelCalls: 2 },
    })
    return text('阶段回复')
  } })
})

test('LR01 persisted deadline stops the next model dispatch while keeping the in-flight stage output', async () => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), startedCall = new Promise(resolve => { entered = resolve })
  let calls = 0
  await fixture(async (store, main) => {
    const started = await store.startContinuous(request(main))
    await startedCall
    await store.harness.commit(async tx => { (await tx.doc(ContinuousBudget, started.rootTaskId)).deadlineAt = new Date(0).toISOString() }, context)
    release()
    const task = await until(store, started.rootTaskId, value => value.continuous.state === 'limited' && value.messages.some(message => message.intermediate))
    assert.equal(calls, 1)
    assert.equal(task.continuous.waitingReason, 'deadline')
    assert.equal(task.messages.filter(message => message.intermediate).length, 1)
    assert.equal(task.continuous.finalOutcome, null)
  }, { modelReply: async () => { calls++; entered(); await gate; return text('截止前已派发的结果如实保存。') } })
})

test('LR01 rework cannot borrow another step submission as current-step completion evidence', async () => {
  let calls = 0, storeRef, previousEvidence
  await fixture(async (store, main) => {
    storeRef = store
    const started = await store.startContinuous(request(main, { limits: { ...limits, modelCalls: 5 } }))
    const task = await until(store, started.rootTaskId, value => value.continuous.state === 'limited')
    assert.equal(task.continuous.finalOutcome, null)
    assert.equal(task.continuous.steps.some(step => step.status === 'verified'), false)
  }, { modelReply: async (_message, options) => {
    calls++
    if (calls === 1) return turn('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' })
    if (calls === 2 || calls === 4) return text('阶段成果')
    const view = await storeRef.get(options.taskId)
    previousEvidence ??= view.messages.filter(message => message.toolName === 'calendar_read_schedule').map(message => ({ taskId: options.taskId, entryId: message.id }))
    return review(await storeRef.harness.snapshot(TaskProgress, options.taskId, context), previousEvidence, calls === 3 ? { goalRevision: 999 } : { stepId: 'execute-2' })
  } })
})

test('LR01 revoked source hides continuous derived content and counts in detail and list projections', async () => {
  let calls = 0, storeRef
  await fixture(async (store, main) => {
    storeRef = store
    const started = await store.startContinuous(request(main))
    await until(store, started.rootTaskId, value => value.continuous.state === 'completed')
    await store.revokeTool('calendar', 'calendar_read_schedule')
    for (const view of [await store.get(started.rootTaskId), (await store.list()).find(item => item.taskId === started.rootTaskId)]) {
      assert.equal(view.continuous.visibility, 'permission-denied')
      assert.equal('steps' in view.continuous, false)
      assert.equal('evidenceRefs' in view.continuous, false)
      assert.equal(view.continuous.finalOutcome, null)
      assert.equal(view.continuous.goal, '核对2026-10-20模拟日程')
      assert.doesNotMatch(JSON.stringify(view.continuous), /私人阶段正文/)
      assert.ok(view.messages.every(message => message.role === 'user' || !message.content.includes('私人阶段正文')))
    }
  }, { modelReply: async (_message, options) => {
    calls++
    if (calls === 1) return turn('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' })
    if (calls === 2) return text('私人阶段正文')
    const view = await storeRef.get(options.taskId)
    return review(await storeRef.harness.snapshot(TaskProgress, options.taskId, context), view.messages.filter(message => message.toolName === 'calendar_read_schedule').map(message => ({ taskId: options.taskId, entryId: message.id })))
  } })
})

test('LR01 unconfigured test-mode bots cannot start a production continuous loop', () => fixture(async (store, main) => {
  await assert.rejects(store.startContinuous(request(main)), { code: 'CONTINUOUS_MODEL_REQUIRED' })
  assert.equal((await store.list()).length, 0)
}, { bots: listBots() }))
