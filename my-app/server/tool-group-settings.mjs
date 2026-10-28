import { randomUUID } from 'node:crypto'
import { TaskInputError } from './task-config.mjs'
import { TOOL_GROUPS, groupOfTool, isToolGroup } from './tool-groups.mjs'
import { WRITE_TOOLS, PolicyRules, groupRule } from './policy.mjs'
import { MAIN_TOOLS } from './main-tools.mjs'
import { MANAGEMENT_TOOLS } from './management-tools.mjs'

import { toolLabel } from './tools.mjs'
export { toolLabel }

const copy = (value) => JSON.parse(JSON.stringify(value))
const writesOf = (group) => group.tools.filter((tool) => WRITE_TOOLS.has(tool))

/**
 * 开 unless the Bot has an ask/deny rule on any write in the group. The switch owns every such rule
 * (any specificity), so the switch shown is the verdict policy.decide() returns.
 */
export function groupMode(rules, botId, group) {
  return rules.some((rule) => groupRule(rule, botId, writesOf(group)) && rule.effect !== 'allow') ? 'ask' : 'allow'
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
    const tools = group.tools.map((name) => ({ name, label: toolLabel(name), write: WRITE_TOOLS.has(name), status: toolStatus(name, { assigned, revoked, mainSession, chief }) }))
    // Only a group with a write this Bot can use has a meaningful switch; read-only groups are always on.
    return copy({ id: group.id, label: group.label, description: group.description, mode: groupMode(rules, botId, group), tools,
      available: tools.some((tool) => tool.status === 'available'),
      switchable: tools.some((tool) => tool.write && tool.status === 'available') })
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
 * One transaction for the whole group: removes every rule this Bot has on the group's writes,
 * narrowed ones included, then 关 writes one ask per write tool and 开 writes nothing (the default
 * is direct). Idempotent by requestId; never a capability grant, so no tools or resources change.
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
  const before = copy(doc.items.filter((rule) => groupRule(rule, botId, tools)))
  doc.items = doc.items.filter((rule) => rule.origin === 'preset' || !groupRule(rule, botId, tools))
  const createdAt = new Date().toISOString()
  if (request.mode === 'ask') for (const tool of tools) doc.items.push({ id: randomUUID(), botId, match: { tool }, effect: 'ask', origin: 'group', createdAt })
  const after = copy(doc.items.filter((rule) => groupRule(rule, botId, tools)))
  const result = { botId, groupId: request.groupId, mode: request.mode, tools, before, after }
  doc.switches[key] = { signature, result: copy(result) }
  audit?.({ type: 'tool-group-switched', requestId: request.requestId, groupId: request.groupId, mode: request.mode, tools })
  return copy(result)
}
