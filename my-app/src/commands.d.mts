export type SkillOption = { id: string; name?: string; description?: string; available: boolean; error?: { code?: string; message?: string } }
export type Command = { id: string; kind: 'skill' | 'action'; label: string; hint: string; keywords?: string[]; skillId?: string; disabled: string | null }
export const ACTIONS: { id: string; label: string; hint: string; keywords: string[] }[]
export function buildCommands(input: { skills?: SkillOption[]; group?: boolean; paused?: boolean }): Command[]
export function matchCommands(commands: Command[], draft: string | undefined): Command[]

export function isCommandDraft(draft: string | undefined): boolean
export type SuggestionKeyEvent = { key: string; defaultPrevented?: boolean; isComposing?: boolean; keyCode?: number; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }
export type SuggestionKeyAction = { type: 'move'; index: number } | { type: 'pick'; index: number } | { type: 'dismiss' }
export function suggestionKeyAction(event: SuggestionKeyEvent, index: number, count: number): SuggestionKeyAction | null
