// Test-only child. Caller must supply a fresh isolated directory.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
const dir = process.argv[2]
if (!dir) throw new Error('isolated directory required')
let started
const ready = new Promise(r => { started = r })
const store = await openTaskStore({ file: join(dir, 'tasks.sqlite'), bots: listBots({ baseUrl: 'https://fixture.invalid/v1', model: 'crash-fixture', apiKey: 'fixture-only' }), modelReply: async () => { started(); await new Promise(() => {}) } })
const task = await store.create({ botId: 'calendar' })
await store.send(task.taskId, '已派发但回执未知'); await ready
await store.send(task.taskId, '必须保留队列')
await store.deactivateBot('calendar', { confirm: true })
await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ taskId: task.taskId, conversationId: task.conversationId }))
setInterval(() => {}, 1000)
