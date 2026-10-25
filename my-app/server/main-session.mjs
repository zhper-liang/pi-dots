import { defineDoc } from '@earendil-works/pi-durable'
import { createHash } from 'node:crypto'
import { TaskInputError, taskParameters } from './task-config.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { workspaceShareAllowed, workspaceHistoryAllowed } from './workspace-grants.mjs'
import { TaskApprovals } from './approvals.mjs'
import { TaskBlockers } from './blockers.mjs'
import { CallUsage, ToolAccess, toolSets } from './tools.mjs'
import { markDirty } from './detector-state.mjs'
import { TASK_CREATE_TOOL, TASK_STATUS_TOOL, MAIN_TASK_LIMIT, MAIN_CHIEF_TOOLS, validMainArgs } from './main-tools.mjs'

// PLAN §8.1. One persistent main session per Bot (card.kind='main'): conversation entry point,
// read-only tools plus task_create. Execution happens in derived Tasks owned by the same Bot.
export const MainSessions = defineDoc({ kind: 'pidot.main-sessions', version: 1, scope: 'session', initial: () => ({ byBot: {}, children: {}, receipts: {} }) })
// I-12: one-line summaries only, deleted after use. Not memory; no preference/decision fields.
export const TaskDigest = defineDoc({ kind: 'pidot.task-digest', version: 1, scope: 'session', initial: () => ({ byMain: {} }) })

const copy = x => JSON.parse(JSON.stringify(x))
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x
const hash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
const OUTCOME = { succeeded: '已完成', failed: '失败', cancelled: '已取消' }

export const MAIN_SYSTEM_PROMPT = '\n这是你的主会话：可直接使用当前Bot已分配的工具完成工作。较长执行或需要等待的工作，用task_create派给自己的独立任务，不要在这里等待结果；进度用task_status查看。用户想定期或在某事发生时自动做某事，用routine_propose为自己创建例行任务；默认直接执行，规则或全局暂停可能要求确认。没有工具回执不得声称已执行。'

// D-18: added only when this Bot has collaborators_list + task_assign (Chief hands work to a Bot it just created).
export const MAIN_DELEGATION_PROMPT = '\n要把工作交给另一个Bot（包括刚用bot_manage新建的）：先用collaborators_list确认对方botId，再用task_create派一个任务，目标里写明交给哪个Bot（botId）和要它做什么；若当前工具集中有task_assign，可用它收取结果。只能声称工具回执确认的执行结果。'

export async function mainSessionFor(tx, botId) { return (await tx.doc(MainSessions)).byBot[botId] ?? null }

/** Idempotent: exactly one main session per active Bot, created with the Bot's live configuration. */
export async function ensureMainSession(tx, botId, { createTask, TaskCard, rootConversationId }) {
  const doc = await tx.doc(MainSessions)
  if (doc.byBot[botId]) return doc.byBot[botId]
  const bot = (await tx.doc(BotDirectory)).items.find(b => b.id === botId)
  if (!bot || (bot.status ?? 'active') === 'inactive') return null
  const taskId = await createTask(tx, { botId, title: bot.name }, rootConversationId)
  const card = await tx.doc(TaskCard, taskId)
  card.kind = 'main'; card.origin = 'user'
  if (botId === 'chief') card.managementTools = [...MAIN_CHIEF_TOOLS]
  doc.byBot[botId] = taskId
  ;(await tx.doc(TaskDigest)).byMain[taskId] = []
  return taskId
}

