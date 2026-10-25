export type WorkspaceView = 'today' | 'calendar' | 'todos' | 'inbox' | 'automation' | 'settings' | 'chats'
export const workspaceViews: { id: WorkspaceView; label: string; description: string }[]
export function nextWorkspaceView(current: WorkspaceView, key: string): WorkspaceView
