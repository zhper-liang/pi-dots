import { writeFile } from 'node:fs/promises'
import { openTaskStore } from '../tasks.mjs'
import { createFeishuClient } from '../feishu-calendar.mjs'
import { eventArgs } from './workspace-external.mjs'
const [dir, boundary, mode] = process.argv.slice(2)
if (!dir?.startsWith('/tmp/pidot-v2-03-kill-')) throw Error('Dedicated isolated path required')
const client = createFeishuClient({ env: { FEISHU_APP_ID: 'kill-fixture', FEISHU_APP_SECRET: 'fixture' }, fetchImpl: async (url, init) => {
  const path = new URL(url).pathname
  if (path.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 })
  if (init.method === 'POST') { await writeFile(`${dir}/writes.json`, JSON.stringify({ count: 1 })); await writeFile(`${dir}/paused.json`, JSON.stringify({ point: 'sent-no-receipt' })); await new Promise(() => {}) }
  return Response.json({ code: 0, data: { calendar_id: 'kill-calendar', role: 'owner', type: 'shared', summary: 'isolated' } })
} })
const store = await openTaskStore({ file: `${dir}/isolated.sqlite`, feishuClient: client, modelReply: async () => { throw Error('No models') } })
setInterval(() => {}, 1000)
if (mode === 'run') {
  await store.feishuCalendar.manage({ action: 'bind', calendarId: 'kill-calendar', confirm: true })
  const source = (await store.workspace.externalSources({})).sources[0]
  await store.workspace.grantExternal({ sourceId: source.id, expectedEpoch: source.epoch, confirmed: true, enabled: true, readScope: 'full' })
  const op = await store.workspace.prepareExternal({ sourceId: source.id, requestId: 'kill', action: 'create', arguments: eventArgs })
  await store.workspace.confirmExternal({ requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true })
  if (boundary === 'ready') await writeFile(`${dir}/paused.json`, JSON.stringify({ point: 'ready' }))
  else await store.workspace.executeExternal({ requestId: 'kill' })
} else {
  const op = await store.workspace.getExternalOperation({ requestId: 'kill' })
  if (boundary === 'sent') await store.workspace.executeExternal({ requestId: 'kill' })
  await writeFile(`${dir}/recovered.json`, JSON.stringify({ state: op.state, receipt: op.receipt ?? null }))
  await store.close(); process.exit(0)
}
