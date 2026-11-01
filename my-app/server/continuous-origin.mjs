import { createHash } from 'node:crypto'
import { TaskInputError } from './task-config.mjs'

const isContinuousTask = card => card?.executionPolicy?.kind === 'continuous'

const copy = value => JSON.parse(JSON.stringify(value))
const fail = (code, message = '持续目标的来源或交付入口当前不可访问。') => { throw new TaskInputError(409, code, message) }

async function readCard(tx, taskId, TaskCard) {
  const {readCancelledArchive}=await import('./cancellation.mjs')
  const record = await tx.task(taskId)
  if (!record) fail('CONTINUOUS_ORIGIN_DENIED')
  const archive = record.state.status === 'terminal' ? await readCancelledArchive(tx, taskId) : null
  const card = archive?.documents[TaskCard.definition.kind] ?? (record.state.status === 'terminal' ? null : await tx.doc(TaskCard, taskId))
  if (!card) fail('CONTINUOUS_ORIGIN_DENIED')
  return { record, card, archive }
}

/** Original source identity never follows a main-session replacement; only delivery does. */
export async function resolveContinuousOrigin(tx, root, { TaskCard, bots } = {}) {
  const {ContinuousOrigin}=await import('./continuous-task.mjs')
  const {assertBotActive,BotDirectory}=await import('./bot-directory.mjs')
  const {assertNotCancelled}=await import('./cancellation.mjs')
  const {assertSessionVisible,SessionLifecycle}=await import('./session-lifecycle.mjs')
  const {MainSessions}=await import('./main-session.mjs')
  const {assertGroupTask}=await import('./groups.mjs')
  const {ToolAccess,toolSets}=await import('./tools.mjs')
  const {workspaceHistoryAllowed,workspaceShareAllowed}=await import('./workspace-grants.mjs')
  if (!isContinuousTask(root) || root.executionPolicy.rootTaskId !== root.taskId || !TaskCard) fail('CONTINUOUS_ORIGIN_DENIED')
  const rootRecord=await tx.task(root.taskId)
  if(!rootRecord||rootRecord.input.botId!==root.bot.id||root.initiatingUser!=='authenticated-user'||
    (await tx.conversation(root.conversationId))?.owner?.taskId!==root.taskId) fail('CONTINUOUS_ORIGIN_DENIED')
  const origin = await tx.doc(ContinuousOrigin, root.taskId)
  if (origin.rootTaskId !== root.taskId || origin.coordinatorBotId !== root.bot.id || root.configRef.botId !== root.bot.id ||
    origin.rootInputId !== undefined && origin.rootInputId !== root.executionPolicy.rootInputId) fail('CONTINUOUS_ORIGIN_DENIED')
  const currentDirectory=await tx.doc(BotDirectory)
  if(!currentDirectory.items.some(bot=>bot.id===root.bot.id&&bot.status!=='inactive')) fail('CONTINUOUS_ORIGIN_DENIED')
  await assertBotActive(tx, root.bot.id)
  const { record, card: source, archive } = await readCard(tx, origin.originTaskId, TaskCard)
  if (record.input.botId !== origin.coordinatorBotId || source.bot.id !== origin.coordinatorBotId || source.configRef.botId !== source.bot.id ||
    source.initiatingUser !== root.initiatingUser || (await tx.conversation(source.conversationId))?.owner?.taskId !== source.taskId) fail('CONTINUOUS_ORIGIN_DENIED')
  if (origin.sourceMessageId !== null && origin.sourceMessageId !== undefined) {
    const entry = await tx.entry(origin.sourceMessageId)
    if (entry?.kind !== 'pidot.user' || entry.conversationId !== source.conversationId) fail('CONTINUOUS_ORIGIN_DENIED')
  }
  let group = null, delivery = source
  if (origin.originKind === 'group') {
    await assertSessionVisible(tx, source.taskId)
    await assertNotCancelled(tx, source.taskId, record)
    group = await assertGroupTask(tx, source)
    if (!group || group.groupId !== origin.groupId || group.adminBotId !== root.bot.id) fail('CONTINUOUS_ORIGIN_DENIED')
  } else if (origin.originKind === 'main') {
    if (source.kind !== 'main' || origin.groupId) fail('CONTINUOUS_ORIGIN_DENIED')
    const lifecycle = await tx.doc(SessionLifecycle), mains = await tx.doc(MainSessions)
    const currentId = mains.byBot[root.bot.id]
    let next = source.taskId
    const visited = new Set()
    while (next !== currentId && !visited.has(next)) {
      visited.add(next)
      const cleared = lifecycle.deleted[String(next)]
      if (cleared?.action !== 'clear-main' || cleared.botId !== root.bot.id || !Number.isSafeInteger(cleared.replacementTaskId)) fail('CONTINUOUS_ORIGIN_DENIED')
      next = cleared.replacementTaskId
    }
    if (!currentId || next !== currentId) fail('CONTINUOUS_ORIGIN_DENIED')
    const pending = Object.values(lifecycle.requests).some(request => request.taskId === currentId && request.action === 'clear-main' && request.state !== 'succeeded')
    if (pending) fail('MAIN_SESSION_REPLACING', '来源主会话正在换新，待原请求完成后继续。')
    if (currentId === source.taskId) {
      await assertSessionVisible(tx, source.taskId)
      await assertNotCancelled(tx, source.taskId, record)
    } else {
      if (archive?.cancellation?.scope !== 'main-session-only' && !(lifecycle.deleted[String(source.taskId)]?.action === 'clear-main')) fail('CONTINUOUS_ORIGIN_DENIED')
      const current = await readCard(tx, currentId, TaskCard)
      delivery = current.card
      await assertSessionVisible(tx, currentId)
      await assertNotCancelled(tx, currentId, current.record)
      if (delivery.kind !== 'main' || delivery.bot.id !== root.bot.id || delivery.configRef.botId !== root.bot.id ||
        delivery.conversationId === source.conversationId || (await tx.conversation(delivery.conversationId))?.owner?.taskId !== currentId) fail('CONTINUOUS_ORIGIN_DENIED')
    }
  } else fail('CONTINUOUS_ORIGIN_DENIED')
  const access = await tx.doc(ToolAccess), catalog = bots ?? (await tx.doc(BotDirectory)).items
  for (const card of [source, root, delivery]) {
    if (!await workspaceHistoryAllowed(tx, card, toolSets(card, catalog, access))) fail('CONTINUOUS_ORIGIN_DENIED')
  }
  if (!workspaceShareAllowed(source, root, access)) fail('CONTINUOUS_ORIGIN_DENIED')
  const { feishuTaskAllowed, isFeishuResource } = await import('./feishu-calendar.mjs')
  const sourceSets = toolSets(source, catalog, access), rootSets = toolSets(root, catalog, access)
  if (!await feishuTaskAllowed(tx, source, sourceSets) || !await feishuTaskAllowed(tx, root, rootSets) ||
    sourceSets.resources.filter(isFeishuResource).some(resource => !rootSets.resources.includes(resource))) fail('CONTINUOUS_ORIGIN_DENIED')
  return { origin, source, group, delivery, root }
}

