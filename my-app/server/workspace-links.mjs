import { copy, fail, object, validId, payloadHash } from './workspace-schema.mjs'

// A relationship is a local record, never an external mutation or permission grant.
export function createWorkspaceLinks({ repo, authorize }) {
  const ref = (value, type) => {
    if (!object(value) || Object.keys(value).some(k => !['type', 'sourceId', 'id'].includes(k)) || value.type !== type || !validId(value.sourceId) || !validId(value.id) || type === 'Todo' && value.sourceId !== 'local') fail(400, 'WORKSPACE_LINK', '关联需要完整、精确的来源和对象引用。')
    return copy(value)
  }
  function refs(data, sourceId) {
    return { todoRef: ref(data.todoRef ?? { type: 'Todo', sourceId, id: data.todoId }, 'Todo'), eventRef: ref(data.eventRef ?? { type: 'Event', sourceId, id: data.eventId }, 'Event') }
  }
  function normalize(data, sourceId) {
    if (!object(data) || data.relation !== 'related') fail(400, 'WORKSPACE_LINK', '关联类型须为related。')
    const explicit = data.todoRef !== undefined || data.eventRef !== undefined
    const fields = explicit ? ['todoRef', 'eventRef', 'relation', 'expectedTodoVersion', 'expectedEventVersion'] : ['todoId', 'eventId', 'relation']
    if (Object.keys(data).some(k => !fields.includes(k))) fail(400, 'WORKSPACE_INPUT', '关联参数含不支持的字段。')
    const pair = refs(data, sourceId)
    if (pair.todoRef.sourceId !== sourceId || explicit && (!data.todoRef || !data.eventRef || ![data.expectedTodoVersion, data.expectedEventVersion].every(v => Number.isSafeInteger(v) && v >= 1))) fail(400, 'WORKSPACE_LINK', '明确关联须指定本地待办、两端当前版本与完整引用。')
    return copy(data)
  }
  async function permitted(tx, actor, data, sourceId) {
    const pair = refs(data, sourceId)
    for (const target of Object.values(pair)) {
      const p = await authorize(tx, actor, target.sourceId)
      if (p.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '关联和回执需要两端当前正文权限。')
    }
    return pair
  }
  async function create(tx, actor, data, sourceId) {
    const pair = await permitted(tx, actor, data, sourceId)
    const records = []
    for (const [key, target] of Object.entries(pair)) {
      const row = await repo.get(tx, target.type, actor.ownerId, target.sourceId, target.id)
      if (!row || row.deletedAt) fail(409, 'WORKSPACE_LINK_TARGET', '关联目标不存在或已删除。')
      const expected = data[key === 'todoRef' ? 'expectedTodoVersion' : 'expectedEventVersion']
      if (expected !== undefined && row.version !== expected) fail(409, 'WORKSPACE_VERSION_CONFLICT', '关联目标已变化，请刷新两端后重新确认。')
      records.push(row)
    }
    const sameSource = pair.eventRef.sourceId === sourceId
    const id = payloadHash(sameSource ? [pair.todoRef.id, pair.eventRef.id, data.relation] : [pair.todoRef, pair.eventRef, data.relation])
    const old = await repo.get(tx, 'ItemLink', actor.ownerId, sourceId, id)
    if (old) return old // Preserve original reference/version evidence; never rewrite history.
    return { schemaVersion: 1, ownerId: actor.ownerId, sourceId, id, todoId: pair.todoRef.id, eventId: pair.eventRef.id, relation: data.relation, ...(data.todoRef ? { ...pair, todoVersion: records[0].version, eventVersion: records[1].version } : {}) }
  }
  return { refs, normalize, permitted, create }
}
