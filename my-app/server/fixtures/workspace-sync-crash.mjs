import { openTaskStore } from '../tasks.mjs'
import { createFeishuClient } from '../feishu-calendar.mjs'
const [file, phase] = process.argv.slice(2), hold = setInterval(() => {}, 1000)
const now = () => Date.parse('2026-10-19T12:00:00Z')
const client = createFeishuClient({ env: { FEISHU_APP_ID: 'sync-crash-fixture', FEISHU_APP_SECRET: 'fixture-only' }, fetchImpl: async url => {
  const p = new URL(url).pathname
  if (p.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'fixture-only', expire: 7200 })
  if (p.endsWith('/instance_view')) return Response.json({ code: 0, data: { items: [] } })
  return Response.json({ code: 0, data: { calendar_id: 'sync-crash-isolated', type: 'shared', role: 'owner' } })
} })
const store = await openTaskStore({ file, feishuClient: client, workspaceScheduleOptions: { autoStart: false }, workspaceSyncOptions: { now, boundary: async (point, value) => { if (point === phase && (point !== 'after_publish' || value.index === 0)) { process.send?.({ point, value }); await new Promise(() => {}) } } } })
try {
  if (phase === 'seed') {
    await store.feishuCalendar.manage({ action: 'bind', calendarId: 'sync-crash-isolated', confirm: true })
    const s = (await store.workspace.externalSources({})).sources[0]
    await store.workspace.grantExternal({ sourceId: s.id, expectedEpoch: s.epoch, enabled: true, confirmed: true, readScope: 'full' })
    await store.workspace.configureSync({ sourceId: s.id, expectedRevision: 0, enabled: true, confirmed: true })
    process.send?.({ seeded: true })
  } else {
    await store.workspaceScheduler.tick()
    const s = (await store.workspace.externalSources({})).sources[0]
    process.send?.({ completed: await store.workspace.syncStatus({ sourceId: s.id }) })
  }
} finally { await store.close(); clearInterval(hold) }
