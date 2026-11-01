import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
import { readMockSchedule } from '../tools.mjs'
const [dir, scenario] = process.argv.slice(2)
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'continuous-fixture', apiKey: 'fixture-only', contextWindow: 65536 }
let id, calls = 0
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 5 } } })
function stop() {
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ taskId: id, scenario }))
  process.kill(process.pid, 'SIGSTOP')
}
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config),
  modelReply: async () => {
    calls++
    appendFileSync(join(dir, 'calls.log'), 'model\n')
    if (calls === 1) {
      const call = { type: 'toolCall', id: 'read-once', name: 'calendar_read_schedule', arguments: { date: '2026-10-20', resource: 'mock:personal' } }
      return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
    }
    if (scenario === 'before-stage') stop()
    return text('已保存的阶段成果，不代表整个目标完成。')
  },
  toolImpl: async args => { appendFileSync(join(dir, 'calls.log'), 'tool\n'); return readMockSchedule(args) },
})
store.harness.subscribeCommits(({ changes }) => {
  if (scenario !== 'before-stage' && changes.some(change => change.type === 'entry' && change.value?.kind === 'pidot.continuous-stage')) stop()
})
const receipt = await store.startContinuous({ requestId: 'kill-start', origin: { kind: 'main', taskId: (await store.mainSessions()).calendar },
  goal: '读取模拟日程并核验来源', completionCriteria: ['有来源的日程摘要'],
  limits: { modelCalls: 8, toolCalls: 10, totalTokens: 100000, durationMs: 60000 } })
id = receipt.rootTaskId
setTimeout(() => process.exit(3), 15000)
