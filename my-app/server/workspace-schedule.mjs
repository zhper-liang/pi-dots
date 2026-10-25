import { randomUUID } from 'node:crypto'
import { LOCAL_OWNER, copy, fail, object, payloadHash, validId } from './workspace-schema.mjs'
import { normalizeScheduleRule, nextScheduleDue, latestScheduleDue } from './workspace-schedule-rules.mjs'
import { automationPaused } from './policy.mjs'

const SOURCE = 'local', MAX_SCHEDULES = 200, LEASE_MS = 30000
const active = o => ['claimed', 'retry_wait', 'dispatching', 'unknown', 'waiting'].includes(o?.state)
export const INTERNAL_SCHEDULE_ACTION = 'internal_deterministic_record'
// This driver has NO external effects, notification, Task, tool or model access.
// Its receipt and occurrence succeed in the SAME repository commit.
export function createWorkspaceScheduler({ repository: repo, authority, commitLocal, now = Date.now, boundary = async () => {}, onError = () => {}, refreshExternalSync = async () => {}, reminders, workflows }) {
  const generation = randomUUID(); let stopped = false, timer, running, waking = false
  const get = (tx, type, id) => repo.get(tx, type, LOCAL_OWNER, SOURCE, id)
  const put = (tx, type, row) => repo.put(tx, type, row)
  async function schedules(tx) {
    const a = await repo.list(tx, 'Schedule', LOCAL_OWNER, SOURCE, { limit: 100 })
    const b = a.next === undefined ? [] : (await repo.list(tx, 'Schedule', LOCAL_OWNER, SOURCE, { cursor: a.next, limit: 100 })).items
    return [...a.items, ...b]
  }
  async function permission(tx, actor, action = 'read') {
    authority.check(actor)
    if (actor.principalKind !== 'user') fail(403, 'WORKSPACE_SCHEDULE_ACTOR', '计划管理仅供认证用户；Agent自动动作尚未接入。')
    const p = await authority.authorize(repo, tx, actor, SOURCE, action)
    const read = await authority.authorize(repo, tx, actor, SOURCE, 'read')
    if (read.readScope !== 'full') fail(403, 'WORKSPACE_FORBIDDEN', '计划与回执要求本地来源正文权限。')
    const connection = await get(tx, 'Connection', 'local')
    return { userEpoch: p.grantEpoch, connectionEpoch: connection.authEpoch, sourceId: SOURCE, actions: ['read'] }
  }
  async function authorized(tx, s) {
    if (reminders?.owns(s)) return reminders.authorized(tx, s)
    if (workflows?.owns(s)) return workflows.authorized(tx, s)
    const g = await get(tx, 'Grant', 'user:authenticated-user'), c = await get(tx, 'Connection', 'local'), source = await get(tx, 'Source', 'local')
    return s.authorizationSnapshot && g?.epoch === s.authorizationSnapshot.userEpoch && g?.readScope === 'full' && g?.actions.includes('read') && c?.status === 'active' && c.authEpoch === s.authorizationSnapshot.connectionEpoch && source?.capabilities.includes('read') && s.executionPrincipal?.kind === 'internal' && s.executionPrincipal?.subjectId === 'authenticated-user' && s.actionSpec?.kind === INTERNAL_SCHEDULE_ACTION
  }
  const base = id => ({ schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: SOURCE, id })
  const occurrenceId = (s, due) => payloadHash([s.id, s.revision, new Date(due).toISOString()])
  function occurrence(s, due, state, extra = {}) {
    return { ...base(occurrenceId(s, due)), scheduleId: s.id, revision: s.revision, scheduledFor: new Date(due).toISOString(), attempts: 0, state, ...extra }
  }
  async function cancelActive(tx, s, reason) {
    const o = s.activeOccurrenceId && await get(tx, 'Occurrence', s.activeOccurrenceId)
    // Unknown/in-flight effects must remain visible and are never falsely undone.
    if (o && ['claimed', 'retry_wait'].includes(o.state)) await put(tx, 'Occurrence', { ...o, state: 'cancelled', reason, finishedAt: new Date(now()).toISOString() })
  }
  async function manage(actor, input, tx = null) {
    if (!object(input) || Object.keys(input).some(k => !['requestId', 'command', 'id', 'expectedRevision', 'title', 'timezone', 'rule', 'actionSpec', 'confirmed'].includes(k)) || !validId(input.requestId) || !['create', 'update', 'pause', 'resume', 'cancel'].includes(input.command)) fail(400, 'WORKSPACE_SCHEDULE_INPUT', '计划管理参数无效；不接受请求中的主体。')
    if (['create', 'update', 'resume'].includes(input.command) && input.confirmed !== true) fail(400, 'WORKSPACE_SCHEDULE_CONFIRM', '请明确确认频率、执行条件和内部验收动作；这不是提醒。')
    if (input.command !== 'create' && (!validId(input.id) || !Number.isSafeInteger(input.expectedRevision))) fail(400, 'WORKSPACE_SCHEDULE_INPUT', '需要计划ID与当前revision。')
    // tx: the routine_propose approval (PLAN §8.5) creates the plan inside its own approval commit.
    const op = await commitLocal(actor, { requestId: input.requestId, sourceId: SOURCE, action: input.command === 'create' ? 'create' : input.command === 'cancel' ? 'delete' : 'update', normalizedArgs: { type: 'Schedule', ...copy(input) } }, async tx => {
      const snapshot = await permission(tx, actor, input.command === 'create' ? 'create' : input.command === 'cancel' ? 'delete' : 'update')
      let s = input.command === 'create' ? null : await get(tx, 'Schedule', input.id)
      if (reminders?.owns(s)) fail(403, 'WORKSPACE_REMINDER_MANAGEMENT', '关联提醒须通过提醒入口管理。')
      if (input.command !== 'create' && !s) fail(404, 'WORKSPACE_SCHEDULE_NOT_FOUND', '计划不存在。')
      if (s && (s.revision !== input.expectedRevision || s.status === 'cancelled')) fail(409, 'WORKSPACE_SCHEDULE_REVISION', '计划版本已变更或已取消，不能重开。')
      if (input.command === 'create' && (await schedules(tx)).length >= MAX_SCHEDULES) fail(409, 'WORKSPACE_SCHEDULE_CAPACITY', '首版最多200条计划（含保留审计）；需容量评审。')
      const previousRun = s?.activeOccurrenceId && await get(tx, 'Occurrence', s.activeOccurrenceId)
      if (previousRun && ['unknown', 'waiting', 'dispatching'].includes(previousRun.state) && ['update', 'resume'].includes(input.command)) fail(409, 'WORKSPACE_SCHEDULE_UNRESOLVED', '原执行尚未核实，保留关联，不能修改后重派。')
      if (input.command === 'pause' && !s.enabled) fail(409, 'WORKSPACE_SCHEDULE_STATE', '只能暂停启用中的计划。')
      const time = now(), at = new Date(time).toISOString()
      if (['create', 'update'].includes(input.command)) {
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || !object(input.actionSpec) || !(input.actionSpec.kind === INTERNAL_SCHEDULE_ACTION && Object.keys(input.actionSpec).length === 1 || workflows && input.actionSpec.kind === 'agent_readonly_workflow')) fail(400, 'WORKSPACE_SCHEDULE_ACTION', '仅开放内部记录或明确确认的只读Agent简报；不支持shell、URL或写入工作流。')
        const rule = normalizeScheduleRule(input.rule, input.timezone), next = nextScheduleDue(rule, input.timezone, time)
        if (rule.type === 'event' && input.actionSpec.kind !== 'agent_readonly_workflow') fail(400, 'WORKSPACE_SCHEDULE_ACTION', '事件触发只用于Bot例行任务。')
        if (next === null && rule.type !== 'event') fail(400, 'WORKSPACE_SCHEDULE_PAST', '一次性计划需要未来时间。')
        if (s) await cancelActive(tx, s, 'revision_changed')
        s = { ...base(s?.id ?? payloadHash(['schedule', actor.ownerId, input.requestId])), title: input.title.trim(), executionPrincipal: { kind: 'internal', subjectId: actor.subjectId }, actionSpec: { kind: INTERNAL_SCHEDULE_ACTION }, timezone: input.timezone, rule, revision: (s?.revision ?? 0) + 1, enabled: s ? s.enabled : true, status: s && !s.enabled ? 'paused' : 'active', nextDueAt: next === null ? null : new Date(next).toISOString(), authorizationSnapshot: snapshot, misfirePolicy: { type: rule.type === 'at' ? 'grace' : 'latest', graceMs: 900000, overlap: 'coalesce', recoveryBatch: 10 }, retryPolicy: { maxAttempts: 3, backoffMs: [30000, 120000], safeInternalOnly: true }, callLimits: { modelCalls: 0, toolCalls: 0 }, activeOccurrenceId: null, createdAt: s?.createdAt ?? at, updatedAt: at }
      } else {
        if (input.command === 'resume') {
          if (workflows?.owns(s)) Object.assign(s, await workflows.normalize(tx, s.actionSpec))
          if (s.enabled || s.status !== 'paused') fail(409, 'WORKSPACE_SCHEDULE_STATE', '只能恢复已暂停计划；已完成计划不能复活。')
          const next = nextScheduleDue(s.rule, s.timezone, time)
          if (next === null && s.rule.type !== 'event') fail(409, 'WORKSPACE_SCHEDULE_PAST', '一次性时间已过，请显式修改未来时间。')
          s.nextDueAt = next === null ? null : new Date(next).toISOString(); if (!workflows?.owns(s)) s.authorizationSnapshot = snapshot
          // Events that happened while this plan was paused are not back-filled.
          if (s.rule.type === 'event') s.eventCursor = await workflows.initialCursor(tx, s, time)
        } else await cancelActive(tx, s, input.command)
        s = { ...s, revision: s.revision + 1, enabled: input.command === 'resume', status: input.command === 'resume' ? 'active' : input.command === 'cancel' ? 'cancelled' : 'paused', updatedAt: at }
      }
      if (['create', 'update'].includes(input.command) && input.actionSpec.kind === 'agent_readonly_workflow') Object.assign(s, await workflows.normalize(tx, input.actionSpec))
      if (workflows?.owns(s)) delete s.authorizationSnapshot
      if (['create', 'update'].includes(input.command) && s.rule.type === 'event') s.eventCursor = await workflows.initialCursor(tx, s, time)
      await put(tx, 'Schedule', s)
      return { kind: 'schedule-management', schedule: workflows?.owns(s) && !await workflows.visible(tx, s) ? { id: s.id, revision: s.revision, status: s.status, redacted: true } : s, note: '内部验收记录不是提醒、通知或Agent工作流；取消不撤销已发生动作。' }
    }, tx)
    wake(); return op
  }
  // PLAN §8.5 test run: start once now, forced read-only, never delivered, marked as a test. It is
  // the user's explicit click (attended), so it is allowed while automation is paused (D-14).
  async function testRun(actor, input) {
    if (!object(input) || Object.keys(input).some(k => !['requestId', 'id'].includes(k)) || !validId(input.requestId) || !validId(input.id)) fail(400, 'WORKSPACE_SCHEDULE_INPUT', '测试运行需要计划ID和请求ID。')
    const op = await commitLocal(actor, { requestId: input.requestId, sourceId: SOURCE, action: 'update', normalizedArgs: { type: 'Schedule', command: 'test', id: input.id } }, async tx => {
      await permission(tx, actor, 'read')
      const s = await get(tx, 'Schedule', input.id)
      if (!s || !workflows?.owns(s)) fail(404, 'WORKSPACE_SCHEDULE_NOT_FOUND', '只有Bot例行任务可以测试运行。')
      if (s.status === 'cancelled') fail(409, 'WORKSPACE_SCHEDULE_STATE', '已取消的计划不能测试运行。')
      const prior = s.testOccurrenceId && await get(tx, 'Occurrence', s.testOccurrenceId)
      if (prior && active(prior)) fail(409, 'WORKSPACE_SCHEDULE_TEST_RUNNING', '上一次测试运行还没结束。')
      if (!await authorized(tx, s)) fail(403, 'WORKSPACE_FORBIDDEN', 'Bot或来源许可已失效，不能运行。')
      const time = now(), id = payloadHash(['schedule-test', s.id, input.requestId])
      const o = { ...base(id), scheduleId: s.id, revision: s.revision, scheduledFor: new Date(time).toISOString(), attempts: 0, state: 'claimed', test: true, operationId: payloadHash(['schedule-test-operation', id]) }
      const started = await workflows.start(tx, o, s, { test: true })
      await put(tx, 'Schedule', { ...s, testOccurrenceId: o.id })
      return { kind: 'schedule-test', scheduleId: s.id, occurrenceId: o.id, taskId: started.taskId }
    })
    workflows.afterDispatch(); wake(); return op
  }
  async function list(actor, input = {}) {
    if (!object(input) || Object.keys(input).some(k => !['scheduleId', 'cursor', 'limit'].includes(k))) fail(400, 'WORKSPACE_SCHEDULE_INPUT', '查询参数无效。')
    return repo.transaction(async tx => {
      await permission(tx, actor)
      if (input.scheduleId !== undefined) {
        if (!validId(input.scheduleId) || !await get(tx, 'Schedule', input.scheduleId) || reminders?.owns(await get(tx, 'Schedule', input.scheduleId))) fail(404, 'WORKSPACE_SCHEDULE_NOT_FOUND', '计划不存在。')
        const selected = await get(tx, 'Schedule', input.scheduleId)
        if (workflows?.owns(selected) && !await workflows.visible(tx, selected)) fail(403, 'WORKSPACE_FORBIDDEN', '工作流来源许可已失效。')
        const page = await repo.list(tx, 'Occurrence', LOCAL_OWNER, SOURCE, { cursor: input.cursor ?? 0, limit: input.limit ?? 100 })
        return { ...page, items: page.items.filter(o => o.scheduleId === input.scheduleId) }
      }
      const items = []; for (const s of await schedules(tx)) if (!reminders?.owns(s)) items.push(workflows?.owns(s) && !await workflows.visible(tx, s) ? { id: s.id, title: '权限已失效的工作流', status: s.status, revision: s.revision, enabled: s.enabled, redacted: true, rule: { type: 'restricted' }, timezone: s.timezone } : s)
      return { items, generation, capabilities: { internal_deterministic_record: true, deliver_notification: false, refresh_source: false, agent_readonly_workflow: !!workflows, agent_routine_writes: !!workflows, event_triggers: !!workflows }, notice: '闭页生效需要后端运行；停机不执行。内部记录与只读Agent简报；通知仅持久应用收件箱，不承诺用户送达。' }
    })
  }
  async function claim() {
    return repo.transaction(async tx => {
      const time = now(), claimed = []
      for (let s of await schedules(tx)) {
        if (claimed.length >= 10) break
        if (s.testOccurrenceId && workflows?.owns(s)) {
          const test = await get(tx, 'Occurrence', s.testOccurrenceId)
          if (test?.taskId) { await workflows.reconcile(tx, test, s); s = await get(tx, 'Schedule', s.id) }
        }
        let current = s.activeOccurrenceId && await get(tx, 'Occurrence', s.activeOccurrenceId)
        if (current?.taskId && workflows?.owns(s)) { await workflows.reconcile(tx, current, s); s = await get(tx, 'Schedule', s.id); current = s.activeOccurrenceId && await get(tx, 'Occurrence', s.activeOccurrenceId); if (current && active(current)) {
          if (s.enabled && !['at', 'event'].includes(s.rule.type) && Date.parse(s.nextDueAt) <= time) {
            const latest = latestScheduleDue(s.rule, s.timezone, Date.parse(s.nextDueAt), time), next = nextScheduleDue(s.rule, s.timezone, time)
            await put(tx, 'Occurrence', occurrence(s, latest, 'coalesced', { reason: 'original_task_unresolved_no_new_task', coalescedUntil: new Date(time).toISOString(), finishedAt: new Date(time).toISOString() }))
            if (next !== null) await put(tx, 'Schedule', { ...s, nextDueAt: new Date(next).toISOString() })
          }
          continue
        } }
        if (current && active(current)) {
          const issue = workflows?.owns(s) ? await workflows.authorizationIssue(tx, s) : null
          if (!s.enabled || s.revision !== current.revision || issue || !workflows?.owns(s) && !await authorized(tx, s)) { await cancelActive(tx, s, issue ?? 'disabled_or_revoked'); continue }
          // Stable association is consulted before lease recovery, never overwritten.
          if (current.operationId || current.taskId || current.deliveryId) {
            const op = current.operationId && await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', current.operationId)
            if (op?.state === 'succeeded') { await put(tx, 'Occurrence', { ...current, state: 'succeeded', result: copy(op.receipt), finishedAt: new Date(time).toISOString() }); continue }
            if (current.taskId || current.deliveryId || op) { if (current.state !== 'unknown') await put(tx, 'Occurrence', { ...current, state: 'unknown', reason: 'linked_execution_requires_reconciliation' }); continue }
          }
          if (current.state === 'unknown' || current.state === 'waiting' || current.retryAt && Date.parse(current.retryAt) > time) continue
          if (current.claim?.generation === generation && current.claim.expiresAt > time) continue
          const recovered = { ...current, claim: { generation, expiresAt: time + LEASE_MS } }
          await put(tx, 'Occurrence', recovered); claimed.push(recovered); continue
        }
        if (s.rule.type === 'event') {
          // PLAN §8.5: one run per batch of events since the cursor. I-14: while paused the cursor
          // moves on without a run, so nothing is back-filled after resume.
          if (!s.enabled || !workflows?.owns(s)) continue
          const polled = await workflows.pollEvent(tx, s, time)
          if (!polled) continue
          if (!polled.fire) { await put(tx, 'Schedule', { ...s, eventCursor: polled.cursor }); continue }
          const issue = await workflows.authorizationIssue(tx, s), allowed = !issue, paused = await automationPaused(tx), id = occurrenceId(s, time)
          if (await get(tx, 'Occurrence', id)) continue // at most one trigger record per instant; never overwrite a run
          const row = occurrence(s, time, allowed && !paused ? 'claimed' : issue ? 'cancelled' : 'skipped', { trigger: { event: s.rule.event, refs: polled.refs }, ...(allowed && !paused ? { claim: { generation, expiresAt: time + LEASE_MS }, operationId: payloadHash(['schedule-operation', id]) } : { reason: issue ?? 'automation_paused', finishedAt: new Date(time).toISOString() }) })
          await put(tx, 'Occurrence', row)
          await put(tx, 'Schedule', { ...s, eventCursor: polled.cursor, activeOccurrenceId: row.state === 'claimed' ? row.id : null })
          if (row.state === 'claimed') claimed.push(row)
          continue
        }
        if (!s.enabled || Date.parse(s.nextDueAt) > time) continue
        const first = Date.parse(s.nextDueAt), latest = latestScheduleDue(s.rule, s.timezone, first, time)
        if (latest > first) await put(tx, 'Occurrence', occurrence(s, first, 'coalesced', { reason: 'latest_only', coalescedUntil: new Date(latest).toISOString(), finishedAt: new Date(time).toISOString() }))
        const id = occurrenceId(s, latest), prior = await get(tx, 'Occurrence', id)
        // I-14: while automation is paused, routines (agent workflows) are skipped and never back-filled.
        const issue = workflows?.owns(s) ? await workflows.authorizationIssue(tx, s) : null
        const allowed = workflows?.owns(s) ? !issue : await authorized(tx, s), expired = s.misfirePolicy.type === 'grace' && time - latest > s.misfirePolicy.graceMs, paused = !!workflows?.owns(s) && await automationPaused(tx)
        const row = prior ?? occurrence(s, latest, issue ? 'cancelled' : !allowed || expired || paused ? 'skipped' : 'claimed', { ...(!allowed || expired || paused ? { reason: issue ?? (!allowed ? 'authorization_revoked' : paused ? 'automation_paused' : 'grace_expired'), finishedAt: new Date(time).toISOString() } : { claim: { generation, expiresAt: time + LEASE_MS }, operationId: payloadHash(['schedule-operation', id]) }) })
        if (!prior) await put(tx, 'Occurrence', row)
        const next = nextScheduleDue(s.rule, s.timezone, time)
        s = { ...s, nextDueAt: next === null ? s.nextDueAt : new Date(next).toISOString(), enabled: next !== null, status: next === null ? 'completed' : s.status, activeOccurrenceId: active(row) ? row.id : null }
        // An at occurrence remains dispatchable even though there is no future due.
        if (active(row) && next === null) { s.enabled = true; s.status = 'finishing' }
        await put(tx, 'Schedule', s)
        if (row.state === 'claimed') claimed.push(row)
      }
      return claimed
    })
  }
  async function dispatch(row) {
    const schedule = await repo.transaction(tx => get(tx, 'Schedule', row.scheduleId))
    const verification = reminders?.owns(schedule) ? await reminders.preflight(row) : null
    await boundary('before_dispatch', copy(row))
    return repo.transaction(async tx => {
      let o = await get(tx, 'Occurrence', row.id), s = await get(tx, 'Schedule', row.scheduleId)
      if (!o || o.state !== 'claimed' && o.state !== 'retry_wait' || o.claim?.generation !== generation) return
      const at = new Date(now()).toISOString()
      const workflowIssue = workflows?.owns(s) ? await workflows.authorizationIssue(tx, s) : null
      if (!s?.enabled || s.revision !== o.revision || workflowIssue || !workflows?.owns(s) && !await authorized(tx, s)) { await put(tx, 'Occurrence', { ...o, state: 'cancelled', reason: workflowIssue ?? 'disabled_or_revoked', finishedAt: at }); return }
      if (workflows?.owns(s)) {
        if (o.taskId) return
        if (await automationPaused(tx)) { await put(tx, 'Occurrence', { ...o, state: 'cancelled', reason: 'automation_paused', finishedAt: at }); await put(tx, 'Schedule', { ...s, activeOccurrenceId: null }); return }
        return workflows.start(tx, o, s)
      }
      const prior = o.operationId && await repo.get(tx, 'Operation', LOCAL_OWNER, 'operations', o.operationId)
      if (prior) { await put(tx, 'Occurrence', { ...o, state: prior.state === 'succeeded' ? 'succeeded' : 'unknown', reason: 'existing_operation_preserved', ...(prior.state === 'succeeded' ? { result: prior.receipt, finishedAt: at } : {}) }); return }
      if (o.taskId || o.deliveryId) { await put(tx, 'Occurrence', { ...o, state: 'unknown', reason: 'linked_execution_preserved' }); return }
      o = { ...o, attempts: o.attempts + 1, startedAt: o.startedAt ?? at, state: 'dispatching' }
      await put(tx, 'Occurrence', o)
      await boundary('in_transaction', copy(o))
      const receipt = reminders?.owns(s) ? await reminders.deliver(tx, o, s, verification) : { kind: INTERNAL_SCHEDULE_ACTION, occurrenceId: o.id, scheduleId: s.id, scheduledFor: o.scheduledFor, recordedAt: at, modelCalls: 0, toolCalls: 0, externalEffects: 0, notificationDelivered: false }
      await repo.put(tx, 'Operation', { schemaVersion: 1, ownerId: LOCAL_OWNER, sourceId: 'operations', id: o.operationId, requestId: `schedule:${o.id}`, actor: { principalKind: 'background', subjectId: 'internal-deterministic-driver', scheduleId: s.id, revision: s.revision }, action: 'record', normalizedArgs: { sourceId: SOURCE, kind: s.actionSpec.kind, occurrenceId: o.id }, payloadHash: payloadHash(receipt), grantEpoch: s.authorizationSnapshot.userEpoch, state: receipt.unknown ? 'unknown' : receipt.suppressed ? 'cancelled' : 'succeeded', receipt })
      await put(tx, 'Occurrence', { ...o, state: receipt.unknown ? 'unknown' : receipt.suppressed ? 'suppressed' : 'succeeded', ...(receipt.deliveryId ? { deliveryId: receipt.deliveryId } : {}), ...(receipt.reason ? { reason: receipt.reason } : {}), result: receipt, finishedAt: at })
      await put(tx, 'Schedule', { ...s, activeOccurrenceId: null, ...(s.rule.type === 'at' ? { enabled: false, status: 'completed' } : {}) })
      return receipt
    })
  }
  async function failed(row) {
    await repo.transaction(async tx => {
      const o = await get(tx, 'Occurrence', row.id), s = await get(tx, 'Schedule', row.scheduleId)
      if (!o || o.state !== 'claimed' && o.state !== 'retry_wait' || o.claim?.generation !== generation) return
      const attempts = o.attempts + 1, retry = !workflows?.owns(s) && attempts < (s?.retryPolicy.maxAttempts ?? 1)
      await put(tx, 'Occurrence', { ...o, attempts, state: retry ? 'retry_wait' : 'failed', error: { code: 'SCHEDULE_INTERNAL_FAILURE', message: '安全读取或内部记录失败；未记录通知，不表示已送达。' }, ...(reminders?.owns(s) ? { reason: 'notification_not_recorded_verification_or_internal_failure' } : {}), ...(retry ? { retryAt: new Date(now() + s.retryPolicy.backoffMs[attempts - 1]).toISOString(), claim: { generation, expiresAt: now() } } : { finishedAt: new Date(now()).toISOString() }) })
    })
  }
  async function tick() {
    if (stopped) return
    if (running) return running
    running = (async () => { await boundary('before_claim'); const rows = await claim(); await boundary('after_claim', copy(rows)); for (const row of rows) { if (stopped) break; try { const dispatched = await dispatch(row); if (dispatched?.taskId) await boundary('after_task_commit', dispatched); workflows?.afterDispatch(); await boundary('after_dispatch', row) } catch (error) { await failed(row); onError(error) } } await refreshExternalSync(); return rows.length })()
    try { return await running } finally { running = undefined }
  }
  // Host timer is only a wake hint, never the source of due/claim/execution facts.
  // No Harness Agent slot is occupied while waiting. Every wake re-reads SQLite.
  function wake() {
    if (stopped || !waking) return
    clearTimeout(timer)
    timer = setTimeout(async () => { try { await tick() } catch (error) { onError(error) } finally { if (!stopped) { timer = setTimeout(wake, 250); timer.unref() } } }, 0); timer.unref()
  }
  return { manage, testRun, list, tick, generation,
    start() { waking = true; wake() },
    async close() { stopped = true; waking = false; clearTimeout(timer); await running },
  }
}
