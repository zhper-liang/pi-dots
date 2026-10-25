import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTaskStore } from './authorized-task-store.mjs'
import { listBots } from '../bots.mjs'
const [dir, boundary] = process.argv.slice(2)
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'unknown-action-fixture', apiKey: 'fixture-only' }
function stop(data) { writeFileSync(join(dir, 'retry-checkpoint.json'), JSON.stringify({ boundary, ...data })); process.kill(process.pid, 'SIGSTOP') }
const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), calendarWriteImpl: async (operation, { execute }) => {
  if (boundary === 'retry-started') stop({ operation })
  const result = await execute()
  if (boundary === 'retry-returned') stop({ operation, result })
  return result
}, modelReply: async () => { throw new Error('No model before the tested receipt boundary') } })
store.harness.subscribeCommits(({ changes }) => {
  if (boundary === 'retry-receipt-saved' && changes.some((x) => x.type === 'entry' && x.value.kind === 'pidot.action-idempotency-result')) stop({ receiptSaved: true })
})
setTimeout(() => { console.error('Expected retry boundary not reached'); process.exit(3) }, 12000)
