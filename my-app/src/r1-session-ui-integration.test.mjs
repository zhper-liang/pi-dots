import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApiServer } from '../server/app.mjs'
import { openTaskStore } from '../server/tasks.mjs'
import { createSessionActionHandlers, removeSessionState, replaceMainSession, SessionActionRecoveryError } from './session-lifecycle-client.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pidot-session-ui-'))
  const token = randomUUID()
  const store = await openTaskStore({ file: join(directory, 'tasks.sqlite'), workspaceEnabled: false, calendarQueryEnabled: false })
  const server = createApiServer({ token, tasks: store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await store.close()
    await rm(directory, { recursive: true, force: true })
  })
  const requests = []
  async function request(path, init = { method: 'GET' }) {
    requests.push({ path, ...init })
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    })
    const body = await response.json()
    if (!response.ok) throw Object.assign(new Error(body.error.message), { status: response.status, code: body.error.code })
    return body
  }
  return { store, request, requests }
}
const input = () => ({ requestId: randomUUID(), confirmed: true })
const targetFor = (task, kind = 'session') => ({ taskId: task.taskId, botId: task.bot.id, title: task.title, kind })

function evictedCaches(taskId, replacementTaskId) {
  for (const values of [
    { [taskId]: 'old draft', 999: 'keep other draft' },
    { [taskId]: { start: 7, end: 9 }, 999: { start: 1, end: 1 } },
    { [taskId]: [{ botId: 'calendar' }], 999: [] },
    { [taskId]: ['calendar'], 999: ['todo'] },
    { [taskId]: { id: 'old-skill' }, 999: { id: 'keep-skill' } },
    { [taskId]: { id: 'old-model' }, 999: { id: 'keep-model' } },
  ]) {
    const before = structuredClone(values)
    const next = removeSessionState(values, taskId)
    assert.equal(Object.hasOwn(next, taskId), false)
    assert.deepEqual(next[999], values[999])
    if (replacementTaskId !== null) assert.equal(Object.hasOwn(next, replacementTaskId), false)
    assert.deepEqual(values, before)
  }
}

test('App session action client deletes through production HTTP and evicts only the confirmed old Task state', async t => {
  const f = await fixture(t)
  const task = await f.store.create({ botId: 'calendar' })
  const survivor = await f.store.create({ botId: 'todo' })
  const target = targetFor(task), command = input()
  const handlers = createSessionActionHandlers(f.request)
  const receipt = await handlers.action(target, command)
  assert.equal(receipt.action, 'delete')
  assert.equal(receipt.taskId, task.taskId)
  assert.equal(f.requests[0].path, `/api/tasks/${task.taskId}/delete`)
  assert.equal(f.requests[0].method, 'POST')
  assert.deepEqual(JSON.parse(f.requests[0].body), command)
  evictedCaches(receipt.taskId, receipt.replacementTaskId)
  await assert.rejects(f.request(`/api/tasks/${task.taskId}`), { status: 410, code: 'SESSION_DELETED' })
  const listed = (await f.request('/api/tasks')).tasks
  assert.equal(listed.some(item => item.taskId === task.taskId), false)
  assert.equal(listed.some(item => item.taskId === survivor.taskId), true)
  assert.equal((await handlers.verify(target, command)).taskId, receipt.taskId)
  const mains = { calendar: 10 }
  assert.equal(replaceMainSession(mains, receipt), mains)
})

