import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActorAuthority } from './workspace-policy.mjs'
import { createWorkspaceService } from './workspace-service.mjs'
import { openFoundation } from './fixtures/workspace-foundation.mjs'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'

const grantInput = { requestId: 'grant-on', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true }
const event = { title: '专用本地日程', description: '不应泄漏的正文', start: '2026-10-20T09:00:00+08:00', end: '2026-10-20T10:00:00+08:00', timezone: 'Asia/Shanghai' }
const command = (type, requestId, data) => ({ sourceId: 'local', type, action: 'create', requestId, data })
const read = (type, extra = {}) => ({ sourceId: 'local', type, ...extra })
const error = code => e => e.code === code
async function fixture(fn, authorize = true) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-02-')), file = join(dir, 'isolated.sqlite')
  const s = await openFoundation(file), authority = createActorAuthority(), actor = authority.user(), service = createWorkspaceService({ repository: s.repo, authority })
  try { if (authorize) await service.manageLocalGrant(actor, grantInput); await fn({ ...s, authority, actor, service, dir, file }) } finally { await s.close(); await rm(dir, { recursive: true, force: true }) }
}
const mutate = (type, requestId, old, data) => ({ ...read(type), requestId, action: 'update', id: old.id, expectedVersion: old.version, data })
const erase = (type, requestId, old) => ({ ...read(type), requestId, action: 'delete', id: old.id, expectedVersion: old.version, confirmedDelete: true })
const one = async (service, actor, type, op) => (await service.getLocalItem(actor, { ...read(type), id: op.receipt.target.id })).items[0]

test('02 owner local access is implicit (ADR-011): no consent step, cannot be revoked, enable stays idempotent, never grants Bots', async () => fixture(async ({ service, actor, repo, authority }) => {
  const status = (await service.diagnostics(actor)).sources[0]
  assert.equal(status.authorized, true); assert.equal(status.grantEpoch, 0)
  assert.deepEqual((await service.query(actor, read('Todo'))).items, [])
  await assert.rejects(service.manageLocalGrant(actor, { ...grantInput, confirmed: false }), error('WORKSPACE_GRANT'))
  await assert.rejects(service.manageLocalGrant(actor, { ...grantInput, requestId: 'off', enabled: false }), error('WORKSPACE_OWNER_IMPLICIT'))
  const op = await service.manageLocalGrant(actor, grantInput)
  assert.deepEqual(await service.manageLocalGrant(actor, grantInput), op)
  await assert.rejects(service.manageLocalGrant(actor, { ...grantInput, requestId: 'stale' }), error('WORKSPACE_VERSION_CONFLICT'))
  assert.equal((await repo.transaction(tx => repo.list(tx, 'Grant', actor.ownerId, 'local'))).items.length, 1)
  await assert.rejects(authority.agent(1), error('WORKSPACE_ACTOR'))
  assert.deepEqual((await service.getLocalItem(actor, { ...read('Todo'), id: 'unseen' })).items, [])
}, false))

