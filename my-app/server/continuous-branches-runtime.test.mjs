import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { TaskProgress } from './continuous-task.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'branches-fixture', apiKey: 'fixture-only', contextWindow: 65536 }
const limits = { modelCalls: 30, toolCalls: 40, totalTokens: 1000000, durationMs: 60000 }
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 5 } } })
const turn = (name, args) => { const call = { type: 'toolCall', id: name, name, arguments: args }; return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } } }
async function until(read, check) {
  let value
  for (let n = 0; n < 600; n++) { value = await read(); if (check(value)) return value; await delay(5) }
  assert.fail(`state did not settle: ${JSON.stringify(value)}`)
}
const blocked = signal => new Promise((_, reject) => { const abort = () => reject(signal.reason); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }) })

async function fixture(t, modelReply) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-continuous-branches-'))
  const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return store
}

test('LR06 a necessary question blocks only its branch; independent work remains verified and the exact answer resumes the stable input', async t => {
  let calls = 0, store, refs
  const steps = [
    { stepId: 'a', title: '需用户信息', dependsOn: [], deliverable: '补齐信息', verification: '核对回答', criteriaIndices: [0] },
    { stepId: 'b', title: '独立日程读取', dependsOn: [], deliverable: '日程来源', verification: '真实回执', criteriaIndices: [1] },
    { stepId: 'c', title: '依赖信息的后续', dependsOn: ['a'], deliverable: '后续成果', verification: '核验成果', criteriaIndices: [2] },
  ]
  store = await fixture(t, async (_message, options) => {
    if (options.purpose === 'context-compaction') return text('A待回答；B已读取成功，不重复；C依赖A。')
    calls++
    const task = await store.get(options.taskId)
    if (calls === 1) return turn('work_plan', { requestId: 'branch-plan', expectedPlanRevision: 1, goalRevision: 1, steps, currentStepId: 'a' })
    if (calls === 2) return turn('report_blocker', { question: '需要哪一天的安排？', requiredInformation: '具体日期', assignee: 'user' })
    if (calls === 3) { assert.equal(task.continuous.currentStepId, 'b'); return turn('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }) }
    if (calls === 4) {
      refs = task.messages.filter(row => row.toolName === 'calendar_read_schedule' && row.result.ok).map(row => ({ taskId: task.taskId, entryId: row.id }))
      return turn('work_submit', { requestId: 'branch-submit', goalRevision: 1, planRevision: 2, stepId: 'b', summary: '独立日程已读取', evidenceRefs: refs })
    }
    if (calls === 5) return text(JSON.stringify({ stageReview: { basis: 'model-review', goalRevision: 1, planRevision: 2, stepId: 'b', submissionRevision: 1,
      criteriaEvidence: [{ index: 1, verdict: 'satisfied', reason: '真实日程来源和日期已核对。', evidenceRefs: refs }] } }))
    assert.equal(task.continuous.currentStepId, 'a')
    return blocked(options.signal)
  })
  const main = (await store.mainSessions()).calendar
  const { rootTaskId: id } = await store.startContinuous({ requestId: 'branch-root', origin: { kind: 'main', taskId: main }, goal: '补齐信息并独立核对日程', completionCriteria: ['信息齐备', '日程核对', '后续成果'], limits })
  const waiting = await until(() => store.get(id).catch(async error => { throw new Error(JSON.stringify((await store.harness.getTask(id, context)).state) + error.message) }), task => task.runtime.checkpoint.phase === 'awaitBlocker' && task.continuous.steps.find(step => step.stepId === 'b')?.status === 'verified')
  const question = waiting.blockers.items.find(item => item.status === 'pending')
  assert.equal(calls, 5)
  assert.equal(waiting.activeInputId, waiting.executionPolicy.rootInputId)
  assert.equal(waiting.continuous.steps.find(step => step.stepId === 'c').status, 'pending')
  assert.equal(waiting.continuous.finalOutcome, null)
  await assert.rejects(store.resolveBlocker(id, question.id, { answer: '10月21日', version: question.version + 1, inReplyTo: question.inReplyTo }), { code: 'BLOCKER_VERSION_CONFLICT' })
  const answer = { requestId: 'exact-answer', answer: '10月21日', version: question.version, inReplyTo: question.inReplyTo }
  await store.resolveBlocker(id, question.id, answer)
  await store.resolveBlocker(id, question.id, answer)
  await until(async () => calls, value => value === 6)
  const resumed = await store.get(id)
  assert.equal(resumed.activeInputId, waiting.activeInputId)
  assert.equal(resumed.continuous.steps.find(step => step.stepId === 'b').status, 'verified')
  assert.equal(resumed.messages.filter(row => row.toolName === 'calendar_read_schedule' && row.result.ok).length, 1)
  assert.equal((await store.harness.snapshot(TaskProgress, id, context)).stall.evaluated, 0)
  await store.cancel(id, {})
})

test('LR05 group entry creates an independent coordinator root without an extra collaboration parent', async t => {
  const store = await fixture(t, async (_message, { signal }) => blocked(signal))
  const { task: group } = await store.createGroup({ requestId: 'continuous-group', title: '持续任务群', adminBotId: 'calendar', memberBotIds: ['calendar', 'todo'] })
  const { rootTaskId: id } = await store.startContinuous({ requestId: 'group-root', origin: { kind: 'group', taskId: group.taskId }, goal: '形成群协作成果', completionCriteria: ['成果可核验'], limits })
  const root = await until(() => store.get(id), task => task.callUsage.modelCalls === 1)
  assert.equal(root.kind, 'chat')
  assert.equal(root.continuous.origin.originKind, 'group')
  assert.equal(root.continuous.origin.originTaskId, group.taskId)
  assert.equal(root.continuous.origin.coordinatorBotId, 'calendar')
  assert.equal(root.collaborations.length, 0)
  assert.equal(root.mainParent, undefined)
  await store.deleteSession(group.taskId, { requestId: 'delete-continuous-group', confirmed: true })
  assert.equal((await store.get(id)).continuous.state, 'cancelled')
})

test('LR05 main replacement keeps the root input and delivers its final event once to the new entry', async t => {
  let store, calls = 0, release, entered
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
  store = await fixture(t, async (_message, options) => {
    calls++
    if (calls === 1) return turn('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' })
    if (calls === 2) { entered(); await gate; return text('已读取日程，等待独立核验。') }
    const state = JSON.parse(options.context.continuous.prompt.split('\n').at(-1))
    return turn('work_complete', { requestId: 'main-final', goalRevision: 1, planRevision: 1, stepId: 'execute-1', submissionRevision: 1,
      summary: '日程已核验。', criteriaEvidence: [{ index: 0, verdict: 'satisfied', reason: '真实日程回执已逐条核对。', evidenceRefs: state.evidence.map(row => row.ref) }] })
  })
  const main = (await store.mainSessions()).calendar
  const { rootTaskId: id } = await store.startContinuous({ requestId: 'clear-root', origin: { kind: 'main', taskId: main }, goal: '核对日程', completionCriteria: ['来源可核验'], limits })
  await ready
  const before = await store.get(id)
  const replacement = await store.clearMainSession(main, { requestId: 'clear-while-root', confirmed: true })
  assert.notEqual(replacement.replacementTaskId, main)
  const listed = await store.list(undefined, { continuousOriginTaskId: replacement.replacementTaskId })
  assert.ok(listed.some(row => row.taskId === id))
  release()
  const done = await until(() => store.get(id), task => task.continuous.state === 'completed')
  assert.equal(done.executionPolicy.rootInputId, before.executionPolicy.rootInputId)
  assert.equal(done.continuous.origin.originTaskId, main)
  assert.equal(done.continuous.origin.deliveryTaskId, replacement.replacementTaskId)
  const target = await store.get(replacement.replacementTaskId)
  assert.equal(target.messages.filter(row => row.rootTaskId === id && row.kind === 'completed').length, 1)
  assert.equal(target.messages.filter(row => row.childTaskId === id && row.mirrorKind === 'finished').length, 0)
  assert.equal(calls, 3)
})

test('LR05/06 a real group child result requires exact acceptance before root submission and one final group delivery', async t => {
  let store, rootId, rootCalls = 0, childCalls = 0
  const { Collaboration } = await import('./collaboration.mjs')
  store = await fixture(t, async (_message, options) => {
    if (options.purpose === 'context-compaction') return text('按原目标处理一次子任务，使用真实结果和精确验收，不能把提交当成功。')
    const task = await store.get(options.taskId)
    if (options.taskId !== rootId) {
      childCalls++
      if (childCalls === 1) { assert.ok(!options.context.tools.some(tool => tool.name === 'work_complete')); return turn('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }) }
      return text('子任务已读取指定日期的模拟日程，提供真实回执供主管核验。')
    }
    rootCalls++
    if (rootCalls === 1) {
      assert.ok(options.context.tools.some(tool => tool.name === 'task_assign'))
      return turn('task_assign', { operationId: 'group-child', botId: 'todo', goal: '读取10月20日日程并汇总', completionCriteria: ['来源和日期有真实回执'] })
    }
    const relation = (await store.harness.snapshot(Collaboration, context)).items.find(row => row.parentTaskId === rootId)
    assert.equal(relation.result.status, 'submitted')
    if (rootCalls === 2) return turn('task_review', { operationId: 'group-accept', childTaskId: relation.childTaskId, rootWorkId: relation.rootWorkId,
      revision: relation.result.revision, expectedState: 'submitted', decision: 'accept', reason: '成功回执的日期和来源与委派标准一致，已独立核对。', continuousBinding: relation.continuousBinding })
    const refs = [{ kind: 'child-result', relationId: relation.id, revision: relation.result.revision }]
    if (rootCalls === 3) {
      assert.equal(relation.businessStatus, 'accepted')
      assert.equal(task.continuous.finalOutcome, null)
      return turn('work_submit', { requestId: 'child-work-submit', goalRevision: 1, planRevision: 1, stepId: 'execute-1', summary: '已接受带真实日程回执的子结果', evidenceRefs: refs })
    }
    return turn('work_complete', { requestId: 'child-final', goalRevision: 1, planRevision: 1, stepId: 'execute-1', submissionRevision: 1,
      summary: '已核验协作日程成果。', criteriaEvidence: [{ index: 0, verdict: 'satisfied', reason: '精确子结果版本已由主管接受，来源与完成标准一致。', evidenceRefs: refs }] })
  })
  await store.updateCapabilityPool({ operation: 'grant', tools: ['collaborators_list', 'task_assign', 'task_review', 'calendar_read_schedule'], resources: ['mock:personal'] })
  const { task: group } = await store.createGroup({ requestId: 'real-child-group', title: '协作验收群', adminBotId: 'calendar', memberBotIds: ['calendar', 'todo'] })
  rootId = (await store.startContinuous({ requestId: 'real-child-root', origin: { kind: 'group', taskId: group.taskId }, goal: '协作核对模拟日程', completionCriteria: ['日程来源已独立核验'], limits })).rootTaskId
  const done = await until(() => store.get(rootId).catch(async error => { throw new Error(JSON.stringify((await store.harness.getTask(rootId, context)).state) + error.message) }), task => ['completed', 'failed', 'limited'].includes(task.continuous.state))
  assert.equal(done.continuous.state, 'completed', JSON.stringify(done.messages.slice(-5)))
  assert.deepEqual([rootCalls, childCalls], [4, 2])
  assert.equal(done.collaborations.length, 1)
  assert.equal(done.continuous.usage.modelCalls, 6)
  const deliveries = (await store.get(group.taskId)).messages.filter(row => row.rootTaskId === rootId && row.kind === 'completed')
  assert.equal(deliveries.length, 1)
  assert.equal(done.continuous.origin.deliveries.filter(row => row.kind === 'completed').length, 1)
})

test('LR06 revising a goal wakes its old question wait without treating an old answer as the new goal', async t => {
  let store, calls = 0
  store = await fixture(t, async (_message, options) => {
    if (++calls === 1) return turn('report_blocker', { question: '旧目标需要哪个日期？', requiredInformation: '日期', assignee: 'user' })
    const task = await store.get(options.taskId)
    assert.equal(task.taskState.goalRevision, 2)
    assert.equal(task.taskState.goal, '新的独立目标')
    return blocked(options.signal)
  })
  const { rootTaskId: id } = await store.startContinuous({ requestId: 'revise-question', origin: { kind: 'main', taskId: (await store.mainSessions()).calendar }, goal: '旧的目标', completionCriteria: ['旧标准'], limits })
  const waiting = await until(() => store.get(id), task => task.runtime.checkpoint.phase === 'awaitBlocker')
  const old = waiting.blockers.items.find(item => item.status === 'pending')
  await store.controlContinuous(id, { requestId: 'revise-old-question', expectedVersion: waiting.continuous.version, action: 'revise-goal', goalPatch: { goal: '新的独立目标', completionCriteria: ['新标准'], constraints: [] } })
  await until(() => store.get(id).catch(async error => { throw new Error(JSON.stringify((await store.harness.getTask(id, context)).state) + error.message) }), task => task.taskState.goalRevision === 2 && calls === 2)
  const revised = await store.get(id)
  assert.equal(revised.activeInputId, waiting.activeInputId)
  assert.equal(revised.continuous.steps.find(step => step.stepId === 'execute-1').status, 'superseded')
  await assert.rejects(store.resolveBlocker(id, old.id, { requestId: 'old-answer', answer: '10月21日', version: old.version, inReplyTo: old.inReplyTo }), { code: 'BLOCKER_VERSION_CONFLICT' })
  await store.cancel(id, {})
})

test('LR06 accepted native child evidence needs the same full read version and stable host fingerprint as root artifacts', async t => {
  const { createHash } = await import('node:crypto')
  const { continuousCollaborationFixture } = await import('./fixtures/continuous-collaboration-fixture.mjs')
  const { TaskCard } = await import('./tasks.mjs')
  const { resolveContinuousChildEvidence, Collaboration } = await import('./collaboration.mjs')
  const f = await continuousCollaborationFixture(t), root = await f.root(), child = (await f.assign(root)).data
  const content = '可核验文件正文', sha256 = createHash('sha256').update(content).digest('hex')
  const append = (toolName, args, data) => f.tx(async tx => {
    const card = await tx.doc(TaskCard, child.childTaskId)
    await tx.appendEntry(card.conversationId, { kind: 'pidot.tool-result', data: { toolName, arguments: args,
      inReplyTo: child.childInputId, continuousBinding: child.continuousBinding, result: { ok: true, data } } })
  }, child.childTaskId)
  await append('write', { path: 'report.md', content }, { path: 'report.md', bytesWritten: Buffer.byteLength(content) })
  const relation = await f.publish(child, { evidence: false })
  await assert.rejects(f.review(root, relation), { code: 'CONTINUOUS_EVIDENCE_UNAVAILABLE' })
  await append('read', { path: 'report.md' }, { path: 'report.md', content, offset: 0, nextOffset: null, totalCharacters: Array.from(content).length, sha256 })
  await f.review(root, relation)
  const ref = { kind: 'child-result', relationId: relation.id, revision: relation.result.revision }
  const resolve = () => f.tx(tx => resolveContinuousChildEvidence(tx, root, ref, relation.continuousBinding, f.services))
  const accepted = await resolve()
  assert.equal(accepted.ok, true)
  await f.tx(async tx => { (await tx.doc(Collaboration)).items.find(row => row.id === relation.id).result.content = '仅改写声称进展，文件没有变化' })
  assert.equal((await resolve()).evidence.fingerprint, accepted.evidence.fingerprint)
  await append('write', { path: 'report.md', content: '另一版本' }, { path: 'report.md', bytesWritten: 12 })
  assert.deepEqual(await resolve(), { ok: false })
})
