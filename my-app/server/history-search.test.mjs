import test from 'node:test'
import assert from 'node:assert/strict'
import { executeSessionHistory, validSessionHistoryArgs } from './history-search.mjs'
import { buildMemoryContext } from './bot-memory.mjs'
import { toolSets } from './tools.mjs'

function fixture() {
  const cards = [{ taskId: 1, kind: 'main', origin: 'user', bot: { id: 'a' }, conversationId: 'c1', parameters: {} }, { taskId: 2, origin: 'user', bot: { id: 'a' }, conversationId: 'c2', parameters: {} }, { taskId: 3, origin: 'user', bot: { id: 'b' }, conversationId: 'c3', parameters: {} }]
  const entries = cards.flatMap(card => [{ id: card.taskId * 10, conversationId: card.conversationId, kind: 'pidot.user', data: { content: '项目中文 /home/代码/pidot 修复方法', source: 'authenticated-user', createdAt: '2026-11-01T00:00:00Z' } }, { id: card.taskId * 10 + 1, conversationId: card.conversationId, byTaskId: card.taskId, kind: 'pidot.model-reply', data: { content: '修复已完成', inReplyTo: card.taskId * 10, createdAt: '2026-11-01T00:01:00Z' } }])
  const documents = new Map(), deleted = {}
  const bots = ['a', 'b'].map(id => ({ id, defaults: { tools: [], toolResources: [] } }))
  const access = { assignments: {}, revoked: {} }
  const tx = {
    async doc(type, id) {
      const kind = type.definition.kind
      if (kind === 'pidot.bot-directory') return { items: bots }
      if (kind === 'pidot.tool-access') return access
      if (kind === 'pidot.session-lifecycle') return { deleted }
      const key = `${kind}:${id}`
      if (!documents.has(key)) documents.set(key, { items: {}, entries: {} })
      return documents.get(key)
    },
    async task(id) { return cards.some(card => card.taskId === id) ? { id, kind: 'chat', state: { status: 'active' } } : null },
    async conversation(id) { return { owner: { taskId: cards.find(card => card.conversationId === id)?.taskId } } },
    async scanTasks() { return { items: cards.map(card => ({ id: card.taskId, kind: 'chat' })) } },
    async scanEntries({ conversationId }) { return { items: entries.filter(entry => entry.conversationId === conversationId) } },
  }
  const TaskCard = { definition: { kind: 'fixture.card' } }
  cards.forEach(card => documents.set(`fixture.card:${card.taskId}`, card))
  return { tx, cards, deleted, entries, bots, access, deps: { TaskCard, taskKind: 'chat', readSource: async (_, id) => cards.find(card => card.taskId === id) } }
}

