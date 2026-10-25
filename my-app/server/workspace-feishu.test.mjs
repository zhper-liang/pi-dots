import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventArgs, externalFixture } from './fixtures/workspace-external.mjs'
const err = code => e => e.code === code
async function prepare(f, requestId, action = 'create', args = eventArgs, extra = {}) { return f.store.workspace.prepareExternal({ sourceId: f.sourceId, requestId, action, arguments: args, ...extra }) }
async function execute(f, op) { await f.store.workspace.confirmExternal({ requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true }); return f.store.workspace.executeExternal({ requestId: op.requestId }) }

test('03 manual create/update/delete require exact confirmation, retain receipt and use zero model/Task', async () => externalFixture(async f => {
  const op = await prepare(f, 'create')
  assert.equal(op.state, 'awaiting_confirmation'); assert.equal(f.writes.length, 0)
  assert.equal((await f.store.workspace.executeExternal({ requestId: 'create' })).state, 'awaiting_confirmation')
  await assert.rejects(f.store.workspace.confirmExternal({ requestId: 'create', payloadHash: 'forged', confirmed: true }), err('WORKSPACE_CONFIRMATION_STALE'))
  const created = await execute(f, op); assert.equal(created.state, 'succeeded'); assert.ok(created.receipt.providerReceipt)
  assert.equal((await f.store.workspace.executeExternal({ requestId: 'create' })).state, 'succeeded'); assert.equal(f.writes.length, 1)
  const eventId = created.receipt.providerReceipt.eventId
  const detail = (await f.store.workspace.getExternal({ sourceId: f.sourceId, eventId })).items[0]
  const update = await prepare(f, 'update', 'update', { ...eventArgs, title: 'Changed', eventId, beforeHash: detail.remoteVersion }, { expectedVersion: detail.version })
  assert.equal((await execute(f, update)).state, 'succeeded')
  const after = (await f.store.workspace.getExternal({ sourceId: f.sourceId, eventId })).items[0]
  assert.equal(after.version, 2); assert.equal(after.title, 'Changed')
  const del = await prepare(f, 'delete', 'delete', { eventId, beforeHash: after.remoteVersion }, { expectedVersion: after.version })
  assert.equal((await execute(f, del)).state, 'succeeded')
  assert.deepEqual(f.writes.map(w => w.method), ['POST', 'PATCH', 'DELETE']); assert.equal(f.modelCalls(), 0); assert.deepEqual(await f.store.list(), [])
}))

test('03 lost response remains unknown through restart; new request and repeated execution never resend', async () => externalFixture(async f => {
  const op = await prepare(f, 'lost'); f.lose()
  assert.equal((await execute(f, op)).state, 'unknown'); assert.equal(f.writes.length, 1)
  await f.restart()
  assert.equal((await f.store.workspace.getExternalOperation({ requestId: 'lost' })).state, 'unknown')
  assert.equal((await f.store.workspace.executeExternal({ requestId: 'lost' })).state, 'unknown')
  await assert.rejects(prepare(f, 'new'), err('WORKSPACE_EXTERNAL_LOCKED')); assert.equal(f.writes.length, 1)
}))

test('03 busy scope has no title/description/receipt; disconnect and rebind invalidate access and grants', async () => externalFixture(async f => {
  const created = await execute(f, await prepare(f, 'seed')), eventId = created.receipt.providerReceipt.eventId
  let s = (await f.store.workspace.externalSources({})).sources[0]
  await f.store.workspace.grantExternal({ sourceId: s.id, expectedEpoch: s.epoch, confirmed: true, enabled: true, readScope: 'busy' })
  const data = await f.store.workspace.getExternal({ sourceId: s.id, eventId })
  assert.equal(JSON.stringify(data).includes('secret-text'), false); assert.equal(JSON.stringify(data).includes('V2-03 isolated'), false); assert.deepEqual(Object.keys(data.items[0]), ['start', 'end', 'timezone'])
  await assert.rejects(f.store.workspace.getExternalOperation({ requestId: 'seed' }), err('WORKSPACE_FORBIDDEN'))
  await f.store.feishuCalendar.manage({ action: 'disconnect', confirm: true })
  await assert.rejects(f.store.workspace.getExternal({ sourceId: s.id, eventId }), err('WORKSPACE_EXTERNAL_REVOKED'))
  await f.store.feishuCalendar.manage({ action: 'bind', calendarId: 'isolated-calendar', confirm: true })
  s = (await f.store.workspace.externalSources({})).sources[0]; assert.equal(s.id, f.sourceId); assert.equal(s.authorized, false)
}))

