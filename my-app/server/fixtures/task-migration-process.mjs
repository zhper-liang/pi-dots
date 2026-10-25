// Deterministic crash evidence; only explicit temporary databases are accepted.
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
const [dir, mode] = process.argv.slice(2)
if (!dir || !['committed', 'uncommitted'].includes(mode)) throw new Error('Explicit temporary directory and crash phase required')
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'migration-fixture', apiKey: 'fixture-only' }
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config, { contextWindows: { [config.model]: 65536 } }) })
const task = await store.create({ botId: 'calendar' }), { bot } = await store.getBotConfiguration('calendar')
await store.updateBotConfiguration('calendar', { requestId: 'process-migration-config', expectedVersion: bot.configRef.version, description: '强杀后保留目标配置', tools: bot.defaults.tools, resources: bot.defaults.toolResources })
const preview = await store.previewMigration(task.taskId), input = { requestId: 'process-migration-confirm', expectedVersion: preview.previous.version, targetVersion: preview.next.version, previewToken: preview.previewToken, confirm: true }
if (mode === 'uncommitted') {
  const commit = store.harness.commit.bind(store.harness)
  store.harness.commit = (fn, ctx) => commit(async (tx) => {
    const append = tx.appendEntry.bind(tx)
    tx.appendEntry = async (...args) => {
      const entry = await append(...args)
      if (args[1]?.kind === 'pidot.configuration-migrated') {
        await writeFile(join(dir, 'migration-checkpoint.json'), JSON.stringify({ taskId: task.taskId, conversationId: task.conversationId, input, mode }))
        await new Promise(() => {})
      }
      return entry
    }
    return fn(tx)
  }, ctx)
}
await store.migrateConfiguration(task.taskId, input)
await writeFile(join(dir, 'migration-checkpoint.json'), JSON.stringify({ taskId: task.taskId, conversationId: task.conversationId, input, mode }))
setInterval(() => {}, 1000)
