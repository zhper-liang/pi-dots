import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore, TaskCard, ChatTask, ChatInput } from './tasks.mjs'
import { createApiServer } from './app.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { listBots } from './bots.mjs'
import { readLifecycleSession } from './session-lifecycle.mjs'
import { TaskInputError } from './task-config.mjs'
import { COLLABORATION_TOOLS } from './collaboration-tools.mjs'
import { Collaboration, collaborationService } from './collaboration.mjs'

// Production API server and store, isolated SQLite only. No custom lifecycle HTTP adapter.
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-r1-production-session-'))
  const storeOptions = { file: join(dir, 'isolated.sqlite'), workspaceEnabled: false, calendarQueryEnabled: false, ...options }
  let store = await openTaskStore(storeOptions), server
  const start = async () => {
    server = createApiServer({ token: 'isolated-r1-session-token', tasks: store })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  }
  const stop = async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await store.close()
  }
  await start()
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }) })
  const call = async (path, { method = 'GET', body, auth = true } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { ...(auth ? { Authorization: 'Bearer isolated-r1-session-token' } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  return { call, get store() { return store },
    restart: async () => { await stop(); store = await openTaskStore(storeOptions); await start() } }
}
const request = requestId => ({ requestId, confirmed: true })
const deleted = error => error.status === 410 && error.code === 'SESSION_DELETED'

test('session list can include Bot main conversations and retains their latest message', async t => {
  const f = await fixture(t)
  const main = (await f.store.mainSessions()).calendar
  await f.store.send(main, '主会话里的历史')
  assert.equal((await f.call('/api/tasks')).body.tasks.some(task => task.taskId === main), false)
  const listed = await f.call('/api/tasks?includeMain=1')
  assert.equal(listed.status, 200)
  const row = listed.body.tasks.find(task => task.taskId === main)
  assert.equal(row.kind, 'main')
  assert.ok(row.lastMessage?.content)
  const detail = await f.call(`/api/tasks/${main}`)
  assert.ok(detail.body.task.messages.some(message => message.content === '主会话里的历史'))
})

test('production HTTP delete is authenticated, persistent, replayable and hidden from list/detail/send', async t => {
  const f = await fixture(t)
  const created = await f.call('/api/tasks', { method: 'POST', body: { botId: 'calendar', title: 'delete target' } })
  assert.equal(created.status, 201)
  const id = created.body.task.taskId, path = `/api/tasks/${id}`, input = request('production-delete')
  const other = await f.store.create({ botId: 'todo' })
  assert.equal((await f.call(`${path}/delete`, { method: 'POST', body: input, auth: false })).status, 401)
  assert.equal((await f.call(path)).status, 200)
  const first = await f.call(`${path}/delete`, { method: 'POST', body: input })
  assert.equal(first.status, 200)
  assert.equal(first.body.data.deleted, true)
  assert.equal(first.body.data.taskId, id)
  assert.equal((await f.call(path)).body.error.code, 'SESSION_DELETED')
  assert.equal((await f.call(`${path}/messages`, { method: 'POST', body: { message: 'cannot resume' } })).status, 410)
  await assert.rejects(f.store.send(id, 'cannot resume internally'), deleted)
  assert.equal((await f.call('/api/tasks')).body.tasks.some(task => task.taskId === id), false)
  assert.equal((await f.call('/api/tasks')).body.tasks.some(task => task.taskId === other.taskId), true)
  const replay = await f.call(`${path}/delete`, { method: 'POST', body: input })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.data.replayed, true)
  assert.equal(replay.body.data.deletedAt, first.body.data.deletedAt)
  const status = await f.call('/api/session-requests/production-delete')
  assert.equal(status.body.data.state, 'succeeded')
  assert.equal(status.body.data.result.taskId, id)
  assert.equal((await f.call('/api/session-requests/production-delete', { auth: false })).status, 401)
  await f.restart()
  assert.equal((await f.call(path)).status, 410)
  assert.equal((await f.call('/api/tasks')).body.tasks.some(task => task.taskId === id), false)
  assert.equal((await f.call(`${path}/delete`, { method: 'POST', body: input })).body.data.replayed, true)
  assert.equal((await f.call('/api/session-requests/production-delete')).body.data.state, 'succeeded')
})

test('production HTTP requires explicit confirmation, preserves request conflicts, and does not alias archive/main clear', async t => {
  const f = await fixture(t), a = await f.store.create({ botId: 'calendar' }), b = await f.store.create({ botId: 'calendar' })
  const path = `/api/tasks/${a.taskId}/delete`
  assert.equal((await f.call(path, { method: 'POST', body: { requestId: 'no-confirm' } })).status, 400)
  assert.equal((await f.call(path)).status, 405)
  assert.equal((await f.call('/api/session-requests/not-found')).status, 404)
  await f.store.setArchived(a.taskId, { archived: true })
  assert.equal((await f.store.get(a.taskId)).archived, true)
  assert.equal((await f.call(path, { method: 'POST', body: request('shared-delete-id') })).status, 200)
  assert.equal((await f.call(`/api/tasks/${b.taskId}/delete`, { method: 'POST', body: request('shared-delete-id') })).body.error.code, 'SESSION_REQUEST_CONFLICT')
  const main = (await f.store.mainSessions()).chief
  assert.equal((await f.call(`/api/tasks/${main}/delete`, { method: 'POST', body: request('wrong-main-delete') })).body.error.code, 'SESSION_ACTION_CONFLICT')
  assert.equal((await f.call(`/api/tasks/${main}`)).status, 200)
})

test('production HTTP stops an in-flight ordinary invocation before hiding without restoring late results', async t => {
  let started = false, release
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { reply: async () => { started = true; await gate; return { role: 'assistant', content: 'late fixture result' } } })
  t.after(() => release())
  const task = await f.store.create({ botId: 'calendar' })
  await f.store.send(task.taskId, 'start fixture work')
  for (let n = 0; n < 100 && !started; n++) await delay(5)
  assert.equal(started, true)
  try {
    const result = await f.call(`/api/tasks/${task.taskId}/delete`, { method: 'POST', body: request('running-production-delete') })
    assert.equal(result.status, 200)
    assert.equal(result.body.data.deleted, true)
  } finally { release() }
  await delay(20)
  assert.equal((await f.call(`/api/tasks/${task.taskId}`)).status, 410)
  assert.equal((await f.call('/api/tasks')).body.tasks.some(item => item.taskId === task.taskId), false)
})


