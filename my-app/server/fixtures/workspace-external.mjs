import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from '../tasks.mjs'
import { createFeishuClient } from '../feishu-calendar.mjs'
import { addRule } from '../policy.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

export const askWorkspaceChange = (store, botId = 'calendar') => store.harness.commit(
  tx => addRule(tx, { botId, match: { tool: 'workspace.prepare_change' }, effect: 'ask' }), context)

export const eventArgs = { title: 'V2-03 isolated', description: 'secret-text', start: '2026-10-22T09:00:00+08:00', end: '2026-10-22T10:00:00+08:00', timezone: 'Asia/Shanghai', freeBusy: 'busy' }
export async function externalFixture(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-03-'))
  const events = new Map(), writes = [], env = { FEISHU_APP_ID: 'isolated-fixture', FEISHU_APP_SECRET: 'fixture-only' }; let lose = false, modelCalls = 0
  const calendar = { calendar_id: 'isolated-calendar', role: 'owner', type: 'shared', summary: 'Fixture' }
  const client = createFeishuClient({ env, fetchImpl: async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET', body = init.body && JSON.parse(init.body), id = decodeURIComponent(u.pathname.split('/').at(-1))
    let data = {}
    if (u.pathname.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 })
    if (method !== 'GET') {
      writes.push({ method, id })
      if (method === 'POST') { const e = { ...body, event_id: `event-${writes.length}`, status: 'confirmed', organizer_calendar_id: calendar.calendar_id }; events.set(e.event_id, e); data = { event: e } }
      if (method === 'PATCH') { Object.assign(events.get(id), body); data = { event: events.get(id) } }
      if (method === 'DELETE') { events.get(id).status = 'cancelled'; data = {} }
      if (lose) { lose = false; throw Error('response lost after effect') }
    } else if (id === calendar.calendar_id) data = calendar
    else if (id === 'attendees') data = { items: [] }
    else if (id === 'instance_view') {
      if (options.readWindow) data = await options.readWindow({ events, u })
      else data = { items: [...events.values()].filter(e => e.status !== 'cancelled') }
    }
    else if (events.has(id)) data = { event: events.get(id) }
    else return Response.json({ code: 193001 }, { status: 404 })
    return Response.json({ code: 0, data })
  } })
  let store
  const open = async () => { store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), feishuClient: client, modelReply: options.modelReply ?? (async () => { modelCalls++; throw Error('No model in manual path') }), ...(options.bots ? { bots: options.bots } : {}), ...(options.storeOptions ?? {}) }); return store }
  try {
    await open(); await store.feishuCalendar.manage({ action: 'bind', calendarId: calendar.calendar_id, confirm: true })
    const source = (await store.workspace.externalSources({})).sources[0], sourceId = source.id
    await store.workspace.grantExternal({ sourceId, expectedEpoch: source.epoch, confirmed: true, enabled: true, readScope: 'full' })
    await fn({ get store() { return store }, sourceId, events, writes, env, dir, lose: () => { lose = true }, restart: async () => { await store.close(); return open() }, modelCalls: () => modelCalls })
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }) }
}
