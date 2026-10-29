import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { openTaskStore } from '../server/tasks.mjs'
import { createApiServer } from '../server/app.mjs'
import { createMemoryApi } from './memory-api.mjs'

// Exercise the adapter against real HTTP + temporary SQLite, without a provider or production env.
test('T11c HTTP adapter matches real store projections, history, conflicts and requestId replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-t11c-ui-'))
  const store = await openTaskStore({ file: join(dir, 'isolated.sqlite'), memoryOptions: { enabled: false } })
  const token = randomUUID()
  const server = createApiServer({ token, tasks: store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await store.close()
    await rm(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const api = createMemoryApi(token, (path, init) => fetch(base + path, init))
  const initial = await api.getBot('chief')
  assert.equal(initial.personality.kind, 'personality')
  assert.equal(typeof initial.personality.version, 'number')
  assert.ok(Array.isArray(initial.history.personality))
  assert.ok(Array.isArray(initial.history.memory))
  assert.ok(Object.hasOwn(initial.historyNextBeforeVersion, 'memory'))
  const edit = { kind: 'personality', action: 'set', content: '简洁，认真核实。', expectedVersion: initial.personality.version, requestId: randomUUID(), sourceEntries: [] }
  const saved = await api.editBot('chief', edit)
  assert.equal(saved.ok, true)
  assert.equal(saved.document.content, edit.content)
  assert.equal(saved.document.version, initial.personality.version + 1)
  const replayed = await api.editBot('chief', edit)
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.document.version, saved.document.version)
  await assert.rejects(api.editBot('chief', { ...edit, requestId: randomUUID(), content: '未保存草稿' }), error => error.code === 'MEMORY_VERSION_CONFLICT')
  const current = await api.getBot('chief')
  assert.equal(current.personality.content, edit.content)
  assert.equal(current.history.personality[0].content, edit.content)
  const preferences = await api.getPreferences()
  assert.equal(preferences.kind, 'preferences')
  assert.ok(Array.isArray(preferences.items))
  assert.ok(Array.isArray(preferences.history))
  assert.ok(Object.hasOwn(preferences, 'historyNextBeforeVersion'))
  // The global route rejects kind: adapter must remove it, leaving an actual service item conflict.
  await assert.rejects(api.editPreferences({ kind: 'preferences', action: 'delete', id: 'missing', expectedVersion: preferences.version, requestId: randomUUID() }), error => error.code === 'MEMORY_ITEM_CONFLICT')
})
