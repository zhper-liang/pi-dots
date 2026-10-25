import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { readExecutionDefaults } from './config.mjs'
import { contextPolicy, planCompaction, restoreCompaction, contextTokens } from './context-compaction.mjs'
import { readMockSchedule, readMockEvent } from './tools.mjs'
import { taskParameters } from './task-config.mjs'
import { ModelReplyError } from './model-reply.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'compaction-fixture', apiKey: 'not-persisted' }
const defaults = { maxOutputTokens: 1024, contextWindows: { [config.model]: 16000 }, callLimits: { modelCalls: 50, toolCalls: 40 } }
const skillId = 'calendar-conflict-analysis'
const call = (name, args = {}) => ({ type: 'toolCall', id: `call-${name}`, name, arguments: args })
const answer = (content = '完成', tokens = 5) => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: tokens, input: tokens - 1, output: 1 } } })
const tools = (...calls) => ({ ...answer(''), toolCalls: calls, assistant: { role: 'assistant', content: calls,
  provider: 'bb-api', api: 'openai-completions', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } })
async function settled(store, id) {
  for (let i = 0; i < 2000; i++) {
    let task
    try { task = await store.get(id) } catch (error) { console.error('ISS12 DIAGNOSTIC', JSON.stringify(await store.harness.getTask(id, ctx))); throw error }
    assert.notEqual(task.runtime.status, 'terminal')
    if (task.activeInputId === null) return task
    await delay(5)
  }
  assert.fail('Task did not settle')
}
async function fixture(t, script, { overrides = {}, events = readMockEvent, schedule = readMockSchedule, executionDefaults = defaults } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss12-')), stores = [], requests = []
  const bots = listBots(config, executionDefaults)
  const open = async () => {
    const store = await openTaskStore({ file: join(dir, 'test.sqlite'), bots, eventImpl: events, toolImpl: schedule,
      modelReply: async (message, options) => { requests.push({ message, ...options }); return script(message, options, requests.length) } })
    stores.push(store); return store
  }
  const store = await open(), task = await store.create({ botId: 'calendar', ...(Object.keys(overrides).length ? { parameters: overrides } : {}),
    taskState: { goal: '分析模拟日程', constraints: ['上午会议不能调整'], completionCriteria: ['指出冲突并给出不改变上午会议的建议'] } })
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const send = async (text = '继续') => { await store.send(task.taskId, text); return settled(store, task.taskId) }
  return { store, task, send, requests, open }
}
const long = '已核实事实，尚未解决的事项保留原文。'.repeat(200)
const summary = '已完成先前交流；未解决：日程冲突分析。上午会议不能调整。已执行工具不可重做；缺失信息按entryId只读回查。'

test('capacity is explicit per model, validated, frozen, and includes output/headroom', () => {
  assert.equal(contextPolicy({ model: { id: 'unknown' } }), null)
  const p = contextPolicy({ ...defaults, model: { id: config.model } })
  assert.equal(p.triggerTokens + p.outputTokens + p.reserveTokens, p.contextWindow)
  for (const raw of ['{}', '[]', 'null', '{"x":8191}', '{"x":4000001}', 'not-json']) assert.throws(() => readExecutionDefaults({ PIDOT_CONTEXT_WINDOWS: raw }))
  assert.deepEqual(readExecutionDefaults({ PIDOT_CONTEXT_WINDOWS: '{"custom":32000}' }).contextWindows, { custom: 32000 })
  assert.equal(taskParameters({ model: { id: 'unknown' } }, { ...defaults, ...listBots(config)[0].defaults, contextWindows: defaults.contextWindows }).contextWindows[config.model], 16000)
  assert.throws(() => taskParameters({ contextWindows: { custom: 32000 } }, listBots(config)[0].defaults))
})