async function until(read, ready) {
  let value
  for (let n = 0; n < 400; n++) { value = await read(); if (ready(value)) return value; await delay(5) }
  assert.fail(`production session state did not settle: ${JSON.stringify(value?.runtime ?? null)}`)
}
const idle = task => task.activeInputId === null && task.queueLength === 0 && task.runtime.checkpoint?.phase === 'awaitInput'

test('production HTTP clear-main atomically replaces context, hides old main and replays the same replacement after restart', async t => {
  const f = await fixture(t), mainId = (await f.store.mainSessions()).chief
  await f.store.send(mainId, 'old private main context')
  const old = await until(() => f.store.get(mainId), idle)
  const ordinary = await f.store.create({ botId: 'chief' }), path = `/api/tasks/${mainId}/clear-main`, input = request('production-clear-main')
  assert.equal((await f.call(path, { method: 'POST', body: input, auth: false })).status, 401)
  assert.equal((await f.call(path)).status, 405)
  assert.equal((await f.call(path, { method: 'POST', body: { requestId: 'unconfirmed-clear' } })).status, 400)
  assert.equal((await f.call(`/api/tasks/${ordinary.taskId}/clear-main`, { method: 'POST', body: request('ordinary-cannot-clear') })).body.error.code, 'SESSION_ACTION_CONFLICT')
  const [first, repeated] = await Promise.all([f.call(path, { method: 'POST', body: input }), f.call(path, { method: 'POST', body: input })])
  assert.equal(first.status, 200); assert.equal(repeated.status, 200)
  const result = first.body.data
  assert.equal(result.action, 'clear-main'); assert.equal(result.deleted, true); assert.equal(result.botId, 'chief')
  assert.notEqual(result.replacementTaskId, mainId)
  assert.equal(repeated.body.data.replacementTaskId, result.replacementTaskId)
  assert.equal(repeated.body.data.deletedAt, result.deletedAt)
  assert.equal((await f.store.mainSessions()).chief, result.replacementTaskId)
  const fresh = await f.store.get(result.replacementTaskId)
  assert.equal(fresh.kind, 'main'); assert.equal(fresh.bot.id, 'chief')
  assert.notEqual(fresh.conversationId, old.conversationId)
  assert.deepEqual(fresh.messages, [])
  assert.equal((await f.call(`/api/tasks/${mainId}`)).status, 410)
  await assert.rejects(f.store.send(mainId, 'old main must stay hidden'), deleted)
  assert.equal((await f.store.list(undefined, { includeMain: true })).some(task => task.taskId === mainId), false)
  assert.equal((await f.call(`/api/tasks/${mainId}/delete`, { method: 'POST', body: request('clear-is-not-delete') })).body.error.code, 'SESSION_ACTION_CONFLICT')
  const status = await f.call('/api/session-requests/production-clear-main')
  assert.equal(status.body.data.state, 'succeeded')
  assert.equal(status.body.data.result.replacementTaskId, result.replacementTaskId)
  await f.restart()
  assert.equal((await f.store.mainSessions()).chief, result.replacementTaskId)
  const replay = await f.call(path, { method: 'POST', body: input })
  assert.equal(replay.body.data.replayed, true)
  assert.equal(replay.body.data.replacementTaskId, result.replacementTaskId)
  assert.equal((await f.call(`/api/tasks/${mainId}`)).status, 410)
  assert.deepEqual((await f.store.get(result.replacementTaskId)).messages, [])
})

