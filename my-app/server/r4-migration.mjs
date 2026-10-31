import { BotDirectory } from './bot-directory.mjs'
import { availableResourceList } from './bot-configuration.mjs'
import { capabilityState, syncSkillTools } from './capability-assignments.mjs'
import { PolicyRules } from './policy.mjs'
import { grantResources, holdsSchedule, MOCK_RESOURCE } from './resource-sharing.mjs'
import { groupTools } from './tool-groups.mjs'
import { ToolAccess } from './tools.mjs'

export const PRESET_TEXT = {
  calendar: { old: '梳理日程与时间安排；可读取模拟日程，尚未连接真实日历。', new: '梳理日程与时间安排，找出冲突和空档。' },
  todo: { old: '整理事项与优先级；当前尚未连接待办服务。', new: '整理待办和优先级，提醒快到期的事。' },
}

export async function migrateToR4(tx) {
  const access = await tx.doc(ToolAccess)
  if (access.r4MigratedAt) return false
  const directory = await tx.doc(BotDirectory), schedule = groupTools('todos')
  for (const bot of directory.items) if (holdsSchedule(access, bot.id)) {
    const assigned = access.assignments[bot.id]
    assigned.tools = [...new Set([...assigned.tools, ...schedule])]
    access.revoked[bot.id] = (access.revoked[bot.id] ?? []).filter(name => !schedule.includes(name))
  }
  const state = await capabilityState(tx)
  for (const bot of directory.items) syncSkillTools(access, state, bot.id)
  const { resources } = await availableResourceList(tx)
  for (const bot of directory.items) if (holdsSchedule(access, bot.id)) grantResources(access, bot.id, resources)
  const rules = await tx.doc(PolicyRules)
  rules.items = rules.items.filter(rule => rule.effect !== 'ask' || rule.origin === 'preset')
  for (const assigned of Object.values(access.assignments)) assigned.resources = assigned.resources.filter(resource => resource !== MOCK_RESOURCE)
  for (const [botId, excluded] of Object.entries(access.excludedResources ?? {})) access.excludedResources[botId] = excluded.filter(resource => resource !== MOCK_RESOURCE)
  for (const [id, text] of Object.entries(PRESET_TEXT)) {
    const bot = directory.items.find(item => item.id === id)
    if (bot?.description === text.old) bot.description = text.new
  }
  access.r4MigratedAt = new Date().toISOString()
  return true
}
