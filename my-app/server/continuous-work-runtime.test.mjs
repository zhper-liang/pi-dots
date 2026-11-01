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

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'work-fixture', apiKey: 'fixture-only', contextWindow: 65536 }
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 10 } } })
const turn = (...calls) => {
  const content = calls.map(([name, args], index) => ({ type: 'toolCall', id: `${name}-${index}`, name, arguments: args }))
  return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }
}
async function until(store, id, predicate) {
  for (let count = 0; count < 1000; count++) { const task = await store.get(id).catch(async error => { throw new Error(JSON.stringify((await store.harness.getTask(id, context)).state) + error.message) }); if (predicate(task)) return task; await delay(5) }
  assert.fail(JSON.stringify(await store.get(id)))
}

test('LR02 real work tools preserve dependency reviews, native artifact versions and one final delivery; plan boundaries skip stale writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-work-runtime-'))
  let store, calls = 0, viewed, researchEvidence, documentEvidence, submitSnapshot
  const steps = [
    { stepId: 'research', title: '读取模拟日程', dependsOn: [], deliverable: '日程来源', verification: '核对真实成功回执', criteriaIndices: [0] },
    { stepId: 'document', title: '写文档并回读', dependsOn: ['research'], deliverable: '可回读文件', verification: '完整文件哈希与内容评审', criteriaIndices: [1] },
  ]
  try {
    store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async (_message, options) => {
      if (options.purpose === 'context-compaction') { return text('目标：核对日程来源并交付文档。研究阶段已核验；文档已写入并回读，仍需提交和独立验收。不得重复写入。') }
      calls++
      viewed = await store.get(options.taskId)
      const progress = await store.harness.snapshot(TaskProgress, options.taskId, context)
      const refs = name => viewed.messages.filter(message => message.toolName === name && message.result.ok).map(message => ({ taskId: options.taskId, entryId: message.id }))
      if (calls === 1) return turn(['work_plan', { requestId: 'plan', expectedPlanRevision: 1, goalRevision: 1, steps, currentStepId: 'research' }], ['write', { path: 'must-not-exist.md', content: 'stale write' }])
      if (calls === 2) return turn(['calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }])
      if (calls === 3) { researchEvidence = refs('calendar_read_schedule'); return turn(['work_submit', { requestId: 'research-submit', stepId: 'research', goalRevision: 1, planRevision: 2, summary: '已读取日程', evidenceRefs: researchEvidence }]) }
      if (calls === 4) {
        submitSnapshot = viewed
        return text(JSON.stringify({ stageReview: { basis: 'model-review', goalRevision: 1, planRevision: 2, stepId: 'research', submissionRevision: 1,
          criteriaEvidence: [{ index: 0, verdict: 'satisfied', reason: '日程回执包含日期和来源，已逐项核对。', evidenceRefs: researchEvidence }] } }))
      }
      if (calls === 5) { assert.equal(progress.steps.find(step => step.stepId === 'research').status, 'verified'); return turn(['write', { path: 'summary.md', content: '# 日程\n来源：模拟日程2026-10-20。\n' }]) }
      if (calls === 6) return turn(['read', { path: 'summary.md' }])
      if (calls === 7) { documentEvidence = [...refs('write'), ...refs('read')]; return turn(['work_submit', { requestId: 'document-submit', stepId: 'document', goalRevision: 1, planRevision: 2, summary: '已写入并完整回读文档', evidenceRefs: documentEvidence }]) }
      if (calls === 8) return turn(['work_complete', { requestId: 'final-review', goalRevision: 1, planRevision: 2, stepId: 'document', submissionRevision: 1, summary: '已核对日程，并交付可回读的摘要文档。', criteriaEvidence: [
        { index: 0, verdict: 'satisfied', reason: '日程已由第一阶段独立核验。', evidenceRefs: researchEvidence },
        { index: 1, verdict: 'satisfied', reason: '文档完整回读版本一致，内容包含来源说明；质量按模型评审。', evidenceRefs: documentEvidence },
      ] }])
      throw new Error(`unexpected call ${calls}`)
    } })
    const root = await store.startContinuous({ requestId: 'work-root', origin: { kind: 'main', taskId: (await store.mainSessions()).calendar }, goal: '调研模拟日程并形成文档', completionCriteria: ['核对日程来源', '交付带来源的文档'], limits: { modelCalls: 20, toolCalls: 30, totalTokens: 1000000, durationMs: 60000 } })
    const done = await until(store, root.rootTaskId, task => ['completed', 'failed', 'limited'].includes(task.continuous.state))
    assert.equal(done.continuous.state, 'completed', JSON.stringify(done.messages.filter(message => message.role === 'error' || message.result?.ok === false)))
    assert.equal(calls, 8)
    assert.equal(done.taskState.goalRevision, 1)
    assert.equal(done.continuous.planRevision, 2)
    assert.equal(submitSnapshot.continuous.steps.find(step => step.stepId === 'research').submissionRevision, 1)
    assert.equal(submitSnapshot.continuous.steps.find(step => step.stepId === 'research').status, 'submitted')
    assert.equal(done.messages.find(message => message.arguments?.path === 'must-not-exist.md').result.error.code, 'TOOL_SKIPPED_WORK_BOUNDARY')
    assert.equal(done.messages.filter(message => message.toolName === 'write' && message.result.ok).length, 1)
    assert.equal(done.messages.find(message => message.toolName === 'read').result.data.sha256.length, 64)
    assert.deepEqual(done.continuous.steps.filter(step => step.kind !== 'verify').map(step => step.status), ['verified', 'verified'])
    assert.equal(done.messages.filter(message => message.role === 'assistant' && !message.intermediate && !message.assistant).length, 1)
    const ordinary = await store.create({ botId: 'calendar' })
    assert.equal(ordinary.toolSets.displayed.some(name => name.startsWith('work_')), false)
    const persisted = await store.harness.snapshot(TaskProgress, root.rootTaskId, context)
    await store.close()
    store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => { throw new Error('completed work cannot restart') } })
    assert.deepEqual(await store.harness.snapshot(TaskProgress, root.rootTaskId, context), persisted)
    assert.deepEqual((await store.get(root.rootTaskId)).taskState, done.taskState)
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }) }
})
