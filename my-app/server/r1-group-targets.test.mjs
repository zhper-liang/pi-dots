import test from 'node:test'
import assert from 'node:assert/strict'
import { admitGroupTarget, GroupDirectory } from './groups.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { ToolAccess } from './tools.mjs'

// Narrow service-boundary fixture: no database, process, credentials or external requests.
function fixture(names = ['Chief', '同名', '同名']) {
  const items = ['chief', 'alpha', 'beta'].map((id, i) => ({ id, name: names[i], status: 'active', defaults: { tools: [], toolResources: [] } }))
  const card = { kind: 'group', taskId: 11, groupId: 'r1-group', conversationId: 'r1-conversation', bot: { id: 'chief' }, initiatingUser: 'authenticated-user' }
  const group = { groupId: card.groupId, taskId: card.taskId, conversationId: card.conversationId, adminBotId: 'chief', memberBotIds: items.map(b => b.id), initiatingUser: card.initiatingUser }
  const access = { assignments: { chief: { tools: ['collaborators_list', 'task_assign', 'task_review'], resources: [] }, alpha: { tools: [], resources: [] }, beta: { tools: [], resources: [] } }, revoked: {} }
  const docs = new Map([[GroupDirectory, { items: [group] }], [BotDirectory, { items }], [ToolAccess, access]])
  const tx = { doc: async kind => {
    assert.ok(docs.has(kind), 'unexpected document access')
    return docs.get(kind)
  } }
  return { items, card, group, access, call: input => admitGroupTarget(tx, card, { requestId: 'r1-target-request', message: '请处理', ...input }, items) }
}

test('R1 structured IDs never expand from duplicate or unknown display names', async () => {
  const f = fixture()
  assert.deepEqual((await f.call({ message: '@同名 @不存在', targetBotIds: ['alpha'] })).targets, ['alpha'])
})

test('R1 structured empty array is authoritative over text and legacy singular target', async () => {
  const f = fixture()
  assert.equal(await f.call({ message: '@同名', targetBotIds: [], targetBotId: 'beta' }), null)
})

test('R1 structured order and deduplication are preserved without singular expansion', async () => {
  const f = fixture()
  assert.deepEqual((await f.call({ targetBotIds: ['beta', 'alpha', 'beta'], targetBotId: 'chief' })).targets, ['beta', 'alpha'])
})

test('R1 legacy text still resolves unique names in input order', async () => {
  const f = fixture(['Chief', '甲', '乙'])
  assert.deepEqual((await f.call({ message: '@乙 @甲 @乙' })).targets, ['beta', 'alpha'])
  assert.deepEqual((await f.call({ message: '请处理', targetBotId: 'alpha' })).targets, ['alpha'])
  await assert.rejects(f.call({ message: '@未知' }), { code: 'GROUP_MENTION_UNKNOWN' })
})

test('R1 legacy duplicate and NFKC-equivalent names are rejected rather than chosen', async () => {
  await assert.rejects(fixture().call({ message: '@同名' }), { code: 'GROUP_MENTION_AMBIGUOUS' })
  await assert.rejects(fixture(['Chief', 'Ａ', 'A']).call({ message: '@A' }), { code: 'GROUP_MENTION_AMBIGUOUS' })
})

test('R1 authoritative targets still enforce membership, active status and bounded requests', async () => {
  const f = fixture()
  await assert.rejects(f.call({ targetBotIds: ['foreign'] }), { code: 'GROUP_TARGET_DENIED' })
  f.items[1].status = 'inactive'
  await assert.rejects(f.call({ targetBotIds: ['alpha'] }), { code: 'BOT_INACTIVE' })
  await assert.rejects(f.call({ targetBotIds: Array(9).fill('beta') }), { code: 'GROUP_TARGET_LIMIT' })
  await assert.rejects(f.call({ targetBotIds: ['beta'], requestId: undefined }), { code: 'INVALID_GROUP_TARGET' })
  await assert.rejects(f.call({ targetBotIds: undefined }), { code: 'INVALID_GROUP_TARGET' })
})

test('R1 explicit selection cannot bypass collaboration permission or input replay conflict', async () => {
  const f = fixture()
  f.access.assignments.chief.tools = []
  await assert.rejects(f.call({ targetBotIds: ['alpha'] }), { code: 'COLLABORATION_NOT_AUTHORIZED' })
  f.access.assignments.chief.tools = ['collaborators_list', 'task_assign', 'task_review']
  const accepted = await f.call({ targetBotIds: ['alpha'] })
  f.group.inputs = [{ requestId: 'r1-target-request', signature: accepted.signature }]
  assert.equal((await f.call({ targetBotIds: ['alpha'] })).prior, f.group.inputs[0])
  await assert.rejects(f.call({ targetBotIds: ['beta'] }), { code: 'GROUP_INPUT_CONFLICT' })
})