test('02 Event full CRUD and Todo edit/complete/reopen/delete persist versions with receipts and outbox', async () => fixture(async ({ service, actor, repo }) => {
  const e = await service.executeLocal(actor, command('Event', 'e1', event))
  let ev = await one(service, actor, 'Event', e)
  assert.equal(ev.start, '2026-10-20T01:00:00.000Z'); assert.equal(ev.authority, 'local')
  const update = await service.executeLocal(actor, mutate('Event', 'e2', ev, { title: '改期', start: '2026-10-21T09:00:00+08:00', end: '2026-10-21T10:00:00+08:00' }))
  ev = await one(service, actor, 'Event', update); assert.equal(ev.version, 2)
  await service.executeLocal(actor, erase('Event', 'e3', ev))
  assert.ok((await one(service, actor, 'Event', e)).deletedAt)
  const t = await service.executeLocal(actor, command('Todo', 't1', { title: '无截止待办' }))
  let todo = await one(service, actor, 'Todo', t); assert.equal(todo.due, null); assert.equal(todo.status, 'open')
  for (const [i, data] of [{ title: '有截止待办', due: '2026-10-23' }, { status: 'completed' }, { status: 'open' }].entries()) {
    await service.executeLocal(actor, mutate('Todo', `tu${i}`, todo, data)); todo = await one(service, actor, 'Todo', t)
    assert.equal(todo.version, i + 2)
  }
  assert.equal(todo.due, '2026-10-23'); assert.equal(todo.status, 'open')
  await service.executeLocal(actor, erase('Todo', 'td', todo))
  const deleted = await one(service, actor, 'Todo', t); assert.ok(deleted.deletedAt); assert.equal(deleted.version, 5)
  await assert.rejects(service.executeLocal(actor, mutate('Todo', 'revive', deleted, { status: 'open' })), error('WORKSPACE_VERSION_CONFLICT'))
  const operations = await repo.transaction(tx => repo.list(tx, 'Operation', actor.ownerId, 'operations'))
  const outbox = await repo.transaction(tx => repo.list(tx, 'Outbox', actor.ownerId, 'local'))
  assert.equal(operations.items.length, 9); assert.equal(outbox.items.length, 8)
  assert.ok(outbox.items.every(o => operations.items.some(op => op.id === o.operationId && op.state === 'succeeded')))
  assert.deepEqual(await service.getLocalOperation(actor, { requestId: 'e1', sourceId: 'local' }), e)
}))

test('02 date ranges, impossible dates, offset/IANA timezone, recurrence, all-day, fields and invalid commands rejected', async () => fixture(async ({ service, actor }) => {
  const bad = [{ ...event, start: event.end }, { ...event, end: '2026-10-20T08:00:00+08:00' }, { ...event, start: '2026-02-30T09:00:00+08:00' }, { ...event, start: '2026-10-20T24:00:00Z' }, { ...event, start: '2026-10-20T09:00:00' }, { ...event, timezone: '+08:00' }, { ...event, timezone: 'Invalid/Zone' }, { ...event, recurrence: 'FREQ=DAILY' }, { ...event, start: '2026-10-20', end: '2026-10-21' }, { ...event, title: ' ' }]
  for (const [n, data] of bad.entries()) await assert.rejects(service.executeLocal(actor, command('Event', `bad${n}`, data)))
  for (const due of ['2026-02-30', '2026-13-01', 'nonsense', '2026-10-20T09:00:00', {}]) await assert.rejects(service.executeLocal(actor, command('Todo', 'bad-due', { title: 'x', due })))
  for (const data of [{ title: 'x', timezone: 'foo/bar' }, { title: 'x', status: 'running' }, { title: 'x', ownerId: 'else' }]) await assert.rejects(service.executeLocal(actor, command('Todo', 'bad-todo', data)))
  await assert.rejects(service.executeLocal(actor, { ...command('Todo', 'inject', { title: 'x' }), taskId: 1 }))
  assert.deepEqual((await service.query(actor, read('Todo'))).items, [])
  assert.deepEqual((await service.query(actor, read('Event'))).items, [])
}))

