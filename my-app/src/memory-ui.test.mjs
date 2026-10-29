import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createMemoryApi } from './memory-api.mjs'
import { createMemoryRequestTracker, memoryErrorMessage, memoryDate, reconcileMemoryDraft, resolveMemorySourceHash } from './memory-helpers.mjs'

const response = (data, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
const doc = { kind: 'memory', version: 3, updatedAt: null, items: [], sourceEntries: [], status: { state: 'ready', code: null, updatedAt: null } }

test('memory adapter uses authenticated real routes, unwraps data and retains root history projections', async () => {
  const calls = []
  const view = { personality: { ...doc, kind: 'personality', content: '简洁' }, memory: doc, preferences: { ...doc, kind: 'preferences' }, history: { personality: [], memory: [] }, historyNextBeforeVersion: { personality: null, memory: 1 } }
  const api = createMemoryApi('disposable-test', async (...args) => { calls.push(args); return response(view) })
  assert.deepEqual(await api.getBot('test-bot'), view)
  assert.equal(calls[0][0], '/api/bots/test-bot/memory')
  assert.equal(calls[0][1].method, 'GET')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer disposable-test')
  assert.equal(calls[0][1].body, undefined)
  await api.getPreferences()
  assert.equal(calls[1][0], '/api/settings/preferences')
})

test('personality edit and item correction keep version, source references and request identity unchanged', async () => {
  const calls = []
  const api = createMemoryApi('disposable-test', async (...args) => { calls.push(args); return response({ ok: true, document: doc }) })
  const change = { kind: 'memory', action: 'update', expectedVersion: 3, requestId: 'one-request', id: 'known-fact', content: '更正内容', sourceEntries: [{ taskId: 1, entryId: 2 }] }
  await api.editBot('a/b', change)
  assert.equal(calls[0][0], '/api/bots/a%2Fb/memory')
  assert.deepEqual(JSON.parse(calls[0][1].body), change)
  await api.editPreferences({ ...change, kind: 'preferences' })
  const { kind: _kind, ...wire } = change
  assert.deepEqual(JSON.parse(calls[1][1].body), wire)
  assert.equal(calls[1][0], '/api/settings/preferences')
})

test('conflict errors retain safe codes but never surface arbitrary backend messages or credentials', async () => {
  const api = createMemoryApi('disposable-test', async () => new Response(JSON.stringify({ error: { code: 'MEMORY_VERSION_CONFLICT', message: 'private backend detail' } }), { status: 409 }))
  await assert.rejects(api.editBot('a', {}), error => error.code === 'MEMORY_VERSION_CONFLICT' && /草稿仍保留/.test(error.message) && !error.message.includes('private'))
})

test('network and malformed success leave mutation delivery ambiguous; no automatic retry', async () => {
  let attempts = 0
  const api = createMemoryApi('disposable-test', async () => { attempts++; throw new Error('private URL') })
  await assert.rejects(api.editBot('a', {}), error => error.ambiguous && !error.message.includes('private URL'))
  assert.equal(attempts, 1)
  const malformed = createMemoryApi('disposable-test', async () => new Response('{}'))
  await assert.rejects(malformed.editPreferences({ kind: 'preferences' }), error => error.ambiguous)
})

test('request tracker reuses the exact request after ambiguity and blocks changed payloads until settled', () => {
  let ids = 0
  const tracker = createMemoryRequestTracker(() => `request-${++ids}`)
  const body = { kind: 'memory', action: 'delete', expectedVersion: 3, id: 'a' }
  const first = tracker.prepare(body)
  first.id = 'mutated-local-copy'
  assert.equal(tracker.prepare({ id: 'a', expectedVersion: 3, action: 'delete', kind: 'memory' }).requestId, 'request-1')
  assert.equal(tracker.prepare(body).id, 'a')
  assert.throws(() => tracker.prepare({ ...body, expectedVersion: 4 }), /核对/)
  assert.equal(ids, 1)
  tracker.settle()
  assert.equal(tracker.prepare({ ...body, expectedVersion: 4 }).requestId, 'request-2')
})

test('refresh displays current document without overwriting draft content, base version or sources', () => {
  const draft = { content: '我的草稿', expectedVersion: 2, sourceEntries: [{ taskId: 1, entryId: 2 }] }
  const state = reconcileMemoryDraft(draft, doc)
  assert.equal(state.draft, draft)
  assert.equal(state.current, doc)
  assert.equal(state.conflicted, true)
  assert.equal(state.draft.content, '我的草稿')
  assert.equal(state.draft.expectedVersion, 2)
  assert.equal(reconcileMemoryDraft(null, doc).conflicted, false)
})

test('pending and validation messages are concise and never dump raw service error payloads', () => {
  assert.match(memoryErrorMessage('MEMORY_BUDGET_EXHAUSTED'), /待处理.*保持不变/)
  assert.match(memoryErrorMessage('MEMORY_CREDENTIAL_REJECTED'), /凭证/)
  assert.doesNotMatch(memoryErrorMessage('UNEXPECTED_TECHNICAL_CODE'), /UNEXPECTED/)
  assert.equal(memoryDate(null), '尚未更新')
  assert.equal(memoryDate('invalid'), '更新时间不可用')
})

test('Bot view keeps shared preferences read-only, detail uses live memory and legacy role has no editor', async () => {
  const bot = await readFile(new URL('./BotMemory.tsx', import.meta.url), 'utf8')
  const page = await readFile(new URL('./BotTemplatePage.tsx', import.meta.url), 'utf8')
  const config = await readFile(new URL('./BotConfiguration.tsx', import.meta.url), 'utf8')
  assert.match(bot, /title="共享偏好"[^\n]+readOnly onRefresh/)
  assert.doesNotMatch(bot, /api\.editPreferences/)
  assert.match(page, /<BotMemory botId=\{bot.id\}/)
  assert.doesNotMatch(page, /将在 T11|bot-memory-placeholder/)
  assert.doesNotMatch(config, /setDescription|<textarea|职责与模型/)
  assert.match(config, /description: view.bot.description/)
  assert.match(config, /配置历史与审计/)
})


test('T12 current Bot details retire old duties and label display-only appearance distinctly', async () => {
  const page = await readFile(new URL('./BotTemplatePage.tsx', import.meta.url), 'utf8')
  const config = await readFile(new URL('./BotConfiguration.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /\{bot\.description\}|bot-detail-desc/)
  assert.match(page, /显示标签/)
  assert.match(page, /仅用于展示/)
  assert.match(config, /当时的职责（历史记录）：\{v.description\}/)
  assert.doesNotMatch(config, /<textarea|setDescription/)
})

test('T12 Bot and settings sources share verified owner/Entry navigation without duplicate settings heading', async () => {
  const page = await readFile(new URL('./BotTemplatePage.tsx', import.meta.url), 'utf8')
  const preferences = await readFile(new URL('./UserPreferences.tsx', import.meta.url), 'utf8')
  const settings = await readFile(new URL('./SettingsPage.tsx', import.meta.url), 'utf8')
  for (const component of [page, preferences]) {
    assert.match(component, /resolveMemorySourceHash\(token, source, controller.signal\)/)
    assert.match(component, /window.location.hash = hash/)
    assert.match(component, /controller.signal.aborted/)
  }
  assert.match(preferences, /onOpenSource \?\? \(source =>/)
  assert.doesNotMatch(settings, /<h2[^>]*>共享偏好<\/h2>/)
  assert.equal((settings.match(/<UserPreferences /g) ?? []).length, 1)
})

test('memory source resolver authenticates original Task and anchors exact Entry with its actual owner', async () => {
  const controller = new AbortController()
  const calls = []
  const hash = await resolveMemorySourceHash('ephemeral-test', { taskId: 84, entryId: 104 }, controller.signal, async (...args) => {
    calls.push(args)
    return new Response(JSON.stringify({ task: { taskId: 84, bot: { id: 'calendar' }, messages: [{ id: 104, content: '原对话' }] } }))
  })
  assert.equal(hash, '#bot=calendar&task=84&message=104')
  assert.equal(calls[0][0], '/api/tasks/84')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer ephemeral-test')
  assert.equal(calls[0][1].signal, controller.signal)
})

test('source resolver refuses missing Entry, wrong Task, invalid owner, groups and failed authorization', async () => {
  const task = { taskId: 84, bot: { id: 'calendar' }, messages: [{ id: 104 }] }
  for (const invalid of [{ ...task, taskId: 85 }, { ...task, messages: [] }, { ...task, messages: {} }, { ...task, bot: { id: 'invalid/owner' } }, { ...task, bot: {} }, { ...task, kind: 'group' }, { ...task, groupId: 'private-group' }]) {
    await assert.rejects(resolveMemorySourceHash('test', { taskId: 84, entryId: 104 }, undefined, async () => new Response(JSON.stringify({ task: invalid }))), /无法打开/)
  }
  await assert.rejects(resolveMemorySourceHash('test', { taskId: 84, entryId: 104 }, undefined, async () => new Response('private auth detail', { status: 403 })), /无法打开/)
  let fetched = false
  for (const invalid of [{ taskId: 0, entryId: 104 }, { taskId: '84', entryId: 104 }, { taskId: 84, entryId: -1 }]) {
    await assert.rejects(resolveMemorySourceHash('test', invalid, undefined, async () => { fetched = true }), /无法打开/)
  }
  assert.equal(fetched, false)
})

test('source resolver preserves cancellation rather than opening a late response', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(resolveMemorySourceHash('test', { taskId: 1, entryId: 2 }, controller.signal, async (_path, init) => {
    init.signal.throwIfAborted()
  }), error => error.name === 'AbortError')
})