test('production clear-main never publishes success when its durable stop transaction fails or is unknown', async t => {
  const f = await fixture(t), mainId = (await f.store.mainSessions()).chief
  const harness = f.store.harness, original = harness.commit
  let code = 'SESSION_STOP_UNKNOWN'
  harness.commit = function (fn, ...args) {
    return original.call(this, tx => fn(new Proxy(tx, { get(target, key) {
      if (key === 'appendEntry') return async (...values) => {
        if (values[1].kind === 'pidot.task-cancelled') throw new TaskInputError(409, code, 'isolated stop failure')
        return target.appendEntry(...values)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })), ...args)
  }
  t.after(() => { harness.commit = original })
  for (const next of ['SESSION_STOP_UNKNOWN', 'SESSION_STOP_FAILED']) {
    code = next
    const requestId = `production-${next.toLowerCase()}`
    const response = await f.call(`/api/tasks/${mainId}/clear-main`, { method: 'POST', body: request(requestId) })
    assert.equal(response.status, 409); assert.equal(response.body.error.code, next)
    assert.equal((await f.store.mainSessions()).chief, mainId)
    assert.equal((await f.call(`/api/tasks/${mainId}`)).status, 200)
    const status = await f.call(`/api/session-requests/${requestId}`)
    assert.equal(status.body.data.state, next === 'SESSION_STOP_UNKNOWN' ? 'unknown' : 'failed')
  }
  harness.commit = original
  const retry = await f.call(`/api/tasks/${mainId}/clear-main`, { method: 'POST', body: request('production-session_stop_unknown') })
  assert.equal(retry.status, 200); assert.equal(retry.body.data.deleted, true)
})

test('production clear-main stops an active main invocation and preserves its independently running derived Task', async t => {
  const config = { baseUrl: 'https://isolated.invalid/v1', model: 'session-clear-fixture', apiKey: 'isolated-only' }
  let mainId, childStarted = false, mainStarted = false, releaseChild, releaseMain, turns = 0
  const childGate = new Promise(resolve => { releaseChild = resolve }), mainGate = new Promise(resolve => { releaseMain = resolve })
  const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 3 } } })
  const f = await fixture(t, { bots: listBots(config), modelReply: async (message, options) => {
    if (options.taskId !== mainId) { childStarted = true; await childGate; return text('independent derived result') }
    if (message === 'hold old main') { mainStarted = true; await mainGate; return text('late private main reply') }
    if (turns++ === 0) {
      const call = { type: 'toolCall', id: 'clear-main-child', name: 'task_create', arguments: { operationId: 'clear-child', goal: 'independent background task', completionCriteria: ['return result'] } }
      return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
    }
    return text('old private conversation remains separate')
  } })
  t.after(() => { releaseChild(); releaseMain() })
  mainId = (await f.store.mainSessions()).chief
  try {
    await f.store.send(mainId, 'delegate independent task')
    const old = await until(() => f.store.get(mainId), task => idle(task) && childStarted)
    const childId = old.messages.find(message => message.toolName === 'task_create').result.data.taskId
    await f.store.send(mainId, 'hold old main')
    await until(async () => mainStarted, Boolean)
    const cleared = await f.call(`/api/tasks/${mainId}/clear-main`, { method: 'POST', body: request('clear-with-running-child') })
    assert.equal(cleared.status, 200)
    const replacement = cleared.body.data.replacementTaskId
    const child = await f.store.get(childId)
    assert.equal(child.cancellation, null)
    assert.equal(child.mainParent.mainTaskId, mainId)
    assert.deepEqual((await f.store.get(replacement)).messages, [])
    releaseMain(); releaseChild()
    const done = await until(() => f.store.get(childId), idle)
    assert.equal(done.cancellation, null)
    assert.equal(done.messages.at(-1).content, 'independent derived result')
    const audit = await f.store.harness.commit(tx => readLifecycleSession(tx, mainId, { TaskCard, taskKind: ChatTask.definition.name }), context)
    assert.equal(audit.runtime.outcome?.status, 'aborted')
    const fresh = await f.store.get(replacement)
    assert.equal(JSON.stringify(fresh.messages).includes('old private'), false)
    assert.equal(fresh.messages.filter(message => message.systemKind === 'mirror' && message.childTaskId === childId && message.mirrorKind === 'finished').length, 1, 'derived completion must reach the current main exactly once')
    assert.equal((await f.call(`/api/tasks/${mainId}`)).status, 410)
    await f.restart()
    assert.equal((await f.store.get(replacement)).messages.filter(message => message.systemKind === 'mirror' && message.childTaskId === childId && message.mirrorKind === 'finished').length, 1)
  } finally { releaseMain(); releaseChild() }
})


