export type SkillOption = { id: string; name?: string; description?: string; available: boolean; error?: { code?: string; message?: string } }
export type Command = { id: string; kind: 'skill' | 'action'; label: string; hint: string; keywords?: string[]; skillId?: string; disabled: string | null }
export const ACTIONS: { id: string; label: string; hint: string; keywords: string[] }[]
export function buildCommands(input: { skills?: SkillOption[]; group?: boolean; paused?: boolean }): Command[]
export function matchCommands(commands: Command[], draft: string | undefined): Command[]