test('02 expectedVersion racing updates never overwrite; concurrent same request only one receipt, ID reuse differs returns 409', async () => fixture(async ({ service, actor, repo }) => {
  const input = command('Todo', 'double', { title: '原值' })
  const [a, b] = await Promise.all([service.executeLocal(actor, input), service.executeLocal(actor, input)])
  assert.deepEqual(a, b); assert.equal((await service.query(actor, read('Todo'))).items.length, 1)
  const old = await one(service, actor, 'Todo', a)
  const updates = await Promise.allSettled(['A', 'B'].map(title => service.executeLocal(actor, mutate('Todo', title, old, { title }))))
  assert.equal(updates.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(updates.find(x => x.status === 'rejected').reason.code, 'WORKSPACE_VERSION_CONFLICT')
  const latest = await one(service, actor, 'Todo', a); assert.equal(latest.version, 2)
  await assert.rejects(service.executeLocal(actor, { ...input, data: { title: '异参' } }), error('WORKSPACE_REQUEST_CONFLICT'))
  await assert.rejects(service.executeLocal(actor, { ...erase('Todo', 'no-confirm', latest), confirmedDelete: false }), error('WORKSPACE_CONFIRMATION_REQUIRED'))
  await assert.rejects(service.executeLocal(actor, { ...mutate('Todo', 'no-version', latest, { title: 'oops' }), expectedVersion: undefined }), error('WORKSPACE_VERSION'))
  assert.equal((await repo.transaction(tx => repo.list(tx, 'Outbox', actor.ownerId, 'local'))).items.length, 2)
}))

test('02 explicit links preserve counterpart and tombstone history; cross-source references cannot be used', async () => fixture(async ({ service, actor, repo }) => {
  const t = await service.executeLocal(actor, command('Todo', 'link-t', { title: '同名' }))
  const e = await service.executeLocal(actor, command('Event', 'link-e', { ...event, title: '同名' }))
  assert.equal((await service.query(actor, read('ItemLink'))).items.length, 0)
  const link = command('ItemLink', 'link', { todoId: t.receipt.target.id, eventId: e.receipt.target.id, relation: 'related' })
  await service.executeLocal(actor, link)
  const todo = await one(service, actor, 'Todo', t), ev = await one(service, actor, 'Event', e)
  await service.executeLocal(actor, mutate('Todo', 'complete-linked', todo, { status: 'completed' }))
  assert.equal((await one(service, actor, 'Event', e)).version, 1)
  await service.executeLocal(actor, erase('Event', 'del-linked', ev))
  const result = (await service.query(actor, read('ItemLink'))).items[0]
  assert.equal(result.todoState, 'completed'); assert.equal(result.eventState, 'deleted')
  assert.equal((await one(service, actor, 'Todo', t)).deletedAt, null)
  await assert.rejects(service.executeLocal(actor, { ...link, requestId: 'relink-deleted' }), error('WORKSPACE_LINK_TARGET'))
  await repo.transaction(tx => repo.put(tx, 'Event', { schemaVersion: 1, ownerId: actor.ownerId, sourceId: 'secret', id: 'foreign', ...event, authority: 'local', version: 1 }))
  await assert.rejects(service.executeLocal(actor, { ...link, requestId: 'foreign-link', data: { ...link.data, eventId: 'foreign' } }), error('WORKSPACE_LINK_TARGET'))
}))

test('02 owner access ignores lowered stored user grant (ADR-011); unknown sources still denied', async () => fixture(async ({ service, actor, repo, authority }) => {
  const op = await service.executeLocal(actor, command('Todo', 'private', { title: 'secret-todo' }))
  await service.executeLocal(actor, command('Event', 'private-event', event))
  const g = await repo.transaction(tx => repo.get(tx, 'Grant', actor.ownerId, 'local', 'user:authenticated-user'))
  await repo.transaction(tx => repo.put(tx, 'Grant', { ...g, actions: [], readScope: 'none', epoch: 2 }))
  assert.equal((await service.getLocalItem(actor, { ...read('Todo'), id: op.receipt.target.id })).items[0].title, 'secret-todo')
  assert.equal((await service.executeLocal(actor, command('Todo', 'still-ok', { title: 'x' }))).state, 'succeeded')
  assert.equal((await service.diagnostics(actor)).sources[0].grantEpoch, 2)
  await assert.rejects(service.query({ ...actor }, read('Todo')), error('WORKSPACE_ACTOR'))
  for (const sourceId of ['secret', 'missing']) await assert.rejects(service.getLocalItem(actor, { type: 'Todo', sourceId, id: 'absent' }), error('WORKSPACE_FORBIDDEN'))
  assert.ok(authority.user())
}))

test('02 rollback injected after object/outbox but before operation leaves no half-commit', async () => fixture(async ({ actor, repo, authority }) => {
  const proxy = { ...repo, async put(tx, type, record) { if (type === 'Operation' && record.action === 'create') throw new Error('isolated transaction interruption'); return repo.put(tx, type, record) } }
  const service = createWorkspaceService({ repository: proxy, authority })
  await assert.rejects(service.executeLocal(actor, command('Todo', 'rollback', { title: 'must-not-exist' })), /interruption/)
  for (const [type, source] of [['Todo', 'local'], ['Outbox', 'local'], ['Operation', 'operations']]) {
    const p = await repo.transaction(tx => repo.list(tx, type, actor.ownerId, source))
    assert.equal(p.items.length, type === 'Operation' ? 1 : 0)
  }
}))

test('02 local CRUD restart keeps completion versions deletion links grant and receipts; no Task or model required', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-02-restart-')), file = join(dir, 'isolated.sqlite')
  let s = await openTaskStore({ file, modelReply: async () => { throw new Error('model must never run') } })
  try {
    await s.workspace.manageLocalGrant(grantInput)
    const t = await s.workspace.executeLocal(command('Todo', 'restart-t', { title: 'restart' }))
    const e = await s.workspace.executeLocal(command('Event', 'restart-e', event))
    await s.workspace.executeLocal({ ...read('ItemLink'), action: 'create', requestId: 'restart-link', data: { todoId: t.receipt.target.id, eventId: e.receipt.target.id, relation: 'related' } })
    const todo = (await s.workspace.query(read('Todo'))).items[0], ev = (await s.workspace.query(read('Event'))).items[0]
    await s.workspace.executeLocal(mutate('Todo', 'restart-complete', todo, { status: 'completed' }))
    await s.workspace.executeLocal(erase('Event', 'restart-delete', ev))
    const before = await Promise.all(['Todo', 'Event', 'ItemLink'].map(type => s.workspace.query(read(type))))
    await s.close(); s = await openTaskStore({ file, modelReply: async () => { throw new Error('model must never run') } })
    const after = await Promise.all(['Todo', 'Event', 'ItemLink'].map(type => s.workspace.query(read(type))))
    assert.deepEqual(after.map(p => p.items), before.map(p => p.items))
    assert.deepEqual(await s.workspace.getLocalOperation({ requestId: 'restart-t', sourceId: 'local' }), t)
    assert.equal((await s.workspaceDiagnostics()).sources[0].authorized, true)
  } finally { await s.close(); await rm(dir, { recursive: true, force: true }) }
})

