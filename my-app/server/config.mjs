/** Local API authentication is separate from provider credentials. */
export function readConfig(env = process.env) {
  const token = env.PIDOT_API_TOKEN
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) {
    throw new Error('PIDOT_API_TOKEN 必须为 32–256 位不含空白的 ASCII 字符，请按 README 生成。')
  }
  const rawPort = env.PIDOT_API_PORT ?? '3001'
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PIDOT_API_PORT 必须为 1–65535 的整数。')
  }
  return { host: '127.0.0.1', port: Number(rawPort), token }
}

/** New Task defaults only; existing snapshots and cumulative counters remain unchanged. */
export function readExecutionDefaults(env = process.env) {
  const integer = (name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    if (env[name] === undefined) return fallback
    const raw = env[name], value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 须为 ${min}–${max} 的整数。`)
    return value
  }
  let contextWindows
  if (env.PIDOT_CONTEXT_WINDOWS !== undefined) {
    try { contextWindows = JSON.parse(env.PIDOT_CONTEXT_WINDOWS) } catch { throw new Error('PIDOT_CONTEXT_WINDOWS 须为模型ID到已核实Token容量的JSON对象。') }
    if (!contextWindows || typeof contextWindows !== 'object' || Array.isArray(contextWindows) || !Object.keys(contextWindows).length ||
      Object.entries(contextWindows).some(([id, capacity]) => !/^[\w./:-]{1,200}$/.test(id) || !Number.isSafeInteger(capacity) || capacity < 8192 || capacity > 4000000)) {
      throw new Error('PIDOT_CONTEXT_WINDOWS 容量须为8192–4000000的整数，不得猜测模型容量。')
    }
  }
  const totalTokens = integer('PIDOT_DEFAULT_TOTAL_TOKENS', undefined)
  return { ...(contextWindows ? { contextWindows } : {}), callLimits: { modelCalls: integer('PIDOT_DEFAULT_MODEL_CALLS', 20), toolCalls: integer('PIDOT_DEFAULT_TOOL_CALLS', 10),
    ...(totalTokens === undefined ? {} : { totalTokens }) }, maxOutputTokens: integer('PIDOT_MAX_OUTPUT_TOKENS', 4096, 1, 32768) }
}
