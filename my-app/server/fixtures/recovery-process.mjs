// Real separate process, killed with SIGKILL by the parent only after a durable
// commit. No production DB, credentials or business writes are involved.
import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
import { readMockSchedule, readMockEvent } from '../tools.mjs'
import { ModelReplyError } from '../model-reply.mjs'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { ContextCompaction } from '../context-compaction.mjs'
const [dir, scenario] = process.argv.slice(2)
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'recovery-fixture', apiKey: 'fixture-only' }
const log = (kind) => appendFileSync(join(dir, 'invocations.jsonl'), JSON.stringify({ kind }) + '\n')
let id, stopped = false
function checkpoint(state) {
  if (stopped) return
  stopped = true
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ taskId: id, state }))
  process.kill(process.pid, 'SIGSTOP')
}
const result = (content = '', tokens = 5) => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: tokens, input: tokens - 1, output: 1 } } })
const tool = (name, args, n = 1) => {
  const calls = [{ type: 'toolCall', id: `call-${n}`, name, arguments: args }]
  return { ...result(), toolCalls: calls, assistant: { role: 'assistant', content: calls, provider: 'bb-api', api: 'openai-completions', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config),
  modelReply: async () => {
    log('model')
    if (scenario === 'model-flight') checkpoint({ inFlight: 'model' })
    if (scenario === 'failed') { const error = new ModelReplyError('MODEL_FAILED'); error.execution = { usage: { totalTokens: 7, input: 5, output: 2 } }; throw error }
    if (scenario === 'final' || scenario === 'inactive') return result('已保存的最终答案')
    if (scenario === 'partial-tools') { const first = tool('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }); const second = { type: 'toolCall', id: 'call-2', name: 'calendar_read_schedule', arguments: { date: '2026-10-17', resource: 'mock:personal' } }; first.toolCalls.push(second); return first }
    if (scenario === 'blocker') return tool('report_blocker', { question: '请提供日期', requiredInformation: '日期', assignee: 'user' })
    return tool('calendar_read_schedule', { ...(scenario === 'artifact' ? { month: '2026-10' } : { date: '2026-10-20' }), resource: 'mock:personal' })
  },
  toolImpl: async (args) => { log('schedule'); if (scenario === 'tool-flight') checkpoint({ inFlight: 'read-tool' }); return readMockSchedule(args) },
  eventImpl: async (args) => { log('event'); return readMockEvent(args) },
})
const task = await store.create({ botId: 'calendar', title: 'ISS18 强制中断恢复',
  parameters: { callLimits: { modelCalls: scenario === 'limited' ? 1 : 12, toolCalls: 10, ...(scenario === 'model-flight' ? { totalTokens: 500 } : {}) } },
  taskState: { goal: '分析2026-10-20模拟日程', constraints: ['上午会议不能调整'], completionCriteria: ['说明冲突及未解决事项'] } })
id = task.taskId
await store.activateSkill(id, { skillId: 'calendar-conflict-analysis' })
if (scenario === 'compacted') {
  await store.harness.commit(async (tx) => {
    const summary = '前序调查：上午会议不可改；未解决事项是核实下午是否空闲。'
    const audit = await tx.appendEntry(task.conversationId, { kind: 'pidot.context-compaction', data: { revision: 1, summary, sourceEntryIds: [], coveredKeys: [], createdAt: new Date().toISOString() } })
    const doc = await tx.doc(ContextCompaction, id)
    doc.revision = 1; doc.coveredKeys = []
    doc.latest = { entryId: audit.id, summary, createdAt: new Date().toISOString() }
  }, ctx)
}
store.harness.subscribeCommits(({ changes }) => {
  for (const change of changes) {
    if (change.type !== 'task' || change.value.id !== id) continue
    const state = change.value.state, cp = state.checkpoint
    if (['saved-tool', 'compacted', 'revoked', 'artifact', 'missing-skill'].includes(scenario) && cp?.phase === 'reply' && !cp.inFlight && changes.some((item) => item.type === 'entry' && item.value?.kind === 'pidot.tool-result')) checkpoint(state)
    if (scenario === 'partial-tools' && cp?.phase === 'tools' && cp.callIndex === 1 && !cp.inFlight) checkpoint(state)
    if (['final', 'inactive', 'failed'].includes(scenario) && cp?.lastOutcome === (scenario === 'failed' ? 'failed' : 'completed')) checkpoint(state)
    if (scenario === 'limited' && cp?.lastOutcome === 'limited') checkpoint(state)
    if (scenario === 'blocker' && cp?.phase === 'awaitBlocker') checkpoint(state)
    if (scenario === 'cancelled' && state.status === 'terminal') checkpoint(state)
  }
})
if (scenario === 'cancelled') await store.cancel(id, {})
else await store.send(id, '分析2026-10-20的三项模拟会议冲突，上午会议不能调整。')
setTimeout(() => { console.error('checkpoint not reached'); process.exit(3) }, 15000)
