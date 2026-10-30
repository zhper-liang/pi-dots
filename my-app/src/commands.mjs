// Composer "/" menu: a Skill for this message, plus shortcuts to buttons that already exist.
// Nothing here grants a permission; the server still checks every action.
export const ACTIONS = [
  { id: 'new-task', label: '新任务', hint: '用这个 Bot 开一个新任务', keywords: ['new', 'task', '新建'] },
  { id: 'pane', label: '对话 / 时间线', hint: '在对话和时间线之间切换', keywords: ['timeline', '时间线', '对话'] },
  { id: 'pause', label: '暂停全部自动化', hint: '例行任务停下，自动执行改为先问你；恢复在设置页', keywords: ['pause', '暂停'] },
  { id: 'new-bot', label: '新建 Bot', hint: '起个名字就能建', keywords: ['bot', '新建'] },
  { id: 'details', label: '会话详情', hint: '权限、用量和 Skill 记录', keywords: ['details', '详情', 'skill'] },
]

/** skills: GET /api/tasks/:id/skills items. Groups get no Skills and no per-Bot new task; resume is Settings-only. */
export function buildCommands({ skills = [], group = false, paused = false }) {
  const skillItems = group ? [] : skills.map(s => ({ id: `skill:${s.id}`, kind: 'skill', skillId: s.id, label: s.name ?? s.id, hint: s.description ?? '', keywords: [s.id], disabled: s.available ? null : (s.error?.message ?? '暂时不能用') }))
  const actions = ACTIONS.filter(a => !(group && a.id === 'new-task') && !(paused && a.id === 'pause'))
  return [...skillItems, ...actions.map(a => ({ ...a, kind: 'action', disabled: null }))]
}

/** Only a draft that is "/" plus one word opens the menu; the word filters label, keywords and hint,
 *  ranked in that order so "/详情" puts 会话详情 before a Skill whose description mentions 详情. */
export function matchCommands(commands, draft) {
  const m = isCommandDraft(draft) ? /^\/(\S*)$/.exec(draft) : null
  if (!m) return []
  const q = m[1].toLowerCase(), has = t => String(t ?? '').toLowerCase().includes(q)
  if (!q) return commands
  const rank = c => has(c.label) ? 0 : (c.keywords ?? []).some(has) ? 1 : has(c.hint) ? 2 : 3
  return commands.map((c, i) => [rank(c), i, c]).filter(([r]) => r < 3).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , c]) => c)
}

/** Keep the existing whole-draft slash trigger separate from caret-local mentions. */
export function isCommandDraft(draft) {
  return typeof draft === 'string' && /^\/\S*$/.test(draft)
}

/** Shared keyboard decisions. Composition and modified keys belong to the textarea. */
export function suggestionKeyAction(event, index, count) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return null
  if (event.key === 'Escape') return { type: 'dismiss' }
  if (!count || event.shiftKey) return null
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    return { type: 'move', index: (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count }
  }
  if (event.key === 'Enter' || event.key === 'Tab') return { type: 'pick', index }
  return null
}
