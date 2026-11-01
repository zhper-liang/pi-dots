// Top-level destinations of the shell. "Home" is the Chief main session; 今天 moved into 事项.
export const workspaceViews = [
  { id: 'home', label: 'pipi', description: '和 pipi 对话，派活给其他机器人' },
  { id: 'chats', label: '会话', description: '和机器人或群聊对话' },
  { id: 'items', label: '事项', description: '日历、定时任务和执行记录' },
  { id: 'inbox', label: '通知', description: '需要你处理的事和提醒' },
  { id: 'settings', label: '设置', description: '连接、模型、自动化和偏好' },
]
// Sub-tabs of 事项. Each stays mounted while hidden so drafts and pending requests survive a switch.
export const itemTabs = [
  { id: 'calendar', label: '日历' },
  { id: 'routines', label: '定时任务' },
  { id: 'runs', label: '执行记录' },
]
/** Old Todo hashes remain valid but now land on the calendar without mounting a hidden Todo UI. */
export const resolveItemTab = tab => tab === 'todos' ? 'calendar' : tab === 'automation' ? 'routines' : tab

/** Narrow compatibility for old Todo links; never override a Bot/Task destination. */
export function isLegacyTodoHash(hash) {
  const value = hash.replace(/^#/, '')
  if (['todo', 'todos', 'items/todos', '/items/todos'].includes(value)) return true
  const params = new URLSearchParams(value)
  if (['bot', 'task', 'new', 'new-bot', 'bots'].some(key => params.has(key))) return false
  return params.has('todos') || params.get('view') === 'todos' || params.get('items') === 'todos'
    || params.get('itemTab') === 'todos' || params.get('tab') === 'todos'
}

/** Roving keyboard focus across a tab list: arrows wrap, Home/End jump, other keys keep the tab. */
export function nextTab(ids, current, key) {
  const index = Math.max(0, ids.indexOf(current))
  if (key === 'Home') return ids[0]
  if (key === 'End') return ids.at(-1)
  if (key === 'ArrowRight') return ids[(index + 1) % ids.length]
  if (key === 'ArrowLeft') return ids[(index + ids.length - 1) % ids.length]
  return current
}
export const nextItemTab = (current, key) => nextTab(itemTabs.map((tab) => tab.id), resolveItemTab(current), key)
