import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTaskStore } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
const root = process.argv[2]
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'native-fixture', apiKey: 'fixture-only' }
const content = [{ type: 'toolCall', id: 'native-bash', name: 'bash', arguments: { command: 'touch duplicated' } }]
const store = await openTaskStore({ file: join(root, 'tasks.sqlite'), bots: listBots(config), modelReply: async () => ({ mode: 'model', reply: { content: '' }, execution: { usage: { totalTokens: 7 } }, toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }) })
const id = (await store.mainSessions()).calendar
store.harness.subscribeCommits(({ changes }) => {
  if (changes.some(change => change.type === 'task' && change.value.id === id && change.value.state.checkpoint?.inFlight?.kind === 'native-tool')) {
    writeFileSync(join(root, 'checkpoint.json'), JSON.stringify({ taskId: id }))
    process.kill(process.pid, 'SIGSTOP')
  }
})
await store.send(id, '检查恢复')
setTimeout(() => process.exit(3), 15000)