test('02 authenticated HTTP methods strict inputs and receipts use production service without Task/model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-02-http-'))
  let modelCalls = 0
  const tasks = await openTaskStore({ file: join(dir, 'isolated.sqlite'), modelReply: async () => { modelCalls++; throw new Error('not permitted') } })
  const server = createApiServer({ tasks, token: 'isolated-v2-02' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/api/workspace/`
  const request = (path, data, auth = true) => fetch(url + path, { method: data ? 'POST' : 'GET', headers: { ...(auth ? { authorization: 'Bearer isolated-v2-02' } : {}), 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) })
  try {
    assert.equal((await request('status', undefined, false)).status, 401)
    assert.equal((await request('query', read('Todo'))).status, 200) // ADR-011 no consent step
    assert.equal((await request('grant', { ...grantInput, requestId: 'grant-off', enabled: false })).status, 400)
    assert.equal((await request('grant', grantInput)).status, 200)
    const input = command('Todo', 'http-t', { title: 'HTTP持久事项' })
    const response = await request('command', input); assert.equal(response.status, 200)
    const op = (await response.json()).data
    assert.equal(op.state, 'succeeded')
    assert.equal((await request('command', { ...input, actor: { principalKind: 'user' } })).status, 400)
    assert.equal((await request('get', { ...read('Todo'), id: op.receipt.target.id })).status, 200)
    assert.equal((await request('operation', { sourceId: 'local', requestId: 'http-t' })).status, 200)
    assert.equal((await request('query', { ...read('Todo'), limit: 101 })).status, 400)
    assert.equal((await request('command')).status, 405)
    assert.equal((await request('query', read('Event'))).status, 200)
    assert.equal(modelCalls, 0)
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); await tasks.close(); await rm(dir, { recursive: true, force: true }) }
})


test('02 SIGKILL before Operation rolls back object/outbox; after commit retry returns one durable receipt', async () => {
  for (const mode of ['before-operation', 'after-commit']) {
    const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-02-kill-')), file = join(dir, 'isolated.sqlite')
    const child = spawn(process.execPath, ['server/fixtures/workspace-local-crash.mjs', file, mode], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stderr.on('data', data => { errors += data })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`crash worker timeout ${errors}`)), 10000)
        child.stdout.on('data', data => { output += data; if (output.includes('point')) { clearTimeout(timer); resolve() } })
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`worker exited ${code}: ${errors}`)) })
      })
      child.kill('SIGKILL'); const [, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL')
      const s = await openFoundation(file), authority = createActorAuthority(), actor = authority.user(), service = createWorkspaceService({ repository: s.repo, authority })
      try {
        const items = (await service.query(actor, read('Todo'))).items
        assert.equal(items.length, mode === 'before-operation' ? 0 : 1)
        assert.equal((await s.repo.transaction(tx => s.repo.list(tx, 'Outbox', actor.ownerId, 'local'))).items.length, items.length)
        const prior = await service.getLocalOperation(actor, { sourceId: 'local', requestId: 'crash-create' })
        assert.equal(prior === null, mode === 'before-operation')
        const op = await service.executeLocal(actor, command('Todo', 'crash-create', { title: 'crash durable' }))
        if (prior) assert.deepEqual(op, prior)
        assert.equal((await service.query(actor, read('Todo'))).items.length, 1)
        assert.equal((await s.repo.transaction(tx => s.repo.list(tx, 'Outbox', actor.ownerId, 'local'))).items.length, 1)
        console.log(JSON.stringify({ mode, signal, point: JSON.parse(output.trim()).point, recovery: 'one object and receipt', modelCalls: 0 }))
      } finally { await s.close() }
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }) }
  }
})

test('02 paginated service includes deleted records without gaps; source capabilities independently deny CRUD (owner grant is implicit, ADR-011)', async () => fixture(async ({ service, actor, repo }) => {
  for (let i = 0; i < 106; i++) await service.executeLocal(actor, command('Todo', `page${i}`, { title: `item${i}` }))
  let cursor = 0; const all = []
  while (cursor !== undefined) { const page = await service.query(actor, read('Todo', { cursor, limit: 37 })); all.push(...page.items); cursor = page.next; assert.equal(page.complete, cursor === undefined) }
  assert.equal(all.length, 106); assert.equal(new Set(all.map(i => i.id)).size, 106)
  const source = await repo.transaction(tx => repo.get(tx, 'Source', actor.ownerId, 'local', 'local'))
  for (const action of ['create', 'update', 'delete', 'read']) {
    await repo.transaction(tx => repo.put(tx, 'Source', { ...source, capabilities: source.capabilities.filter(a => a !== action) }))
    const request = action === 'create' ? command('Todo', 'deny-create', { title: 'denied' }) : action === 'delete' ? erase('Todo', 'deny-delete', all[0]) : mutate('Todo', 'deny-update', all[0], { title: 'denied' })
    await assert.rejects(service.executeLocal(actor, request), error('WORKSPACE_FORBIDDEN'))
    if (action === 'read') {
      await assert.rejects(service.query(actor, read('Todo')), error('WORKSPACE_FORBIDDEN'))
      await assert.rejects(service.getLocalOperation(actor, { sourceId: 'local', requestId: 'page0' }), error('WORKSPACE_FORBIDDEN'))
    }
  }
}))
