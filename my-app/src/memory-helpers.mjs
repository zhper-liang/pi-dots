const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value

/** One unresolved mutation retains its request identity, even if delivery is ambiguous. */
export function createMemoryRequestTracker(makeId = () => crypto.randomUUID()) {
  let saved = null
  return {
    prepare(body) {
      const signature = JSON.stringify(canonical(body))
      if (saved && saved.signature !== signature) throw new Error('请先核对上一次保存结果，再修改草稿。')
      if (!saved) saved = { signature, request: { ...structuredClone(body), requestId: makeId() } }
      return structuredClone(saved.request)
    },
    settle() { saved = null },
  }
}

export function memoryErrorMessage(code) {
  const messages = {
    MEMORY_VERSION_CONFLICT: '内容已在别处更新。你的草稿仍保留，请对照当前版本后再保存。',
    MEMORY_ITEM_CONFLICT: '这条内容已被修改或删除。你的草稿仍保留，请核对当前版本。',
    MEMORY_REQUEST_CONFLICT: '上一次保存需要核对。请重新读取当前内容；你的草稿不会被覆盖。',
    MEMORY_CREDENTIAL_REJECTED: '内容可能包含凭证，未保存。请移除敏感内容。',
    MEMORY_SOURCE_REQUIRED: '缺少可核实的对话来源，未保存。请先在对话中说明。',
    MEMORY_SOURCE_INVALID: '对话来源不可用，未保存。请核对来源。',
    MEMORY_CONTENT_LIMIT: '内容过长，未保存。请缩短后再试。',
    MEMORY_DOCUMENT_LIMIT: '记忆已满，未保存。请精简内容后再试。',
    MEMORY_BUDGET_EXHAUSTED: '待处理：本次整理额度已用完，现有内容保持不变。',
    MEMORY_EXTRACTION_PENDING: '待处理：正在等待整理，现有内容保持不变。',
    MEMORY_EXTRACTION_FAILED: '待处理：本次整理未完成，现有内容保持不变。',
  }
  return messages[code] ?? '记忆操作未完成，请核对内容后重试。'
}

export function memoryDate(value) {
  if (!value) return '尚未更新'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '更新时间不可用' : date.toLocaleString('zh-CN')
}

const ACTOR_LABELS = { user: '你编辑的', candidate: '对话整理', file: '文件修改' }
export function memoryActorLabel(actor) {
  return Object.hasOwn(ACTOR_LABELS, actor) ? ACTOR_LABELS[actor] : '已更新'
}

/** An item with an explicit empty source list was written by hand (file or UI), not extracted from a conversation. */
export function memoryHandwritten(item) {
  return Array.isArray(item?.sourceEntries) && item.sourceEntries.length === 0
}

/** Save confirmation; while the file is rejected the Bot gets nothing from this document, so do not promise it. */
export function memorySavedNotice(action, file) {
  if (action === 'delete') return '已删除，编辑历史仍保留。'
  return file?.state === 'rejected' ? '已保存。这份文件现在无法使用，Bot 暂时拿不到它的内容，修好文件后恢复。' : '已保存，所有会话的下一次模型调用会读取最新内容。'
}

// Mirrors BOT_MEMORY_LIMITS so the user knows how far to trim; the server stays the authority.
const FILE_LIMITS = { personality: '人格最多 8192 字', memory: '最多 64 条、每条 2048 字、合计 16384 字', preferences: '最多 64 条、每条 2048 字、合计 16384 字' }
/** Plain-Chinese file state for the memory pages. Never shows codes, OS errors or anything beyond the relative path. */
export function memoryFileView(file, kind) {
  if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !file.path) return null
  const time = file.syncedAt ? new Date(file.syncedAt) : null
  const synced = time ? Number.isNaN(time.getTime()) ? '同步时间不可用' : time.toLocaleString('zh-CN')
    : file.state === 'synced' ? '还没有生成文件，有内容后自动创建' : '尚未同步'
  const reasons = {
    MEMORY_FILE_TOO_LONG: `文件太长，超出记忆上限（${FILE_LIMITS[kind] ?? FILE_LIMITS.memory}），Bot 暂时拿不到这份文件的内容。精简后保存，会自动恢复。`,
    MEMORY_FILE_INVALID: '文件无法读取（可能不是 UTF-8 编码），Bot 暂时拿不到这份文件的内容。改正后保存，会自动恢复。',
    MEMORY_FILE_UNAVAILABLE: '文件不可访问（可能是链接或权限问题），Bot 暂时拿不到这份文件的内容。修复后会自动恢复。',
    MEMORY_FILE_WRITE_FAILED: '最新内容已保存，Bot 照常使用；写入文件失败，稍后自动重试。',
  }
  const reason = file.state === 'rejected' || file.state === 'pending'
    ? Object.hasOwn(reasons, file.code) ? reasons[file.code] : file.state === 'pending' ? '文件暂时没有同步，稍后自动重试。' : '文件暂时无法使用，Bot 暂时拿不到这份文件的内容。'
    : null
  return { path: file.path, synced, reason }
}

/** An external refresh never rebases a user's draft without explicit confirmation. */
export function reconcileMemoryDraft(draft, document) {
  return { draft, current: document, conflicted: !!draft && draft.expectedVersion !== document.version }
}

/** Resolve provenance through the authenticated Task API, never the currently selected Bot. */
export async function resolveMemorySourceHash(token, source, signal, fetcher = (...args) => fetch(...args)) {
  const unavailable = () => new Error('无法打开这条来源，原消息可能已不可见。请刷新后核对。')
  if (!Number.isSafeInteger(source?.taskId) || source.taskId < 1 || !Number.isSafeInteger(source?.entryId) || source.entryId < 1) throw unavailable()
  const response = await fetcher(`/api/tasks/${source.taskId}`, { headers: { Authorization: `Bearer ${token}` }, signal })
  if (!response.ok) throw unavailable()
  const { task } = await response.json()
  if (task?.taskId !== source.taskId || typeof task.bot?.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(task.bot.id) || task.kind === 'group' || task.groupId || !Array.isArray(task.messages) || !task.messages.some(message => message.id === source.entryId)) throw unavailable()
  return `#${new URLSearchParams({ bot: task.bot.id, task: String(source.taskId), message: String(source.entryId) })}`
}
