export type CapabilityChange = { botId?: string; revision?: string }
export function publishCapabilityChange(change?: CapabilityChange): void
export function subscribeCapabilityChanges(listener: (change: CapabilityChange) => void): () => void
