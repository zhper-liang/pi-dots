export type BotTab = 'chat' | 'capabilities' | 'memory' | 'settings'
export const botTabs: { id: Exclude<BotTab, 'chat'>; label: string }[]
export function readBotTab(hash: string): BotTab
export function botDetailHash(botId: string, tab?: BotTab): string
export function directoryBots<T extends { name: string; description: string }>(bots: T[], query?: string): T[]
export function credentialBots<T extends { id: string; status?: string }>(bots: T[], fixedBotId?: string): T[]
export function credentialClients<T extends { botId: string }>(clients: T[], fixedBotId?: string): T[]
