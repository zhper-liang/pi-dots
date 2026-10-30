import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { defineDoc } from '@earendil-works/pi-durable'
import { BotDirectory, assertBotActive } from './bot-directory.mjs'
import { initializeConfiguration } from './bot-configuration.mjs'
import { ToolAccess, toolCatalog } from './tools.mjs'
import { TOOL_GROUPS } from './tool-groups.mjs'
import { MANAGEMENT_TOOLS } from './management-tools.mjs'
import { MAIN_TOOLS } from './main-tools.mjs'
import { TaskInputError } from './task-config.mjs'

// Only Skill selection and binding provenance live here. All tool authorization, including
// MCP tools, remains in ToolAccess. Catalogs and credentials are never persisted here.
export const CapabilityAssignments = defineDoc({ kind: 'pidot.capability-assignments', version: 1, scope: 'session',
  initial: () => ({ legacySkillIds: null, legacyBots: [], skills: {}, bindings: {} }) })
const copy = value => JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
const statuses = new Set(['ready', 'configured', 'needs_auth', 'missing_dependency', 'error', 'disabled'])
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(value)
const validRequest = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value) && !['constructor', 'prototype'].includes(value)

export function builtinCapabilityCatalog() {
  const installed = new Map(toolCatalog().map(tool => [tool.name, tool]))
  return TOOL_GROUPS.map(group => ({ id: `tool:${group.id}`, kind: 'tool', name: group.label, description: group.description,
    status: 'ready', revision: 'static-1', requirements: [], toolNames: group.tools.filter(name => installed.has(name)) }))
    .filter(group => group.toolNames.length)
}

function catalogItems(catalog = []) {
  if (!Array.isArray(catalog) || catalog.length > 512) fail(400, 'INVALID_CAPABILITY_CATALOG', '能力目录无效或超出上限。')
  const staticItems = builtinCapabilityCatalog(), installed = new Set(toolCatalog().map(tool => tool.name))
  const reserved = new Set([...installed, ...MANAGEMENT_TOOLS, ...MAIN_TOOLS])
  const ids = new Set(), aliases = new Set()
  const external = []
  for (const item of catalog) {
    if (!item || !['tool', 'mcp', 'skill'].includes(item.kind) || !safeId(item.id) || !item.id.startsWith(`${item.kind}:`) || ids.has(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || typeof item.description !== 'string' || item.description.length > 4000 ||
      !statuses.has(item.status) || typeof item.revision !== 'string' || !item.revision || item.revision.length > 200 ||
      !Array.isArray(item.toolNames) || item.toolNames.length > 128 || new Set(item.toolNames).size !== item.toolNames.length ||
      item.toolNames.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) ||
      !Array.isArray(item.requirements) || item.requirements.length > 128) fail(400, 'INVALID_CAPABILITY_CATALOG', '能力投影字段无效；只接受已登记且不含秘密的目录。')
    ids.add(item.id)
    if (item.kind === 'tool') {
      const builtin = staticItems.find(entry => entry.id === item.id)
      if (!builtin || hash(item.toolNames) !== hash(builtin.toolNames)) fail(400, 'INVALID_CAPABILITY_CATALOG', '内置工具范围不能由目录覆盖。')
      continue
    }
    if (item.kind === 'skill' && item.toolNames.length) fail(400, 'INVALID_CAPABILITY_CATALOG', 'Skill 依赖是声明，不是工具授权。')
    if (item.kind === 'mcp') for (const name of item.toolNames) {
      if (reserved.has(name) || aliases.has(name)) fail(400, 'INVALID_CAPABILITY_CATALOG', '外部工具名与已登记工具冲突。')
      aliases.add(name)
    }
    // Select fields, rather than spreading provider data into UI/receipts.
    external.push({ id: item.id, kind: item.kind, name: item.name, description: item.description, status: item.status,
      revision: item.revision, ...(typeof item.version === 'string' ? { version: item.version } : {}), toolNames: [...item.toolNames],
      requirements: copy(item.requirements), ...(item.lastCheck === undefined ? {} : { lastCheck: copy(item.lastCheck) }) })
  }
  return [...staticItems, ...external]
}

async function stateFor(tx, botId) {
  const directory = await tx.doc(BotDirectory), access = await tx.doc(ToolAccess)
  initializeConfiguration(directory, access)
  access.revoked ??= {}
  const bot = directory.items.find(item => item.id === botId)
  if (!bot) fail(404, 'BOT_NOT_FOUND', '指定的 Bot 不存在。')
  const state = await tx.doc(CapabilityAssignments)
  if (state.legacySkillIds === null) {
    // Freeze only the existing read-only built-in source, never a caller's imported catalog.
    const entries = await readdir(new URL('./skills/', import.meta.url), { withFileTypes: true })
    state.legacySkillIds = entries.filter(item => item.isDirectory()).map(item => `skill:${item.name}`)
    state.legacyBots = directory.items.filter(item => item.capabilityDefaultsVersion !== 2).map(item => item.id)
  }
  return { directory, access, bot, state }
}
function project(item, { bot, access, state }) {
  const assigned = access.assignments[bot.id], revoked = access.revoked[bot.id] ?? []
  const tools = item.toolNames.filter(name => assigned.tools.includes(name) && !revoked.includes(name))
  const enabledForBot = item.kind === 'skill'
    ? state.skills[bot.id]?.[item.id] ?? (state.legacyBots.includes(bot.id) && state.legacySkillIds.includes(item.id))
    : tools.length > 0
  return { ...copy(item), enabledForBot, partiallyEnabled: item.kind !== 'skill' && tools.length > 0 && tools.length < item.toolNames.length,
    assignedToolNames: tools, available: bot.status !== 'inactive' && enabledForBot && item.status === 'ready' }
}

