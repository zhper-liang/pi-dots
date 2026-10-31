export type CapabilityKind = 'tool' | 'skill' | 'mcp'
export type CapabilityItem = {
  id: string
  kind: CapabilityKind
  name: string
  description: string
  status: string
}
export type BotTemplate = { name: string; description: string; capabilities: string[] }
export const CAPABILITY_TABS: { id: CapabilityKind; label: string }[]
export const DEFAULT_CAPABILITIES: string[]
export const BOT_TEMPLATES: BotTemplate[]
export function visibleCapabilities<T extends CapabilityItem>(items: T[], botId: string | null): T[]
export function filterCapabilities<T extends CapabilityItem>(items: T[], tab: CapabilityKind, query: string): T[]
export function capabilityStatusLabel(status: string): string
