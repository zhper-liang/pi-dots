/** Directory/detail navigation reuses existing Bot and Task identities. */
export const botTabs = [
  { id: 'chat', label: '对话' },
  { id: 'rules', label: '工具' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'memory', label: '记忆' },
  { id: 'settings', label: '设置' },
  { id: 'tasks', label: '任务' },
]
export function readBotTab(hash) {
  const tab = new URLSearchParams(hash.replace(/^#/, '')).get('tab')
  return botTabs.some(item => item.id === tab) ? tab : 'chat'
}
export function botDetailHash(botId, tab = 'chat') {
  const params = new URLSearchParams({ bot: botId })
  if (botTabs.some(item => item.id === tab) && tab !== 'chat') params.set('tab', tab)
  return `#${params}`
}
export function tasksForBot(tasks, botId) {
  return tasks.filter(task => task.bot?.id === botId && task.kind !== 'group' && task.kind !== 'main')
}
export function directoryBots(bots, query = '') {
  const needle = query.trim().toLocaleLowerCase()
  return bots.filter(bot => `${bot.name} ${bot.description}`.toLocaleLowerCase().includes(needle))
}
/** Scope only the view; issuing/revoking remains enforced by the existing server endpoints. */
export function credentialBots(bots, fixedBotId) {
  return bots.filter(bot => fixedBotId ? bot.id === fixedBotId : bot.status !== 'inactive')
}
export function credentialClients(clients, fixedBotId) {
  return fixedBotId ? clients.filter(client => client.botId === fixedBotId) : clients
}
export function mergeBotSkills(catalog, available, hasMainTask) {
  return catalog.map(skill => {
    const current = available.find(item => item.id === skill.id)
    if (current) {
      const { error: _catalogError, ...metadata } = skill
      return { ...metadata, ...current }
    }
    return { ...skill, available: false, error: skill.error ?? { code: 'SKILL_AVAILABILITY_UNKNOWN', message: hasMainTask ? '当前会话未返回此 Skill 的可用性；未核实前不能使用。' : '尚无主会话，无法核对当前依赖。' } }
  })
}
