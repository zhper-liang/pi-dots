/** Directory/detail navigation reuses existing Bot and Task identities. */
export const botTabs = [
  { id: 'capabilities', label: '能力' },
  { id: 'memory', label: '记忆' },
  { id: 'settings', label: '设置' },
]
export function readBotTab(hash) {
  const tab = new URLSearchParams(hash.replace(/^#/, '')).get('tab')
  return botTabs.some(item => item.id === tab) ? tab : 'chat'
}
export function botDetailHash(botId, tab = 'chat') {
  const params = new URLSearchParams({ bot: botId })
  if (botTabs.some(item => item.id === tab)) params.set('tab', tab)
  return `#${params}`
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
