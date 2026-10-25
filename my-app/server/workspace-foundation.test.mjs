import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { WorkspaceMeta, WorkspaceRecords, LOCAL_OWNER, validateRecord, identityKey } from './workspace-schema.mjs'
import { createActorAuthority } from './workspace-policy.mjs'
import { createWorkspaceService } from './workspace-service.mjs'
import { openFoundation, assignWorkspaceBot, probeSchedule, ProbeWakeTask } from './fixtures/workspace-foundation.mjs'
import { openTaskStore, TaskCard, ChatInput } from './tasks.mjs'
import { TaskApprovals } from './approvals.mjs'
import { ToolAccess } from './tools.mjs'
import { createApiServer } from './app.mjs'

const base = { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: 'local' }
const todo = id => ({ ...base, id, title: `todo ${id}`, version: 1, status: 'open' })
const grant = (id, readScope = 'full', epoch = 0) => ({ ...base, id, principalKind: id.startsWith('user:') ? 'user' : 'bot', subjectId: id.split(':')[1], actions: ['read', 'create', 'update', 'delete'], readScope, epoch })
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-01-')), file = join(dir, 'isolated.sqlite')
  const s = await openFoundation(file)
  try { await fn({ ...s, dir, file }) } finally { await s.close(); await rm(dir, { recursive: true, force: true }) }
}
async function consent(repo) { await repo.transaction(tx => repo.put(tx, 'Grant', grant('user:authenticated-user'))) }
const command = { requestId: 'atomic-1', sourceId: 'local', action: 'create', normalizedArgs: { title: 'one' } }
async function waitUntil(fn, timeout = 5000) { const start = Date.now(); while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 15)) } throw new Error('Probe timeout') }

test('V2 schemas cover every versioned family and reject secrets, invalid identities and versions', async () => {
  assert.equal(Object.keys(WorkspaceRecords).length, 15)
  assert.equal(validateRecord('Todo', todo('one')).ownerId, LOCAL_OWNER)
  for (const patch of [{ schemaVersion: 2 }, { version: 0 }, { ownerId: '../escape' }, { token: 'not-a-real-secret' }, { status: 'TaskCard' }]) assert.throws(() => validateRecord('Todo', { ...todo('one'), ...patch }))
  assert.notEqual(identityKey('owner1', 'source', 'id'), identityKey('owner2', 'source', 'id'))
  assert.notEqual(identityKey('owner1', 'source1', 'id'), identityKey('owner1', 'source2', 'id'))
})

test('V2 one commit contains object, Operation, outbox and occurrence; rollback leaves none; request idempotency', async () => withStore(async ({ repo }) => {
  await consent(repo)
  const authority = createActorAuthority(), service = createWorkspaceService({ repository: repo, authority }), actor = authority.user()
  const apply = async (tx, { operationId }) => {
    await repo.put(tx, 'Todo', todo('one'))
    await repo.put(tx, 'Outbox', { ...base, id: 'one', operationId, dedupeKey: 'one', state: 'pending' })
    await repo.put(tx, 'Occurrence', { ...base, id: 'one', scheduleId: 'one', revision: 1, scheduledFor: '2026-10-19T00:00:00.000Z', attempts: 0, state: 'claimed', operationId })
    return { id: 'one', version: 1 }
  }
  await assert.rejects(service.commitLocal(actor, command, async (...args) => { await apply(...args); throw new Error('injected rollback') }), /injected rollback/)
  for (const type of ['Todo', 'Outbox', 'Occurrence']) assert.equal(await repo.transaction(tx => repo.get(tx, type, LOCAL_OWNER, 'local', 'one')), null)
  assert.equal((await repo.transaction(tx => repo.list(tx, 'Operation', LOCAL_OWNER, 'operations'))).items.length, 0)
  const first = await service.commitLocal(actor, command, apply)
  assert.equal(first.state, 'succeeded')
  assert.deepEqual(await service.commitLocal(actor, command, () => { throw new Error('must not reapply') }), first)
  await assert.rejects(service.commitLocal(actor, { ...command, normalizedArgs: { title: 'different' } }, apply), { code: 'WORKSPACE_REQUEST_CONFLICT', status: 409 })
  for (const type of ['Todo', 'Outbox', 'Occurrence']) assert.equal((await repo.transaction(tx => repo.get(tx, type, LOCAL_OWNER, 'local', 'one'))).id, 'one')
}))

