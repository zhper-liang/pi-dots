import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createMemoryApi } from './memory-api.mjs'
import { readdir } from 'node:fs/promises'
import { createMemoryRequestTracker, memoryActorLabel, memoryErrorMessage, memoryDate, memoryFileView, memoryHandwritten, memorySavedNotice, reconcileMemoryDraft, resolveMemorySourceHash } from './memory-helpers.mjs'

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
  assert.match(config, /<details className="tech-info">[\s\S]*?<summary>技术信息<\/summary>/)
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
    await assert.rejects(resolveMemorySourceHash('test', { taskId: 84, entryId: 104 }, undefined, async () => new Response(JSON.stringify({ task: invalid }))), /打不开原对话/)
  }
  await assert.rejects(resolveMemorySourceHash('test', { taskId: 84, entryId: 104 }, undefined, async () => new Response('private auth detail', { status: 403 })), /打不开原对话/)
  let fetched = false
  for (const invalid of [{ taskId: 0, entryId: 104 }, { taskId: '84', entryId: 104 }, { taskId: 84, entryId: -1 }]) {
    await assert.rejects(resolveMemorySourceHash('test', invalid, undefined, async () => { fetched = true }), /打不开原对话/)
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

const file = (state, code = null, syncedAt = '2026-10-30T08:00:00.120Z', path = 'bot-workspaces/bots/chief/MEMORY.md') => ({ path, state, code, syncedAt })

test('R2-07 file state: nothing when file mode is off; location and sync time when synced', () => {
  for (const off of [null, undefined, {}, { path: '' }, { path: 7, state: 'synced' }]) assert.equal(memoryFileView(off, 'memory'), null)
  const synced = memoryFileView(file('synced'), 'memory')
  assert.equal(synced.path, 'bot-workspaces/bots/chief/MEMORY.md')
  assert.equal(synced.synced, new Date('2026-10-30T08:00:00.120Z').toLocaleString('zh-CN'))
  assert.equal(synced.reason, null)
  assert.match(memoryFileView(file('synced', null, null), 'memory').synced, /还没有生成文件/)
  assert.equal(memoryFileView(file('rejected', 'MEMORY_FILE_TOO_LONG', null), 'memory').synced, '尚未同步')
  assert.equal(memoryFileView(file('synced', null, 'invalid'), 'memory').synced, '同步时间不可用')
})

test('R2-07 rejected and pending reasons are plain Chinese without codes, paths or internals', () => {
  const tooLong = memoryFileView(file('rejected', 'MEMORY_FILE_TOO_LONG'), 'memory').reason
  assert.match(tooLong, /文件太长/)
  assert.match(tooLong, /机器人暂时拿不到/)
  assert.match(tooLong, /精简后保存，会自动恢复/)
  assert.match(tooLong, /64 条/)
  assert.match(memoryFileView(file('rejected', 'MEMORY_FILE_TOO_LONG', null, 'bot-workspaces/bots/chief/PROFILE.md'), 'personality').reason, /8192 字/)
  assert.match(memoryFileView(file('rejected', 'MEMORY_FILE_INVALID'), 'memory').reason, /无法读取.*UTF-8/)
  assert.match(memoryFileView(file('rejected', 'MEMORY_FILE_UNAVAILABLE'), 'preferences').reason, /不可访问/)
  assert.match(memoryFileView(file('pending', 'MEMORY_FILE_WRITE_FAILED'), 'memory').reason, /已保存.*机器人照常使用.*自动重试/)
  assert.ok(memoryFileView(file('rejected', 'SOMETHING_NEW'), 'memory').reason)
  assert.ok(memoryFileView(file('pending', 'SOMETHING_NEW'), 'memory').reason)
  for (const [state, code] of [['rejected', 'MEMORY_FILE_TOO_LONG'], ['rejected', 'MEMORY_FILE_INVALID'], ['rejected', 'MEMORY_FILE_UNAVAILABLE'], ['pending', 'MEMORY_FILE_WRITE_FAILED'], ['rejected', 'SOMETHING_NEW']]) {
    const reason = memoryFileView(file(state, code), 'memory').reason
    assert.doesNotMatch(reason, /MEMORY_|SOMETHING|bot-workspaces|\.md|ENOSPC|EACCES|symlink/)
  }
})

test('R2-07 history labels file edits; empty sources mean hand-written; unknown actors never echo raw values', () => {
  assert.equal(memoryActorLabel('file'), '文件修改')
  assert.equal(memoryActorLabel('user'), '你编辑的')
  assert.equal(memoryActorLabel('candidate'), '对话整理')
  for (const unknown of ['toString', '__proto__', 'other', undefined, null]) assert.equal(memoryActorLabel(unknown), '已更新')
  assert.equal(memoryHandwritten({ sourceEntries: [] }), true)
  assert.equal(memoryHandwritten({ sourceEntries: [{ taskId: 1, entryId: 2 }] }), false)
  assert.equal(memoryHandwritten({}), false)
  assert.equal(memoryHandwritten(null), false)
})

test('R2-07 adapter keeps the file field; file state lives only in the memory section, without new gates', async () => {
  const view = { personality: { ...doc, kind: 'personality', content: '', file: file('synced') }, memory: { ...doc, file: file('rejected', 'MEMORY_FILE_TOO_LONG') }, preferences: { ...doc, kind: 'preferences', file: null } }
  assert.deepEqual((await createMemoryApi('disposable-test', async () => response(view)).getBot('chief')).memory.file, view.memory.file)
  const section = await readFile(new URL('./MemoryDocuments.tsx', import.meta.url), 'utf8')
  assert.match(section, /<MemoryFileState file=\{doc\.file\} kind=\{doc\.kind\} \/>/)
  assert.match(section, /memoryActorLabel\(revision\.actor\)/)
  assert.match(section, /<Handwritten item=\{item\} \/>/)
  assert.doesNotMatch(section, /type="checkbox"|window\.confirm|EditorDialog|<input/)
  assert.match(section, />纠正<\/button>/)
  const others = (await readdir(new URL('.', import.meta.url))).filter(name => /\.(tsx|ts|mjs)$/.test(name) && !['MemoryDocuments.tsx', 'memory-helpers.mjs', 'memory-helpers.d.mts', 'memory-types.ts', 'memory-ui.test.mjs'].includes(name))
  for (const name of others) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /memoryFileView|MemoryFileState|bot-workspaces/, `${name} must not show memory file paths`)
  }
})

test('R2 save notice does not promise the Bot sees an edit while its file is rejected', () => {
  const rejected = { path: 'bot-workspaces/bots/chief/MEMORY.md', state: 'rejected', code: 'MEMORY_FILE_TOO_LONG', syncedAt: null }
  assert.equal(memorySavedNotice('update', { ...rejected, state: 'synced', code: null }), '已保存，改完马上生效。')
  assert.equal(memorySavedNotice('update', null), '已保存，改完马上生效。')
  assert.match(memorySavedNotice('update', rejected), /机器人暂时拿不到/)
  assert.equal(memorySavedNotice('delete', rejected), '已删除，编辑历史仍保留。')
})