/** Groups are origins, not another execution parent or a new permission grant. */
export async function resolveContinuousSource(tx, parent, services) {
  const {assertGroupTask}=await import('./groups.mjs')
  if (isContinuousTask(parent)) return resolveContinuousOrigin(tx, parent, services)
  return { source: parent, root: parent, delivery: parent, group: await assertGroupTask(tx, parent), origin: null }
}

/** Read before cancelling/appending: callers stop each returned root using existing cancellation. */
export async function continuousOriginRoots(tx, originTaskId, { TaskCard, taskKind } = {}) {
  const {ContinuousOrigin}=await import('./continuous-task.mjs')
  const roots = []
  let cursor
  do {
    const page = await tx.scanTasks(taskKind ? { kind: taskKind } : {}, 100, cursor)
    cursor = page.next
    for (const record of page.items) {
      if (record.state.status === 'terminal') continue
      const card = await tx.doc(TaskCard, record.id)
      if (isContinuousTask(card) && (await tx.doc(ContinuousOrigin, record.id)).originTaskId === originTaskId) roots.push(record.id)
    }
  } while (cursor)
  return roots
}

/** Same commit as stage/final state. A stable event ID cannot publish changed content on retry. */
export async function publishContinuousOriginEvent(tx, root, event, services) {
  const {mirrorToMain}=await import('./main-session.mjs')
  if (!event || typeof event.eventId !== 'string' || !/^[\w.:-]{1,160}$/.test(event.eventId) || !Number.isSafeInteger(event.goalRevision) || event.goalRevision < 1 ||
    !['progress', 'completed', 'failed', 'cancelled', 'blocked', 'limited'].includes(event.kind) || typeof event.summary !== 'string' || event.summary.length > 8000) fail('CONTINUOUS_EVENT_INVALID')
  // The host may resolve before appending the stage decision in this same commit.
  // This is not a persisted permission grant; never accept it from an API/model input.
  const { origin, delivery, group } = services?.resolvedOrigin ?? await resolveContinuousOrigin(tx, root, services)
  if(event.goalRevision>root.taskState.goalRevision) fail('CONTINUOUS_EVENT_INVALID')
  if(event.kind==='completed') {
    const {TaskProgress}=await import('./continuous-task.mjs')
    const outcome=(await tx.doc(TaskProgress,root.taskId)).finalOutcome
    if(outcome?.status!=='completed'||outcome.goalRevision!==event.goalRevision) fail('CONTINUOUS_EVENT_INVALID','整个目标尚未通过最终核验，不能发布完成。')
  }
  const key = `${root.taskId}:${event.goalRevision}:${event.eventId}`
  const signature = createHash('sha256').update(JSON.stringify(event)).digest('hex')
  origin.deliveries ??= []
  const final=event.kind==='completed'
  const prior = origin.deliveries.find(row => row.key === key || final&&row.kind==='completed'&&row.goalRevision===event.goalRevision)
  if (prior) {
    if (prior.signature !== signature) fail('CONTINUOUS_EVENT_CONFLICT', '同一目标事件不能变更交付内容。')
    return { ...copy(prior), replayed: true }
  }
  const data = { ...copy(event), rootTaskId: root.taskId, rootInputId: root.executionPolicy.rootInputId,
    originTaskId: origin.originTaskId, sourceMessageId: origin.sourceMessageId ?? null, createdAt: new Date().toISOString() }
  let receipt
  if (group) {
    const entry = await tx.appendEntry(delivery.conversationId, { kind: 'pidot.continuous-event', data })
    receipt = { taskId: delivery.taskId, entryId: entry.id }
  } else {
    receipt = await mirrorToMain(tx, { ...root, mainParent: { ...root.mainParent, mainTaskId: origin.originTaskId,
      mainConversationId: delivery.taskId === origin.originTaskId ? delivery.conversationId : undefined, botId: root.bot.id } },
    { mirrorKind: 'continuous-event', ...data })
  }
  const result = { key, signature, kind:event.kind, goalRevision: event.goalRevision, eventId: event.eventId, ...receipt }
  origin.deliveries.push(result)
  origin.deliveryTaskId = receipt?.taskId ?? delivery.taskId
  return { ...copy(result), replayed: false }
}