test('main-only history search validates arguments and never installs on ordinary Task', () => {
  assert.equal(validSessionHistoryArgs('session_search', { query: '中文', before: 'invalid' }), false)
  assert.equal(validSessionHistoryArgs('session_search', { query: '中文', taskId: 3 }), false)
  assert.equal(validSessionHistoryArgs('session_search', { query: '/home/代码', limit: 10 }), true)
  const f = fixture()
  assert.equal(toolSets(f.cards[0], f.bots, f.access).authorized.includes('session_search'), true)
  assert.equal(toolSets(f.cards[1], f.bots, f.access).authorized.includes('session_search'), false)
})
test('Chinese/path search discovers consumed originals, binds refs, filters count and rechecks deletion', async () => {
  const f = fixture()
  const search = () => executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: '/home/代码/pidot', limit: 1 }, 12, f.deps)
  const result = await search()
  assert.equal(result.ok, true)
  assert.equal(result.data.totalCount, 2)
  assert.equal(result.data.nextOffset, 1)
  const ref = result.data.entries[0].historyRef
  const read = () => executeSessionHistory(f.tx, f.cards[0], 'session_history_read', { historyRef: ref }, 12, f.deps)
  assert.match((await read()).data.text, /项目中文/)
  f.deleted['1'] = { deleted: true }
  assert.equal((await read()).ok, false)
  delete f.deleted['1']
  f.deleted['2'] = { deleted: true }
  assert.equal((await search()).data.totalCount, 1)
  assert.equal((await executeSessionHistory(f.tx, f.cards[1], 'session_search', { query: '中文' }, 22, f.deps)).ok, false)
})
test('source revocation hides snippets, totals and previously issued references', async () => {
  const f = fixture()
  const result = await executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: '中文' }, 12, f.deps)
  const historyRef = result.data.entries.find(entry => entry.taskId === 2).historyRef
  f.deps.readSource = async (_, id) => id === 1
  assert.equal((await executeSessionHistory(f.tx, f.cards[0], 'session_history_read', { historyRef }, 12, f.deps)).ok, false)
  assert.equal((await executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: '中文' }, 12, f.deps)).data.totalCount, 1)
})
test('memory keeps global preferences and stable whole relevant entries within budget', () => {
  const item = (id, content) => ({ id, content, updatedAt: '2026-11-01', sourceEntries: [] })
  const documents = { preferences: { items: [item('p', '默认中文')] }, memory: { items: [item('b', 'unrelated-project uses Java'), item('a', 'pidot 路径 /home/代码/pidot 使用 pnpm')] } }
  const result = buildMemoryContext(documents, { query: 'pidot 怎么构建', maxChars: 300 })
  assert.match(result.text, /默认中文/)
  assert.match(result.text, /pnpm/)
  assert.doesNotMatch(result.text, /unrelated-project/)
  const reverse = { ...documents, memory: { items: [...documents.memory.items].reverse() } }
  assert.equal(result.text, buildMemoryContext(reverse, { query: 'pidot 怎么构建', maxChars: 300 }).text)
})

