import { createHash, randomUUID } from 'node:crypto'
import { BLOCKER_TOOL } from './blockers.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError, taskParameters } from './task-config.mjs'
import { inferBotRole } from './bot-templates.mjs'

// One session Document, committed atomically with the creation receipt. No new Task state machine.
export const BotDirectory = defineDoc({ kind: 'pidot.bot-directory', version: 1, scope: 'session',
  initial: () => ({ initialized: false, items: [], requests: {} }) })

// PLAN §8.6: only the name is required; an omitted description comes from the fixed template (P-18).
export function parseBotCreation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !['name', 'description', 'profile', 'parameters', 'requestId'].includes(key)) ||
    typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60 ||
    (input.description !== undefined && (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 2000)) ||
    typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) || ['constructor', 'prototype'].includes(input.requestId) ||
    (input.profile !== undefined && !['general', 'mock-calendar'].includes(input.profile))) {
    throw new TaskInputError(400, 'INVALID_BOT', '仅接受名称（1–60字符）、可选职责（1–2000字符）、受控profile/parameters及稳定requestId；不能提供工具、资源或凭证。')
  }
  const name = input.name.normalize('NFKC').trim()
  const value = { name, description: input.description?.trim() ?? inferBotRole(name).description,
    profile: input.profile ?? 'general', parameters: input.parameters }
  return { ...value, requestId: input.requestId }
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value

export function createDirectoryBot(directory, input) {
  const signature = createHash('sha256').update(JSON.stringify(canonical({ name: input.name, description: input.description, profile: input.profile, ...(input.parameters === undefined ? {} : { parameters: input.parameters }) }))).digest('hex')
  const previous = Object.hasOwn(directory.requests, input.requestId) ? directory.requests[input.requestId] : undefined
  if (previous?.bot) {
    if (previous.signature !== signature) throw new TaskInputError(409, 'BOT_REQUEST_CONFLICT', '同一requestId不能用于不同创建请求。')
    return { bot: JSON.parse(JSON.stringify(previous.bot)), created: false }
  }
  const base = directory.items.find((bot) => bot.id === (input.profile === 'mock-calendar' ? 'calendar' : 'chief'))
  if (!base) throw new TaskInputError(409, 'BOT_PROFILE_UNAVAILABLE', '服务端未配置此基础能力。')
  const defaults = taskParameters(input.parameters, JSON.parse(JSON.stringify(base.defaults)))
  // A general specialist never inherits future Chief management capabilities.
  if (input.profile === 'general') { defaults.tools = defaults.tools.filter((tool) => tool === BLOCKER_TOOL); defaults.toolResources = [] }
  const legacySignature = createHash('sha256').update(JSON.stringify(canonical({ name: input.name, description: input.description, profile: input.profile, defaults }))).digest('hex')
  if (previous) {
    if (previous.signature !== legacySignature) throw new TaskInputError(409, 'BOT_REQUEST_CONFLICT', '同一requestId不能用于不同创建请求。')
    return { bot: directory.items.find((bot) => bot.id === previous.botId), created: false }
  }
  if (directory.items.some((bot) => bot.name.normalize('NFKC').trim().toLowerCase() === input.name.toLowerCase())) {
    throw new TaskInputError(409, 'BOT_NAME_EXISTS', '此名称已存在，请选择已有Bot或使用不同名称。')
  }
  const id = `bot-${randomUUID()}`
  const bot = { id, name: input.name, description: input.description, role: 'specialist', status: 'active',
    profile: input.profile, createdAt: new Date().toISOString(), configRef: { botId: id, version: '1' }, defaults }
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
  if (bot.id === 'chief' || bot.role === 'chief') throw new TaskInputError(409, 'CHIEF_DEACTIVATION_FORBIDDEN', '本轮不能停用 Chief。')
  if (bot.status === 'inactive') return JSON.parse(JSON.stringify(bot))
  bot.status = 'inactive'; bot.deactivatedAt = new Date().toISOString()
  directory.managementAudit.push({ id: directory.managementAudit.length + 1, type: 'bot-deactivated', botId, source: 'authenticated-user', createdAt: bot.deactivatedAt })
  return JSON.parse(JSON.stringify(bot))
}
