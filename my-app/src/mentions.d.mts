export type MentionBot = { id: string; name: string; description?: string; status?: 'active' | 'inactive'; deactivatedAt?: string }
export type MentionContext = { kind: 'direct'; currentBotId: string } | { kind: 'group'; memberBotIds: readonly string[] }
export type MentionToken = { start: number; end: number; query: string; text: string; selectionStart: number; selectionEnd: number }
export type MentionAction = 'mention' | 'switch-bot' | 'unavailable'
export type MentionCandidate = { id: string; botId: string; label: string; hint: string; action: MentionAction; actionLabel: string; disabled: string | null }
export type MentionBinding = { botId: string; start: number; end: number; text: string }
export type MentionPick = {
  botId: string
  action: 'mention' | 'switch-bot'
  draft: string
  selectionStart: number
  selectionEnd: number
  replacement: { start: number; end: number; text: string }
  binding: MentionBinding
  bindings: MentionBinding[]
  targetBotIds: string[]
}
export function findMentionToken(draft: string, selectionStart: number, selectionEnd?: number): MentionToken | null
export function buildMentionCandidates(bots: readonly MentionBot[], context: MentionContext, query?: string): MentionCandidate[]
export function reconcileMentions(previousDraft: string, nextDraft: string, bindings?: readonly MentionBinding[]): MentionBinding[]
export function mentionTargetIds(draft: string, bindings?: readonly MentionBinding[]): string[]
export function applyMention(draft: string, token: MentionToken | null, candidate: MentionCandidate, options?: { bindings?: readonly MentionBinding[]; maxLength?: number }): MentionPick | null
