import { useMemo, type RefObject } from 'react'
import ComposerSuggestions from './ComposerSuggestions'
import BotAvatar from './BotAvatar'
import { loadLook } from './botLook'
import { applyMention, buildMentionCandidates, findMentionToken, type MentionBinding, type MentionBot, type MentionContext, type MentionPick } from './mentions.mjs'

export type MentionMenuProps = {
  bots: readonly MentionBot[]
  context: MentionContext
  draft: string
  selectionStart: number
  selectionEnd?: number
  inputRef: RefObject<HTMLTextAreaElement | null>
  onPick: (pick: MentionPick) => void
  bindings?: readonly MentionBinding[]
  disabled?: boolean
  maxLength?: number
  scopeKey?: string | number
}

// No network, send, group mutation or navigation here: a private target switch is only
// an onPick payload. The App owns per-Task drafts, selected spans and explicit routing.
export default function MentionMenu({ bots, context, draft, selectionStart, selectionEnd = selectionStart, inputRef, onPick,
  bindings = [], disabled = false, maxLength = 4000, scopeKey = '' }: MentionMenuProps) {
  const token = disabled ? null : findMentionToken(draft, selectionStart, selectionEnd)
  const query = token?.query ?? ''
  const candidates = useMemo(() => buildMentionCandidates(bots, context, query), [bots, context, query])
  const items = candidates.map(candidate => candidate.disabled || !token || applyMention(draft, token, candidate, { bindings, maxLength }) ? candidate :
    { ...candidate, disabled: `选择后会超出 ${maxLength} 字符限制，请先缩短草稿` })
  return <ComposerSuggestions enabled={Boolean(token)} sessionKey={JSON.stringify([scopeKey, context, draft, selectionStart, selectionEnd])}
    label="选择机器人" items={items} inputRef={inputRef} emptyLabel="没有匹配的机器人"
    onPick={candidate => {
      if (!token) return
      // Reject a stale event if a textarea edit/selection happened before React rerendered.
      const input = inputRef.current
      if (!input || input.value !== draft || input.selectionStart !== selectionStart || input.selectionEnd !== selectionEnd) return
      const pick = applyMention(draft, token, candidate, { bindings, maxLength })
      if (pick) onPick(pick)
    }}
    renderLeading={candidate => <BotAvatar name={candidate.label} look={loadLook(candidate.botId)} size={28} />}
    renderLabel={candidate => <>{candidate.label}<span className="composer-suggestion-id">{candidate.botId}</span></>}
    renderDetail={candidate => candidate.actionLabel} />
}