test('App clear-main client switches the current mapping without moving old context or other Tasks', async t => {
  const f = await fixture(t)
  const before = await f.request('/api/bots')
  const oldId = before.mainSessions.calendar
  const old = (await f.request(`/api/tasks/${oldId}`)).task
  await f.store.send(oldId, 'old-main-context-sentinel')
  const survivor = await f.store.create({ botId: 'calendar', title: 'keep separate work' })
  const target = targetFor(old, 'main'), command = input()
  const handlers = createSessionActionHandlers(f.request)
  const receipt = await handlers.action(target, command)
  assert.equal(receipt.action, 'clear-main')
  assert.notEqual(receipt.replacementTaskId, oldId)
  assert.ok(f.requests.some(item => item.path === `/api/tasks/${oldId}/clear-main` && item.method === 'POST'))
  const nextMappings = replaceMainSession(before.mainSessions, receipt)
  assert.equal(nextMappings.calendar, receipt.replacementTaskId)
  assert.equal(nextMappings.chief, before.mainSessions.chief)
  assert.equal(before.mainSessions.calendar, oldId)
  evictedCaches(oldId, receipt.replacementTaskId)
  const fresh = (await f.request(`/api/tasks/${receipt.replacementTaskId}`)).task
  assert.equal(fresh.bot.id, old.bot.id)
  assert.notEqual(fresh.conversationId, old.conversationId)
  assert.equal(fresh.messages.some(message => message.content.includes('old-main-context-sentinel')), false)
  assert.equal((await f.request('/api/bots')).mainSessions.calendar, receipt.replacementTaskId)
  assert.equal((await f.request(`/api/tasks/${survivor.taskId}`)).task.taskId, survivor.taskId)
  await assert.rejects(f.request(`/api/tasks/${oldId}`), { status: 410, code: 'SESSION_DELETED' })
  assert.equal((await handlers.verify(target, command)).replacementTaskId, receipt.replacementTaskId)
})

test('App unknown mutation outcome verifies the original request by GET without a second POST or optimistic eviction', async t => {
  const f = await fixture(t)
  const task = await f.store.create({ botId: 'calendar' }), target = targetFor(task), command = input()
  const state = { tasks: [task], drafts: { [task.taskId]: 'keep until verified' } }
  const handlers = createSessionActionHandlers(async (path, init) => {
    const body = await f.request(path, init)
    if (init.method === 'POST') throw new Error('response lost after server commit')
    return body
  })
  await assert.rejects(handlers.action(target, command), /response lost/)
  assert.equal(state.tasks[0].taskId, task.taskId)
  assert.equal(state.drafts[task.taskId], 'keep until verified')
  const receipt = await handlers.verify(target, command)
  assert.equal(receipt.taskId, task.taskId)
  assert.equal(receipt.requestId, command.requestId)
  assert.deepEqual(f.requests.map(item => item.method), ['POST', 'GET'])
  assert.equal(f.requests[1].path, `/api/session-requests/${command.requestId}`)
  assert.equal(f.requests[1].body, undefined)
  state.tasks = state.tasks.filter(item => item.taskId !== receipt.taskId)
  state.drafts = removeSessionState(state.drafts, receipt.taskId)
  assert.deepEqual(state, { tasks: [], drafts: {} })
})

test('App verification rejects pending, failed, mismatched and unconfirmed receipts without resubmitting', async () => {
  const target = { taskId: 4, botId: 'calendar', title: 'target', kind: 'session' }, command = input()
  const receipt = { taskId: 4, botId: 'calendar', requestId: command.requestId, action: 'delete', deleted: true,
    deletedAt: '2026-10-29T01:00:00Z', replacementTaskId: null, replayed: false }
  for (const data of [
    { state: 'pending', taskId: 4, action: 'delete', result: receipt },
    { state: 'unknown', taskId: 4, action: 'delete', result: receipt },
    { state: 'failed', taskId: 4, action: 'delete', result: receipt },
    { state: 'succeeded', taskId: 5, action: 'delete', result: receipt },
    { state: 'succeeded', taskId: 4, action: 'clear-main', result: receipt },
    { state: 'succeeded', taskId: 4, action: 'delete', result: { ...receipt, requestId: 'other-request' } },
  ]) {
    const calls = []
    const handlers = createSessionActionHandlers(async (path, init) => { calls.push({ path, ...init }); return { data } })
    if (['failed', 'unknown'].includes(data.state)) await assert.rejects(handlers.verify(target, command), error => error instanceof SessionActionRecoveryError && error.retryable)
    else assert.equal(await handlers.verify(target, command), null)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].body, undefined)
  }
  const accepted = createSessionActionHandlers(async () => ({ data: { accepted: true } }))
  await assert.rejects(accepted.action(target, command), /结果未确认/)
})
