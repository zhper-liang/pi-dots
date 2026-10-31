export type WorkspaceView = 'home' | 'chats' | 'items' | 'inbox' | 'settings'
export type ItemTab = 'calendar' | 'routines' | 'runs' | 'todos' | 'automation'
export const workspaceViews: { id: WorkspaceView; label: string; description: string }[]
export const itemTabs: { id: ItemTab; label: string }[]
export function nextTab<T extends string>(ids: T[], current: T, key: string): T
export function nextItemTab(current: ItemTab, key: string): ItemTab

export function resolveItemTab(tab: ItemTab): Exclude<ItemTab, 'todos' | 'automation'>
export function isLegacyTodoHash(hash: string): boolean
