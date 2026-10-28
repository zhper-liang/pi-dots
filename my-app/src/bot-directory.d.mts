export type BotTab = 'chat' | 'rules' | 'skills' | 'mcp' | 'memory' | 'settings' | 'tasks'
export const botTabs: { id: BotTab; label: string }[]
export function readBotTab(hash: string): BotTab
export function botDetailHash(botId: string, tab?: BotTab): string
export function tasksForBot<T extends { bot?: { id: string }; kind?: string }>(tasks: T[], botId: string): T[]
export function directoryBots<T extends { name: string; description: string }>(bots: T[], query?: string): T[]
export function credentialBots<T extends { id: string; status?: string }>(bots: T[], fixedBotId?: string): T[]
export function credentialClients<T extends { botId: string }>(clients: T[], fixedBotId?: string): T[]
type Skill = { id: string; available: boolean; error?: { code: string; message: string; missing?: string[] } }
export function mergeBotSkills<T extends Skill>(catalog: T[], available: T[], hasMainTask: boolean): T[]
