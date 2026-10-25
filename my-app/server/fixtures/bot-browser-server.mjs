// Isolated browser acceptance fixture. Never defaults to the application database.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTaskStore } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
import { createApiServer } from '../app.mjs'
import { readModelConfig, createModelReply } from '../model-reply.mjs'
const [file, port = '3107', mode = 'test'] = process.argv.slice(2)
if (!file) throw new Error('Explicit temporary DB path required')
const config = mode === 'real' ? await readModelConfig() : undefined
const store = await openTaskStore({ file: resolve(file), bots: listBots(config), ...(config ? { modelReply: createModelReply(config) } : {}) })
const server = createApiServer({ token: 'pidot-01-browser-test-only', tasks: store, staticDir: fileURLToPath(new URL('../../dist', import.meta.url)) })
server.listen(Number(port), '127.0.0.1', () => console.log(`Ready http://127.0.0.1:${port}; ${config ? 'real model' : 'deterministic test'}`))
process.once('SIGTERM', () => { server.closeAllConnections(); server.close(async () => { await store.close() }) })
