export type CardKind = 'approval' | 'blocker' | 'mirror' | 'finding' | 'auto-applied' | 'summary' | 'routine-proposal' | 'bot-management'
export type CardTone = 'attention' | 'busy' | 'muted'
export type CardAction = 'approve' | 'always' | 'reject' | 'answer' | 'undo' | 'handle' | 'assist' | 'dismiss' | 'mute'
export type CardInput = { kind: CardKind | string; state?: string; detector?: string; toolName?: string; retry?: boolean; allowAlways?: boolean; assist?: boolean }
export const CARD_KINDS: Record<CardKind, { label: string; tone: CardTone }>
export const DETECTOR_LABELS: Record<string, string>
export const ALWAYS_WARNING: string
export function stateLabel(kind: string, state?: string): string
export function canAlways(card: CardInput): boolean
export function cardActions(card: CardInput): CardAction[]
export function cardView(card: CardInput): { kind: CardKind; label: string; tone: CardTone; state: string; waiting: boolean; actions: CardAction[] }
export function mirrorCard(item: { mirrorKind: string; toolName?: string; live?: string; outcome?: string; allowAlways?: boolean; retryOf?: unknown }): CardInput
export function inboxCard(item: { kind: string; detail?: Record<string, unknown> }): CardInput
export function openApproval(item: { receipt?: unknown; operation?: unknown }, cancelled?: boolean): boolean
export function openBlocker(item: { status: string }, cancelled?: boolean): boolean