test('selects complete call/result groups and chunks oversized prefix within the summarizer capacity', () => {
  const parameters = { ...defaults, model: { id: config.model } }
  const segments = Array.from({ length: 10 }, (_, i) => ({ key: `turn:${i}`, entryId: i, messages: [tools(call('x')).assistant,
    { role: 'toolResult', toolCallId: 'call-x', toolName: 'x', content: [{ type: 'text', text: 'x'.repeat(5000) }], timestamp: 0 }] }))
  const context = { systemPrompt: 'system', segments, messages: segments.flatMap(s => s.messages) }
  const plan = planCompaction(context, parameters)
  assert.ok(plan.selected.length > 0 && plan.selected.length < 10)
  assert.ok(contextTokens(plan.context) + plan.policy.summaryTokens + plan.policy.reserveTokens <= plan.policy.contextWindow)
  assert.ok(plan.selected.every(s => s.messages[0].role === 'assistant' && s.messages[1].role === 'toolResult'))
  const restored = restoreCompaction({ coveredKeys: plan.selected.map(s => s.key), latest: { summary, createdAt: new Date().toISOString() } }, segments)
  assert.equal(restored.messages[0].role, 'user')
  assert.equal(restored.segments[0].messages[0].role, 'assistant')
})

test('oversized unsplittable input is explicit failure, never silently truncated', () => {
  assert.throws(() => planCompaction({ systemPrompt: long.repeat(3), segments: [], messages: [] }, { ...defaults, model: { id: config.model } }), { code: 'CONTEXT_CAPACITY_EXCEEDED' })
})

test('compacts consumed history, restores task state and leaves raw history accessible after reopen', async (t) => {
  let normal = 0
  const f = await fixture(t, (_m, options) => options.purpose === 'context-compaction' ? answer(summary, 9) : answer(++normal === 1 ? long : '后续仍不调整上午会议'))
  const first = await f.send('记录长期分析背景')
  const task = await f.send('继续分析')
  assert.ok(task.compaction.revision > 0)
  assert.ok(task.messages.some(m => m.content === long))
  assert.equal(task.callUsage.modelCalls, f.requests.length)
  assert.equal(task.callUsage.totalTokens, normal * 5 + task.compaction.revision * 9)
  const after = f.requests.at(-1).context
  assert.match(after.systemPrompt, /上午会议不能调整|指出冲突/)
  assert.ok(after.messages.some(m => typeof m.content === 'string' && m.content.includes('继续执行检查点')))
  assert.ok(!after.messages.some(m => JSON.stringify(m).includes(long)))
  const reopened = await f.open()
  const persisted = await reopened.get(f.task.taskId)
  assert.equal(persisted.compaction.latest.entryId, task.compaction.latest.entryId)
  assert.equal(persisted.messages.length, task.messages.length)
  assert.ok(first.messages.length < persisted.messages.length)
})

test('active pinned Skill is reconstructed across compaction and inactive rules do not return', async (t) => {
  let phase = 0, afterCompact = false
  const f = await fixture(t, (_m, options) => {
    if (options.purpose === 'context-compaction') { afterCompact = true; assert.equal(options.context.tools, undefined); return answer(summary) }
    phase++
    if (phase === 1) return answer(long)
    if (phase === 2) return tools(call('skill_activate', { skillId }))
    if (phase === 3) {
      assert.ok(afterCompact)
      assert.match(options.context.systemPrompt, /必须执行的步骤/)
      return tools(call('skill_deactivate', { skillId }))
    }
    assert.doesNotMatch(options.context.systemPrompt, /必须执行的步骤/)
    return answer('完成分析，保持上午会议不变')
  })
  await f.send('建立长背景')
  const task = await f.send('日程冲突分析')
  assert.ok(task.compaction.revision)
  assert.equal(task.skillState.active.length, 0)
  assert.ok(task.skillState.pinned.some(s => s.id === skillId))
  assert.equal(task.messages.filter(m => m.toolName === 'skill_activate').length, 1)
})