test('V2 trusted actors use live Bot assignments; stdio busy scope stays narrow', async () => withStore(async store => {
  const { repo } = store
  const binding = { botId: 'calendar', scope: { tools: ['workspace.list', 'workspace.get'], sources: ['local'], actions: ['read'], readScope: 'full' } }
  const authority = createActorAuthority({ resolveAgent: async () => structuredClone(binding), resolveClient: async () => ({ ...binding, scope: { ...binding.scope, readScope: 'busy' } }) })
  const service = createWorkspaceService({ repository: repo, authority })
  const user = authority.user(), agent = await authority.agent(42), client = await authority.client('fixture')
  const background = await authority.background(42, { ...probeSchedule('s1', '2026-10-19T00:00:00.000Z'), executionPrincipal: { botId: 'calendar' } })
  await assert.rejects(service.diagnostics({ ...user, ownerId: 'attacker' }), { code: 'WORKSPACE_ACTOR' })
  assert.equal(await service.get(user, 'Todo', 'local', 'one'), null)
  await repo.transaction(async tx => { await repo.put(tx, 'Todo', todo('one')); await repo.put(tx, 'Grant', grant('bot:calendar', 'busy')) })
  await assert.rejects(service.get(agent, 'Todo', 'local', 'one'), { code: 'WORKSPACE_FORBIDDEN' })
  await assignWorkspaceBot(store)
  assert.equal((await service.get(agent, 'Todo', 'local', 'one')).title, 'todo one')
  await assert.rejects(service.get(client, 'Todo', 'local', 'one'), { code: 'WORKSPACE_BUSY_ONLY' })
  const event = { ...base, id: 'event', title: 'SECRET TITLE', description: 'SECRET DESCRIPTION', start: '2026-10-19T09:00:00+08:00', end: '2026-10-19T10:00:00+08:00', timezone: 'Asia/Shanghai', version: 1, authority: 'local', remoteId: 'hidden-provider-id' }
  await repo.transaction(tx => repo.put(tx, 'Event', event))
  assert.equal((await service.get(agent, 'Event', 'local', 'event')).title, 'SECRET TITLE')
  assert.deepEqual(Object.keys(await service.get(client, 'Event', 'local', 'event')).sort(), ['end', 'start', 'timezone'])
  await assert.rejects(service.get(background, 'Event', 'local', 'event'), { code: 'WORKSPACE_FORBIDDEN' })
  await repo.transaction(tx => repo.put(tx, 'Grant', grant('bot:calendar', 'none', 1)))
  assert.equal((await service.get(agent, 'Todo', 'local', 'one')).id, 'one')
  await repo.transaction(async tx => { (await tx.doc(ToolAccess)).assignments.calendar.tools = ['workspace.list'] })
  await assert.rejects(service.get(agent, 'Event', 'local', 'event'), { code: 'WORKSPACE_FORBIDDEN' })
  await assignWorkspaceBot(store)
  assert.equal((await service.get(agent, 'Todo', 'local', 'one')).id, 'one')
  await assert.rejects(service.prepareCommand(user, { ...command, ownerId: 'forged', botId: 'chief', taskId: 42 }), { code: 'WORKSPACE_COMMAND' })
  await assert.rejects(service.commitLocal(agent, command, () => null), { code: 'WORKSPACE_CONFIRMATION_REQUIRED' })
}))

test('V2 prepare command canonical request reuse and cross-source 409', async () => withStore(async ({ repo }) => {
  await consent(repo)
  const authority = createActorAuthority(), service = createWorkspaceService({ repository: repo, authority }), user = authority.user()
  const first = await service.prepareCommand(user, command)
  assert.equal(first.operation.state, 'prepared'); assert.equal(first.created, true)
  assert.equal((await service.prepareCommand(user, { normalizedArgs: { title: 'one' }, action: 'create', sourceId: 'local', requestId: 'atomic-1' })).created, false)
  await assert.rejects(service.prepareCommand(user, { ...command, normalizedArgs: { title: 'different' } }), { status: 409 })
}))

