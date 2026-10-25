import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { openTaskStore } from './tasks.mjs'
import { createApiServer } from './app.mjs'

const groupInput = { requestId: 'archive-group-001', title: '归档测试群', adminBotId: 'todo', memberBotIds: ['calendar', 'todo'] }

test('archive flag hides only: persisted, idempotent, reversible, no runtime/approval change', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-archive-')), file = join(dir, 'isolated.sqlite')
  let store = await openTaskStore({ file })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const task = await store.create({ botId: 'todo' })
  assert.equal(task.archived, false)
  const before = await store.get(task.taskId)
  const archived = await store.setArchived(task.taskId, { archived: true })
  assert.equal(archived.archived, true)
  assert.equal((await store.setArchived(task.taskId, { archived: true })).archived, true)
  // Hiding never cancels, deletes or rewrites approvals/permissions.
  assert.equal(archived.runtime?.status ?? archived.status, before.runtime?.status ?? before.status)
  assert.deepEqual(archived.approvals, before.approvals)
  assert.deepEqual(archived.parameters, before.parameters)
  assert.equal(archived.cancellation, before.cancellation)
  assert.equal((await store.list()).length, 1)
  await store.close(); store = await openTaskStore({ file })
  assert.equal((await store.get(task.taskId)).archived, true)
  assert.equal((await store.setArchived(task.taskId, { archived: false })).archived, false)
  for (const bad of [null, {}, { archived: 'yes' }, { archived: true, extra: 1 }, []]) await assert.rejects(store.setArchived(task.taskId, bad), { code: 'INVALID_ARCHIVE' })
  await assert.rejects(store.setArchived(9999, { archived: true }), { code: 'TASK_NOT_FOUND' })
})

test('archive HTTP route: auth, method, task and group binding', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-archive-http-'))
  const store = await openTaskStore({ file: join(dir, 'isolated.sqlite') }), token = 'archive-fixture-token-not-for-production'
  const server = createApiServer({ token, tasks: store }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); server.close(); await store.close(); await rm(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const req = (path, method = 'POST', body) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const task = await store.create({ botId: 'todo' })
  assert.equal((await fetch(`${base}/api/tasks/${task.taskId}/archive`, { method: 'POST', body: '{"archived":true}' })).status, 401)
  assert.equal((await req(`/api/tasks/${task.taskId}/archive`, 'GET')).status, 405)
  let res = await req(`/api/tasks/${task.taskId}/archive`, 'POST', { archived: 1 }); assert.equal(res.status, 400); assert.equal((await res.json()).error.code, 'INVALID_ARCHIVE')
  res = await req(`/api/tasks/${task.taskId}/archive`, 'POST', { archived: true }); assert.equal(res.status, 200); assert.equal((await res.json()).task.archived, true)
  assert.equal((await req('/api/tasks/9999/archive', 'POST', { archived: true })).status, 404)
  res = await req(`/api/bots/todo/tasks/${task.taskId}/archive`, 'POST', { archived: false }); assert.equal(res.status, 200); assert.equal((await res.json()).task.archived, false)
  const { group, task: groupTask } = await store.createGroup(groupInput)
  res = await req(`/api/groups/${group.groupId}/archive`, 'POST', { archived: true }); assert.equal(res.status, 200)
  assert.equal((await store.get(groupTask.taskId)).archived, true)
  assert.equal((await req(`/api/groups/${crypto.randomUUID()}/archive`, 'POST', { archived: true })).status, 404)
  // A task that is not a child of this group cannot be reached through the child route.
  assert.equal((await req(`/api/groups/${group.groupId}/children/${task.taskId}/archive`, 'POST', { archived: true })).status, 404)
})
