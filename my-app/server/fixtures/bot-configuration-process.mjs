import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
const dir = process.argv[2]
if (!dir) throw new Error('Explicit temporary directory required')
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'config-fixture', apiKey: 'fixture-only' }
let entered
const ready = new Promise((r) => { entered = r })
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), modelReply: async () => { entered(); await new Promise(() => {}) } })
const task = await store.create({ botId: 'calendar' })
await store.send(task.taskId, '读取日程'); await ready
const { bot } = await store.getBotConfiguration('calendar')
await store.updateBotConfiguration('calendar', { requestId: 'process-config-02', expectedVersion: bot.configRef.version, description: 'SIGKILL前新职责', tools: bot.defaults.tools, resources: bot.defaults.toolResources })
await store.updateBotConfiguration('calendar', { requestId: 'process-revoke-02', expectedVersion: (await store.getBotConfiguration('calendar')).bot.configRef.version, description: 'SIGKILL前新职责', tools: [], resources: ['mock:personal'] })
await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ taskId: task.taskId }))
setInterval(() => {}, 1000)