test('model-call exhaustion before summary waits, preserves queue, and explicit raise resumes original input', async (t) => {
  const f = await fixture(t, (_m, o) => o.purpose === 'context-compaction' ? answer(summary) : answer(long), { overrides: { callLimits: { modelCalls: 1 } } })
  await f.send('长背景')
  let task = await f.send('继续')
  assert.equal(task.runtime.checkpoint.lastOutcome, 'limited')
  assert.equal(task.compaction.revision, 0)
  const original = task.runtime.checkpoint.lastInputId
  await f.store.send(task.taskId, '排队：不要提前进入摘要')
  assert.equal((await f.store.get(task.taskId)).queueLength, 1)
  await f.store.raiseLimits(task.taskId, { modelCalls: 2 })
  task = await settled(f.store, task.taskId)
  assert.ok(task.compaction.revision > 0)
  assert.equal(task.runtime.checkpoint.lastOutcome, 'limited')
  assert.equal(task.runtime.checkpoint.lastInputId, original)
  assert.equal(task.queueLength, 1)
  const summaryRequest = f.requests.find(r => r.purpose === 'context-compaction')
  assert.doesNotMatch(JSON.stringify(summaryRequest.context), /排队：不要提前进入摘要/)
  assert.equal(task.callUsage.modelCalls, 2)
})

test('summary tokens count and pause before the next generation without losing checkpoint', async (t) => {
  const f = await fixture(t, (_m, o) => o.purpose === 'context-compaction' ? answer(summary, 20) : answer(long), { overrides: { callLimits: { totalTokens: 15 } } })
  await f.send('长背景')
  const task = await f.send('继续')
  assert.equal(task.callUsage.totalTokens, 25)
  assert.equal(task.runtime.checkpoint.waitingReason, 'totalTokens')
  assert.equal(task.compaction.revision, 1)
  assert.equal(task.callUsage.modelCalls, 2)
})

test('failed summarization accounts known provider usage and preserves original progress', async (t) => {
  const f = await fixture(t, (_m, o) => {
    if (o.purpose === 'context-compaction') { const error = new ModelReplyError('MODEL_OUTPUT_LIMIT'); error.execution = { usage: { totalTokens: 8 } }; throw error }
    return answer(long)
  })
  await f.send('长背景')
  const task = await f.send('继续')
  assert.equal(task.compaction.revision, 0)
  assert.equal(task.callUsage.modelCalls, 2)
  assert.equal(task.callUsage.totalTokens, 13)
  assert.ok(task.messages.some(m => m.content === long))
})

test('invalid summary cannot execute tools and is charged once', async (t) => {
  const f = await fixture(t, (_m, o) => o.purpose === 'context-compaction' ? tools(call('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' })) : answer(long))
  await f.send('长背景')
  const task = await f.send('继续')
  assert.equal(task.messages.at(-1).errorCode, 'CONTEXT_SUMMARY_INVALID')
  assert.equal(task.callUsage.modelCalls, 2)
  assert.equal(task.callUsage.totalTokens, 10)
  assert.equal(task.callUsage.toolCalls, 0)
})

test('legacy model without capacity stays unmodified and old tools are not expanded', async (t) => {
  const f = await fixture(t, () => answer(long), { executionDefaults: { maxOutputTokens: 1024, callLimits: { modelCalls: 20, toolCalls: 10 } } })
  await f.send(); const task = await f.send()
  assert.equal(task.contextPolicy, null)
  assert.equal(task.compaction.revision, 0)
  assert.equal(f.requests.filter(r => r.purpose === 'context-compaction').length, 0)
})

