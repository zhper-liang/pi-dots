import { FeishuCalendar } from './feishu-calendar.mjs'
import { externalWorkspaceResources } from './workspace-providers.mjs'
import { MANAGEMENT_TOOLS } from './management-tools.mjs'
import { createHash } from 'node:crypto'
import { assertBotActive, BotDirectory, createDirectoryBot } from './bot-directory.mjs'
import { ToolAccess, toolCatalog, INTRINSIC_TOOLS, RECALL_TOOLS } from './tools.mjs'
import { TaskInputError, taskParameters, pinModelContext } from './task-config.mjs'
import { DEFAULT_CAPABILITIES, enableAtCreation } from './capability-assignments.mjs'
import { MOCK_RESOURCE } from './resource-sharing.mjs'
import { describeGroups, toolLabel } from './tool-group-settings.mjs'
import { MAIN_TOOLS } from './main-tools.mjs'
import { AUTOMATION_PAUSE_TOOL } from './policy.mjs'

const copy = (x) => JSON.parse(JSON.stringify(x))
const canonical = (x) => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])])) : x
const hash = (x) => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
const object = (x) => x && typeof x === 'object' && !Array.isArray(x)
const names = (access) => toolCatalog({ externalTools: access?.externalMcp?.tools ?? [] }).map((t) => t.name).filter(n => !MANAGEMENT_TOOLS.includes(n))
export const supportedResources = ['mock:personal', 'workspace:local']
// S1 + R3: assignable = supported + Feishu binding + live multi-source providers (Google), with titles.
export async function availableResourceList(tx) {
  const binding = (await tx.doc(FeishuCalendar)).binding, external = await externalWorkspaceResources(tx)
  const resources = [...supportedResources.filter(resource => resource !== MOCK_RESOURCE), ...(binding ? [binding.resource, `workspace:feishu:${hash([binding.connectionId, binding.calendarId])}`] : []), ...external.map(e => e.resource)]
  return { resources, ...(external.length ? { resourceLabels: Object.fromEntries(external.map(e => [e.resource, { title: e.title || e.label, note: e.readOnly ? `${e.label} · 只读` : e.label }])) } : {}) }
}
export function initializeConfiguration(directory, access) {
  directory.configurations ??= {}
  directory.managementRequests ??= {}
  directory.managementAudit ??= []
  // S1: no pool. Assignment defaults to bot.defaults (no filtering).
  access.assignments ??= {}
  access.revoked ??= {}
  for (const bot of directory.items) {
    access.assignments[bot.id] ??= { tools: [...(bot.defaults.tools ?? [])], resources: [...(bot.defaults.toolResources ?? [])] }
    // Built-in abilities need no optional assignment; keep immutable versions/receipts intact.
    access.assignments[bot.id].tools = access.assignments[bot.id].tools.filter(name => !INTRINSIC_TOOLS.includes(name))
    directory.configurations[bot.id] ??= [{ ...copy(bot), source: bot.source === 'legacy-task' ? 'legacy-task' : bot.createdAt ? 'authenticated-user-creation' : 'legacy-persisted-config', savedAt: bot.createdAt ?? new Date().toISOString() }]
  }
}
// Preserve old effective rights as ordinary assignments once. Preset identities must
// not restore a capability after the user removes it through normal configuration.
export function migrateMainAssignments(directory, access) {
  if ((access.mainAssignments?.version ?? 0) >= 2) return
  const legacy = new Set([...(access.mainAssignments?.bots ?? []),
    ...directory.items.filter(bot => bot.capabilityDefaultsVersion !== 2).map(bot => bot.id)])
  const tools = [...MAIN_TOOLS, AUTOMATION_PAUSE_TOOL]
  for (const bot of directory.items) {
    if (!legacy.has(bot.id) || bot.id === 'chief') continue
    const assigned = access.assignments[bot.id]
    assigned.tools = [...new Set([...assigned.tools, ...tools.filter(name => !access.revoked[bot.id]?.includes(name))])]
  }
  access.mainAssignments = { version: 2, bots: legacy.has('chief') ? ['chief'] : [] }
}
// Compatibility export for callers that enumerate the static installed tools, not a grant.
export const allGroupTools = () => names()
export const TOOL_GROUPS_VERSION = 2
// R1-08 migration is marker-only. Persisted per-tool grants, revocations, resources and
// narrowed rules are already authoritative. Do not replay the v1 grant-all migration,
// restore its archived pre-state, or reinterpret an old ask/deny rule as enabled=false.
export function migrateToolGroups(directory, access, _rules) {
  if ((access.groupsVersion ?? 0) >= TOOL_GROUPS_VERSION) return false
  initializeConfiguration(directory, access)
  access.revoked ??= {}
  access.groupsVersion = TOOL_GROUPS_VERSION
  access.capabilityMigration = { version: TOOL_GROUPS_VERSION, migratedAt: new Date().toISOString(), strategy: 'preserve-live-access' }
  return true
}
function shape(input, fields) {
  if (!object(input) || Object.keys(input).some((k) => !fields.includes(k)) || typeof input.requestId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) || ['constructor', 'prototype'].includes(input.requestId)) fail(400, 'INVALID_CONFIGURATION', '配置字段或requestId无效；不接受凭证、身份覆盖或任意资源。')
}
function subset(value, allowed) {
  return Array.isArray(value) && value.length <= allowed.length && new Set(value).size === value.length && value.every((n) => typeof n === 'string' && allowed.includes(n))
}
// Shared atomic contract for authenticated HTTP and Chief tool transactions.
export async function changeConfiguration(tx, botId, input, { models }) {
  const d = await tx.doc(BotDirectory), a = await tx.doc(ToolAccess)
  initializeConfiguration(d, a)
  const audit = (event) => d.managementAudit.push({ id: d.managementAudit.length + 1, botId,
    createdAt: new Date().toISOString(), source: 'authenticated-user', ...event })
  try {
    shape(input, ['requestId', 'expectedVersion', 'description', 'parameters', 'tools', 'resources'])
    const signature = hash({ botId, input }), key = `${botId}:${input.requestId}`
    const prior = Object.hasOwn(d.managementRequests, key) ? d.managementRequests[key] : null
    if (prior) { if (prior.signature !== signature) fail(409, 'CONFIG_REQUEST_CONFLICT', '同一requestId不能用于不同修改。'); return copy(prior.result) }
    let response
    {
      const bot = d.items.find((b) => b.id === botId)
      if (!bot) fail(404, 'BOT_NOT_FOUND', '指定的Bot不存在。')
      await assertBotActive(tx, botId)
      if (typeof input.expectedVersion !== 'string' || input.expectedVersion !== bot.configRef.version) fail(409, 'CONFIG_VERSION_CONFLICT', '配置已更新；请重新加载并比较后再保存。')
      // S1: available tools = installed tools; available resources = supportedResources + feishu binding.
      const availableTools = names(a), availableResources = [...new Set([...(await availableResourceList(tx)).resources, ...a.assignments[botId].resources])]
      if (typeof input.description !== 'string' || input.description.length > 2000 || !subset(input.tools, [...availableTools, ...RECALL_TOOLS]) || !subset(input.resources, availableResources)) fail(400, 'CAPABILITY_NOT_GRANTED', '职责无效或工具/资源不可用。')
      const defaults = taskParameters(input.parameters, copy(bot.defaults))
      if (defaults.mode === 'model' && !models.some((m) => m.id === defaults.model.id)) fail(400, 'MODEL_NOT_CONFIGURED', '仅可选择服务端已配置的模型。')
      pinModelContext(defaults, models)
      defaults.tools = input.tools.filter(name => !INTRINSIC_TOOLS.includes(name)); defaults.toolResources = [...input.resources]
      const history = d.configurations[botId]
      const next = { ...copy(bot), description: input.description.trim(), defaults,
        configRef: { botId, version: `config-${history.length + 1}-${hash({ input, previous: bot.configRef }).slice(0, 12)}` } }
      const previousResources = a.assignments[botId].resources
      const removed = previousResources.filter(resource => resource !== MOCK_RESOURCE && !input.resources.includes(resource))
      const added = input.resources.filter(resource => !previousResources.includes(resource))
      a.excludedResources ??= {}
      a.excludedResources[botId] = [...new Set([...(a.excludedResources[botId] ?? []), ...removed])].filter(resource => !added.includes(resource))
      a.assignments[botId] = { tools: [...defaults.tools], resources: [...input.resources] }
      d.items[d.items.findIndex((b) => b.id === botId)] = next
      history.push({ ...copy(next), source: 'authenticated-user', requestId: input.requestId, savedAt: new Date().toISOString() })
      audit({ type: 'configuration-saved', requestId: input.requestId, previous: copy(bot.configRef), next: copy(next.configRef) })
      response = { bot: copy(next), created: true }
    }
    d.managementRequests[key] = { signature, result: copy(response) }
    return response
  } catch (e) {
    if (!(e instanceof TaskInputError)) throw e
    audit({ type: 'management-denied', code: e.code }) // Never persist arbitrary untrusted input or secrets.
    return { error: { status: e.status, code: e.code, message: e.message } }
  }
}
export function configurationApi({ harness, context, catalog, models, refreshModels = async () => {} }) {
  const syncedRevisions = new Map()
  const sync = ({ bot, versions }) => {
    if ((syncedRevisions.get(bot.id) ?? 0) >= versions.length) return
    const i = catalog.findIndex((b) => b.id === bot.id)
    if (i >= 0) { catalog[i] = { ...copy(bot), ...(catalog[i].status === 'inactive' ? { status: 'inactive', deactivatedAt: catalog[i].deactivatedAt } : {}) }; syncedRevisions.set(bot.id, versions.length) }
  }
  async function read(botId) {
    return harness.commit(async (tx) => {
      await refreshModels(tx)
      const d = await tx.doc(BotDirectory), a = await tx.doc(ToolAccess)
      initializeConfiguration(d, a)
      const bot = d.items.find((b) => b.id === botId)
      if (!bot) fail(404, 'BOT_NOT_FOUND', '指定的Bot不存在。')
      const assigned = a.assignments[botId], revoked = a.revoked[botId] ?? []
      return copy({ bot, versions: d.configurations[botId], installed: names(a), toolLabels: Object.fromEntries(names(a).map((n) => [n, toolLabel(n)])),
        toolGroups: describeGroups({ botId, assigned: assigned.tools, revoked, mainSession: botId !== 'group' }),
        assigned, revoked,
        models: models.map((m) => ({ id: m.id, provider: m.provider, ...(m.name ? { name: m.name } : {}) })), ...await availableResourceList(tx),
        audit: d.managementAudit.filter((e) => !e.botId || e.botId === botId) })
    }, context)
  }
  async function change(botId, input) {
    const result = await harness.commit(async (tx) => {
      await refreshModels(tx)
      return changeConfiguration(tx, botId, input, { models })
    }, context)
    if (result.error) fail(result.error.status, result.error.code, result.error.message)
    // Reload committed truth; concurrent callers must not replace a newer catalog with an old receipt.
    sync(await read(botId))
    return result
  }
  return { getBotConfiguration: read, updateBotConfiguration: (id, input) => change(id, input) }
}

