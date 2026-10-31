import { TOOL_GROUPS, groupOfTool } from './tool-groups.mjs'
import { WRITE_TOOLS } from './policy.mjs'
import { MAIN_TOOLS } from './main-tools.mjs'
import { MANAGEMENT_TOOLS } from './management-tools.mjs'

import { toolLabel } from './tools.mjs'
export { toolLabel }

const copy = (value) => JSON.parse(JSON.stringify(value))
/** Tool status within a group, from live assignment/revocation and the Bot's session kind. */
function toolStatus(name, { assigned, revoked, mainSession, chief }) {
  const group = TOOL_GROUPS.find((g) => g.id === groupOfTool(name))
  if (group?.requiresMainSession && !mainSession || MAIN_TOOLS.includes(name)) return 'main-only'
  // Management tools come with Chief's sessions, not with the assignment.
  if (MANAGEMENT_TOOLS.includes(name) && !chief) return 'chief-only'
  if (revoked.includes(name)) return 'revoked'
  if (!assigned.includes(name) && !MANAGEMENT_TOOLS.includes(name)) return 'unassigned'
  return 'available'
}

export function describeGroups({ botId, assigned, revoked, mainSession }) {
  const chief = botId === 'chief'
  return TOOL_GROUPS.map((group) => {
    const tools = group.tools.map((name) => ({ name, label: toolLabel(name), write: WRITE_TOOLS.has(name),
      enabled: assigned.includes(name) && !revoked.includes(name), status: toolStatus(name, { assigned, revoked, mainSession, chief }) }))
    const enabledCount = tools.filter((tool) => tool.enabled).length
    return copy({ id: group.id, label: group.label, description: group.description,
      enabled: enabledCount > 0, partiallyEnabled: enabledCount > 0 && enabledCount < tools.length,
      tools, available: tools.some((tool) => tool.status === 'available') })
  })
}
