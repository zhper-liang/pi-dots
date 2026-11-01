// Isolated UI fixture: explicit temporary storage, scripted model, no provider or account access.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
import { createApiServer } from '../app.mjs'

const [file, port = '3197', staticPath] = process.argv.slice(2)
if (!file) throw new Error('An explicit temporary database is required')
const config = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', model: 'continuous-browser-fixture', contextWindow: 65536 }
const store = await openTaskStore({ file: resolve(file), bots: listBots(config), modelReply: async (_message, { signal }) => {
  await delay(1500, undefined, { signal })
  return { mode: 'model', reply: { content: '示例阶段：仍需取得实际成果与核验依据。' }, execution: { usage: { totalTokens: 10 } } }
} })
const server = createApiServer({ token: 'pidot-continuous-browser-fixture', tasks: store,
  staticDir: staticPath ? resolve(staticPath) : fileURLToPath(new URL('../../dist', import.meta.url)) })
server.listen(Number(port), '127.0.0.1', () => console.log(`Ready http://127.0.0.1:${port}; scripted model, isolated storage`))
process.once('SIGTERM', () => {
  server.closeAllConnections()
  server.close(async () => { await store.close() })
})
