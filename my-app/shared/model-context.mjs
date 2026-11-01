// DSH-style token spelling: K=1000, M=1000000. A blank field uses 256K.
export const DEFAULT_CONTEXT_WINDOW = 256000
export function parseContextWindow(value) {
  if (value === undefined || value === '') return DEFAULT_CONTEXT_WINDOW
  let tokens = value
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i)
    if (!match) throw new Error('上下文容量须为 8192–4000000 tokens，可填写 256K 或 1M。')
    tokens = Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2]?.toLowerCase()] ?? 1)
  }
  if (!Number.isSafeInteger(tokens) || tokens < 8192 || tokens > 4000000) throw new Error('上下文容量须为 8192–4000000 tokens。')
  return tokens
}
export function formatContextWindow(value = DEFAULT_CONTEXT_WINDOW) {
  return value % 1000000 === 0 ? `${value / 1000000}M` : value % 1000 === 0 ? `${value / 1000}K` : String(value)
}
