type DayEvent = { title: string; start?: string; end?: string }
export function nextEvent<T extends DayEvent>(events: T[], now: number): T | null
export function todayParts(input: { authorized?: boolean; events?: DayEvent[]; todos?: { due?: string | null }[]; confirmations?: number; now: number; day: string }): string[]
