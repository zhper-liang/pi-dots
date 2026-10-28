// Top-level destinations of the shell. "Home" is the Chief main session; 今天 moved into 事项.
export const workspaceViews = [
  { id: 'home', label: 'Chief', description: '和 Chief 对话，派活给其他 Bot' },
  { id: 'chats', label: '会话', description: '和 Bot 或群聊对话' },
  { id: 'items', label: '事项', description: '今天、日历、待办和自动化放在一处' },
  { id: 'inbox', label: '通知', description: '需要你处理的事和事项提醒' },
  { id: 'settings', label: '设置', description: '数据来源、连接状态与模型说明' },
]
// Sub-tabs of 事项. Each stays mounted while hidden so drafts and pending requests survive a switch.
export const itemTabs = [
  { id: 'today', label: '今天' },
  { id: 'calendar', label: '日历' },
  { id: 'todos', label: '待办' },
  { id: 'automation', label: '自动化' },
]
/** Roving keyboard focus across a tab list: arrows wrap, Home/End jump, other keys keep the tab. */
export function nextTab(ids, current, key) {
  const index = Math.max(0, ids.indexOf(current))
  if (key === 'Home') return ids[0]
  if (key === 'End') return ids.at(-1)
  if (key === 'ArrowRight') return ids[(index + 1) % ids.length]
  if (key === 'ArrowLeft') return ids[(index + ids.length - 1) % ids.length]
  return current
}
export const nextItemTab = (current, key) => nextTab(itemTabs.map((tab) => tab.id), current, key)