test('V2 indexed pagination handles 1000 Todos and 1000 Occurrences without duplicate rows', async () => withStore(async ({ repo }) => {
  for (let block = 0; block < 10; block++) await repo.transaction(async tx => {
    for (let i = block * 100; i < block * 100 + 100; i++) {
      await repo.put(tx, 'Todo', todo(`scale-${i}`))
      await repo.put(tx, 'Occurrence', { ...base, id: `scale-${i}`, scheduleId: 'scale', revision: 1, scheduledFor: new Date(Date.UTC(2026, 9, 19, 0, i)).toISOString(), attempts: 0, state: 'pending' })
    }
  })
  for (const type of ['Todo', 'Occurrence']) {
    let cursor, ids = [], pages = 0
    do { const page = await repo.transaction(tx => repo.list(tx, type, LOCAL_OWNER, 'local', { cursor, limit: 73 })); ids.push(...page.items.map(r => r.id)); cursor = page.next; pages++ } while (cursor !== undefined)
    assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000); assert.equal(pages, 14)
  }
  await repo.transaction(tx => repo.put(tx, 'Todo', { ...todo('scale-0'), version: 2 }))
  assert.equal((await repo.transaction(tx => repo.list(tx, 'Todo', LOCAL_OWNER, 'local', { cursor: 999 }))).items.length, 1)
  await assert.rejects(repo.transaction(tx => repo.list(tx, 'Todo', LOCAL_OWNER, 'local', { limit: 101 })), { code: 'WORKSPACE_PAGE' })
  assert.equal(await repo.transaction(tx => repo.get(tx, 'Todo', 'other-owner', 'local', 'scale-0')), null)
}))

test('V2 installed Harness sleep wakes on schedule change without starving other durable tasks', async () => withStore(async ({ harness, repo, context }) => {
  const root = await harness.root(context)
  const first = probeSchedule('wake-change', new Date(Date.now() + 60000).toISOString())
  await repo.transaction(tx => repo.put(tx, 'Schedule', first))
  const id = await harness.commit(tx => tx.createTask(ProbeWakeTask, { sourceId: 'local', id: first.id }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true }), context)
  harness.resume()
  await waitUntil(async () => (await harness.getTask(id, context)).state.status === 'running')
  // While one task sleeps a second ordinary conversation-owned task reaches done.
  await repo.transaction(tx => repo.put(tx, 'Schedule', probeSchedule('ordinary', new Date().toISOString())))
  const ordinary = await harness.commit(tx => tx.createTask(ProbeWakeTask, { sourceId: 'local', id: 'ordinary' }, { ownership: { kind: 'conversation' }, conversationId: root.id }), context)
  await waitUntil(async () => (await harness.getTask(ordinary, context)).state.status === 'terminal')
  assert.equal((await harness.getTask(id, context)).state.status, 'running')
  await repo.transaction(tx => repo.put(tx, 'Schedule', { ...first, revision: 2, nextDueAt: new Date().toISOString() }))
  const done = await waitUntil(async () => { const t = await harness.getTask(id, context); return t.state.status === 'terminal' && t })
  assert.equal(done.state.outcome.status, 'completed')
  assert.equal((await repo.transaction(tx => repo.list(tx, 'Occurrence', LOCAL_OWNER, 'local'))).items.filter(x => x.scheduleId === first.id).length, 1)
}))

