// Temporary DB only. Parent kills this child after Bot identity, first input and FIFO queue commit.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
const [dir] = process.argv.slice(2)
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'dynamic-recovery', apiKey: 'fixture-only' }
let entered
const started = new Promise((resolve) => { entered = resolve })
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => { entered(); await new Promise(() => {}) } })
const input = { name: '进程恢复专家', description: '只处理此Bot的持久输入', requestId: 'process-request-0001', profile: 'general' }
const { bot } = await store.createBot(input)
const task = await store.create({ botId: bot.id }), other = await store.create({ botId: 'todo' })
await store.send(task.taskId, 'first-private'); await started
await store.send(task.taskId, 'second-private')
const saved = await store.get(task.taskId)
writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ bot, taskId: task.taskId, otherId: other.taskId, conversationId: task.conversationId, input, saved }))
process.kill(process.pid, 'SIGSTOP')
