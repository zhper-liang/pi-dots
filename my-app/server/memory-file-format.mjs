import { createHash } from 'node:crypto'
import { BOT_MEMORY_LIMITS, validId } from './bot-memory.mjs'

// Pure R2 file format: no I/O. Parsing is total and deterministic; rendering is canonical bytes per ledger version.
export const MEMORY_FILE_NAMES = Object.freeze({ personality: 'PROFILE.md', memory: 'MEMORY.md', preferences: 'USER.md' })
export const MEMORY_FILE_MAX_BYTES = 262144
export const MEMORY_FILE_HEADER = '<!-- pidot: 每行“- ”开头是一条记忆；续行缩进两个空格；行尾 id 注释用来保留来源，可以不写 -->'
const kinds = Object.keys(MEMORY_FILE_NAMES)
// No leading \s*: whitespace before the comment is removed by trim(), and the anchor-free prefix stays linear.
const ID_SUFFIX = /<!--\s*id:(\S*?)\s*-->$/
const decoder = new TextDecoder('utf-8', { fatal: true })
export const fileItemId = content => `file-${createHash('sha256').update(content).digest('hex').slice(0, 32)}`
const failure = code => ({ ok: false, code })

function decode(input) {
  if (typeof input === 'string') return input
  if (!(input instanceof Uint8Array)) throw new TypeError('Memory file input must be bytes or text')
  if (input.byteLength > MEMORY_FILE_MAX_BYTES) return null
  try { return decoder.decode(input) } catch { return undefined }
}

/** → { ok: true, value: { content } | { items: [{ id, content }] } } | { ok: false, code } */
export function parseMemoryFile(kind, input) {
  if (!kinds.includes(kind)) throw new TypeError('Unknown memory file kind')
  const decoded = decode(input)
  if (decoded === null) return failure('MEMORY_FILE_TOO_LONG')
  if (decoded === undefined) return failure('MEMORY_FILE_INVALID')
  if (Buffer.byteLength(decoded) > MEMORY_FILE_MAX_BYTES) return failure('MEMORY_FILE_TOO_LONG')
  const text = decoded.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (kind === 'personality') {
    const content = text.trim()
    return content.length > BOT_MEMORY_LIMITS.personalityChars ? failure('MEMORY_FILE_TOO_LONG') : { ok: true, value: { content } }
  }
  const raw = []
  let current = null, blanks = 0
  for (const line of text.split('\n')) {
    const continued = /^(?: {2}|\t)/.exec(line)
    if (current && continued) {
      for (; blanks > 0; blanks--) current.push('')
      current.push(line.slice(continued[0].length))
      continue
    }
    if (current && !line.trim()) { blanks++; continue }
    if (current) { raw.push(current); current = null; blanks = 0 }
    const trimmed = line.trim()
    if (!trimmed || /^#{1,6}(?:\s|$)/.test(trimmed) || /^<!--.*-->$/.test(trimmed)) continue
    current = [/^- /.test(line) ? line.slice(2) : trimmed === '-' ? '' : line]
  }
  if (current) raw.push(current)
  const items = [], seen = new Map()
  let total = 0
  for (const lines of raw) {
    const joined = lines.join('\n').trimEnd(), match = ID_SUFFIX.exec(joined)
    const content = (match ? joined.slice(0, match.index) : joined).trim()
    if (!content) continue
    if (content.length > BOT_MEMORY_LIMITS.contentChars) return failure('MEMORY_FILE_TOO_LONG')
    // Duplicates are resolved in file order: identical id+content drops, a clash re-derives from content.
    let id = match && validId(match[1]) ? match[1] : fileItemId(content)
    if (seen.has(id) && seen.get(id) === content) continue
    for (let n = 1; seen.has(id); n++) {
      id = n === 1 ? fileItemId(content) : `${fileItemId(content)}-${n}`
      if (seen.get(id) === content) { id = null; break }
    }
    if (id === null) continue
    seen.set(id, content)
    items.push({ id, content })
    total += content.length
  }
  if (items.length > BOT_MEMORY_LIMITS.items || total > BOT_MEMORY_LIMITS.documentChars) return failure('MEMORY_FILE_TOO_LONG')
  return { ok: true, value: { items } }
}

/** Canonical bytes for one ledger version: same input always yields the same text. */
export function renderMemoryFile(kind, document) {
  if (!kinds.includes(kind)) throw new TypeError('Unknown memory file kind')
  if (kind === 'personality') return document?.content ? `${document.content}\n` : ''
  const items = [...(document?.items ?? [])].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const lines = [MEMORY_FILE_HEADER]
  for (const item of items) {
    const body = item.content.split('\n')
    // Omit the id only when parsing would derive the same id and could not mistake content for an id comment.
    if (item.id !== fileItemId(item.content) || body.at(-1).endsWith('-->')) body[body.length - 1] += ` <!-- id:${item.id} -->`
    lines.push(`- ${body[0]}`, ...body.slice(1).map(line => line ? `  ${line}` : ''))
  }
  return `${lines.join('\n')}\n`
}

/** base/theirs: { content } or { items: [{ id, content }] }. Output is the file actor's patch list. */
export function diffMemoryFile(kind, base, theirs) {
  if (!kinds.includes(kind)) throw new TypeError('Unknown memory file kind')
  if (kind === 'personality') return (base?.content ?? '') === theirs.content ? [] : [{ action: 'set', content: theirs.content }]
  const before = new Map((base?.items ?? []).map(item => [item.id, item.content])), after = new Map(theirs.items.map(item => [item.id, item.content]))
  const patches = []
  for (const [id, content] of before) {
    if (!after.has(id)) patches.push({ action: 'delete', id })
    else if (after.get(id) !== content) patches.push({ action: 'update', id, content: after.get(id) })
  }
  for (const item of theirs.items) if (!before.has(item.id)) patches.push({ action: 'add', id: item.id, content: item.content })
  return patches
}

/** True when a parsed file says exactly what the ledger document says (ids and contents, order-free). */
export function sameMemoryContent(kind, parsed, document) {
  if (kind === 'personality') return parsed.content === (document?.content ?? '')
  const items = document?.items ?? []
  if (parsed.items.length !== items.length) return false
  const map = new Map(items.map(item => [item.id, item.content]))
  return parsed.items.every(item => map.get(item.id) === item.content)
}
