export const CAPABILITY_TABS = [
  { id: 'skill', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'tool', label: '工具集' },
]
export const DEFAULT_CAPABILITIES = []
export const BOT_TEMPLATES = [
  { name: '每日助理', description: '每天早上汇总今天的日程、到期待办和需要我处理的事，并提醒冲突。', capabilities: ['tool:todos'] },
  { name: '日程整理', description: '查看我的日历，找出冲突和空档，给出调整建议。', capabilities: ['tool:todos'] },
  { name: '费用整理', description: '整理我提供的消费记录，按类别汇总并标出异常。', capabilities: [] },
  { name: 'Bug 复现', description: '根据我描述的问题，整理复现步骤、预期与实际结果。', capabilities: [] },
]
const HIDDEN = ['tool:history', 'tool:skills', 'tool:automation', 'tool:bots']

/** botId null = the creation page. */
export const visibleCapabilities = (items, botId) => items.filter(item => !HIDDEN.includes(item.id) && !(botId === 'chief' && item.id === 'tool:capabilities'))

export function filterCapabilities(items, tab, query) {
  const q = query.trim().toLocaleLowerCase()
  return items.filter(item => item.kind === tab && (!q || `${item.name} ${item.description}${item.id === 'tool:todos' ? ' 飞书 日历 来源' : ''}`.toLocaleLowerCase().includes(q)))
}

export const capabilityStatusLabel = status => ({ configured: '待检查', needs_auth: '需要凭据', missing_dependency: '缺少依赖', error: '连接失败', disabled: '已停用' })[status] ?? ''
