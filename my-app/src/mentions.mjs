import { isCommandDraft } from './commands.mjs'

const tokenCharacter = /[^\s@＠，。！？、；：,.!?;:]/u
const separator = /[\s@＠，。！？、；：,.!?;:]/u
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase()

// Inspect the original text, not a normalized copy: textarea offsets are UTF-16 offsets.
// Code, quotations and block quotes are data, including unfinished code/quote spans.
function isProseAt(draft, offset) {
  let fence = null
  let lineStart = 0
  for (const line of draft.split('\n')) {
    const current = offset <= lineStart + line.length
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (current) return false
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
    } else if (current) {
      if (fence || /^\s*>/.test(line)) return false
      let code = 0
      let quote = null
      const end = offset - lineStart
      for (let i = 0; i < end; i++) {
        const char = line[i]
        if (char === '\\') { i++; continue }
        if (char === '`' && !quote) {
          let length = 1
          while (line[i + length] === '`') length++
          if (!code) code = length
          else if (length === code) code = 0
          i += length - 1
          continue
        }
        if (code) continue
        if (quote) { if (char === quote) quote = null }
        else if (char === '"' || char === '“' || char === '「') quote = char === '“' ? '”' : char === '「' ? '」' : '"'
      }
      return !code && !quote
    }
    lineStart += line.length + 1
  }
  return false
}

/** A collapsed caret inside a prose @token; [start,end) replaces the entire token. */
export function findMentionToken(draft, selectionStart, selectionEnd = selectionStart) {
  if (typeof draft !== 'string' || isCommandDraft(draft) || !Number.isInteger(selectionStart) ||
    selectionStart < 0 || selectionStart > draft.length || selectionEnd !== selectionStart) return null
  let start = selectionStart - 1
  while (start >= 0 && tokenCharacter.test(draft[start])) start--
  if (start < 0 || !'@＠'.includes(draft[start]) || start > 0 && !/\s/u.test(draft[start - 1]) || !isProseAt(draft, start)) return null
  let end = selectionStart
  while (end < draft.length && tokenCharacter.test(draft[end])) end++
  if (/[\\/]/.test(draft.slice(start, end))) return null
  return { start, end, query: draft.slice(start + 1, selectionStart), text: draft.slice(start, end), selectionStart, selectionEnd }
}

/** Candidates carry stable IDs. These labels are never authority for routing or permission. */
export function buildMentionCandidates(bots, context, query = '') {
  const q = normalize(query)
  const members = new Set(context.kind === 'group' ? context.memberBotIds : [])
  const seen = new Set()
  return bots.filter(bot => {
    if (!bot.id || seen.has(bot.id) || bot.deactivatedAt || bot.status !== undefined && bot.status !== 'active') return false
    seen.add(bot.id)
    return true
  }).map((bot, index) => {
    const label = bot.name.trim() || bot.id
    const member = context.kind !== 'group' || members.has(bot.id)
    const action = !member ? 'unavailable' : context.kind === 'direct' && bot.id !== context.currentBotId ? 'switch-bot' : 'mention'
    const rank = !q || normalize(label).includes(q) ? 0 : normalize(bot.id).includes(q) ? 1 : normalize(bot.description).includes(q) ? 2 : 3
    return { index, rank, candidate: {
      id: bot.id, botId: bot.id, label, hint: bot.description ?? '', action,
      actionLabel: action === 'switch-bot' ? '转到这个机器人的会话，带上未发送的草稿' : action === 'unavailable' ? '加入后 @' : '在当前会话 @',
      disabled: member ? null : '还不是群成员，暂时不能 @',
    } }
  }).filter(item => item.rank < 3).sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.candidate)
}

function validBinding(draft, binding) {
  return Boolean(binding && typeof binding.botId === 'string' && binding.botId &&
    Number.isInteger(binding.start) && Number.isInteger(binding.end) && binding.start >= 0 && binding.end > binding.start && binding.end <= draft.length &&
    typeof binding.text === 'string' && /^[@＠].+/u.test(binding.text) && draft.slice(binding.start, binding.end) === binding.text &&
    (binding.start === 0 || /\s/u.test(draft[binding.start - 1])) &&
    (binding.end === draft.length || separator.test(draft[binding.end])) && isProseAt(draft, binding.start))
}