// All three functions run inside the caller's existing authenticated Harness transaction.
export async function listBotCapabilities(tx, botId, { catalog = [] } = {}) {
  const items = catalogItems(catalog), state = await stateFor(tx, botId)
  return { botId, revision: state.bot.configRef.version, items: items.map(item => project(item, state)) }
}

export async function setCapabilityAssignment(tx, botId, input, { catalog = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key =>
    !['requestId', 'expectedRevision', 'capabilityId', 'enabled', 'expectedCatalogRevision'].includes(key)) ||
    !validRequest(input.requestId) || !safeId(input.capabilityId) || typeof input.enabled !== 'boolean' ||
    typeof input.expectedRevision !== 'string' || !input.expectedRevision || typeof input.expectedCatalogRevision !== 'string') {
    fail(400, 'INVALID_CAPABILITY_ASSIGNMENT', '须提供能力、开关、配置/目录版本和稳定 requestId。')
  }
  const state = await stateFor(tx, botId), { directory, access, bot } = state
  const key = `${botId}:${input.requestId}`, signature = hash({ operation: 'capability-assignment', botId, input })
  const prior = Object.hasOwn(directory.managementRequests, key) ? directory.managementRequests[key] : null
  if (prior) {
    if (prior.signature !== signature) fail(409, 'CONFIG_REQUEST_CONFLICT', '同一 requestId 不能用于不同修改。')
    return copy(prior.result)
  }
  await assertBotActive(tx, botId)
  if (bot.configRef.version !== input.expectedRevision) fail(409, 'CONFIG_VERSION_CONFLICT', '配置已更新，请重新读取。')
  const item = catalogItems(catalog).find(entry => entry.id === input.capabilityId)
  const binding = state.state.bindings[botId]?.[input.capabilityId]
  // An unavailable/unregistered provider must not prevent revoking its saved binding.
  if (!item && (input.enabled || !binding)) fail(404, 'CAPABILITY_NOT_FOUND', '能力未登记。')
  if (input.enabled && item.revision !== input.expectedCatalogRevision) fail(409, 'CAPABILITY_CATALOG_CONFLICT', '工具目录已变化，请核对后再启用。')
  if (input.enabled && (item.status === 'disabled' || item.kind !== 'skill' && !item.toolNames.length)) fail(409, 'CAPABILITY_UNAVAILABLE', '能力已停用或尚未发现工具，不能启用。')
  const kind = item?.kind ?? binding.kind
  const assigned = access.assignments[botId]
  const names = [...new Set([...(item?.toolNames ?? []), ...(binding?.toolNames ?? [])])]
  if (kind === 'skill') {
    state.state.skills[botId] ??= {}
    state.state.skills[botId][input.capabilityId] = input.enabled
  } else if (input.enabled) {
    // Only the reviewed current catalog is granted; remembered/removed tools never return.
    assigned.tools = [...new Set([...assigned.tools, ...item.toolNames])]
    access.revoked[botId] = (access.revoked[botId] ?? []).filter(name => !item.toolNames.includes(name))
  } else {
    assigned.tools = assigned.tools.filter(name => !names.includes(name))
    access.revoked[botId] = [...new Set([...(access.revoked[botId] ?? []), ...names])]
  }
  state.state.bindings[botId] ??= {}
  state.state.bindings[botId][input.capabilityId] = { kind, toolNames: input.enabled ? [...(item?.toolNames ?? [])] : [], catalogRevision: item?.revision ?? binding.catalogRevision }
  const history = directory.configurations[botId]
  const next = { ...copy(bot), defaults: { ...copy(bot.defaults), tools: [...assigned.tools], toolResources: [...assigned.resources] },
    configRef: { botId, version: `config-${history.length + 1}-${hash({ input, previous: bot.configRef }).slice(0, 12)}` } }
  directory.items[directory.items.findIndex(entry => entry.id === botId)] = next
  history.push({ ...copy(next), source: 'authenticated-user', requestId: input.requestId, savedAt: new Date().toISOString() })
  directory.managementAudit.push({ id: directory.managementAudit.length + 1, botId, type: 'capability-assignment-changed',
    requestId: input.requestId, capabilityId: input.capabilityId, enabled: input.enabled, createdAt: new Date().toISOString(), source: 'authenticated-user' })
  const result = { botId, capabilityId: input.capabilityId, kind, revision: next.configRef.version,
    enabledForBot: input.enabled, status: item?.status ?? 'disabled', toolNames: input.enabled ? [...(item?.toolNames ?? [])] : [] }
  directory.managementRequests[key] = { signature, result: copy(result) }
  return result
}

export async function assertCapabilityEnabled(tx, botId, capabilityId, { catalog = [] } = {}) {
  await assertBotActive(tx, botId)
  const view = await listBotCapabilities(tx, botId, { catalog })
  const item = view.items.find(entry => entry.id === capabilityId)
  if (!item?.enabledForBot) fail(403, 'CAPABILITY_NOT_ENABLED', '能力未分配或已撤销。')
  if (!item.available) fail(409, 'CAPABILITY_UNAVAILABLE', '能力当前不可用，请核对连接、凭据和依赖。')
  return item
}
