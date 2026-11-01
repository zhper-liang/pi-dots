import { groupTools } from './tool-groups.mjs'
import { BotDirectory } from './bot-directory.mjs'

// ADR-022: sources follow 日程与待办, except sources narrowed from a Bot in 设置 → 高级.
export const SCHEDULE_GROUP = 'todos'
// Legacy main sessions could propose a routine without holding calendar/task data.
// Materializing that right as a normal assignment must not grant connected sources.
const SCHEDULE_TOOLS = groupTools(SCHEDULE_GROUP).filter(name => name !== 'routine_propose')
export const MOCK_RESOURCE = 'mock:personal'
export const holdsSchedule = (access, botId) => SCHEDULE_TOOLS.some(name => access.assignments[botId]?.tools.includes(name) && !access.revoked?.[botId]?.includes(name))
export function grantResources(access, botId, resources) {
  const excluded = access.excludedResources?.[botId] ?? []
  const assigned = access.assignments[botId]
  assigned.resources = [...new Set([...assigned.resources, ...resources.filter(r => r !== MOCK_RESOURCE && !excluded.includes(r))])]
}
/** A newly connected source reaches every Bot holding 日程与待办 unless narrowed from it. */
export async function shareWithBots(tx, resources) {
  const { ToolAccess } = await import('./tools.mjs')
  const access = await tx.doc(ToolAccess), directory = await tx.doc(BotDirectory)
  for (const bot of directory.items) if (access.assignments[bot.id] && holdsSchedule(access, bot.id)) grantResources(access, bot.id, resources)
}
