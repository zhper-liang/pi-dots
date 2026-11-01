import { createHash } from 'node:crypto'
import { memorySourceAllowed } from './bot-memory-runtime.mjs'
import { validId } from './bot-memory.mjs'

export const MAIN_MEMORY_TOOLS = Object.freeze(['memory_review'])
export const MEMORY_TOOLS = Object.freeze(['memory_read', 'memory_edit'])
const kindSchema = { type: 'string', enum: ['personality', 'memory', 'preferences'] }
export const memoryTools = [
  { name: 'memory_review', description: '仅主会话：当前认证用户明确要求整理、回顾或总结记忆时，将本Bot未处理材料排入后台整理队列。参数固定为空对象；排队不代表已保存新记忆，结果以后台完成回执为准。', parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'memory_read', description: '读取自己的长期记忆、人格或所有Bot共享的用户偏好，返回版本和条目ID。修改前先读版本；分页未读部分不可声称已读。不能指定其他Bot。',
    parameters: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: kindSchema, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16 } } } },
  { name: 'memory_edit', description: '用户在本次私聊明确要求记住、纠正、忘记或修改人格时立即保存，不必等待后台总结。只改自己的memory/personality或共享preferences，不得猜测或从外部资料写入。先用memory_read取得expectedVersion和条目id；memory/preferences支持add/update/delete，人格仅set。日程、待办、凭证不存长期记忆。保存失败不得声称已记住；版本冲突先重读。',
    parameters: { type: 'object', additionalProperties: false, required: ['kind', 'action', 'expectedVersion'], properties: {
      kind: kindSchema, action: { type: 'string', enum: ['add', 'update', 'delete', 'set'] }, expectedVersion: { type: 'integer', minimum: 0 },
      id: { type: 'string', minLength: 1, maxLength: 128 }, content: { type: 'string', maxLength: 8192 },
    } } },
]
export function validMemoryCall(call) {
  const args = call.arguments
  if (call.name === 'memory_review') return !call.argumentsError && !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0
  if (call.argumentsError || !args || typeof args !== 'object' || Array.isArray(args) || !['personality', 'memory', 'preferences'].includes(args.kind)) return false
  if (call.name === 'memory_read') return Object.keys(args).every(key => ['kind', 'offset', 'limit'].includes(key)) &&
    (args.offset === undefined || Number.isSafeInteger(args.offset) && args.offset >= 0) && (args.limit === undefined || Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 16)
  if (call.name !== 'memory_edit' || Object.keys(args).some(key => !['kind', 'action', 'expectedVersion', 'id', 'content'].includes(key)) || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 0) return false
  if (args.kind === 'personality') return args.action === 'set' && args.id === undefined && typeof args.content === 'string' && args.content.length <= 8192
  return ['add', 'update', 'delete'].includes(args.action) && (args.action === 'add' && args.id === undefined || validId(args.id)) &&
    (args.action === 'delete' ? args.content === undefined : typeof args.content === 'string' && args.content.trim().length > 0 && args.content.length <= 2048)
}
const denied = (code, message) => ({ ok: false, error: { code, message } })
// The host binds identity and the current authenticated source; models cannot supply either.
export async function executeMemoryTool(tx, card, call, entryId, { service, readEntry, files, review }) {
  if (!validMemoryCall(call)) return denied('TOOL_INVALID_ARGUMENTS', '记忆工具参数无效。')
  const args = call.arguments
  if (call.name === 'memory_review') {
    const source = await tx.entry(entryId)
    if (card.kind !== 'main' || !memorySourceAllowed(card, source) || /(?:不要|别|无需|不用|不必|停止|取消).{0,12}(?:整理|回顾|总结|归纳|梳理)|\b(?:do not|don't|never|stop|cancel)\b.{0,30}\b(?:review|organize|summarize|consolidate)\b/i.test(source.data.content) || !/(?:整理|回顾|总结|归纳|梳理).{0,12}(?:记忆|长期事实|长期偏好)|(?:记忆).{0,12}(?:整理|回顾|总结|归纳|梳理)|\b(?:review|organize|summarize|consolidate)\b.{0,30}\bmemor(?:y|ies)\b/i.test(source.data.content)) return denied('MEMORY_USER_REQUEST_REQUIRED', '整理记忆须来自本次主会话认证用户的明确要求。')
    if (typeof review !== 'function') return denied('MEMORY_REVIEW_UNAVAILABLE', '后台整理暂不可用，尚未排队。')
    const result = await review(tx, card, entryId)
    if (result?.ok === false) return result
    return { ok: true, data: { ...(result?.data ?? result ?? {}), status: 'queued', notice: '已排入后台整理队列；这不代表新记忆已经保存，结果以整理完成回执为准。' } }
  }
  const documents = await service.get(tx, card.bot.id)
  files?.attach(documents, card.bot.id)
  if (documents[args.kind].file?.state === 'rejected') return denied(documents[args.kind].file.code, '记忆文件过长或无法读取，请先修正文件后重试。')
  if (call.name === 'memory_read') {
    const document = documents[args.kind]
    if (args.kind === 'personality') return { ok: true, data: document }
    const items = []
    for (const item of document.items) {
      let visible = true
      for (const ref of item.sourceEntries) if (!await readEntry(tx, ref, { botId: card.bot.id, kind: args.kind })) { visible = false; break }
      if (visible) items.push(item)
    }
    const offset = args.offset ?? 0, end = Math.min(items.length, offset + (args.limit ?? 8))
    return { ok: true, data: { kind: args.kind, version: document.version, items: items.slice(offset, end), total: items.length, nextOffset: end < items.length ? end : null } }
  }
  const source = await tx.entry(entryId)
  if (!memorySourceAllowed(card, source) || !/记住|记下|记入|忘掉|忘记|别再记|(?:修改|更改|更新|纠正|调整|清空|删除|保存).*(?:记忆|偏好|人格)|(?:记忆|偏好|人格).*(?:修改|更改|更新|纠正|调整|清空|删除|改为|改成)|\b(?:remember|forget|memorize)\b|(?:change|update|correct|delete|remove|clear).*(?:memory|preference|personality)/i.test(source.data.content)) return denied('MEMORY_USER_REQUEST_REQUIRED', '修改长期记忆须来自本次认证用户私聊的明确要求。')
  if (args.kind === 'personality' && !/人格|personality/i.test(source.data.content)) return denied('MEMORY_USER_REQUEST_REQUIRED', '人格只接受用户明确要求修改人格。')
  if (args.kind !== 'personality' && args.content && /日程|会议|预约|航班|行程|待办|明天|后天|下周|下个月|\d{4}-\d{2}-\d{2}|\d{1,2}[:：]\d{2}|\b(?:meeting|appointment|calendar|tomorrow|flight|todo)\b/i.test(args.content)) return denied('MEMORY_TRANSIENT_CONTENT', '日程、待办等时效信息请使用对应工具保存。')
  const requestId = `tool-${createHash('sha256').update(JSON.stringify([card.taskId, entryId, call.id])).digest('hex').slice(0, 48)}`
  const id = args.id ?? `item-${requestId.slice(5)}`
  const result = await service.edit(tx, { botId: card.bot.id, ...args, ...(args.kind === 'personality' ? {} : { id }), requestId,
    ...(['add', 'update', 'set'].includes(args.action) ? { sourceEntries: [{ taskId: card.taskId, entryId }] } : {}) })
  return result.ok ? { ok: true, data: { kind: args.kind, version: result.document.version, ...(args.kind === 'personality' ? {} : { id }), action: args.action, replayed: result.replayed } }
    : denied(result.code, '记忆未保存；版本冲突请先重新读取，其他错误请检查内容与来源。')
}