test('large result reference and call/result pairs survive compaction without repeating schedule operations', async (t) => {
  let phase = 0, schedules = 0
  const f = await fixture(t, (_m, o) => {
    if (o.purpose === 'context-compaction') return answer(summary)
    phase++
    const receipts = o.context.messages.filter(m => m.role === 'toolResult').map(m => JSON.parse(m.content[0].text))
    if (phase === 1) return answer(long)
    if (phase === 2) return tools(call('calendar_read_schedule', { month: '2026-10', resource: 'mock:personal' }))
    if (phase === 3) {
      const ref = receipts.find(r => r.data?.resultRef).data.resultRef
      return tools(call('tool_result_read', { resultRef: ref, resource: 'mock:personal', date: '2026-10-20' }))
    }
    if (phase === 4) return tools(call('calendar_read_event', { eventId: 'mock-20261020-1', resource: 'mock:personal' }))
    return answer('模拟日程已读取，上午会议不动；其余月份未读。')
  }, { schedule: (args) => { schedules++; return readMockSchedule(args) } })
  await f.send('长背景'); const task = await f.send('分析10月20日')
  assert.equal(schedules, 1)
  assert.ok(task.compaction.revision)
  assert.ok(task.messages.some(m => m.result?.data?.resultRef))
  assert.ok(task.messages.filter(m => m.role === 'tool').every(m => m.result.ok))
  for (const request of f.requests.filter(r => r.purpose === 'reply')) {
    const calls = new Set()
    for (const message of request.context.messages) {
      if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall') calls.add(block.id)
      if (message.role === 'toolResult') assert.ok(calls.has(message.toolCallId))
    }
  }
})

