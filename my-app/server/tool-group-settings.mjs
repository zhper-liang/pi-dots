import { TaskInputError } from './task-config.mjs'
import { TOOL_GROUPS, ITEM_WRITE_TOOL, groupOfTool, isToolGroup, itemTypesOfGroup } from './tool-groups.mjs'
import { WRITE_TOOLS, PolicyRules, groupRule, groupWriteMatches, setGroupMode } from './policy.mjs'
import { MAIN_TOOLS } from './main-tools.mjs'
import { MANAGEMENT_TOOLS } from './management-tools.mjs'

import { toolLabel } from './tools.mjs'
export { toolLabel }

const copy = (value) => JSON.parse(JSON.stringify(value))
const writesOf = (group) => group.tools.filter((tool) => WRITE_TOOLS.has(tool))

/**
 * Write confirmation only: ask if a write the group decides has an ask/deny rule (D15: schedule writes
 * through the workspace tool count for 日历与日程). Capability enabled/disabled is projected from ToolAccess.
 */
export function groupMode(rules, botId, group) {
  return rules.some((rule) => groupRule(rule, botId, group.id) && rule.effect !== 'allow') ? 'ask' : 'allow'
}

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

export function describeGroups({ rules, botId, assigned, revoked, mainSession }) {
  const chief = botId === 'chief'
  return TOOL_GROUPS.map((group) => {
    const tools = group.tools.map((name) => ({ name, label: toolLabel(name), write: WRITE_TOOLS.has(name),
      enabled: assigned.includes(name) && !revoked.includes(name), status: toolStatus(name, { assigned, revoked, mainSession, chief }) }))
    const enabledCount = tools.filter((tool) => tool.enabled).length
    // D15: a group that decides item writes can be switched whenever the item write tool is usable,
    // even if none of its own tools is enabled (enabling the group still grants only its own tools).
    const itemWrites = itemTypesOfGroup(group.id).length > 0 && toolStatus(ITEM_WRITE_TOOL, { assigned, revoked, mainSession, chief }) === 'available'
    return copy({ id: group.id, label: group.label, description: group.description,
      enabled: enabledCount > 0, partiallyEnabled: enabledCount > 0 && enabledCount < tools.length,
      mode: groupMode(rules, botId, group), tools,
      available: tools.some((tool) => tool.status === 'available'),
      switchable: itemWrites || tools.some((tool) => tool.write && tool.status === 'available') })
  })
}

export function validateGroupSwitch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['requestId', 'groupId', 'mode'].includes(key)) ||
    typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) || ['constructor', 'prototype'].includes(input.requestId) ||
    !isToolGroup(input.groupId) || !['allow', 'ask'].includes(input.mode)) {
    throw new TaskInputError(400, 'INVALID_TOOL_GROUP', '工具组开关只接受已知组、allow/ask 和稳定 requestId。')
  }
  return input
}

/**
 * One transaction for the whole group: removes every rule this Bot has on the writes the group decides,
 * narrowed ones included, then 关 writes one ask per write (typed for item writes, D15) and 开 writes
 * nothing (the default is direct). A shared untyped item-write rule keeps its effect on the other item
 * type. Idempotent by requestId; never a capability grant, so no tools or resources change.
 */
export async function switchGroup(tx, botId, input, { audit }) {
  const request = validateGroupSwitch(input)
  const doc = await tx.doc(PolicyRules)
  doc.switches ??= {}
  const key = `${botId}:${request.requestId}`
  const signature = JSON.stringify({ groupId: request.groupId, mode: request.mode })
  const prior = doc.switches[key]
  if (prior) {
    if (prior.signature !== signature) throw new TaskInputError(409, 'GROUP_SWITCH_CONFLICT', '同一requestId不能用于不同的工具组修改。')
    return copy(prior.result)
  }
  const tools = writesOf(TOOL_GROUPS.find((group) => group.id === request.groupId))
  const writes = groupWriteMatches(request.groupId)
  const { before, after } = setGroupMode(doc, botId, request.groupId, request.mode, { keepPresets: true })
  const result = { botId, groupId: request.groupId, mode: request.mode, tools, writes, before, after }
  doc.switches[key] = { signature, result: copy(result) }
  audit?.({ type: 'tool-group-switched', requestId: request.requestId, groupId: request.groupId, mode: request.mode, tools, writes })
  return copy(result)
}