test('03 beforeHash conflict prevents provider mutation; changed request payload and unsupported fields rejected', async () => externalFixture(async f => {
  const op = await prepare(f, 'seed'); assert.deepEqual(await prepare(f, 'seed'), op)
  await assert.rejects(prepare(f, 'seed', 'create', { ...eventArgs, title: 'other' }), err('WORKSPACE_REQUEST_CONFLICT'))
  await assert.rejects(prepare(f, 'unsupported', 'create', { ...eventArgs, attendees: ['x'] }), err('WORKSPACE_EXTERNAL_INPUT'))
  const created = await execute(f, op), eventId = created.receipt.providerReceipt.eventId
  const e = (await f.store.workspace.getExternal({ sourceId: f.sourceId, eventId })).items[0]
  const update = await prepare(f, 'conflict', 'update', { ...eventArgs, title: 'new', eventId, beforeHash: e.remoteVersion }, { expectedVersion: e.version })
  f.events.get(eventId).summary = 'external-edit'
  assert.equal((await execute(f, update)).state, 'conflict'); assert.equal(f.writes.length, 1)
}))

test('03 concurrent execute sends once and cancellation stays terminal', async () => externalFixture(async f => {
  const op = await prepare(f, 'concurrent'); await f.store.workspace.confirmExternal({ requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true })
  await Promise.all(Array.from({ length: 5 }, () => f.store.workspace.executeExternal({ requestId: op.requestId })))
  assert.equal(f.writes.length, 1)
  const cancel = await prepare(f, 'cancel'); await f.store.workspace.cancelExternal({ requestId: cancel.requestId })
  assert.equal((await f.store.workspace.executeExternal({ requestId: cancel.requestId })).state, 'cancelled'); assert.equal(f.writes.length, 1)
}))

test('03 revoking prepared intent prevents approval and provider dispatch', async () => externalFixture(async f => {
  const op = await prepare(f, 'stale')
  const source = (await f.store.workspace.externalSources({})).sources[0]
  await f.store.workspace.grantExternal({ sourceId: source.id, expectedEpoch: source.epoch, enabled: false, readScope: 'full', confirmed: true })
  await assert.rejects(f.store.workspace.confirmExternal({ requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true }), err('WORKSPACE_FORBIDDEN'))
  assert.equal(f.writes.length, 0)
}))

test('03 actual SIGKILL preserves ready or sent unknown and never resends after recovery', { timeout: 30000 }, async () => {
  const { spawn } = await import('node:child_process'), { once } = await import('node:events')
  const { mkdtemp, readFile, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path'), { setTimeout: delay } = await import('node:timers/promises')
  for (const boundary of ['ready', 'sent']) {
    const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-03-kill-'))
    let child
    const run = mode => { const p = spawn(process.execPath, [new URL('./fixtures/workspace-external-crash.mjs', import.meta.url).pathname, dir, boundary, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; p.stdout.on('data', d => output += d); p.stderr.on('data', d => output += d); return { p, output: () => output } }
    try {
      child = run('run')
      let paused
      for (let i = 0; i < 1000; i++) { try { paused = JSON.parse(await readFile(join(dir, 'paused.json'))); break } catch {} if (child.p.exitCode !== null) throw Error(child.output()); await delay(5) }
      assert.ok(paused, child.output()); const exit = once(child.p, 'exit'); child.p.kill('SIGKILL'); assert.equal((await exit)[1], 'SIGKILL')
      const next = run('recover'); assert.equal((await once(next.p, 'exit'))[0], 0, next.output())
      const recovered = JSON.parse(await readFile(join(dir, 'recovered.json')))
      assert.equal(recovered.state, boundary === 'ready' ? 'ready' : 'unknown'); assert.equal(recovered.receipt, null)
      if (boundary === 'sent') assert.equal(JSON.parse(await readFile(join(dir, 'writes.json'))).count, 1)
    } finally { child?.p.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }) }
  }
})

test('03 confirmation expiry, forged actor, bot permissions, and cached bypass are rejected', async () => {
  const { openFoundation } = await import('./fixtures/workspace-foundation.mjs'), { createWorkspaceService } = await import('./workspace-service.mjs'), { createActorAuthority } = await import('./workspace-policy.mjs'), { createCalendarService, createFeishuClient } = await import('./feishu-calendar.mjs'), { ToolAccess } = await import('./tools.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-03-authority-')), f = await openFoundation(join(dir, 'isolated.sqlite'))
  let now = Date.parse('2026-10-19T00:00:00Z')
  const client = createFeishuClient({ env: { FEISHU_APP_ID: 'authority-fixture', FEISHU_APP_SECRET: 'fixture' }, fetchImpl: async url => Response.json(url.includes('/auth/') ? { code: 0, tenant_access_token: 'fixture', expire: 7200 } : { code: 0, data: { calendar_id: 'authority-calendar', role: 'owner', type: 'shared' } }) })
  const calendar = createCalendarService({ client, ToolAccess, commit: fn => f.repo.transaction(fn) })
  const authority = createActorAuthority({ resolveAgent: async () => ({ botId: 'fixture-bot', grantEpoch: 1, scope: { actions: ['read', 'create'], sources: [], readScope: 'full' } }) }), actor = authority.user()
  const service = createWorkspaceService({ repository: f.repo, authority, external: { calendar, client, now: () => now } })
  try {
    await calendar.manage({ action: 'bind', calendarId: 'authority-calendar', confirm: true })
    const source = (await service.externalSources(actor)).sources[0]
    await service.grantExternal(actor, { sourceId: source.id, expectedEpoch: source.epoch, enabled: true, readScope: 'full', confirmed: true })
    const op = await service.prepareExternal(actor, { sourceId: source.id, requestId: 'expire', action: 'create', arguments: eventArgs })
    now += 300001
    await assert.rejects(service.confirmExternal(actor, { requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true }), err('WORKSPACE_CONFIRMATION_STALE'))
    await assert.rejects(service.externalSources({ ...actor }), err('WORKSPACE_ACTOR'))
    const agent = await authority.agent(1)
    await assert.rejects(service.confirmExternal(agent, { requestId: op.requestId, payloadHash: op.payloadHash, confirmed: true }), err('WORKSPACE_CONFIRMATION_REQUIRED'))
    await assert.rejects(service.prepareExternal(agent, { sourceId: source.id, requestId: 'bot', action: 'create', arguments: eventArgs }), err('WORKSPACE_FORBIDDEN'))
    await assert.rejects(service.get(actor, 'Event', source.id, 'anything'), err('WORKSPACE_EXTERNAL_READ_REQUIRED'))
  } finally { await f.close(); await rm(dir, { recursive: true, force: true }) }
})