export async function createConfiguredBot(tx, parsed, configuredModels, catalog = []) {
  const liveDirectory = await tx.doc(BotDirectory)
  const directory = copy(liveDirectory)
  const access = await tx.doc(ToolAccess)
  const created = createDirectoryBot(directory, parsed)
  if (created.created) pinModelContext(created.bot.defaults, configuredModels)
  if (created.created && created.bot.defaults.mode === 'model' && !configuredModels.some((m) => m.id === created.bot.defaults.model.id)) throw new TaskInputError(400, 'MODEL_NOT_CONFIGURED', '仅可选择已配置模型。')
  if (created.created) {
    // Seed version 1 before applying the selected capabilities to the live directory.
    directory.items[directory.items.findIndex((b) => b.id === created.bot.id)] = JSON.parse(JSON.stringify(created.bot))
    directory.requests[parsed.requestId].bot = JSON.parse(JSON.stringify(created.bot))
    initializeConfiguration(directory, access)
    access.assignments[created.bot.id] = { tools: [...created.bot.defaults.tools], resources: [...created.bot.defaults.toolResources] }
    directory.managementAudit.push({ id: directory.managementAudit.length + 1, botId: created.bot.id, type: 'bot-created', source: 'authenticated-user', createdAt: new Date().toISOString(), configRef: JSON.parse(JSON.stringify(created.bot.configRef)) })
  }
  Object.assign(liveDirectory, directory)
  if (created.created) {
    for (const id of parsed.capabilities ?? DEFAULT_CAPABILITIES) await enableAtCreation(tx, created.bot.id, id, catalog)
    const bot = liveDirectory.items.find(item => item.id === created.bot.id), assigned = access.assignments[bot.id]
    bot.defaults.tools = [...assigned.tools]
    bot.defaults.toolResources = [...assigned.resources]
    liveDirectory.requests[parsed.requestId].bot.defaults = copy(bot.defaults)
    liveDirectory.configurations[bot.id][0].defaults = copy(bot.defaults)
    created.bot = bot
  }
  return copy(created)
}