test('real mainParent shape without botId is accepted and forged parent is excluded', async () => {
  const f = fixture()
  f.cards[1].origin = 'main'
  f.cards[1].mainParent = { mainTaskId: 1, entryId: 10, operationId: 'derive-1', briefEntryId: 20, mainConversationId: 'c1' }
  const search = () => executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: '中文' }, 12, f.deps)
  assert.equal((await search()).data.totalCount, 2)
  f.cards[1].mainParent.mainConversationId = 'forged'
  assert.equal((await search()).data.totalCount, 1)
})
test('compaction preserves original searchable text and revoked tools hide derived reply counts', async () => {
  const f = fixture()
  f.entries.push({ id: 29, conversationId: 'c2', byTaskId: 2, kind: 'pidot.context-compaction', data: { inReplyTo: 20, content: '压缩后不含原始路径' } })
  const search = query => executeSessionHistory(f.tx, f.cards[0], 'session_search', { query }, 12, f.deps)
  assert.equal((await search('/home/代码/pidot')).data.totalCount, 2)
  f.entries.push({ id: 22, conversationId: 'c2', byTaskId: 2, kind: 'pidot.tool-result', data: { inReplyTo: 20, toolName: 'calendar_read_schedule', arguments: { resource: 'mock:personal' }, result: { ok: true }, createdAt: '2026-11-01T00:00:30Z' } })
  assert.equal((await search('修复已完成')).data.totalCount, 1)
})
test('time range and pagination expose only current allowed hits; source loading is cached', async () => {
  const f = fixture()
  let sourceReads = 0
  f.deps.readSource = async () => { sourceReads++; return true }
  const result = await executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: '修复', after: '2026-11-01T00:00:30Z', offset: 1, limit: 1 }, 12, f.deps)
  assert.equal(result.data.totalCount, 2)
  assert.equal(result.data.entries.length, 1)
  assert.equal(sourceReads, 3)
})
test('host-bound historyRef supplements only the exact original full result with live resource checks', async () => {
  const f = fixture()
  const { boundToolResult } = await import('./tool-results.mjs')
  f.access.assignments.a = { tools: ['calendar_read_schedule'], resources: ['mock:personal'] }
  // The fixture provides the supported task-document storage used by ToolResults.
  const originalDoc = f.tx.doc.bind(f.tx)
  const artifacts = {}
  f.tx.doc = async (type, id) => type.definition.kind === 'pidot.tool-results' ? { artifacts } : originalDoc(type, id)
  const result = await boundToolResult(f.tx, f.cards[1], { ok: true, data: { text: '中文完整结果'.repeat(3000) } }, { toolName: 'calendar_read_schedule', resource: 'mock:personal', arguments: { resource: 'mock:personal' } })
  f.entries.push({ id: 22, conversationId: 'c2', byTaskId: 2, kind: 'pidot.tool-result', data: { inReplyTo: 20, toolName: 'calendar_read_schedule', arguments: { resource: 'mock:personal' }, result, createdAt: '2026-11-01T00:00:30Z' } })
  const search = await executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: 'calendar_read_schedule' }, 12, f.deps)
  const historyRef = search.data.entries[0].historyRef
  const args = { historyRef, resultRef: result.data.resultRef, resource: 'mock:personal', limit: 100 }
  const read = () => executeSessionHistory(f.tx, f.cards[0], 'session_history_read', args, 12, f.deps)
  assert.match((await read()).data.text, /中文完整结果/)
  f.access.assignments.a.resources = []
  assert.equal((await read()).ok, false)
})
test('later search receipts keep own direct history readable without replaying recalled derived text', async () => {
  const f = fixture()
  const first = await executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: '中文' }, 12, f.deps)
  const historyRef = first.data.entries.find(entry => entry.taskId === 1).historyRef
  f.entries.push({ id: 12, conversationId: 'c1', kind: 'pidot.user', data: { content: '上次处理方法', createdAt: '2026-11-01T01:00:00Z' } }, { id: 13, conversationId: 'c1', byTaskId: 1, kind: 'pidot.tool-result', data: { toolName: 'session_search', arguments: { query: '中文' }, inReplyTo: 12, result: first } }, { id: 14, conversationId: 'c1', byTaskId: 1, kind: 'pidot.model-reply', data: { inReplyTo: 12, content: '被回查带入的敏感历史片段', createdAt: '2026-11-01T01:01:00Z' } })
  const read = await executeSessionHistory(f.tx, f.cards[0], 'session_history_read', { historyRef }, 15, f.deps)
  assert.equal(read.ok, true)
  assert.match(read.data.text, /项目中文/)
  const recalled = await executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: '敏感历史片段' }, 15, f.deps)
  assert.equal(recalled.data.totalCount, 0)
})
test('completed terminal Task remains searchable when live source policy allows it', async () => {
  const f = fixture()
  const task = f.tx.task.bind(f.tx)
  f.tx.task = async id => ({ ...await task(id), state: { status: id === 2 ? 'terminal' : 'active' } })
  const result = await executeSessionHistory(f.tx, f.cards[0], 'session_search', { query: '中文' }, 12, f.deps)
  assert.equal(result.data.totalCount, 2)
})
test('independent child survives archived and cleared parent identity', async () => {
  const f = fixture()
  f.cards[1].mainParent = { mainTaskId: 1, mainConversationId: 'c1' }
  f.deleted['1'] = { action: 'clear-main' }
  // Run from a new main while the old parent's task-scoped documents are retired.
  const current = { ...f.cards[0], taskId: 4, conversationId: 'c4' }
  f.cards.push(current)
  const task = f.tx.task.bind(f.tx), doc = f.tx.doc.bind(f.tx)
  f.tx.task = async id => id === 1 ? { id: 1, kind: 'chat', state: { status: 'terminal' } } : task(id)
  f.tx.scanConversations = async () => ({ items: [{ id: 'c1' }] })
  f.tx.doc = async (type, id) => {
    if (type.definition.kind === 'pidot.cancelled-task-archive') return { snapshot: { documents: { 'fixture.card': f.cards[0] } } }
    if (type.definition.kind === 'fixture.card' && id === 1) throw new Error('retired task document')
    return doc(type, id)
  }
  const result = await executeSessionHistory(f.tx, current, 'session_search', { query: '中文' }, 41, f.deps)
  assert.equal(result.ok, true)
  assert.equal(result.data.totalCount, 1)
  assert.equal(result.data.entries[0].taskId, 2)
})
