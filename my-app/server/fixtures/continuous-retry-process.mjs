import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
import { ModelReplyError } from '../model-reply.mjs'
import { TaskProgress } from '../continuous-task.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

const [dir] = process.argv.slice(2)
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'resilience-fixture', apiKey: 'fixture-only', contextWindow: 65536 }
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => {
  const error = new ModelReplyError('MODEL_RATE_LIMITED')
  error.execution = { usage: { totalTokens: 5 } }
  throw error
} })
const { rootTaskId } = await store.startContinuous({ requestId: 'retry-kill-start', origin: { kind: 'main', taskId: (await store.mainSessions()).calendar },
  goal: '检验重试恢复', completionCriteria: ['产物存在且核验'], limits: { modelCalls: 20, toolCalls: 20, totalTokens: 1000000, durationMs: 60000 } })
for (let n = 0; n < 1000; n++) {
  const progress = await store.harness.snapshot(TaskProgress, rootTaskId, context)
  if (progress.retry) {
    const task = await store.get(rootTaskId)
    writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ taskId: rootTaskId, rootInputId: task.executionPolicy.rootInputId, retry: progress.retry }))
    process.kill(process.pid, 'SIGSTOP')
    break
  }
  await delay(5)
}
await store.close()
process.exit(3)
