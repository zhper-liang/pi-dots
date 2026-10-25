import { FeishuCalendar } from './feishu-calendar.mjs'
import { MANAGEMENT_TOOLS } from './management-tools.mjs'
import { createHash } from 'node:crypto'
import { assertBotActive, BotDirectory, createDirectoryBot } from './bot-directory.mjs'
import { ToolAccess, toolCatalog } from './tools.mjs'
import { TaskInputError, taskParameters } from './task-config.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'

export const NEW_BOT_WORKSPACE_TOOLS = WORKSPACE_TOOLS.filter((n) => n !== 'workspace.prepare_schedule')

const copy = (x) => JSON.parse(JSON.stringify(x))
const canonical = (x) => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])])) : x
const hash = (x) => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
const object = (x) => x && typeof x === 'object' && !Array.isArray(x)
const names = () => toolCatalog().map((t) => t.name).filter(n => !MANAGEMENT_TOOLS.includes(n))
export const supportedResources = ['mock:personal', 'workspace:local']
export function initializeConfiguration(directory, access) {
  directory.configurations ??= {}
  directory.managementRequests ??= {}
  directory.managementAudit ??= []
  // S1: no pool. Assignment defaults to bot.defaults (no filtering).
  access.assignments ??= {}
  for (const bot of directory.items) {
    access.assignments[bot.id] ??= { tools: [...(bot.defaults.tools ?? [])], resources: [...(bot.defaults.toolResources ?? [])] }
    directory.configurations[bot.id] ??= [{ ...copy(bot), source: bot.source === 'legacy-task' ? 'legacy-task' : bot.createdAt ? 'authenticated-user-creation' : 'legacy-persisted-config', savedAt: bot.createdAt ?? new Date().toISOString() }]
  }
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
      const availableTools = names(), availableResources = [...supportedResources, ...((await tx.doc(FeishuCalendar)).binding ? [(await tx.doc(FeishuCalendar)).binding.resource, `workspace:feishu:${hash([(await tx.doc(FeishuCalendar)).binding.connectionId, (await tx.doc(FeishuCalendar)).binding.calendarId])}`] : [])]
      if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 2000 || !subset(input.tools, availableTools) || !subset(input.resources, availableResources)) fail(400, 'CAPABILITY_NOT_GRANTED', '职责无效或工具/资源不可用。')
      const defaults = taskParameters(input.parameters, copy(bot.defaults))
      if (defaults.mode === 'model' && !models.some((m) => m.id === defaults.model.id && m.provider === defaults.model.provider && m.baseUrl === defaults.model.baseUrl && m.api === defaults.model.api)) fail(400, 'MODEL_NOT_CONFIGURED', '仅可选择服务端已配置的模型。')
      defaults.tools = [...input.tools]; defaults.toolResources = [...input.resources]
      const history = d.configurations[botId]
      const next = { ...copy(bot), description: input.description.trim(), defaults,
        configRef: { botId, version: `config-${history.length + 1}-${hash({ input, previous: bot.configRef }).slice(0, 12)}` } }
      a.assignments[botId] = { tools: [...input.tools], resources: [...input.resources] }
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
export function configurationApi({ harness, context, catalog, models }) {
  const syncedRevisions = new Map()
  const sync = ({ bot, versions }) => {
    if ((syncedRevisions.get(bot.id) ?? 0) >= versions.length) return
    const i = catalog.findIndex((b) => b.id === bot.id)
    if (i >= 0) { catalog[i] = { ...copy(bot), ...(catalog[i].status === 'inactive' ? { status: 'inactive', deactivatedAt: catalog[i].deactivatedAt } : {}) }; syncedRevisions.set(bot.id, versions.length) }
  }
  async function read(botId) {
    return harness.commit(async (tx) => {
      const d = await tx.doc(BotDirectory), a = await tx.doc(ToolAccess)
      initializeConfiguration(d, a)
      const bot = d.items.find((b) => b.id === botId)
      if (!bot) fail(404, 'BOT_NOT_FOUND', '指定的Bot不存在。')
      return copy({ bot, versions: d.configurations[botId], installed: names(), assigned: a.assignments[botId], revoked: a.revoked[botId] ?? [],
        models: models.map((m) => ({ id: m.id, provider: m.provider })), resources: [...supportedResources, ...((await tx.doc(FeishuCalendar)).binding ? [(await tx.doc(FeishuCalendar)).binding.resource, `workspace:feishu:${hash([(await tx.doc(FeishuCalendar)).binding.connectionId, (await tx.doc(FeishuCalendar)).binding.calendarId])}`] : [])],
        audit: d.managementAudit.filter((e) => !e.botId || e.botId === botId) })
    }, context)
  }
  async function change(botId, input) {
    const result = await harness.commit(async (tx) => {
      return changeConfiguration(tx, botId, input, { models })
    }, context)
    if (result.error) fail(result.error.status, result.error.code, result.error.message)
    // Reload committed truth; concurrent callers must not replace a newer catalog with an old receipt.
    sync(await read(botId))
    return result
  }
  return { getBotConfiguration: read, updateBotConfiguration: (id, input) => change(id, input) }
}

export async function createConfiguredBot(tx, parsed, configuredModels) {
  const liveDirectory = await tx.doc(BotDirectory)
  const directory = copy(liveDirectory)
  const access = await tx.doc(ToolAccess)
  const created = createDirectoryBot(directory, parsed)
  if (created.created && created.bot.defaults.mode === 'model' && !configuredModels.some((m) => JSON.stringify(m) === JSON.stringify(created.bot.defaults.model))) throw new TaskInputError(400, 'MODEL_NOT_CONFIGURED', '仅可选择已配置模型。')
  if (created.created) {
    // S1/D-15: a new Bot starts with local workspace tools (no pool filtering).
    const local = NEW_BOT_WORKSPACE_TOOLS.filter((n) => !created.bot.defaults.tools.includes(n))
    if (local.length) {
      created.bot.defaults.tools.push(...local)
      if (!created.bot.defaults.toolResources.includes('workspace:local')) created.bot.defaults.toolResources.push('workspace:local')
    }
    directory.items[directory.items.findIndex((b) => b.id === created.bot.id)] = JSON.parse(JSON.stringify(created.bot))
    directory.requests[parsed.requestId].bot = JSON.parse(JSON.stringify(created.bot))
    initializeConfiguration(directory, access)
    access.assignments[created.bot.id] = { tools: [...created.bot.defaults.tools], resources: [...created.bot.defaults.toolResources] }
    directory.managementAudit.push({ id: directory.managementAudit.length + 1, botId: created.bot.id, type: 'bot-created', source: 'authenticated-user', createdAt: new Date().toISOString(), configRef: JSON.parse(JSON.stringify(created.bot.configRef)) })
  }
  Object.assign(liveDirectory, directory)
  return JSON.parse(JSON.stringify(created))
}
