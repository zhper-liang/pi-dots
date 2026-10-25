import { createHash } from 'node:crypto'
import { BotDirectory, parseBotCreation, deactivateDirectoryBot } from './bot-directory.mjs'
import { createConfiguredBot, changeConfiguration } from './bot-configuration.mjs'
import { ToolAccess } from './tools.mjs'
import { MANAGEMENT_TOOLS, validManagementArgs } from './management-tools.mjs'
import { decide, unattended } from './policy.mjs'
import { requestManagementApproval } from './approvals.mjs'
const copy = x => JSON.parse(JSON.stringify(x))
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x
const hash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const managementOperationId = (card, entryId, args) => `chief-${hash({ taskId: card.taskId, entryId, action: args.action, target: args.action === 'create' ? 'new' : args.botId }).slice(0, 40)}`
// Only deactivation asks by default; Chief cannot deactivate its own entry point.
export async function gateManagement(tx, card, call, entryId, turnId) {
  const d = await tx.doc(BotDirectory)
  const denied = (code, message) => ({ ok: false, error: { code, message } })
  // Admission failures and inspect are answered by executeManagement itself; no card is created.
  if (call.name === 'bot_inspect' || await admissionDenied(tx, card, call) || !validManagementArgs(call)) return { execute: true }
  const args = call.arguments
  if (args.action === 'deactivate' && args.botId === 'chief') return { result: denied('CHIEF_MANAGEMENT_FORBIDDEN', '不能停用Chief。') }
  const verdict = await decide(tx, { botId: card.bot.id, tool: 'bot_manage', action: args.action, args, selfBotId: card.bot.id, origin: card.origin ?? (card.scheduledWorkflow ? 'routine' : 'user') })
  if (verdict.effect === 'allow') return { execute: true }
  if (verdict.effect === 'deny') return { result: denied('POLICY_DENIED', '规则禁止该动作。') }
  if (unattended(card.origin ?? (card.scheduledWorkflow ? 'routine' : 'user'))) return { result: { ok: true, data: { state: 'skipped', reason: verdict.reason, notice: '已跳过：这一步需要你来做。' } } }
  // Replays and admission failures keep executeManagement's exact semantics and need no card.
  const operationKey = managementOperationId(card, entryId, args)
  if (d.chiefReceipts?.[operationKey]) return { execute: true }
  const target = d.items.find(b => b.id === args.botId)
  if (args.action !== 'create' && !target) return { execute: true }
  if (args.action !== 'create' && target.configRef.version !== args.expectedVersion) return { execute: true }
  return { result: await requestManagementApproval(tx, card, call, entryId, turnId, operationKey, target, 'bot_manage', verdict.allowAlways) }
}
async function admissionDenied(tx, card, call) {
  const d = await tx.doc(BotDirectory), access = await tx.doc(ToolAccess), record = await tx.task(card.taskId)
  const chief = d.items.find(b => b.id === 'chief')
  return card.bot.id !== 'chief' || record.input.botId !== 'chief' || !chief || chief.status === 'inactive' || !card.managementTools?.includes(call.name) || !MANAGEMENT_TOOLS.includes(call.name) || access.revoked.chief?.includes(call.name)
}
export async function executeManagement(tx, card, call, entryId, models, hooks = {}) {
  const d = await tx.doc(BotDirectory), access = await tx.doc(ToolAccess)
  const denied = (code, message) => ({ ok: false, error: { code, message } })
  if (await admissionDenied(tx, card, call)) return denied('MANAGEMENT_NOT_AUTHORIZED', '仅服务端授权的Chief会话可使用管理工具。')
  if (!validManagementArgs(call)) return denied('TOOL_INVALID_ARGUMENTS', '管理参数无效；不能覆盖身份或调用其他管理动作。')
  if (call.name === 'bot_inspect') return { ok: true, data: { source: 'chief-management-directory', bots: d.items.map(b => ({ botId: b.id, name: b.name, description: b.description, status: b.status ?? 'active', configRef: copy(b.configRef), assigned: copy(access.assignments[b.id]), parameters: copy(b.defaults) })), notice: '可按Bot当前工具与资源分配执行管理。目标不明确须询问用户。' } }
  const args = copy(call.arguments)
  const operationId = managementOperationId(card, entryId, args)
  const signature = hash(args)
  d.chiefReceipts ??= {}
  const prior = d.chiefReceipts[operationId]
  if (prior) return prior.signature === signature ? { ...copy(prior.result), replayed: true } : denied('MANAGEMENT_REQUEST_CONFLICT', '同一操作不能更换参数；请重新明确请求，产生新的用户输入。')
  const before = d.items.find(b => b.id === args.botId)
  const previous = before ? copy(before.configRef) : null
  const auditStart = d.managementAudit.length
  const remember = result => { d.chiefReceipts[operationId] = { signature, result: copy(result) }; return result }
  let result
  try {
    let response
    if (args.action === 'create') {
      const { action: _action, ...input } = args
      response = await createConfiguredBot(tx, parseBotCreation({ ...input, requestId: operationId }), models)
      if (response.created && hooks.botCreated) await hooks.botCreated(tx, response.bot.id, card)
    } else {
      if (!before) return remember(denied('BOT_NOT_FOUND', '目标必须是目录中明确的botId；名称或模糊目标无效。'))
      if (before.id === 'chief' && args.action === 'deactivate') return remember(denied('CHIEF_MANAGEMENT_FORBIDDEN', '不能停用Chief。'))
      if (before.configRef.version !== args.expectedVersion) return remember(denied('CONFIG_VERSION_CONFLICT', '配置已更新；请重新读取并由用户重新决策。'))
      if (args.action === 'configure') {
        const { action: _action, botId: _botId, ...input } = args
        response = await changeConfiguration(tx, args.botId, { ...input, requestId: operationId }, { models })
        if (response.error) return remember({ ok: false, error: response.error })
      } else response = { bot: await deactivateDirectoryBot(tx, args.botId) }
    }
    const bot = response.bot
    const provenance = { source: 'chief-management', initiatingUser: card.initiatingUser ?? 'authenticated-user', executingChief: 'chief', taskId: card.taskId, inputEntryId: entryId, operationId, botId: bot.id, previous, next: copy(bot.configRef) }
    for (const audit of d.managementAudit.slice(auditStart)) Object.assign(audit, provenance)
    for (const version of d.configurations[bot.id] ?? []) if (args.action === 'create' || version.requestId === operationId) Object.assign(version, { source: 'chief-management', initiatingUser: provenance.initiatingUser, executingChief: 'chief', taskId: card.taskId, operationId })
    result = { ok: true, data: { ...provenance, action: args.action, bot: copy(bot), entry: { botId: bot.id, href: `/#bot=${encodeURIComponent(bot.id)}`, historyAvailable: true }, created: response.created ?? false } }
    d.managementAudit.push({ id: d.managementAudit.length + 1, type: `chief-${args.action}`, ...provenance, createdAt: new Date().toISOString() })
    d.chiefReceipts[operationId] = { signature, result: copy(result) }
  } catch (e) {
    if (!e.code || !e.status) throw e
    result = denied(e.code, e.message)
  }
  return remember(result)
}
