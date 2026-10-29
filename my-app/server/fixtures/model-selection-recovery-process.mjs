// T12 isolated child: no host env files; credentials never enter argv/checkpoints/output.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModelSettings } from '../model-settings.mjs'
import { listBots } from '../bots.mjs'
import { openTaskStore } from '../tasks.mjs'

const [dir] = process.argv.slice(2)
const file = join(dir, 'isolated.sqlite')
const settings = createModelSettings({ file, env: {}, envFiles: [] })
const bots = listBots(await settings.read())
bots.find(bot => bot.id === 'calendar').defaults.model.id = 'model-b'
const store = await openTaskStore({ file, bots, modelSettings: settings, memoryOptions: { enabled: false }, workspaceScheduleOptions: { autoStart: false } })
async function until(read, check) {
  for (let i = 0; i < 1000; i++) { const result = await read(); if (check(result)) return result; await delay(5) }
  throw new Error('Isolated recovery child did not reach checkpoint')
}
const id = (await store.mainSessions()).chief
await store.send(id, 'recovery-history')
const history = await until(() => store.get(id), view => view.activeInputId === null && view.messages.some(message => message.role === 'assistant'))
const independent = await store.create({ botId: 'chief', title: 'T12 independent snapshot' })
await store.send(id, 'recovery-active', undefined, { model: { id: 'model-a' } })
await until(() => store.get(id), view => view.runtime.checkpoint?.inFlight?.kind === 'model')
for (const model of ['model-b', 'model-a', 'model-b']) await store.send(id, `recovery-queued-${model}`, undefined, { model: { id: model } })
const saved = await store.get(id)
writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ history, saved, independent, mainSessions: await store.mainSessions() }), { mode: 0o600 })
process.kill(process.pid, 'SIGSTOP')
