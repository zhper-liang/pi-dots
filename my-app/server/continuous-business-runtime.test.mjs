import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { addRule } from './policy.mjs'
import { externalFixture, eventArgs } from './fixtures/workspace-external.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'business-fixture', apiKey: 'fixture-only', contextWindow: 32768 }
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 10 } } })
const tool = (name, args) => {
  const content = [{ type: 'toolCall', id: name, name, arguments: args }]
  return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }
}
async function finished(store, id) {
  for (let count = 0; count < 1200; count++) {
    const task = await store.get(id)
    if (['completed', 'failed', 'limited', 'blocked'].includes(task.continuous.state)) return task
    await delay(5)
  }
  assert.fail(`continuous business task did not settle: ${JSON.stringify((await store.get(id)).runtime)}`)
}
async function configure(store, sourceId) {
  const { bot } = await store.getBotConfiguration('calendar')
  await store.updateBotConfiguration('calendar', { requestId: 'business-assign', expectedVersion: bot.configRef.version,
    description: bot.description, tools: WORKSPACE_TOOLS, resources: [`workspace:${sourceId}`] })
}
const ref = (task, name) => ({ taskId: task.taskId, entryId: task.messages.filter(message => message.toolName === name).at(-1).id })
const submit = evidenceRefs => tool('work_submit', { requestId: 'business-submit', stepId: 'execute-1', goalRevision: 1,
  planRevision: 1, summary: '提交业务操作终态与对象回读', evidenceRefs })
const complete = evidenceRefs => tool('work_complete', { requestId: 'business-complete', goalRevision: 1, planRevision: 1,
  stepId: 'execute-1', submissionRevision: 1, summary: '已核对业务操作成功终态及对象回读。', criteriaEvidence: [
    { index: 0, verdict: 'satisfied', reason: '原requestId的Operation为succeeded，成功回执目标和对象回读的ID/版本/正文一致。', evidenceRefs },
  ] })
async function start(store, requestId, modelCalls = 12) {
  return store.startContinuous({ requestId, origin: { kind: 'main', taskId: (await store.mainSessions()).calendar },
    goal: '在隔离业务源创建指定事项，并核对成功终态及原对象', completionCriteria: ['业务操作成功且对象回读一致'],
    limits: { modelCalls, toolCalls: 30, totalTokens: 1000000, durationMs: 60000 } })
}

test('LR02 business example accepts a real local Operation terminal receipt plus matching object readback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-continuous-business-'))
  let store, calls = 0, status, target, evidenceRefs
  t.after(async () => { await store?.close(); await rm(dir, { recursive: true, force: true }) })
  store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async (_message, options) => {
    if (options.purpose === 'context-compaction') return text('工作检查点：按原业务requestId和成功回执继续核对目标对象，不重复已发生的业务写入；完整标准以任务卡为准。')
    const task = await store.get(options.taskId)
    calls++
    if (calls === 1) return tool('workspace.prepare_change', { sourceId: 'local', requestId: 'business-create', action: 'create',
      change: { type: 'Todo', data: { title: '隔离业务验收事项', due: '2026-11-03' } } })
    if (calls === 2) return tool('workspace.operation_status', { sourceId: 'local', requestId: 'business-create' })
    if (calls === 3) {
      status = task.messages.find(message => message.toolName === 'workspace.operation_status').result.data
      assert.equal(status.state, 'succeeded')
      assert.ok(status.receipt.target.id)
      return tool('workspace.get', { sourceId: 'local', type: 'Todo', id: status.receipt.target.id })
    }
    if (calls === 4) {
      target = task.messages.find(message => message.toolName === 'workspace.get').result.data.items[0]
      assert.equal(target.id, status.receipt.target.id)
      assert.equal(target.version, status.receipt.version)
      assert.equal(target.title, '隔离业务验收事项')
      evidenceRefs = [ref(task, 'workspace.operation_status'), ref(task, 'workspace.get')]
      return submit(evidenceRefs)
    }
    if (calls === 5) return complete(evidenceRefs)
    throw new Error(`unexpected business model call ${calls}`)
  } })
  await configure(store, 'local')
  const root = await start(store, 'business-positive'), done = await finished(store, root.rootTaskId)
  assert.equal(done.continuous.state, 'completed', JSON.stringify(done.messages))
  assert.equal(calls, 5)
  assert.equal(done.messages.filter(message => message.toolName === 'workspace.prepare_change').length, 1)
  const persisted = await store.workspace.query({ sourceId: 'local', type: 'Todo' })
  assert.equal(persisted.items.length, 1)
  assert.equal(persisted.items[0].id, target.id)
  assert.equal(done.messages.filter(message => message.role === 'assistant' && !message.intermediate && !message.assistant).length, 1)
})