test('production clear-main preserves a direct collaborator across repeated main replacement and restart without duplicate delivery', async t => {
  const config = { baseUrl: 'https://isolated.invalid/v1', model: 'direct-clear-fixture', apiKey: 'isolated-only' }
  let mainId, childStarted = false, releaseChild, turns = 0
  const childGate = new Promise(resolve => { releaseChild = resolve })
  const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 3 } } })
  const f = await fixture(t, { bots: listBots(config), modelReply: async (_message, options) => {
    if (options.taskId !== mainId) { childStarted = true; await childGate; return text('direct collaborator result') }
    if (turns++ === 0) {
      const call = { type: 'toolCall', id: 'direct-clear-child', name: 'task_assign', arguments: { operationId: 'direct-clear', botId: 'calendar', goal: 'independent direct collaborator', completionCriteria: ['return result'] } }
      return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
    }
    return text('original supervisor must remain stopped')
  } })
  try {
    const { bot } = await f.store.getBotConfiguration('chief')
    await f.store.updateBotConfiguration('chief', { requestId: 'direct-main-assignment', expectedVersion: bot.configRef.version, description: bot.description, tools: COLLABORATION_TOOLS, resources: [] })
    mainId = (await f.store.mainSessions()).chief
    await f.store.send(mainId, 'delegate direct collaborator')
    const waiting = await until(() => f.store.get(mainId), task => childStarted && task.collaborations.length === 1)
    const relation = waiting.collaborations[0], childId = relation.childTaskId
    const original = await f.store.get(childId)
    const first = await f.store.clearMainSession(mainId, request('clear-direct-parent'))
    const second = await f.store.clearMainSession(first.replacementTaskId, request('clear-direct-parent-again'))
    const replacement = second.replacementTaskId
    const unrelated = await f.store.create({ botId: 'chief' })
    await f.store.cancel(unrelated.taskId, {}) // Exercise the global cancellation propagation pass.
    assert.equal((await f.store.get(childId)).cancellation, null)
    releaseChild()
    const done = await until(() => f.store.get(childId), idle)
    assert.equal(done.cancellation, null)
    assert.equal(done.messages.at(-1).content, 'direct collaborator result')
    assert.deepEqual(done.configRef, original.configRef)
    assert.equal(done.collaboration.parentTaskId, mainId)
    assert.equal(done.collaborations[0].parentTaskId, mainId)
    const mirrors = () => f.store.get(replacement).then(task => task.messages.filter(message => message.mirrorKind === 'collaboration-result' && message.childTaskId === childId))
    assert.equal((await mirrors()).length, 1)
    assert.equal((await mirrors())[0].sourceMainTaskId, mainId)
    assert.equal(JSON.stringify((await f.store.get(replacement)).messages).includes('original supervisor'), false)
    await f.restart()
    assert.equal((await mirrors()).length, 1)
    assert.equal((await f.store.mainSessions()).chief, replacement)
    assert.equal((await f.store.clearMainSession(mainId, request('clear-direct-parent'))).replacementTaskId, first.replacementTaskId)
    assert.equal((await mirrors()).length, 1)
    const audit = await f.store.harness.commit(async tx => {
      const old = await readLifecycleSession(tx, mainId, { TaskCard, taskKind: ChatTask.definition.name })
      return (await tx.scanEntries({ conversationId: old.conversationId }, 100)).items
    }, context)
    assert.equal(audit.filter(entry => entry.kind === 'pidot.mirror' && entry.data.mirrorKind === 'collaboration-result').length, 0)
    const guard = () => f.store.harness.commit(tx => collaborationService({ TaskCard, ChatInput, bots: f.store.bots() }).guard(tx, childId), context)
    await guard()
    await f.store.revokeTool('chief', 'task_assign')
    await assert.rejects(guard(), { code: 'COLLABORATION_NOT_AUTHORIZED' })
    await f.store.harness.commit(async tx => { (await tx.doc(Collaboration)).stops.push({ rootWorkId: relation.rootWorkId, parentTaskId: mainId, parentInputId: relation.parentInputId }) }, context)
    await assert.rejects(guard(), { code: 'COLLABORATION_STOPPED' })
  } finally { releaseChild() }
})