/** Preserve only explicitly selected spans. Editing a span never infers a new botId. */
export function reconcileMentions(previousDraft, nextDraft, bindings = []) {
  let prefix = 0
  while (prefix < previousDraft.length && prefix < nextDraft.length && previousDraft[prefix] === nextDraft[prefix]) prefix++
  let suffix = 0
  while (suffix < previousDraft.length && suffix < nextDraft.length &&
    previousDraft[previousDraft.length - 1 - suffix] === nextDraft[nextDraft.length - 1 - suffix]) suffix++
  // Repeated text can make an edit position ambiguous (deleting either '@同名 ').
  // Invalidate the union of possible edit spans rather than keep the wrong botId.
  const commonLength = Math.min(previousDraft.length, nextDraft.length)
  const safePrefix = Math.min(prefix, commonLength - suffix)
  const safeSuffix = Math.min(suffix, commonLength - prefix)
  const oldEnd = previousDraft.length - safeSuffix
  const delta = nextDraft.length - previousDraft.length
  const result = []
  for (const binding of bindings) {
    if (!validBinding(previousDraft, binding)) continue
    let next
    if (previousDraft === nextDraft || binding.end <= safePrefix) next = { ...binding }
    else if (binding.start >= oldEnd) next = { ...binding, start: binding.start + delta, end: binding.end + delta }
    else {
      // A shared '@' or trailing space can overlap the diff although a whole, unique
      // mention survived. Keep that span, but never guess between identical tokens.
      const alternatives = []
      if (binding.end <= prefix) alternatives.push({ ...binding })
      if (binding.start >= previousDraft.length - suffix) alternatives.push({ ...binding, start: binding.start + delta, end: binding.end + delta })
      const possible = alternatives.filter(item => validBinding(nextDraft, item))
      if (!possible.length || possible.some(item => item.start !== possible[0].start)) continue
      let occurrences = 0
      for (let start = previousDraft.indexOf(binding.text); start !== -1; start = previousDraft.indexOf(binding.text, start + 1)) {
        if (validBinding(previousDraft, { ...binding, start, end: start + binding.text.length })) occurrences++
      }
      if (occurrences > 1) continue
      next = possible[0]
    }
    if (validBinding(nextDraft, next)) result.push(next)
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** First selected occurrence wins; unselected literal @names are not converted to IDs. */
export function mentionTargetIds(draft, bindings = []) {
  return [...new Set(bindings.filter(binding => validBinding(draft, binding)).sort((a, b) => a.start - b.start || a.end - b.end).map(binding => binding.botId))]
}

/** Pure draft edit only. The caller owns navigation, persistence, focus and sending. */
export function applyMention(draft, token, candidate, { bindings = [], maxLength = 4000 } = {}) {
  if (!token || candidate.disabled || candidate.action === 'unavailable') return null
  const current = findMentionToken(draft, token.selectionStart, token.selectionEnd)
  if (!current || current.start !== token.start || current.end !== token.end || current.text !== token.text || current.query !== token.query) return null
  const text = `@${candidate.label}`
  const trailing = draft.slice(token.end)
  const inserted = text + (!trailing || !separator.test(trailing[0]) || '@＠'.includes(trailing[0]) ? ' ' : '')
  const nextDraft = draft.slice(0, token.start) + inserted + trailing
  if (nextDraft.length > maxLength) return null
  const binding = { botId: candidate.botId, start: token.start, end: token.start + text.length, text }
  const nextBindings = [...reconcileMentions(draft, nextDraft, bindings).filter(item => item.end <= binding.start || item.start >= binding.end), binding]
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const caret = token.start + inserted.length + (/^[ \t]/.test(trailing) ? 1 : 0)
  return { botId: candidate.botId, action: candidate.action, draft: nextDraft, selectionStart: caret, selectionEnd: caret,
    replacement: { start: token.start, end: token.end, text: inserted }, binding, bindings: nextBindings, targetBotIds: mentionTargetIds(nextDraft, nextBindings) }
}