test('LR02 business pending intent and unknown real fake-provider outcome cannot be submitted or completed', async t => {
  // One pending example and one uncertain-outcome extreme; no real external service is used.
  for (const scenario of ['pending', 'unknown']) await t.test(scenario, async t => {
    let calls = 0, store, sourceId, f, evidenceRefs
    const modelReply = async (_message, options) => {
      if (options.purpose === 'context-compaction') return text('工作检查点：原业务Operation仍无成功核验，按原requestId只读核查；不能重发未知写入，也不能宣称目标完成。')
      const task = await store.get(options.taskId)
      calls++
      if (calls === 1) {
        if (scenario === 'unknown') f.lose()
        return tool('workspace.prepare_change', { sourceId, requestId: 'business-unsettled', action: 'create',
          change: scenario === 'pending' ? { type: 'Todo', data: { title: '等待确认，不应写入' } } : { arguments: eventArgs } })
      }
      if (calls === 2) return tool('workspace.operation_status', { sourceId, requestId: 'business-unsettled' })
      if (calls === 3) {
        const status = task.messages.find(message => message.toolName === 'workspace.operation_status').result.data
        assert.equal(status.state, scenario === 'pending' ? 'awaiting_confirmation' : 'unknown')
        evidenceRefs = [ref(task, 'workspace.operation_status')]
        return submit(evidenceRefs)
      }
      if (calls === 4) {
        assert.equal(task.messages.find(message => message.toolName === 'work_submit').result.ok, false)
        return complete(evidenceRefs)
      }
      return text('原业务操作仍无成功终态，不能完成目标，也不能重发未知写入。')
    }
    const run = async () => {
      await configure(store, sourceId)
      if (scenario === 'pending') await store.harness.commit(tx => addRule(tx, { botId: 'calendar', match: { tool: 'workspace.prepare_change' }, effect: 'ask' }), context)
      const root = await start(store, `business-${scenario}`, 7), done = await finished(store, root.rootTaskId)
      assert.notEqual(done.continuous.state, 'completed', JSON.stringify(done.messages))
      const submission = done.messages.find(message => message.toolName === 'work_submit')
      assert.ok(submission, JSON.stringify({ calls, state: done.continuous.state, messages: done.messages }))
      assert.equal(submission.result.error.code, 'CONTINUOUS_EVIDENCE_UNAVAILABLE')
      const completion = done.messages.find(message => message.toolName === 'work_complete')
      assert.ok(completion, JSON.stringify({ calls, state: done.continuous.state, runtime: done.runtime, messages: done.messages }))
      assert.equal(completion.result.ok, false)
      assert.equal(done.messages.filter(message => message.toolName === 'workspace.prepare_change').length, 1)
      if (scenario === 'pending') assert.equal((await store.workspace.query({ sourceId, type: 'Todo' })).items.length, 0)
      else { assert.equal(f.writes.length, 1); assert.equal((await store.workspace.getExternalOperation({ requestId: 'business-unsettled' })).state, 'unknown') }
    }
    if (scenario === 'unknown') await externalFixture(async fixture => { f = fixture; store = fixture.store; sourceId = fixture.sourceId; await run() }, { bots: listBots(config), modelReply })
    else {
      const dir = await mkdtemp(join(tmpdir(), 'pidot-business-pending-'))
      t.after(async () => { await store?.close(); await rm(dir, { recursive: true, force: true }) })
      store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply }); sourceId = 'local'
      await run()
    }
  })
})