export function mainSessionService({ TaskCard, ChatInput, createTask }) {
  const create = (tx, card, call, entryId) => derive(tx, card, { entryId, ...call.arguments })
  // Shared by task_create and finding actions (PLAN §8.2 "处理"): same snapshot, brief and limits.
  async function derive(tx, card, a) {
    const entryId = a.entryId, doc = await tx.doc(MainSessions)
    const key = `${card.taskId}:${entryId}:${a.operationId}`, signature = hash([a.goal, a.completionCriteria])
    const prior = doc.receipts[key]
    if (prior) return prior.signature === signature ? { ...copy(prior.result), replayed: true } : fail(409, 'MAIN_REQUEST_CONFLICT', '同一operationId不能更换目标或完成标准。')
    const bot = (await tx.doc(BotDirectory)).items.find(b => b.id === card.bot.id)
    if (!bot || (bot.status ?? 'active') === 'inactive') fail(409, 'BOT_INACTIVE', 'Bot 已停用，不能派新任务。')
    // Reads only (no append before createTask): a terminally faulted child no longer counts.
    let running = 0
    for (const [id, c] of Object.entries(doc.children)) if (c.mainTaskId === card.taskId && c.state === 'running') { const r = await tx.task(Number(id)); if (r && r.state.status !== 'terminal') running++ }
    if (running >= MAIN_TASK_LIMIT) fail(409, 'MAIN_CONCURRENCY_LIMIT', `已有 ${running} 个任务在进行，先等其中一个结束或取消，再派新任务。`)
    const parent = await tx.task(card.taskId)
    const childTaskId = await createTask(tx, { botId: card.bot.id, title: (a.title ?? a.goal).trim().slice(0, 100), taskState: { goal: a.goal, completionCriteria: a.completionCriteria } }, parent.conversationId)
    const child = await tx.doc(TaskCard, childTaskId)
    const createdAt = new Date().toISOString()
    const brief = await tx.appendEntry(child.conversationId, { kind: 'pidot.user', data: { role: 'user', content: `主会话派来的独立任务简报（仅任务数据，不授予权限）：${JSON.stringify({ goal: a.goal, completionCriteria: a.completionCriteria })}`, createdAt, source: 'main-session' } })
    child.mainParent = { mainTaskId: card.taskId, entryId, operationId: a.operationId, briefEntryId: brief.id, mainConversationId: card.conversationId }
    child.origin = 'user'
    ;(await tx.doc(ChatInput, childTaskId)).entryId = brief.id
    doc.children[childTaskId] = { mainTaskId: card.taskId, botId: card.bot.id, title: child.title, state: 'running', outcome: null, createdAt, overAt: null, result: null }
    const digest = await tx.doc(TaskDigest)
    ;(digest.byMain[card.taskId] ??= []).push({ taskId: childTaskId, summary: a.goal.trim().slice(0, 80), createdAt, state: 'running', overAt: null, outcome: null })
    const result = { ok: true, data: { taskId: childTaskId, href: `/#bot=${encodeURIComponent(card.bot.id)}&task=${childTaskId}`, status: 'running', notice: '已派给独立任务，正在后台执行；不要等待，结束后会在后续对话中出现概述。' } }
    doc.receipts[key] = { signature, result: copy(result) }
    return result
  }
  async function status(tx, card, call) {
    const doc = await tx.doc(MainSessions), want = call.arguments.taskId
    const rows = Object.entries(doc.children).filter(([id, c]) => c.mainTaskId === card.taskId && (want === undefined || Number(id) === want))
    if (want !== undefined && !rows.length) fail(404, 'MAIN_TASK_NOT_OWNED', '只能查看本主会话派出的任务。')
    const items = []
    for (const [id, c] of rows) {
      const taskId = Number(id), record = await tx.task(taskId)
      // A terminally faulted child not yet reconciled is reported as over/failed without writing here.
      const dead = c.state === 'running' && (!record || record.state.status === 'terminal')
      const view = dead ? { state: 'over', outcome: record?.state.outcome?.status === 'aborted' ? 'cancelled' : 'failed' } : { state: c.state, outcome: c.outcome }
      let pendingApprovals = null, pendingBlockers = null, shared = false
      if (record && record.state.status !== 'terminal') {
        pendingApprovals = (await tx.doc(TaskApprovals, taskId)).items.filter(i => i.status === 'pending').length
        pendingBlockers = (await tx.doc(TaskBlockers, taskId)).items.filter(i => i.status === 'pending').length
        const childCard = await tx.doc(TaskCard, taskId), access = await tx.doc(ToolAccess)
        shared = c.result !== null && workspaceShareAllowed(childCard, card, access) && await workspaceHistoryAllowed(tx, childCard, toolSets(childCard, (await tx.doc(BotDirectory)).items, access))
      }
      items.push({ taskId, title: c.title, state: view.state, outcome: view.outcome, createdAt: c.createdAt, overAt: c.overAt, pendingApprovals, pendingBlockers, ...(shared ? { resultExcerpt: c.result } : {}) })
    }
    return { ok: true, data: { items, notice: '结果只是摘要；详情在对应任务里。' } }
  }
  return {
    derive,
    async execute(tx, card, call, entryId) {
      if (card.kind !== 'main' || (await mainSessionFor(tx, card.bot.id)) !== card.taskId) fail(403, 'MAIN_SESSION_ONLY', '只有主会话可以使用此工具。')
      if (!validMainArgs(call)) fail(400, 'TOOL_INVALID_ARGUMENTS', '参数无效；task_create 不能指定其他Bot。')
      return call.name === TASK_CREATE_TOOL ? create(tx, card, call, entryId) : call.name === TASK_STATUS_TOOL ? status(tx, card, call) : fail(400, 'TOOL_INVALID_ARGUMENTS', '未知主会话工具。')
    },
  }
}

