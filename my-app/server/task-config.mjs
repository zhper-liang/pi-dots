export class TaskInputError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => { throw new TaskInputError(400, code, message) }
const modelId = (value) => typeof value === 'string' && /^[\w./:-]{1,200}$/.test(value)

/** Only ordinary configuration can be overridden; identity, endpoints and tools stay server-owned. */
export function taskParameters(overrides, defaults) {
  if (overrides === undefined) return structuredClone(defaults)
  if (!object(overrides) || !Object.keys(overrides).length ||
    Object.keys(overrides).some((key) => !['model', 'thinkingLevel', 'requestTimeoutMs', 'maxOutputTokens', 'callLimits'].includes(key))) {
    fail('INVALID_TASK', '参数仅支持 model、thinkingLevel、requestTimeoutMs、maxOutputTokens 和 callLimits；不能覆盖身份、地址或工具授权。')
  }
  const parameters = structuredClone(defaults)
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'model') {
      if (defaults.mode !== 'model' || !object(value) || Object.keys(value).length !== 1 || !modelId(value.id)) {
        fail('INVALID_PARAMETERS', 'model 仅接受当前服务端接口下的模型 id；测试 Task 不能切换真实模型。')
      }
      parameters.model = { ...parameters.model, id: value.id }
    } else if (key === 'thinkingLevel') {
      // The approved bb-api adapter currently supports explicit off only, never guess provider effort values.
      if (value !== 'off') fail('INVALID_PARAMETERS', '当前模型接入仅支持 thinkingLevel=off。')
      parameters.thinkingLevel = value
    } else if (key === 'maxOutputTokens') {
      if (!Number.isSafeInteger(value) || value < 1 || value > 32768) fail('INVALID_PARAMETERS', 'maxOutputTokens 须为 1–32768 的整数。')
      parameters.maxOutputTokens = value
    } else if (key === 'requestTimeoutMs') {
      if (defaults.mode !== 'model' || !Number.isInteger(value) || value < 1 || value > 600000) {
        fail('INVALID_PARAMETERS', '真实模型请求超时须为 1–600000 毫秒的整数。')
      }
      parameters.requestTimeoutMs = value
    } else {
      if (value !== null && (!object(value) || !Object.keys(value).length || Object.entries(value).some(([name, limit]) =>
        !['modelCalls', 'toolCalls', 'totalTokens'].includes(name) || !Number.isSafeInteger(limit) || limit < 0))) {
        fail('INVALID_PARAMETERS', 'callLimits 须为 null，或包含非负整数 modelCalls、toolCalls、totalTokens 的对象。')
      }
      parameters.callLimits = { modelCalls: 20, toolCalls: 10, ...structuredClone(defaults.callLimits ?? {}), ...structuredClone(value ?? {}) }
    }
  }
  return parameters
}

export function parseTaskState(input) {
  if (!object(input) || !Object.keys(input).length || Object.keys(input).some((key) => !['goal', 'completionCriteria', 'constraints'].includes(key))) {
    fail('INVALID_TASK_STATE', '任务状态仅支持 goal、completionCriteria 和 constraints，至少提供一项。')
  }
  const state = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'goal') {
      if (typeof value !== 'string' || !value.trim() || value.length > 4000) fail('INVALID_TASK_STATE', '目标须为 1–4000 个字符的非空字符串。')
      state[key] = value.trim()
    } else {
      if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 1000)) {
        fail('INVALID_TASK_STATE', '完成标准与有效限制须为字符串数组，最多 20 项，每项 1–1000 个字符；空数组表示清除。')
      }
      state[key] = value.map((item) => item.trim())
    }
  }
  return state
}

// Existing cards remain readable without rewriting their frozen config or fabricating provenance.
export function currentTaskState(card) {
  return card.taskState ?? { goal: card.title, completionCriteria: [], constraints: [] }
}

export function currentTaskStateSources(card) {
  return card.taskStateSources ?? { goal: { type: 'legacy-title', source: 'task-card.title' },
    completionCriteria: { type: 'legacy-default', source: 'not-recorded' },
    constraints: { type: 'legacy-default', source: 'not-recorded' } }
}

/** Explicit, monotonic Task limit change; never resets counters or changes identity. */
export function raisedCallLimits(input, current, usage) {
  if (!object(input) || !Object.keys(input).length || Object.entries(input).some(([key, value]) =>
    !['modelCalls', 'toolCalls', 'totalTokens'].includes(key) ||
    !(key === 'totalTokens' && value === null && usage.unknownTokenCalls > 0 && current.totalTokens !== undefined) &&
    (!Number.isSafeInteger(value) || value < 0))) fail('INVALID_CALL_LIMITS', '仅接受非负整数调用上限；用量未知时可显式设 totalTokens=null 取消 Token 阈值。')
  const next = { ...current }
  let changed = false
  for (const [key, value] of Object.entries(input)) {
    if (value === null) { delete next[key]; changed = true; continue }
    if (current[key] === undefined || value < current[key]) fail('INVALID_CALL_LIMITS', '此入口仅允许提高已有上限，不能降低或新增限制。')
    if (value > current[key]) changed = true
    next[key] = value
  }
  if (!changed) fail('INVALID_CALL_LIMITS', '请显式提高至少一项上限；计数不会清零。')
  return next
}
