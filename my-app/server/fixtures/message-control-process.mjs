// ISS19 uses a real child process. The parent SIGKILLs only after this process
// SIGSTOPs at a persisted boundary; all storage belongs to its temporary dir.
import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
const [dir, scenario] = process.argv.slice(2)
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'message-control-fixture', apiKey: 'fixture-only' }
const directive = '上午会议不能调整，只允许提出下午方案。'
let release, started, calls = 0, metadata, stopped = false
const held = new Promise((resolve) => { release = resolve })
const entered = new Promise((resolve) => { started = resolve })
const result = (text) => ({ mode: 'model', reply: { content: text }, execution: { usage: { totalTokens: 5, input: 4, output: 1 } } })
function checkpoint(state) {
  if (stopped) return
  stopped = true
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ ...metadata, state }))
  process.kill(process.pid, 'SIGSTOP')
}
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async (message, options) => {
  calls++
  appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ message, context: options.context }) + '\n')
  started()
  await held // Deliberately ignores cancellation to test a real late result.
  if (scenario.startsWith('tools-') || scenario === 'limited-pending') {
    const toolCalls = [1, 2].map((n) => ({ type: 'toolCall', id: `old-call-${n}`, name: 'calendar_read_schedule', arguments: { date: '2026-10-20', resource: 'mock:personal' } }))
    return { ...result(''), toolCalls, assistant: { role: 'assistant', content: toolCalls, provider: 'bb-api', api: 'openai-completions', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
  }
  return result(`原进程已保存答案：${message}`)
} })
const task = await store.create({ botId: 'calendar', title: `ISS19 ${scenario}`, taskState: { goal: '日程规划', constraints: ['原有限制'] },
  parameters: { callLimits: { modelCalls: scenario.startsWith('limited') ? 1 : 15, toolCalls: 10 } } })
const original = await store.send(task.taskId, '原输入：分析2026-10-20日程')
await entered
const first = await store.send(task.taskId, '第二输入：整理下午方案')
const second = await store.send(task.taskId, '第三输入：总结最终安排')
metadata = { taskId: task.taskId, conversationId: task.conversationId, original: original.messageId,
  queued: [first.messageId, second.messageId], directive, scenario }
if (!['consumed', 'limited-pending'].includes(scenario)) {
  const steer = scenario.startsWith('converted')
    ? await store.send(task.taskId, directive).then((message) => store.steer(task.taskId, { messageId: message.messageId }))
    : await store.steer(task.taskId, { message: directive })
  metadata.steer = steer.messageId
}
store.harness.subscribeCommits(({ changes }) => {
  if (changes.some((x) => x.type === 'entry' && x.value.data?.afterCancellation)) metadata.lateReceived = true
  const state = changes.find((x) => x.type === 'task' && x.value.id === task.taskId)?.value.state
  if (scenario === 'cancelled-request' && changes.some((x) => x.type === 'entry' && x.value.kind === 'pidot.task-cancelled')) checkpoint(state)
  if (scenario === 'cancelled-terminal' && state?.status === 'terminal') checkpoint(state)
  if (scenario.endsWith('applied') && changes.some((x) => x.type === 'entry' && x.value.kind === 'pidot.steer-applied')) checkpoint(state)
  if (scenario === 'consumed' && state?.checkpoint?.lastOutcome === 'completed') checkpoint(state)
  if (scenario === 'tools-pending' && changes.some((x) => x.type === 'entry' && x.value.kind === 'pidot.model-tool-turn')) checkpoint(state)
  if (scenario === 'limited' && state?.checkpoint?.lastOutcome === 'limited') checkpoint(state)
})
if (scenario.startsWith('cancelled')) {
  await store.cancel(task.taskId, {})
  release()
  if (scenario === 'cancelled-late') {
    for (let n = 0; n < 500; n++) {
      const current = await store.get(task.taskId)
      if (current.runtime.status === 'terminal' && current.messages.some((x) => x.afterCancellation)) checkpoint(current.runtime)
      await delay(10)
    }
  }
} else if (scenario === 'limited-pending') {
  release()
  for (let n = 0; n < 500; n++) {
    const current = await store.get(task.taskId)
    if (current.runtime.checkpoint?.lastOutcome === 'limited') {
      metadata.steer = (await store.steer(task.taskId, { message: directive })).messageId
      checkpoint((await store.get(task.taskId)).runtime)
    }
    await delay(10)
  }
} else if (scenario.endsWith('pending') && scenario !== 'tools-pending') checkpoint((await store.get(task.taskId)).runtime)
else release()
setTimeout(() => { console.error('ISS19 boundary not reached', scenario, calls); process.exit(3) }, 12000)