test('production direct collaborator requires a committed same-Bot main replacement and still obeys live revocation', async t => {
  const config = { baseUrl: 'https://isolated.invalid/v1', model: 'direct-clear-retry', apiKey: 'isolated-only' }
  let mainId, childStarted = false, releaseChild, failCreation = false, turns = 0
  const childGate = new Promise(resolve => { releaseChild = resolve })
  const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 3 } } })
  const f = await fixture(t, { bots: listBots(config), readModelSettings: async () => {
    if (failCreation) throw new TaskInputError(409, 'MODEL_UNAVAILABLE', 'isolated creation failure')
    return null
  }, modelReply: async (_message, options) => {
    if (options.taskId !== mainId) {
      childStarted = true; await childGate
      const call = { type: 'toolCall', id: 'must-not-dispatch-after-revoke', name: 'calendar_read_schedule', arguments: { date: '2026-10-20', resource: 'mock:personal' } }
      return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
    }
    if (turns++ === 0) {
      const call = { type: 'toolCall', id: 'direct-retry-child', name: 'task_assign', arguments: { operationId: 'direct-retry', botId: 'calendar', goal: 'direct collaborator with retry boundary', completionCriteria: ['return result'] } }
      return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
    }
    return text('original main')
  } })
  try {
    const { bot } = await f.store.getBotConfiguration('chief')
    await f.store.updateBotConfiguration('chief', { requestId: 'direct-retry-assignment', expectedVersion: bot.configRef.version, description: bot.description, tools: COLLABORATION_TOOLS, resources: [] })
    mainId = (await f.store.mainSessions()).chief
    await f.store.send(mainId, 'delegate before a failed clear')
    const waiting = await until(() => f.store.get(mainId), task => childStarted && task.collaborations.length === 1)
    const childId = waiting.collaborations[0].childTaskId
    const guard = () => f.store.harness.commit(tx => collaborationService({ TaskCard, ChatInput, bots: f.store.bots() }).guard(tx, childId), context)
    failCreation = true
    await assert.rejects(f.store.clearMainSession(mainId, request('direct-clear-creation-retry')), { code: 'MODEL_UNAVAILABLE' })
    assert.equal((await f.store.mainSessions()).chief, mainId)
    assert.equal((await f.store.sessionRequestStatus('direct-clear-creation-retry')).state, 'failed')
    await assert.rejects(guard(), { code: 'MAIN_SESSION_REPLACING' })
    failCreation = false
    const cleared = await f.store.clearMainSession(mainId, request('direct-clear-creation-retry'))
    await guard()
    await f.store.revokeTool('chief', 'task_assign')
    await assert.rejects(guard(), { code: 'COLLABORATION_NOT_AUTHORIZED' })
    releaseChild()
    await until(() => f.store.get(childId), task => task.runtime.checkpoint?.phase === 'tools')
    const child = await f.store.get(childId)
    assert.equal(child.messages.some(message => message.toolName === 'calendar_read_schedule'), false)
    assert.equal((await f.store.get(cleared.replacementTaskId)).messages.some(message => message.childTaskId === childId), false)
    await f.store.cancel(childId, {})
  } finally { releaseChild() }
})


