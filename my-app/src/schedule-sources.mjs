// A Feishu source has both legacy and workspace tool addresses. They are one user choice.
export function scheduleSourceRows(configuration) {
  const resources = configuration.resources ?? []
  const feishu = resources.filter(id => id.startsWith('feishu:') || id.startsWith('workspace:feishu:'))
  const rows = resources.filter(id => !feishu.includes(id)).map(id => ({
    id, resources: [id], title: configuration.resourceLabels?.[id]?.title ?? (id === 'workspace:local' ? '本地日程与待办' : id),
    note: configuration.resourceLabels?.[id]?.note ?? '',
  }))
  if (feishu.length) rows.push({ id: 'feishu', resources: feishu, title: '飞书日历', note: '' })
  return rows.map(row => {
    const selected = row.resources.filter(id => configuration.assigned.resources.includes(id)).length
    return { ...row, enabled: selected > 0, partiallyEnabled: selected > 0 && selected < row.resources.length }
  })
}

export function sourceAssignment(configuration, row, enabled, requestId) {
  const selected = new Set(configuration.assigned.resources)
  for (const id of row.resources) { if (enabled) selected.add(id); else selected.delete(id) }
  return { expectedVersion: configuration.bot.configRef.version, requestId,
    description: configuration.bot.description, tools: [...configuration.assigned.tools], resources: [...selected] }
}
