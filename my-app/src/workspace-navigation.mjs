export const workspaceViews = [
  { id: 'today', label: '今天', description: '今天的日程、到期待办和待你确认的事项' },
  { id: 'calendar', label: '日历', description: '本地与飞书日程；显示的缓存不代表已写入飞书' },
  { id: 'todos', label: '待办', description: '记录要做的事，可关联到任务' },
  { id: 'inbox', label: '收件箱', description: '通知、提醒和需要你逐项确认的操作' },
  { id: 'automation', label: '自动化', description: '定时任务与每次执行的记录，可随时暂停或取消' },
  { id: 'settings', label: '设置', description: '数据来源、连接状态与模型说明' },
  { id: 'chats', label: '任务', description: '和 Bot 对话' },
]
export function nextWorkspaceView(current, key) {
  const index = Math.max(0, workspaceViews.findIndex(view => view.id === current))
  if (key === 'Home') return workspaceViews[0].id
  if (key === 'End') return workspaceViews.at(-1).id
  if (key === 'ArrowRight') return workspaceViews[(index + 1) % workspaceViews.length].id
  if (key === 'ArrowLeft') return workspaceViews[(index + workspaceViews.length - 1) % workspaceViews.length].id
  return current
}