test('03 legacy unknown blocks new requests without mutating original Task or approval', async () => externalFixture(async f => {
  const { TaskApprovals } = await import('./approvals.mjs'), { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context')
  const task = await f.store.create({ botId: 'calendar' }), binding = (await f.store.feishuCalendar.status()).binding
  const original = { id: 'legacy-unknown', source: binding, toolName: 'calendar_feishu_create_event', arguments: { title: 'old' }, status: 'outcome-unknown', receipt: null, operation: { id: 'old-operation', unknownAt: '2026-10-18T00:00:00Z' } }
  await f.store.harness.commit(async tx => { const state = await tx.doc(TaskApprovals, task.taskId); state.items.push(original); state.activeId = original.id }, BACKGROUND_CONTEXT)
  await assert.rejects(prepare(f, 'new-after-legacy'), err('WORKSPACE_EXTERNAL_LOCKED'))
  const retained = await f.store.harness.snapshot(TaskApprovals, task.taskId, BACKGROUND_CONTEXT)
  assert.deepEqual(retained.items, [original]); assert.equal(f.writes.length, 0)
}))

test('03 source rotation fails closed and new source never inherits old grants or receipts', async () => externalFixture(async f => {
  await execute(f, await prepare(f, 'old-account'))
  f.env.FEISHU_APP_SECRET = 'rotated-fixture'
  assert.equal((await f.store.workspace.externalSources({})).sources.length, 0)
  await assert.rejects(f.store.workspace.getExternalOperation({ requestId: 'old-account' }), err('WORKSPACE_EXTERNAL_REVOKED'))
  await f.store.feishuCalendar.manage({ action: 'bind', calendarId: 'isolated-calendar', confirm: true })
  const current = (await f.store.workspace.externalSources({})).sources[0]
  assert.notEqual(current.id, f.sourceId); assert.equal(current.authorized, false)
}))

test('03 unsupported readonly types and imprecise windows never write', async () => externalFixture(async f => {
  const created = await execute(f, await prepare(f, 'readonly-seed')), eventId = created.receipt.providerReceipt.eventId
  f.events.get(eventId).recurrence = 'FREQ=DAILY'
  const item = (await f.store.workspace.getExternal({ sourceId: f.sourceId, eventId })).items[0]
  assert.equal(item.readOnly, true)
  await assert.rejects(prepare(f, 'repeat-write', 'delete', { eventId, beforeHash: item.remoteVersion }, { expectedVersion: item.version }), err('WORKSPACE_VERSION_CONFLICT'))
  await assert.rejects(f.store.workspace.queryExternal({ sourceId: f.sourceId, start: '2026-10-19T00:00:00.001Z', end: '2026-10-20T00:00:00Z', timezone: 'UTC' }), err('WORKSPACE_EXTERNAL_INPUT'))
  assert.equal(f.writes.length, 1)
}))

test('03 new unknown mutation blocks old approved Task dispatcher on the same event', async () => {
  const { listBots } = await import('./bots.mjs'), { FEISHU_TOOLS } = await import('./feishu-calendar.mjs'), { FEISHU_UPDATE_TOOL } = await import('./feishu-mutation.mjs')
  const config = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-only' }
  let resource, eventId
  const modelReply = async (_message, o) => {
    const results = o.context.messages.filter(m => m.role === 'toolResult')
    const base = { mode: 'model', reply: { role: 'assistant', content: 'fixture done' }, execution: { usage: { input: 1, output: 1, totalTokens: 2 } } }
    if (results.length >= 2) return base
    const call = !results.length ? { type: 'toolCall', id: 'read', name: FEISHU_TOOLS[1], arguments: { resource, eventId } } : { type: 'toolCall', id: 'write', name: FEISHU_UPDATE_TOOL, arguments: { ...eventArgs, title: 'old-path-update', resource, eventId, beforeHash: JSON.parse(results.at(-1).content[0].text).data.beforeHash } }
    return { ...base, toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: Date.now() } }
  }
  await externalFixture(async f => {
    const created = await execute(f, await prepare(f, 'cross-seed')); eventId = created.receipt.providerReceipt.eventId
    const e = (await f.store.workspace.getExternal({ sourceId: f.sourceId, eventId })).items[0]
    const op = await prepare(f, 'unknown-update', 'update', { ...eventArgs, title: 'lost-new-update', eventId, beforeHash: e.remoteVersion }, { expectedVersion: e.version })
    f.lose(); assert.equal((await execute(f, op)).state, 'unknown'); assert.equal(f.writes.length, 2)
    resource = (await f.store.feishuCalendar.status()).binding.resource
    const tools = [FEISHU_TOOLS[1], FEISHU_UPDATE_TOOL]
    const { bot } = await f.store.getBotConfiguration('calendar')
    await f.store.updateBotConfiguration('calendar', { requestId: 'cross-bot', expectedVersion: bot.configRef.version, description: 'isolated exact old mutation', tools, resources: [resource] })
    const { addRule } = await import('./policy.mjs'), { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context')
    await f.store.harness.commit(tx => addRule(tx, { botId: 'calendar', match: { tool: FEISHU_UPDATE_TOOL }, effect: 'ask' }), context)
    const task = await f.store.create({ botId: 'calendar' }); await f.store.send(task.taskId, `明确精确eventId=${eventId}；读取后申请修改。`)
    let current
    for (let i = 0; i < 500; i++) { current = await f.store.get(task.taskId); if (current.approvals.activeId) break; await new Promise(r => setTimeout(r, 5)) }
    assert(current.approvals.activeId, JSON.stringify({ status: current.status, waiting: current.waiting, messages: current.messages, callUsage: current.callUsage }))
    await f.store.decideApproval(task.taskId, current.approvals.activeId, { decision: 'approved' })
    for (let i = 0; i < 500; i++) { current = await f.store.get(task.taskId); if (current.approvals.items[0].status === 'outcome-unknown') break; await new Promise(r => setTimeout(r, 5)) }
    assert.equal(current.approvals.items[0].status, 'outcome-unknown'); assert.equal(f.writes.length, 2)
    assert.equal((await f.store.workspace.getExternalOperation({ requestId: 'unknown-update' })).state, 'unknown')
  }, { bots: listBots(config), modelReply })
})

test('03 authenticated HTTP exposes manual routes but never trusts body actors', async () => externalFixture(async f => {
  const { createApiServer } = await import('./app.mjs'), { once } = await import('node:events')
  const server = createApiServer({ tasks: f.store, token: 'external-fixture-http' }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api/workspace/`
  try {
    const post = (path, data, token = 'external-fixture-http') => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    assert.equal((await post('external-sources', {}, 'wrong')).status, 401)
    const source = await post('external-sources', {}); assert.equal(source.status, 200)
    const forged = await post('external-prepare', { sourceId: f.sourceId, requestId: 'forged-http', action: 'create', arguments: eventArgs, principalKind: 'user' }); assert.equal(forged.status, 400)
    const r = await post('external-prepare', { sourceId: f.sourceId, requestId: 'http', action: 'create', arguments: eventArgs }), op = (await r.json()).data
    assert.equal(r.status, 200); assert.equal(op.state, 'awaiting_confirmation'); assert.equal(f.writes.length, 0)
    const denied = await post('external-confirm', { requestId: op.requestId, payloadHash: op.payloadHash, confirmed: false }); assert.equal(denied.status, 400)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))
