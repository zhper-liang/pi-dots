import { createHash, randomUUID } from 'node:crypto'
import { BLOCKER_TOOL } from './blockers.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError, taskParameters } from './task-config.mjs'
import { inferLegacyBotRole } from './bot-templates.mjs'

// One session Document, committed atomically with the creation receipt. No new Task state machine.
export const BotDirectory = defineDoc({ kind: 'pidot.bot-directory', version: 1, scope: 'session',
  initial: () => ({ initialized: false, items: [], requests: {} }) })

// R1-08: a name is only identity. An omitted description stays blank.
export function parseBotCreation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !['name', 'description', 'profile', 'parameters', 'requestId', 'capabilities'].includes(key)) ||
    typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60 ||
    (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) ||
    typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) || ['constructor', 'prototype'].includes(input.requestId) ||
    (input.profile !== undefined && !['general', 'mock-calendar'].includes(input.profile)) ||
    (input.capabilities !== undefined && (!Array.isArray(input.capabilities) || input.capabilities.length > 64 ||
      new Set(input.capabilities).size !== input.capabilities.length || input.capabilities.some(id =>
        typeof id !== 'string' || !/^(tool|skill|mcp):[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(id))))) {
    throw new TaskInputError(400, 'INVALID_BOT', '仅接受名称（1–60字符）、可选职责（1–2000字符）、受控profile/parameters及稳定requestId；能力只能用能力目录里的 id。')
  }
  const name = input.name.normalize('NFKC').trim()
  const value = { name, description: input.description?.trim() ?? '',
    profile: input.profile ?? 'general', parameters: input.parameters, capabilities: input.capabilities }
  return { ...value, descriptionProvided: input.description !== undefined, requestId: input.requestId }
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value

export function createDirectoryBot(directory, input) {
  const signatureFor = (description, defaults) => createHash('sha256').update(JSON.stringify(canonical({ name: input.name,
    description, profile: input.profile, ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}), ...(defaults ? { defaults } : input.parameters === undefined ? {} : { parameters: input.parameters }) }))).digest('hex')
  const signature = signatureFor(input.description)
  const previous = Object.hasOwn(directory.requests, input.requestId) ? directory.requests[input.requestId] : undefined
  // Old receipts signed the inferred description. Only an omitted description can replay
  // that old signature; explicit changed content must still conflict. Return the frozen bot.
  const descriptions = [input.description, ...(!input.descriptionProvided ? [inferLegacyBotRole(input.name).description] : [])]
  if (previous?.bot) {
    const legacy = previous.bot.capabilityDefaultsVersion !== 2
    if (!descriptions.slice(0, legacy ? undefined : 1).some(description => previous.signature === signatureFor(description)))
      throw new TaskInputError(409, 'BOT_REQUEST_CONFLICT', '同一requestId不能用于不同创建请求。')
    return { bot: JSON.parse(JSON.stringify(previous.bot)), created: false }
  }
  const base = directory.items.find((bot) => bot.id === (input.profile === 'mock-calendar' ? 'calendar' : 'chief'))
  if (!base) throw new TaskInputError(409, 'BOT_PROFILE_UNAVAILABLE', '服务端未配置此基础能力。')
  const defaults = taskParameters(input.parameters, JSON.parse(JSON.stringify(base.defaults)))
  if (previous) {
    const legacyDefaults = JSON.parse(JSON.stringify(defaults))
    if (input.profile === 'general') { legacyDefaults.tools = legacyDefaults.tools.filter(tool => tool === BLOCKER_TOOL); legacyDefaults.toolResources = [] }
    if (!descriptions.some(description => previous.signature === signatureFor(description, legacyDefaults)))
      throw new TaskInputError(409, 'BOT_REQUEST_CONFLICT', '同一requestId不能用于不同创建请求。')
    const bot = directory.items.find(bot => bot.id === previous.botId)
    if (!bot) throw new TaskInputError(409, 'BOT_REQUEST_CONFLICT', '原创建回执缺少 Bot，不能重新创建。')
    return { bot: JSON.parse(JSON.stringify(bot)), created: false }
  }
  // profile is retained as a legacy input, never an implicit grant, even mock-calendar.
  // Runtime safety controls are handled separately by the shared execution chain.
  defaults.tools = []
  defaults.toolResources = []
  if (directory.items.some((bot) => bot.name.normalize('NFKC').trim().toLowerCase() === input.name.toLowerCase())) {
    throw new TaskInputError(409, 'BOT_NAME_EXISTS', '此名称已存在，请选择已有Bot或使用不同名称。')
  }
  const id = `bot-${randomUUID()}`
  const bot = { id, name: input.name, description: input.description, role: 'specialist', status: 'active',
    profile: input.profile, capabilityDefaultsVersion: 2, createdAt: new Date().toISOString(), configRef: { botId: id, version: '1' }, defaults }
  directory.items.push(bot)
  directory.requests[input.requestId] = { botId: id, signature, bot: JSON.parse(JSON.stringify(bot)) }
  return { bot, created: true }
}

// Lifecycle lives in the directory, never in immutable Task/config snapshots.
export async function assertBotActive(tx, botId) {
  const bot = (await tx.doc(BotDirectory)).items.find((item) => item.id === botId)
  if (bot?.status === 'inactive') throw new TaskInputError(409, 'BOT_INACTIVE', 'Bot 已停用；历史和在途真实结果保留，不能执行新工作。')
}

export async function deactivateDirectoryBot(tx, botId) {
  const directory = await tx.doc(BotDirectory)
  const bot = directory.items.find(b => b.id === botId)
  if (!bot) throw new TaskInputError(404, 'BOT_NOT_FOUND', '指定的Bot不存在。')
  if (bot.id === 'chief' || bot.role === 'chief') throw new TaskInputError(409, 'CHIEF_DEACTIVATION_FORBIDDEN', '不能停用 pipi。')
  if (bot.status === 'inactive') return JSON.parse(JSON.stringify(bot))
  bot.status = 'inactive'; bot.deactivatedAt = new Date().toISOString()
  directory.managementAudit.push({ id: directory.managementAudit.length + 1, type: 'bot-deactivated', botId, source: 'authenticated-user', createdAt: bot.deactivatedAt })
  return JSON.parse(JSON.stringify(bot))
}