for (const mode of ['direct', 'derived']) test(`production ${mode} child crosses the durable main stop and replacement commit without losing its result`, async t => {
  const config = { baseUrl: 'https://isolated.invalid/v1', model: 'main-clear-window', apiKey: 'isolated-only' }
  let mainId, childStarted = false, releaseChild, releaseSwap, enteredSwap, turns = 0, childTurns = 0
  const childGate = new Promise(resolve => { releaseChild = resolve }), swapGate = new Promise(resolve => { releaseSwap = resolve })
  const swapEntered = new Promise(resolve => { enteredSwap = resolve })
  const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 3 } } })
  const tool = (name, args) => {
    const call = { type: 'toolCall', id: `gap-${name}`, name, arguments: args }
    return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], timestamp: Date.now() } }
  }
  const f = await fixture(t, { bots: listBots(config), modelReply: async (_message, options) => {
    if (options.taskId !== mainId) {
      if (childTurns++ === 0) { childStarted = true; await childGate; return mode === 'direct' ? tool('calendar_read_schedule', { date: '2026-10-20', resource: 'mock:personal' }) : text('child finished inside replacement commit gap') }
      return text('child resumed after committed replacement')
    }
    return turns++ === 0 ? tool(mode === 'direct' ? 'task_assign' : 'task_create', { operationId: 'window-child', ...(mode === 'direct' ? { botId: 'calendar' } : {}), goal: 'independent child across clear commit gap', completionCriteria: ['return result'] }) : text('old main must not resume')
  } })
  const harness = f.store.harness, commit = harness.commit, abortTask = harness.abortTask
  let holdNext = false
  try {
    const { bot } = await f.store.getBotConfiguration('chief')
    await f.store.updateBotConfiguration('chief', { requestId: 'gap-main-assignment', expectedVersion: bot.configRef.version, description: bot.description, tools: COLLABORATION_TOOLS, resources: [] })
    mainId = (await f.store.mainSessions()).chief
    await f.store.send(mainId, 'delegate gap child')
    const waiting = await until(() => f.store.get(mainId), task => childStarted && (mode === 'direct' ? task.collaborations.length === 1 : task.messages.some(message => message.toolName === 'task_create')))
    const childId = mode === 'direct' ? waiting.collaborations[0].childTaskId : waiting.messages.find(message => message.toolName === 'task_create').result.data.taskId
    // Hold the replacement before it acquires the commit lock. Child commits remain free
    // to observe the durable stop marker while the old mapping is still authoritative.
    harness.abortTask = function (id, ...args) {
      if (id === mainId) { holdNext = true; return Promise.resolve() }
      return abortTask.call(this, id, ...args)
    }
    harness.commit = async function (fn, ...args) {
      if (holdNext) { holdNext = false; enteredSwap(); await swapGate }
      return commit.call(this, fn, ...args)
    }
    const clearing = f.store.clearMainSession(mainId, request('clear-commit-window'))
    await swapEntered
    releaseChild()
    await until(() => f.store.get(childId), mode === 'direct' ? task => task.runtime.checkpoint?.phase === 'tools' : idle)
    assert.equal((await f.store.mainSessions()).chief, mainId)
    if (mode === 'direct') await assert.rejects(f.store.harness.commit(tx => collaborationService({ TaskCard, ChatInput, bots: f.store.bots() }).guard(tx, childId), context), { code: 'MAIN_SESSION_REPLACING' })
    assert.equal((await f.store.get(childId)).cancellation, null)
    releaseSwap()
    const cleared = await clearing
    harness.commit = commit; harness.abortTask = abortTask
    await harness.abortTask(mainId, context)
    const done = await until(() => f.store.get(childId), idle)
    if (mode === 'direct') assert.equal(done.messages.find(message => message.toolName === 'calendar_read_schedule').result.ok, true)
    assert.equal(done.messages.at(-1).content, mode === 'direct' ? 'child resumed after committed replacement' : 'child finished inside replacement commit gap')
    assert.equal(done.cancellation, null)
    assert.equal(childTurns, mode === 'direct' ? 2 : 1)
    const fresh = await f.store.get(cleared.replacementTaskId)
    assert.equal(fresh.messages.filter(message => message.mirrorKind === (mode === 'direct' ? 'collaboration-result' : 'finished') && message.childTaskId === childId).length, 1)
    assert.equal(fresh.messages.some(message => message.content.includes('old main must not resume')), false)
  } finally { releaseChild(); releaseSwap(); harness.commit = commit; harness.abortTask = abortTask; if (mainId) await harness.abortTask(mainId, context) }
})
