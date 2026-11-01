import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseContextWindow, formatContextWindow } from '../shared/model-context.mjs'
import { createModelSettings } from './model-settings.mjs'
import { openTaskStore } from './tasks.mjs'
import { readModelEnvironment } from './model-reply.mjs'
import { contextPolicy } from './context-compaction.mjs'
import { piCompactionPrefix, serializeConversation } from './pi-compaction.mjs'

test('DSH-style capacity spelling accepts K/M and blank defaults to 256K; invalid values fail closed', async () => {
  for (const [value, tokens] of [[undefined, 256000], ['', 256000], ['256K', 256000], [' 1m ', 1000000], ['128.5k', 128500], [8192, 8192], ['4000000', 4000000]]) assert.equal(parseContextWindow(value), tokens)
  for (const value of [null, true, {}, -1, 8191, 4000001, 'NaN', '128KB', '1e6', '0.0000001M']) assert.throws(() => parseContextWindow(value))
  assert.equal(formatContextWindow(256000), '256K')
  assert.equal(contextPolicy({ model: { id: 'old-model' } }).contextWindow, 256000)
  const policy = contextPolicy({ model: { id: 'configured' }, contextWindows: { configured: 1000000 } })
  assert.equal(policy.reserveTokens, 16384)
  assert.equal(policy.keepRecentTokens, 20000)
  const { config } = await readModelEnvironment({ files: [], env: { MODEL: 'env-model', OPENAI_BASE_URL: 'https://fixture.invalid/v1', OPENAI_API_KEY: 'synthetic-env-capacity', PIDOT_CONTEXT_WINDOWS: '{"env-model":131072}' } })
  assert.equal(config.contextWindow, 131072)
})

test('registered capacity persists; existing Tasks stay pinned and each queued main input captures its own capacity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pidot-model-capacity-')), file = join(root, 'tasks.sqlite')
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = createModelSettings({ file, env: {}, envFiles: [] })
  const base = { providerId: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-capacity-key', model: 'capacity-a' }
  const a = await settings.saveRegistration({ ...base, contextWindow: '128K', requestId: 'capacity-register-a' })
  const b = await settings.saveRegistration({ ...base, model: 'capacity-b', contextWindow: '1M', requestId: 'capacity-register-b' })
  assert.equal(a.contextWindow, 128000)
  for (const value of [-1, null, 'bad', 4000001]) await assert.rejects(settings.saveRegistration({ ...base, id: a.id, contextWindow: value, requestId: 'capacity-invalid-request' }), error => error.code === 'INVALID_MODEL_SETTINGS')
  const calls = []
  let release
  const started = new Promise(resolve => { release = resolve })
  let signalFirst
  const first = new Promise(resolve => { signalFirst = resolve })
  const store = await openTaskStore({ file, modelSettings: settings, modelReply: async (_message, options) => {
    calls.push(structuredClone(options.parameters))
    if (calls.length === 1) { signalFirst(); await started }
    return { mode: 'model', reply: { content: '完成' }, execution: { usage: { totalTokens: 7 } } }
  } })
  t.after(() => store.close())
  const old = await store.create({ botId: 'chief', parameters: { model: { id: b.selectionId } } })
  assert.equal(old.parameters.contextWindows[b.selectionId], 1000000)
  const id = (await store.mainSessions()).chief
  await store.send(id, 'first', undefined, { model: { id: a.selectionId } })
  await first
  await store.send(id, 'queued old capacity', undefined, { model: { id: b.selectionId } })
  await settings.saveRegistration({ ...base, id: b.id, model: 'capacity-b', contextWindow: '512K', requestId: 'capacity-edit-b' })
  await store.send(id, 'queued new capacity', undefined, { model: { id: b.selectionId } })
  release()
  let done = false
  for (let i = 0; i < 600; i++) {
    const task = await store.get(id)
    if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput') { done = true; break }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(done)
  assert.deepEqual(calls.map(parameters => parameters.contextWindows[parameters.model.id]), [128000, 1000000, 512000])
  assert.equal((await store.get(old.taskId)).parameters.contextWindows[b.selectionId], 1000000)
  assert.equal((await createModelSettings({ file, env: {}, envFiles: [] }).read({ id: b.selectionId })).contextWindow, 512000)
  await settings.saveRegistration({ ...base, id: a.id, contextWindow: '', requestId: 'capacity-reset-a' })
  assert.equal((await settings.read({ id: a.selectionId })).contextWindow, 256000)
})

test('Pi selection keeps tool pairs together and serialization omits thinking and bounds large tool bodies', () => {
  const tool = { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'notes.txt' } }] }
  const result = { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(9000) }] }
  const segments = [{ key: 'user', entryId: 1, messages: [{ role: 'user', content: '读取笔记' }] }, { key: 'tool', entryId: 2, messages: [tool, result] }, { key: 'new', entryId: 3, messages: [{ role: 'user', content: '继续' }] }]
  assert.deepEqual(piCompactionPrefix(segments, 0).map(segment => segment.key), ['user', 'tool'])
  const transcript = serializeConversation([tool, result])
  assert.match(transcript, /notes.txt/)
  assert.doesNotMatch(transcript, /private reasoning/)
  assert.ok(transcript.length < 2400)
})