async function crash(file, mode) {
  const child = spawn(process.execPath, ['server/fixtures/workspace-crash.mjs', file, mode], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', stderr = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  try {
    await waitUntil(() => { if (child.exitCode !== null) throw new Error(`Probe child failed: ${stderr}`); return output.includes('\n') })
    const record = JSON.parse(output.trim().split('\n')[0])
    child.kill('SIGKILL'); const [code, signal] = await once(child, 'exit'); assert.equal(code, null); assert.equal(signal, 'SIGKILL')
    return record
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
}

test('V2 SIGKILL before commit rolls back family record and index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-01-kill-')), file = join(dir, 'isolated.sqlite')
  try {
    const killed = await crash(file, 'rollback'); assert.equal(killed.point, 'uncommitted')
    const s = await openFoundation(file)
    try { assert.equal(await s.repo.transaction(tx => s.repo.get(tx, 'Todo', LOCAL_OWNER, 'local', 'killed')), null); assert.equal((await s.repo.transaction(tx => s.repo.list(tx, 'Todo', LOCAL_OWNER, 'local'))).items.length, 0)
      for (const type of ['Outbox', 'Occurrence']) assert.equal(await s.repo.transaction(tx => s.repo.get(tx, type, LOCAL_OWNER, 'local', 'killed')), null)
      assert.equal(await s.repo.transaction(tx => s.repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', 'killed')), null)
      assert.equal(await s.harness.getTask(killed.taskId, s.context), undefined)
    } finally { await s.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('V2 SIGKILL sleeping task resumes same task and recomputes persisted due point', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-01-kill-')), file = join(dir, 'isolated.sqlite')
  try {
    const before = await crash(file, 'wake'), s = await openFoundation(file)
    try {
      s.harness.resume()
      const t = await waitUntil(async () => { const t = await s.harness.getTask(before.taskId, s.context); return t.state.status === 'terminal' && t })
      assert.equal(t.state.outcome.status, 'completed')
      const runs = await s.repo.transaction(tx => s.repo.list(tx, 'Occurrence', LOCAL_OWNER, 'local'))
      assert.equal(runs.items.length, 1); assert.equal(runs.items[0].taskId, before.taskId); assert.equal(runs.items[0].scheduledFor, before.due)
    } finally { await s.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('V2 Task and Occurrence association commit survives SIGKILL with original identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-01-kill-')), file = join(dir, 'isolated.sqlite')
  try {
    const before = await crash(file, 'linked'), s = await openFoundation(file)
    try { const r = await s.repo.transaction(tx => s.repo.get(tx, 'Occurrence', LOCAL_OWNER, 'local', 'linked')); assert.equal(r.taskId, before.taskId); assert.ok(await s.harness.getTask(r.taskId, s.context)) } finally { await s.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('V2 explicit migration on isolated legacy copy preserves Task, approval unknown and Bot permissions; rollback disables only new entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-01-migration-')), oldFile = join(dir, 'legacy.sqlite'), file = join(dir, 'copy.sqlite')
  let s
  try {
    s = await openTaskStore({ file: oldFile, workspaceEnabled: false })
    const created = await s.create({ botId: 'chief', title: 'isolated legacy fixture' }), id = created.taskId
    await s.harness.commit(async tx => { const a = await tx.doc(TaskApprovals, id); a.items.push({ id: 'legacy-unknown', status: 'pending', operation: { state: 'outcome-unknown' } }) }, (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT)
    const ctx = (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT
    const before = await s.harness.commit(async tx => ({ card: JSON.parse(JSON.stringify(await tx.doc(TaskCard, id))), approvals: JSON.parse(JSON.stringify(await tx.doc(TaskApprovals, id))), input: JSON.parse(JSON.stringify(await tx.doc(ChatInput, id))), permissions: JSON.parse(JSON.stringify(await tx.doc(ToolAccess))) }), ctx)
    await s.harness.commit(async tx => { const meta = await tx.doc(WorkspaceMeta); meta.schemaVersion = 0; meta.initialized = false }, ctx)
    await s.close(); s = null; await cp(oldFile, file)
    await assert.rejects(openTaskStore({ file }), { code: 'WORKSPACE_MIGRATION_REQUIRED' })
    s = await openTaskStore({ file, workspaceMigration: 'v0-to-v1' })
    const after = await s.harness.commit(async tx => ({ card: JSON.parse(JSON.stringify(await tx.doc(TaskCard, id))), approvals: JSON.parse(JSON.stringify(await tx.doc(TaskApprovals, id))), input: JSON.parse(JSON.stringify(await tx.doc(ChatInput, id))), permissions: JSON.parse(JSON.stringify(await tx.doc(ToolAccess))) }), ctx)
    assert.deepEqual(after, before); assert.equal((await s.workspaceDiagnostics()).schemaVersion, 1)
    await s.close(); s = await openTaskStore({ file, workspaceEnabled: false })
    assert.equal((await s.workspaceDiagnostics()).enabled, false)
    assert.deepEqual(await s.harness.snapshot(TaskApprovals, id, ctx), before.approvals)
  } finally { if (s) await s.close(); await rm(dir, { recursive: true, force: true }) }
})

test('V2 diagnostic HTTP authenticates before lookup, rejects identity bodies; no sensitive error details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-01-http-')), s = await openTaskStore({ file: join(dir, 'isolated.sqlite') }), token = 'isolated-token'
  const server = createApiServer({ tasks: s, token }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/api/workspace/status`
  try {
    assert.equal((await fetch(url)).status, 401)
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 200)
    const text = await response.text(); assert.ok(!text.includes(token)); assert.equal(JSON.parse(text).data.sources[0].authorized, true) // ADR-011 owner implicit local access
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ ownerId: 'forged', botId: 'chief', taskId: 1 }) })).status, 405)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await s.close(); await rm(dir, { recursive: true, force: true }) }
})

test('V2 occurrence semantic uniqueness rejects a different id at identical trigger point', async () => withStore(async ({ repo }) => {
  const record = { ...base, id: 'first', scheduleId: 's1', revision: 1, scheduledFor: '2026-10-19T00:00:00.000Z', attempts: 0, state: 'pending' }
  await repo.transaction(tx => repo.put(tx, 'Occurrence', record))
  await assert.rejects(repo.transaction(tx => repo.put(tx, 'Occurrence', { ...record, id: 'second' })), { code: 'WORKSPACE_OCCURRENCE_CONFLICT' })
  await assert.rejects(repo.transaction(tx => repo.put(tx, 'Occurrence', { ...record, revision: 2 })), { code: 'WORKSPACE_OCCURRENCE_CONFLICT' })
  assert.equal((await repo.transaction(tx => repo.list(tx, 'Occurrence', LOCAL_OWNER, 'local'))).items.length, 1)
}))

test('V2 production authority cannot mint agent or background from body-shaped bindings', async () => {
  const authority = createActorAuthority()
  await assert.rejects(authority.agent(1), { code: 'WORKSPACE_ACTOR' })
  await assert.rejects(authority.background(1, probeSchedule('s1', '2026-10-19T00:00:00.000Z')), { code: 'WORKSPACE_ACTOR' })
})

test('V2 background requires a live source and current Bot assignment, not a configuration epoch', async () => withStore(async store => {
  const { repo } = store
  await assignWorkspaceBot(store)
  const binding = { botId: 'calendar', scope: { tools: ['workspace.list', 'workspace.get'], sources: ['local'], actions: ['read'], readScope: 'full' } }
  const authority = createActorAuthority({ resolveAgent: async () => structuredClone(binding) })
  const schedule = { ...probeSchedule('s1', '2026-10-19T00:00:00.000Z'), executionPrincipal: { botId: 'calendar' }, actionSpec: { actions: ['read'] } }
  await assert.rejects(authority.background(42, { ...schedule, enabled: false }), { code: 'WORKSPACE_ACTOR' })
  const actor = await authority.background(42, schedule)
  const read = () => repo.transaction(tx => authority.authorize(repo, tx, actor, 'local', 'read'))
  assert.equal((await read()).readScope, 'full')
  binding.scope.scheduleRevision = 2
  assert.equal((await read()).readScope, 'full')
  await repo.transaction(async tx => { (await tx.doc(ToolAccess)).assignments.calendar.resources = [] })
  await assert.rejects(read(), { code: 'WORKSPACE_FORBIDDEN' })
  await assignWorkspaceBot(store)
  const connection = await repo.transaction(tx => repo.get(tx, 'Connection', LOCAL_OWNER, 'local', 'local'))
  await repo.transaction(tx => repo.put(tx, 'Connection', { ...connection, status: 'inactive' }))
  await assert.rejects(read(), { code: 'WORKSPACE_FORBIDDEN' })
  await repo.transaction(tx => repo.put(tx, 'Connection', connection))
  assert.equal((await read()).readScope, 'full')
}))

test('V2 many sleeping Harness invocations do not starve an actual existing chat Task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-01-chat-'))
  let probe
  try {
    // The probe and real chat use their own isolated single-owner DB, never share
    // an adapter/connection. Same Node event loop demonstrates no blocking sleep;
    // ordinary same-Harness task concurrency is independently tested above.
    probe = await openFoundation(join(dir, 'probe.sqlite'))
    const root = await probe.harness.root(probe.context)
    await probe.repo.transaction(async tx => {
      for (let i = 0; i < 20; i++) {
        await probe.repo.put(tx, 'Schedule', probeSchedule(`sleeper-${i}`, new Date(Date.now() + 60000).toISOString()))
        await tx.createTask(ProbeWakeTask, { sourceId: 'local', id: `sleeper-${i}` }, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true })
      }
    })
    probe.harness.resume()
    const chat = await openTaskStore({ file: join(dir, 'chat.sqlite') })
    try {
      const t = await chat.create({ botId: 'chief' })
      await chat.send(t.taskId, '01无模型聊天并发验收')
      const result = await waitUntil(async () => { const x = await chat.get(t.taskId); return x.messages.some(m => m.content.includes('[测试回复，非模型输出]')) && x })
      assert.ok(result.messages.some(m => m.content.includes('01无模型聊天并发验收')))
    } finally { await chat.close() }
  } finally { if (probe) await probe.close(); await rm(dir, { recursive: true, force: true }) }
})

test('V2 all domain record schemas persist and read back with composite identities', async () => withStore(async ({ repo }) => {
  const samples = {
    Connection: { provider: 'local', accountKey: 'fixture', authEpoch: 0, status: 'active' },
    Source: { connectionId: 'sample', authority: 'local', capabilities: ['read'] },
    Grant: { principalKind: 'bot', subjectId: 'sample', actions: ['read'], readScope: 'busy', epoch: 0 },
    Event: { title: 'sample', start: '2026-10-19', end: '2026-10-20', timezone: 'Asia/Shanghai', version: 1, authority: 'local' },
    Todo: { title: 'sample', status: 'open', version: 1 }, ItemLink: { todoId: 't', eventId: 'e', relation: 'explicit' },
    Operation: { requestId: 'sample', actor: { principalKind: 'user' }, action: 'create', normalizedArgs: {}, payloadHash: 'sample', grantEpoch: 0, state: 'unknown' },
    Outbox: { operationId: 'sample', state: 'pending', dedupeKey: 'sample' },
    Reminder: { targetRef: { type: 'Todo', id: 'sample' }, at: '2026-10-19T00:00:00Z', channel: 'inbox', enabled: false, version: 1, targetVersion: 1 },
    Schedule: probeSchedule('sample', '2026-10-19T00:00:00.000Z'),
    Occurrence: { scheduleId: 'sample', revision: 1, scheduledFor: '2026-10-19T00:00:00.000Z', attempts: 0, state: 'pending' },
    SyncState: { window: { start: '2026-10-19', end: '2026-10-20' }, coverage: 'incomplete', generation: 0 },
    Notification: { dedupeKey: 'sample', itemVersion: 1, status: 'unread', channel: 'inbox' },
    Delivery: { dedupeKey: 'sample', itemVersion: 1, status: 'pending', channel: 'inbox', attempts: 0 },
  }
  for (const [type, fields] of Object.entries(samples)) {
    const record = { ...base, id: type === 'Grant' ? 'bot:sample' : 'sample', ...fields }
    if (type === 'Source') record.sourceId = 'sample'
    await repo.transaction(tx => repo.put(tx, type, record))
    assert.deepEqual(await repo.transaction(tx => repo.get(tx, type, record.ownerId, record.sourceId, record.id)), record)
  }
}))