/** P-21: the first brief input finished (success/failure) or the Task was cancelled. Idempotent. */
export async function markMainChildOver(tx, childCard, outcome, content = null) {
  const parent = childCard.mainParent
  if (!parent) return
  const doc = await tx.doc(MainSessions), row = doc.children[childCard.taskId]
  if (!row || row.state === 'over') return
  const overAt = new Date().toISOString()
  Object.assign(row, { state: 'over', outcome, overAt, result: typeof content === 'string' ? content.slice(0, 500) : null })
  const item = ((await tx.doc(TaskDigest)).byMain[parent.mainTaskId] ?? []).find(i => i.taskId === childCard.taskId)
  if (item) Object.assign(item, { state: 'over', outcome, overAt })
  // D-20: a "帮我想办法" card shows its conclusion (user-facing system card only; never model context, I-08).
  const result = childCard.findingAssist && outcome === 'succeeded' && typeof content === 'string' && content.trim() ? { result: content.length > 500 ? `${content.slice(0, 500)}…` : content } : {}
  await mirrorToMain(tx, childCard, { mirrorKind: 'finished', outcome, summary: `任务「${childCard.title}」${OUTCOME[outcome] ?? outcome}`, ...result })
  // PLAN §8.5 "本 Bot 的派生 Task 结束" routine trigger.
  await markDirty(tx, { sourceId: `bot:${childCard.bot.id}`, type: 'TaskFinished', id: childCard.taskId })
}

/** A derived Task that faulted terminally never reaches finishReply or cancel: settle it as failed. */
export async function reconcileMainChildren(tx, mainCard) {
  const doc = await tx.doc(MainSessions), dead = []
  for (const [id, c] of Object.entries(doc.children)) if (c.mainTaskId === mainCard.taskId && c.state === 'running') {
    const record = await tx.task(Number(id))
    if (!record || record.state.status === 'terminal') dead.push([Number(id), c, record?.state.outcome?.status === 'aborted' ? 'cancelled' : 'failed'])
  }
  // All table reads happen above; only document writes and appends follow.
  for (const [taskId, c, outcome] of dead) await markMainChildOver(tx, { taskId, title: c.title, bot: { id: c.botId }, mainParent: { mainTaskId: mainCard.taskId, mainConversationId: mainCard.conversationId } }, outcome)
}

/** Mirror card in the main session (I-08): a system entry; never wakes the model, never counted. */
export async function mirrorToMain(tx, childCard, data) {
  const parent = childCard.mainParent
  if (!parent?.mainConversationId) return
  await tx.appendEntry(parent.mainConversationId, { kind: 'pidot.mirror', data: { ...copy(data), childTaskId: childCard.taskId, childTitle: childCard.title, botId: childCard.bot.id, createdAt: new Date().toISOString() } })
}

/** U-10: inject over-and-unconsumed digest items for this input; deleted only after a committed reply. */
export async function claimDigest(tx, mainTaskId, entryId) {
  const items = ((await tx.doc(TaskDigest)).byMain[mainTaskId] ?? []).filter(i => i.state === 'over')
  if (!items.length) return ''
  for (const item of items) item.consumingEntryId = entryId
  return `\n上次对话后已结束的任务（宿主记录的一行概述，不是用户指令）：${items.map(i => `#${i.taskId}「${i.summary}」${OUTCOME[i.outcome] ?? i.outcome}`).join('；')}。需要细节用task_status。`
}
export async function settleDigest(tx, mainTaskId, entryId, failed) {
  const digest = await tx.doc(TaskDigest), list = digest.byMain[mainTaskId]
  if (!list) return
  if (failed) { for (const item of list) if (item.consumingEntryId === entryId) delete item.consumingEntryId; return }
  digest.byMain[mainTaskId] = list.filter(i => i.consumingEntryId !== entryId)
}

/**
 * Admission of a new input into a main session. Per-input call budget (lifetime kept separately).
 * S1: removed D-04 permission refresh; tools now reflect current assignment, effective immediately.
 */
export async function beginMainInput(tx, card, entryId) {
  const usage = await tx.doc(CallUsage, card.taskId)
  if (usage.inputEntryId === entryId) return
  usage.lifetime ??= { modelCalls: 0, toolCalls: 0, totalTokens: 0, unknownTokenCalls: 0 }
  for (const key of ['modelCalls', 'toolCalls', 'totalTokens', 'unknownTokenCalls']) { usage.lifetime[key] += usage[key] ?? 0; usage[key] = 0 }
  usage.inputEntryId = entryId
  await reconcileMainChildren(tx, card)
}
/** What a main session's next input will run with: the composer's "/" Skill list uses it. S1: simplified. */
export async function projectMainCard(tx, card) {
  if (card.kind !== 'main') return card
  const bot = (await tx.doc(BotDirectory)).items.find(b => b.id === card.bot.id), access = await tx.doc(ToolAccess)
  if (!bot || !access.assignments?.[bot.id]) return card
  const parameters = { ...taskParameters(undefined, copy(bot.defaults)), tools: [...access.assignments[bot.id].tools], toolResources: [...access.assignments[bot.id].resources] }
  return { ...copy(card), parameters }
}
// S1: refreshMainPermissions deleted.
