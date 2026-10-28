export const FOCUSABLE: string
export function trapTarget(count: number, index: number, shift: boolean): number | 'root' | null
export function drawerStack(): { open(id: string): void; close(id: string): void; isTop(id: string): boolean }
export function closesOnKey(event: { key: string; defaultPrevented: boolean; isComposing: boolean }): boolean