test('history paging is Task-owned, bounded, and respects original-tool revocation', async (t) => {
  let phase = 0, targetId
  const f = await fixture(t, (_m, o) => {
    if (o.purpose === 'context-compaction') return answer(summary)
    phase++
    if (phase === 1) return tools(call('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }))
    if (phase === 2) return answer('已读取模拟日程')
    if (phase === 3) return tools(call('task_history_read', {}))
    if (phase === 4) {
      const data = JSON.parse(o.context.messages.at(-1).content[0].text).data
      targetId = data.entries[0].entryId
      return tools(call('task_history_read', { entryId: targetId, offset: 0, limit: 1024 }))
    }
    if (phase === 6) return tools(call('task_history_read', { entryId: targetId }))
    return answer('完成回读')
  }, { executionDefaults: { ...defaults, contextWindows: { [config.model]: 65536 } } })
  await f.send(); let task = await f.send('回读')
  const reads = task.messages.filter(m => m.toolName === 'task_history_read')
  assert.equal(reads.length, 2)
  assert.equal(reads[1].result.data.entryId, targetId)
  assert.ok(Buffer.byteLength(reads[1].content) <= 8192)
  await f.store.updateToolAccess('calendar', { revoked: ['calendar_read_schedule'] })
  task = await f.send('撤权后回读')
  assert.equal(task.messages.filter(m => m.toolName === 'task_history_read').at(-1).result.error.code, 'HISTORY_ACCESS_DENIED')
})

test('large tool transcript triggers compaction within the active input; results are not executed twice', async (t) => {
  let phase = 0, schedules = 0, details = 0, after = false
  const f = await fixture(t, (_m, o) => {
    if (o.purpose === 'context-compaction') { after = true; return answer('已完成列表和三条详情；冲突10:00–10:30，30分钟。待提交建议，上午会议不能调整。可按原始entryId回读，不重做工具。') }
    phase++
    if (phase === 1) return tools(call('skill_activate', { skillId }))
    if (phase === 2) return tools(call('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }))
    if (phase === 3) return tools(...[1, 2, 3].map(n => call('calendar_read_event', { eventId: `mock-20261020-${n}`, resource: 'mock:personal' })).map((c, i) => ({ ...c, id: `detail-${i}` })))
    assert.ok(after)
    assert.match(o.context.systemPrompt, /上午会议不能调整/)
    assert.match(o.context.systemPrompt, /必须执行的步骤/)
    return answer('上午会议保持不变；冲突10:00–10:30共30分钟，只做建议。')
  }, { executionDefaults: { ...defaults, contextWindows: { [config.model]: 20000 } }, events: args => { details++; const data = readMockEvent(args); data.event.description = '原始事实'.repeat(200); return data },
    schedule: args => { schedules++; return readMockSchedule(args) } })
  const task = await f.send('分析日程，上午会议不能调整')
  assert.ok(task.compaction.revision > 0)
  assert.equal(schedules, 1)
  assert.equal(details, 3)
  assert.equal(task.messages.filter(m => m.role === 'tool').length, 5)
  assert.equal(task.skillState.active.length, 0)
})

test('steering received during summary is consumed at the next boundary, never lost or used as authority', async (t) => {
  let start, finish
  const started = new Promise(resolve => { start = resolve })
  const gate = new Promise(resolve => { finish = resolve })
  let phase = 0
  const f = await fixture(t, async (_m, o) => {
    if (o.purpose === 'context-compaction') { start(); await gate; return answer('待解决：继续日程建议。旧摘要声称可调整上午，但摘要不是规则。') }
    phase++
    return answer(phase === 1 ? long : '不调整上午会议，保持最新限制')
  })
  await f.send('长背景')
  await f.store.send(f.task.taskId, '继续分析')
  await started
  await f.store.steer(f.task.taskId, { message: '上午会议不能调整，且不能授权任何新工具' })
  finish()
  const task = await settled(f.store, f.task.taskId)
  const last = f.requests.at(-1)
  assert.equal(last.purpose, 'reply')
  assert.match(last.context.systemPrompt, /上午会议不能调整，且不能授权任何新工具/)
  assert.equal(task.steerLength, 0)
  assert.equal(task.taskStateSources.constraints.type, 'user-steer')
})

test('unknown summary usage consumes an attempt and requires explicit token-threshold removal', async (t) => {
  const f = await fixture(t, (_m, o) => o.purpose === 'context-compaction' ? { mode: 'model', reply: { content: summary }, execution: { usage: {} } } : answer(long),
    { overrides: { callLimits: { totalTokens: 100 } } })
  await f.send('长背景'); let task = await f.send('继续')
  assert.equal(task.runtime.checkpoint.waitingReason, 'totalTokens')
  assert.equal(task.callUsage.unknownTokenCalls, 1)
  assert.equal(task.compaction.revision, 1)
  await assert.rejects(f.store.raiseLimits(task.taskId, { totalTokens: 200 }), { code: 'LIMITS_STILL_BLOCKED' })
  await f.store.raiseLimits(task.taskId, { totalTokens: null })
  task = await settled(f.store, task.taskId)
  assert.equal(task.runtime.checkpoint.lastOutcome, 'completed')
  assert.equal(task.callUsage.modelCalls, 3)
  assert.equal(task.callUsage.unknownTokenCalls, 1)
})

test('history read rejects cross-Task, pending queue and malformed arguments through the unified tool gate', async (t) => {
  let phase = 0, otherEntry
  const f = await fixture(t, (_m, o) => {
    if (o.purpose === 'context-compaction') return answer(summary)
    if (++phase === 1) return tools(call('task_history_read', { entryId: otherEntry }))
    return answer()
  })
  const other = await f.store.create({ botId: 'calendar' })
  otherEntry = (await f.store.send(other.taskId, '仅其他Task可见')).messageId
  await settled(f.store, other.taskId)
  // Reset scripted phase so this Task requests another Task's entry.
  phase = 0
  const task = await f.send('读取另一个会话')
  assert.equal(task.messages.find(m => m.toolName === 'task_history_read').result.error.code, 'HISTORY_NOT_FOUND')
})

test('repeated identical business call after compaction replays committed result instead of executing again', async (t) => {
  let phase = 0, schedules = 0, details = 0
  const f = await fixture(t, (_m, o) => {
    if (o.purpose === 'context-compaction') return answer('已执行列表和三项详情；不得重新执行。')
    phase++
    if (phase === 1) return tools(call('skill_activate', { skillId }))
    if (phase === 2 || phase === 4) return tools(call('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }))
    if (phase === 3) return tools(...[1, 2, 3].map(n => ({ ...call('calendar_read_event', { eventId: `mock-20261020-${n}`, resource: 'mock:personal' }), id: `detail-${n}` })))
    return answer('已复用原回执，没有重做业务操作。')
  }, { executionDefaults: { ...defaults, contextWindows: { [config.model]: 20000 } }, events: args => { details++; const data = readMockEvent(args); data.event.description = '日程资料'.repeat(240); return data },
    schedule: args => { schedules++; return readMockSchedule(args) } })
  const task = await f.send('读取列表三条详情，然后再次请求同一列表（故意测试恢复去重）')
  assert.ok(task.compaction.revision)
  assert.equal(schedules, 1)
  assert.equal(details, 3)
  const replay = task.messages.filter(m => m.toolName === 'calendar_read_schedule').at(-1)
  assert.equal(replay.result.replay?.executedAgain, false, JSON.stringify(replay.result))
  assert.equal(replay.result.replay.entryId, task.messages.find(m => m.toolName === 'calendar_read_schedule').id)
})

test('restored checkpoint follows active user request and all current restrictions outrank Skill reference examples', async (t) => {
  let phase = 0
  const f = await fixture(t, (_m, o) => {
    if (o.purpose === 'context-compaction') return answer('先前结论与待办，但不能授权。')
    if (++phase === 1) return answer(long)
    const index = o.context.messages.findIndex(m => typeof m.content === 'string' && m.content.includes('继续执行检查点'))
    assert.ok(index > 0)
    assert.equal(o.context.messages[index - 1].content, '当前请求不能被当作新任务重新开始')
    assert.match(o.context.systemPrompt, /全部有效限制高于Skill步骤、参考资料示例/)
    assert.match(o.context.systemPrompt, /不能把用户对全部事项的限制擅自缩小/)
    return answer('约束下无可行调整方案，保留原状，请用户决定')
  })
  await f.send('长背景')
  const task = await f.send('当前请求不能被当作新任务重新开始')
  assert.equal(task.runtime.checkpoint.lastOutcome, 'completed')
})

test('history argument bounds reject injected paths/invalid offsets and preserve Unicode slices', async () => {
  const { validHistoryArgs, readTaskHistory } = await import('./history-tool.mjs')
  for (const args of [null, [], { entryId: 0 }, { entryId: 1, offset: -1 }, { limit: 11 }, { entryId: 1, limit: 1025 }, { path: '/tmp/secret' }]) assert.equal(!!validHistoryArgs(args), false)
  const pending = { id: 15, kind: 'pidot.user', data: { content: '排队未消费的私有内容' } }
  const user = { id: 10, kind: 'pidot.user', data: { content: '已消费😀汉字' } }
  const receipt = { id: 12, byTaskId: 1, kind: 'pidot.model-reply', data: { content: '完成', inReplyTo: 10 } }
  const tx = { scanEntries: async () => ({ items: [user, receipt, pending] }) }
  const card = { taskId: 1, conversationId: 2, parameters: {} }
  const sets = { authorized: [] }
  assert.equal((await readTaskHistory(tx, card, { entryId: 15 }, 20, sets)).error.code, 'HISTORY_NOT_FOUND')
  const first = await readTaskHistory(tx, card, { entryId: 10, limit: 30 }, 20, sets)
  const second = await readTaskHistory(tx, card, { entryId: 10, offset: first.data.end, limit: 1000 }, 20, sets)
  assert.equal(first.data.text + second.data.text, JSON.stringify({ id: user.id, kind: user.kind, data: user.data }))
  assert.equal(second.data.nextOffset, null)
  assert.equal((await readTaskHistory(tx, card, { entryId: 10, offset: 10000 }, 20, sets)).error.code, 'TOOL_INVALID_ARGUMENTS')
})
