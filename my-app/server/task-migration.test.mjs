import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { ChatQueue } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { CallUsage, CALENDAR_TOOL, CALENDAR_EVENT_TOOL, readMockSchedule } from './tools.mjs'
import { TaskSkills } from './skills.mjs'
import { ChatSteering } from './steering.mjs'
import { TaskApprovals, CALENDAR_WRITE_TOOL } from './approvals.mjs'
import { TaskBlockers } from './blockers.mjs'
import { ContextCompaction } from './context-compaction.mjs'
import { createApiServer } from './app.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'migration-fixture', apiKey: 'fixture-only' }
const text = (content = '配置迁移后回复') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
let sequence = 0
const requestId = () => `migration-request-${++sequence}`
const bots = (window = 65536) => listBots(config, { contextWindows: { [config.model]: window } })
async function until(read, predicate) { for (let i = 0; i < 800; i++) { const value = await read(); if (predicate(value)) return value; await delay(5) } assert.fail('migration fixture did not settle') }
const idle = (s, id) => until(() => s.get(id), (t) => t.activeInputId === null && t.queueLength === 0 && t.runtime.checkpoint?.phase === 'awaitInput')
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-migration-03-')), file = join(dir, 'task.sqlite'), stores = new Set()
  const open = async (extra = {}) => { const s = await openTaskStore({ file, bots: bots(), modelReply: async () => text(), ...options, ...extra }); stores.add(s); return s }
  const close = async (s) => { await s.close(); stores.delete(s) }
  t.after(async () => { for (const s of stores) await s.close(); await rm(dir, { force: true, recursive: true }) })
  return { store: await open(), file, dir, open, close }
}
async function edit(s, changes = {}, id = 'calendar') {
  const { bot } = await s.getBotConfiguration(id)
  return s.updateBotConfiguration(id, { requestId: requestId(), expectedVersion: bot.configRef.version, description: '新的迁移职责', tools: bot.defaults.tools, resources: bot.defaults.toolResources, ...changes })
}
const pool = (s, operation, tools = [], resources = []) => s.updateCapabilityPool({ requestId: requestId(), operation, tools, resources })
const confirm = (p, changes = {}) => ({ requestId: requestId(), expectedVersion: p.previous.version, targetVersion: p.next.version, previewToken: p.previewToken, confirm: true, ...changes })
const migrate = async (s, id) => s.migrateConfiguration(id, confirm(await s.previewMigration(id)))
const denied = (code) => (e) => e.code === code
async function changedTask(s, input = {}) {
  const task = await s.create({ botId: 'calendar', ...input }); await edit(s); return task
}

test('03 preview is read-only; explicit migration retains identity, requirements, receipts, usage and permits next reply', async (t) => {
  let observed
  const { store: s } = await fixture(t, { modelReply: async (_m, options) => { observed = options; return text() } })
  const task = await s.create({ botId: 'calendar', title: '保持原目标', taskState: { constraints: ['不改上午事项'], completionCriteria: ['核对完整结果'] } })
  await s.send(task.taskId, '原历史'); const before = await idle(s, task.taskId)
  await edit(s)
  const preview = await s.previewMigration(task.taskId), input = confirm(preview)
  assert.deepEqual((await s.get(task.taskId)).configRef, before.configRef)
  assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview, 'preview remains serializable after transaction commit'); assert.equal(preview.source, 'authenticated-user'); assert.ok(preview.changes.some((c) => c.field === 'bot.description'))
  const { task: after, migration } = await s.migrateConfiguration(task.taskId, input)
  for (const key of ['taskId', 'conversationId', 'title', 'taskState', 'taskStateSources', 'callUsage', 'messages', 'skillState', 'compaction', 'approvals', 'blockers']) assert.deepEqual(after[key], before[key], key)
  assert.equal(after.bot.description, '新的迁移职责'); assert.deepEqual(after.configRef, preview.next)
  assert.equal(after.migrationHistory.length, 1); assert.equal(after.migrationHistory[0].id, migration.entryId)
  assert.ok((await s.getBotConfiguration('calendar')).audit.some((a) => a.type === 'task-configuration-migrated' && a.taskId === task.taskId && a.source === 'authenticated-user'))
  await s.send(task.taskId, '迁移后继续'); const final = await idle(s, task.taskId)
  assert.ok(observed.context.systemPrompt.includes('新的迁移职责')); assert.ok(observed.context.systemPrompt.includes('不改上午事项'))
  assert.ok(observed.context.messages.some((m) => m.content === '原历史')); assert.equal(final.callUsage.modelCalls, before.callUsage.modelCalls + 1)
})

test('03 preserves explicit Task parameter overrides and raised limits, does not reset unknown usage', async (t) => {
  const { store: s } = await fixture(t)
  const task = await s.create({ botId: 'calendar', parameters: { maxOutputTokens: 777, callLimits: { modelCalls: 30 } } })
  await s.raiseLimits(task.taskId, { modelCalls: 40 })
  await s.harness.commit(async (tx) => { Object.assign(await tx.doc(CallUsage, task.taskId), { modelCalls: 3, totalTokens: 12, unknownTokenCalls: 1 }) }, context)
  await edit(s, { parameters: { maxOutputTokens: 888, callLimits: { modelCalls: 5 } } })
  const { task: after } = await migrate(s, task.taskId)
  assert.equal(after.parameters.maxOutputTokens, 777); assert.equal(after.effectiveCallLimits.modelCalls, 40)
  assert.equal(after.parameterSources.maxOutputTokens.type, 'user-request'); assert.equal(after.parameterSources.callLimits.type, 'user-limit-increase')
  assert.deepEqual(after.callUsage, { modelCalls: 3, toolCalls: 0, totalTokens: 12, unknownTokenCalls: 1 })
})

test('03 exact retry is idempotent even after new work; changed payload is rejected; same version no-op refused', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s), preview = await s.previewMigration(task.taskId), input = confirm(preview)
  const first = await s.migrateConfiguration(task.taskId, input)
  await s.send(task.taskId, '普通消息不是迁移'); await idle(s, task.taskId)
  const retry = await s.migrateConfiguration(task.taskId, input)
  assert.deepEqual(first.migration, retry.migration); assert.equal(retry.task.migrationHistory.length, 1)
  await assert.rejects(s.migrateConfiguration(task.taskId, { ...input, targetVersion: 'other' }), denied('MIGRATION_REQUEST_CONFLICT'))
  await assert.rejects(s.previewMigration(task.taskId), denied('MIGRATION_NOT_NEEDED'))
})

test('03 busy model invocation and FIFO inputs reject immediately without queuing migration', async (t) => {
  let release, entered; const held = new Promise((r) => { release = r }), ready = new Promise((r) => { entered = r })
  const { store: s } = await fixture(t, { modelReply: async () => { entered(); await held; return text() } })
  t.after(release)
  const task = await changedTask(s), preview = await s.previewMigration(task.taskId)
  await s.send(task.taskId, '运行中'); await ready; await s.send(task.taskId, '队列')
  await assert.rejects(s.previewMigration(task.taskId), denied('TASK_MIGRATION_BUSY'))
  await assert.rejects(s.migrateConfiguration(task.taskId, confirm(preview)), denied('TASK_MIGRATION_BUSY'))
  const heldTask = await s.get(task.taskId); assert.equal(heldTask.queueLength, 1); assert.deepEqual(heldTask.configRef, task.configRef)
  release(); const after = await idle(s, task.taskId); assert.equal(after.migrationHistory.length, 0)
})

for (const [label, document, mutate] of [
  ['queued input', ChatQueue, (d) => { d.entryIds.push(12345) }],
  ['steering', ChatSteering, (d) => { d.pending.push({ entryId: 12345, targetInputId: 12344 }) }],
  ['approval lock', TaskApprovals, (d) => { d.activeId = 12345 }],
  ['blocker lock', TaskBlockers, (d) => { d.activeId = 12345 }],
  ['pending blocker', TaskBlockers, (d) => { d.items.push({ status: 'pending' }) }],
  ['unknown operation', TaskApprovals, (d) => { d.items.push({ operation: { id: 'unknown' } }) }],
]) test(`03 independently rejects ${label} at otherwise idle checkpoint`, async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s)
  await s.harness.commit(async (tx) => mutate(await tx.doc(document, task.taskId)), context)
  await assert.rejects(s.previewMigration(task.taskId), denied('TASK_MIGRATION_BUSY'))
  assert.deepEqual((await s.get(task.taskId)).configRef, task.configRef)
})

test('03 real limited wait and cancelled terminal cannot migrate or bypass quota', async (t) => {
  const { store: s } = await fixture(t)
  const task = await changedTask(s, { parameters: { callLimits: { modelCalls: 0 } } })
  await s.send(task.taskId, '触发限额'); await until(() => s.get(task.taskId), (x) => x.runtime.checkpoint?.lastOutcome === 'limited')
  await assert.rejects(s.previewMigration(task.taskId), denied('TASK_MIGRATION_BUSY'))
  await s.cancel(task.taskId, {})
  await assert.rejects(s.previewMigration(task.taskId), (e) => ['TASK_CANCELLED', 'TASK_UNAVAILABLE', 'TASK_MIGRATION_BUSY'].includes(e.code))
})

for (const kind of ['tools', 'resources', 'legacy']) test(`03 denies live ${kind} revocation before commit`, async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s), preview = await s.previewMigration(task.taskId)
  if (kind === 'tools') await pool(s, 'revoke', [CALENDAR_TOOL])
  else if (kind === 'resources') await pool(s, 'revoke', [], ['mock:personal'])
  else await s.revokeTool('calendar', CALENDAR_TOOL)
  await assert.rejects(s.migrateConfiguration(task.taskId, confirm(preview)), denied('MIGRATION_PERMISSION_DENIED'))
  assert.deepEqual((await s.get(task.taskId)).configRef, task.configRef)
})

test('03 revoked then regranted capability is immediately available to the old Task', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s), preview = await s.previewMigration(task.taskId)
  await pool(s, 'revoke', [CALENDAR_TOOL]); await pool(s, 'grant', [CALENDAR_TOOL])
  assert.ok((await s.get(task.taskId)).toolSets.authorized.includes(CALENDAR_TOOL))
  await assert.rejects(s.migrateConfiguration(task.taskId, confirm(preview)), denied('MIGRATION_PREVIEW_STALE'))
  const { task: after } = await s.migrateConfiguration(task.taskId, confirm(await s.previewMigration(task.taskId))); assert.ok(after.toolSets.authorized.includes(CALENDAR_TOOL))
})

test('03 stale target, stale Task requirement and forged preview fail without mutations', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s), preview = await s.previewMigration(task.taskId)
  await edit(s, { description: '再下一版本' })
  await assert.rejects(s.migrateConfiguration(task.taskId, confirm(preview)), denied('MIGRATION_PREVIEW_STALE'))
  const next = await s.previewMigration(task.taskId); await s.updateState(task.taskId, { goal: '新的任务要求' })
  await assert.rejects(s.migrateConfiguration(task.taskId, confirm(next)), denied('MIGRATION_PREVIEW_STALE'))
  await assert.rejects(s.migrateConfiguration(task.taskId, confirm(await s.previewMigration(task.taskId), { previewToken: '0'.repeat(64) })), denied('MIGRATION_PREVIEW_STALE'))
  assert.deepEqual((await s.get(task.taskId)).configRef, task.configRef)
})

for (const [label, mutate, code] of [
  ['unknown model capacity', (d) => { delete d.contextWindows }, 'MIGRATION_CAPACITY_UNKNOWN'],
  ['output exceeds capacity', (d) => { d.contextWindows = { [config.model]: 8192 }; d.maxOutputTokens = 8192 }, 'MIGRATION_CAPACITY_UNKNOWN'],
  ['unconfigured model', (d) => { d.model.id = 'not-configured' }, 'MIGRATION_MODEL_UNAVAILABLE'],
]) test(`03 rejects ${label}`, async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s)
  await s.harness.commit(async (tx) => { const d = await tx.doc(BotDirectory), b = d.items.find((x) => x.id === 'calendar'); mutate(b.defaults); const v = d.configurations.calendar.at(-1); v.defaults = JSON.parse(JSON.stringify(b.defaults)) }, context)
  await assert.rejects(s.previewMigration(task.taskId), denied(code))
})

test('03 oversized fixed requirements fail capacity check; no rules, history or usage discarded', async (t) => {
  const { store: s } = await fixture(t, { bots: bots(8192) }), task = await changedTask(s)
  await s.updateState(task.taskId, { constraints: Array.from({ length: 20 }, () => '不可丢弃规则'.repeat(150)) })
  const before = await s.get(task.taskId)
  await assert.rejects(s.previewMigration(task.taskId), denied('MIGRATION_CAPACITY_EXCEEDED'))
  assert.deepEqual((await s.get(task.taskId)).taskState, before.taskState); assert.deepEqual((await s.get(task.taskId)).compaction, before.compaction)
})

test('03 fixed active Skill survives migration without source reload; incompatible dependencies and corrupt snapshots refuse', async (t) => {
  const { store: s } = await fixture(t), task = await s.create({ botId: 'calendar' })
  await s.activateSkill(task.taskId, { skillId: 'calendar-conflict-analysis' }); await edit(s)
  const before = await s.get(task.taskId), { task: after } = await migrate(s, task.taskId)
  assert.deepEqual(after.skillState, before.skillState)
  await edit(s, { tools: [] }); await assert.rejects(s.previewMigration(task.taskId), denied('SKILL_DEPENDENCY_MISSING'))
  await edit(s)
  // Restore required tools explicitly after the negative configuration test.
  await edit(s, { tools: before.parameters.tools })
  await s.harness.commit(async (tx) => { (await tx.doc(TaskSkills, task.taskId)).active[0].rules += '篡改' }, context)
  await assert.rejects(s.previewMigration(task.taskId), denied('SKILL_SNAPSHOT_INVALID'))
})

test('03 last failed Skill activation is not silently discarded by migration', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s)
  await s.harness.commit(async (tx) => { (await tx.doc(TaskSkills, task.taskId)).lastFailure = { code: 'SKILL_LOAD_FAILED' } }, context)
  await assert.rejects(s.previewMigration(task.taskId), denied('SKILL_NOT_READY'))
})

test('03 admission versus migration is serialized: either new configuration reply or immediate rejection, never mixed config', async (t) => {
  const seen = [], { store: s } = await fixture(t, { modelReply: async (_m, o) => { seen.push(o.context.systemPrompt); return text() } })
  for (const migrationFirst of [true, false]) {
    const task = await s.create({ botId: 'calendar' }); await edit(s, { description: `race-${migrationFirst}` })
    const preview = await s.previewMigration(task.taskId), apply = () => s.migrateConfiguration(task.taskId, confirm(preview)), send = () => s.send(task.taskId, 'race')
    const results = await Promise.allSettled(migrationFirst ? [apply(), send()] : [send(), apply()])
    const after = await idle(s, task.taskId), migrated = results[migrationFirst ? 0 : 1]
    if (migrated.status === 'fulfilled') { assert.deepEqual(after.configRef, preview.next); assert.ok(seen.at(-1).includes(preview.next.version)) }
    else { assert.ok(['TASK_MIGRATION_BUSY', 'MIGRATION_PREVIEW_STALE'].includes(migrated.reason.code)); assert.deepEqual(after.configRef, task.configRef); assert.ok(seen.at(-1).includes(task.configRef.version)) }
  }
})

test('03 audit write failure atomically rolls back card, receipt and idempotency; same request can retry', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s), preview = await s.previewMigration(task.taskId), input = confirm(preview)
  const commit = s.harness.commit.bind(s.harness)
  s.harness.commit = (fn, ctx) => commit(async (tx) => {
    const append = tx.appendEntry.bind(tx)
    let wrote = false
    tx.appendEntry = async (...args) => { const entry = await append(...args); if (args[1]?.kind === 'pidot.configuration-migrated') wrote = true; return entry }
    const result = await fn(tx)
    if (wrote) throw new Error('injected persistence failure')
    return result
  }, ctx)
  await assert.rejects(s.migrateConfiguration(task.taskId, input), /injected persistence failure/)
  s.harness.commit = commit
  const after = await s.get(task.taskId); assert.deepEqual(after.configRef, task.configRef); assert.equal(after.migrationHistory.length, 0)
  assert.ok(!(await s.harness.snapshot(BotDirectory, undefined, context)).managementRequests[`migration:${task.taskId}:${input.requestId}`])
  assert.equal((await s.migrateConfiguration(task.taskId, input)).task.migrationHistory.length, 1)
})

test('03 restart retains same Task/conversation, migrated configuration, audit receipt, compaction and repeat protection', async (t) => {
  const { store: s, close, open } = await fixture(t), task = await changedTask(s)
  await s.harness.commit(async (tx) => { (await tx.doc(ContextCompaction, task.taskId)).revision = 2 }, context)
  const input = confirm(await s.previewMigration(task.taskId)), first = await s.migrateConfiguration(task.taskId, input)
  await close(s); const reopened = await open(), after = await reopened.get(task.taskId)
  assert.deepEqual(after.configRef, first.task.configRef); assert.equal(after.conversationId, task.conversationId); assert.equal(after.compaction.revision, 2)
  assert.equal(after.migrationHistory.length, 1); assert.deepEqual((await reopened.migrateConfiguration(task.taskId, input)).migration, first.migration)
  await reopened.send(task.taskId, '重启后继续'); assert.equal((await idle(reopened, task.taskId)).callUsage.modelCalls, 1)
})

test('03 HTTP authentication, Bot ownership, methods, malformed confirmation and ordinary message isolation', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s), server = createApiServer({ token: 'migration-test-token', tasks: s })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r) }))
  const url = `http://127.0.0.1:${server.address().port}`, path = `/api/bots/calendar/tasks/${task.taskId}/configuration-migration`, headers = { Authorization: 'Bearer migration-test-token', 'Content-Type': 'application/json' }
  assert.equal((await fetch(url + path)).status, 401)
  assert.equal((await fetch(url + path.replace('calendar', 'todo'), { headers })).status, 404)
  assert.equal((await fetch(url + path, { headers, method: 'DELETE' })).status, 405)
  const response = await fetch(url + path, { headers }), { preview } = await response.json(); assert.equal(response.status, 200)
  for (const input of [confirm(preview, { confirm: false }), { ...confirm(preview), tools: [] }, {}, confirm(preview, { targetVersion: 'invented' })]) {
    const response = await fetch(url + path, { headers, method: 'POST', body: JSON.stringify(input) }); assert.ok([400, 409].includes(response.status))
  }
  await s.send(task.taskId, '确认迁移到最新配置并扩权'); await idle(s, task.taskId)
  assert.deepEqual((await s.get(task.taskId)).configRef, task.configRef)
  const response2 = await fetch(url + path, { headers, method: 'POST', body: JSON.stringify(confirm(await s.previewMigration(task.taskId))) }); assert.equal(response2.status, 200)
  assert.equal((await response2.json()).task.migrationHistory.length, 1)
})

test('03 migration uses existing successful simulated tool receipts; it never replays a business effect', async (t) => {
  let reads = 0
  const { store: s } = await fixture(t, { modelReply: async (_m, { context: ctx }) => {
    const last = ctx.messages.findLastIndex((m) => m.role === 'user' && m.content === '读取')
    if (last >= 0 && !ctx.messages.slice(last).some((m) => m.role === 'toolResult')) {
      const call = { type: 'toolCall', id: 'read-migration', name: CALENDAR_TOOL, arguments: { resource: 'mock:personal', date: '2026-10-20' } }
      return { ...text(), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
    }
    return text()
  }, toolImpl: async (a) => { reads++; return readMockSchedule(a) } })
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '读取'); const before = await idle(s, task.taskId)
  assert.equal(reads, 1); await edit(s); const { task: after } = await migrate(s, task.taskId)
  assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.callUsage, before.callUsage); assert.equal(reads, 1)
  assert.ok(after.messages.some((m) => m.result?.ok === true))
})

for (const mode of ['committed', 'uncommitted']) test(`03 SIGKILL ${mode} migration has durable all-or-nothing receipt and configuration`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-migration-kill-'))
  const child = spawn(process.execPath, ['server/fixtures/task-migration-process.mjs', dir, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
  let store, stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (store) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const saved = await until(async () => { try { return JSON.parse(await readFile(join(dir, 'migration-checkpoint.json'), 'utf8')) } catch { if (child.exitCode !== null) assert.fail(stderr); return null } }, Boolean)
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: bots(), modelReply: async () => text() })
  const after = await store.get(saved.taskId)
  assert.equal(after.taskId, saved.taskId); assert.equal(after.conversationId, saved.conversationId)
  assert.equal(after.configRef.version, mode === 'committed' ? saved.input.targetVersion : saved.input.expectedVersion)
  assert.equal(after.migrationHistory.length, mode === 'committed' ? 1 : 0)
  if (mode === 'committed') assert.equal((await store.migrateConfiguration(saved.taskId, saved.input)).task.migrationHistory.length, 1)
  else assert.equal((await migrate(store, saved.taskId)).task.migrationHistory.length, 1)
  await store.send(saved.taskId, '强杀恢复后继续'); assert.equal((await idle(store, saved.taskId)).callUsage.modelCalls, 1)
})

for (const mode of ['approval', 'blocker', 'unknown']) test(`03 actual ${mode} wait refuses preview and confirmation, retaining original exact binding`, async (t) => {
  const turn = (name, args) => {
    const call = { type: 'toolCall', id: `wait-${name}`, name, arguments: args }
    return { ...text(), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
  }
  const { store: s } = await fixture(t, { calendarQueryEnabled: false, calendarIdempotencyEnabled: false,
    calendarWriteImpl: mode === 'unknown' ? async () => { throw new Error('lost receipt') } : undefined,
    modelReply: async (_m, { context: ctx }) => {
      if (mode === 'blocker') return turn('report_blocker', { question: '迁移前需确认的事项', requiredInformation: '答复', assignee: 'user' })
      const results = ctx.messages.filter((m) => m.role === 'toolResult')
      if (!results.length) return turn(CALENDAR_TOOL, { date: '2026-10-20', resource: 'mock:personal' })
      if (results.length === 1) return turn(CALENDAR_EVENT_TOOL, { eventId: 'mock-20261020-1', resource: 'mock:personal' })
      if (results.length === 2) return turn(CALENDAR_WRITE_TOOL, { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' })
      return text()
    } })
  const task = await changedTask(s), preview = await s.previewMigration(task.taskId)
  await s.send(task.taskId, '先处理等待事项')
  let waiting = await until(() => s.get(task.taskId), (x) => x.runtime.checkpoint?.phase === (mode === 'blocker' ? 'awaitBlocker' : 'awaitApproval'))
  if (mode === 'unknown') {
    await s.decideApproval(task.taskId, waiting.approvals.activeId, { decision: 'approved' })
    waiting = await until(() => s.get(task.taskId), (x) => x.approvals.items.some((a) => a.operation?.unknownAt) && x.runtime.checkpoint?.waitingReason === 'action-outcome-unknown')
  }
  await assert.rejects(s.previewMigration(task.taskId), denied('TASK_MIGRATION_BUSY'))
  await assert.rejects(s.migrateConfiguration(task.taskId, confirm(preview)), denied('TASK_MIGRATION_BUSY'))
  const after = await s.get(task.taskId)
  assert.deepEqual(after.configRef, task.configRef); assert.deepEqual(after.approvals, waiting.approvals); assert.deepEqual(after.blockers, waiting.blockers)
})

test('03 fixed active Skill can migrate after restart even if local Skill source disappeared', async (t) => {
  const { store: s, close, open } = await fixture(t), task = await s.create({ botId: 'calendar' })
  await s.activateSkill(task.taskId, { skillId: 'calendar-conflict-analysis' }); await edit(s)
  const before = await s.get(task.taskId); await close(s)
  const reopened = await open({ skillDirectory: '/nonexistent/fixture-skills-03' })
  const { task: after } = await migrate(reopened, task.taskId)
  assert.deepEqual(after.skillState, before.skillState)
})

test('03 finished historical retry decision is retained, not mistaken for an active unknown-result wait', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s)
  await s.harness.commit(async (tx) => {
    (await tx.doc(TaskApprovals, task.taskId)).items.push({ id: 9991, operation: { id: 'historical-original', resolution: { outcome: 'retry', retryApprovalId: 9992 } }, receipt: null })
    ;(await tx.doc(TaskApprovals, task.taskId)).items.push({ id: 9992, receipt: { result: { ok: true } } })
  }, context)
  const before = await s.get(task.taskId), { task: after } = await migrate(s, task.taskId)
  assert.deepEqual(after.approvals, before.approvals)
})

test('03 concurrent identical confirmations produce one migration audit and one durable receipt', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s), input = confirm(await s.previewMigration(task.taskId))
  const results = await Promise.all(Array.from({ length: 5 }, () => s.migrateConfiguration(task.taskId, input)))
  assert.ok(results.every((r) => r.migration.entryId === results[0].migration.entryId))
  assert.equal((await s.get(task.taskId)).migrationHistory.length, 1)
})

test('03 explicitly migrated permissions still honor subsequent live revocation without touching existing receipts', async (t) => {
  const { store: s } = await fixture(t), task = await changedTask(s)
  const { task: after } = await migrate(s, task.taskId)
  assert.ok(after.toolSets.authorized.includes(CALENDAR_TOOL))
  await pool(s, 'revoke', [CALENDAR_TOOL]); await pool(s, 'grant', [CALENDAR_TOOL])
  const revoked = await s.get(task.taskId)
  assert.ok(revoked.toolSets.authorized.includes(CALENDAR_TOOL)); assert.equal(revoked.permissionSnapshot, undefined)
  assert.deepEqual(revoked.callUsage, after.callUsage); assert.deepEqual(revoked.migrationHistory, after.migrationHistory)
})

test('03 new capability is not applied by Bot edit or ordinary message; fresh consented migration applies target only', async (t) => {
  const { store: s } = await fixture(t)
  await edit(s, { tools: [], resources: [] })
  const task = await s.create({ botId: 'calendar' })
  await edit(s, { tools: [CALENDAR_TOOL], resources: ['mock:personal'] })
  await s.send(task.taskId, '请用最新配置并授权'); const before = await idle(s, task.taskId)
  assert.deepEqual(before.parameters.tools, []); assert.deepEqual(before.configRef, task.configRef)
  const { task: after } = await migrate(s, task.taskId)
  assert.deepEqual(after.toolSets.authorized, [CALENDAR_TOOL]); assert.deepEqual(after.parameters.toolResources, ['mock:personal'])
  assert.deepEqual(after.callUsage, before.callUsage)
})

test('03 successful exact action approval and effect stay historical across migration; old approval cannot dispatch again', async (t) => {
  const turn = (name, args) => { const call = { type: 'toolCall', id: `historical-${name}`, name, arguments: args }; return { ...text(), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } } }
  const { store: s } = await fixture(t, { modelReply: async (_m, { context: ctx }) => {
    const results = ctx.messages.filter((m) => m.role === 'toolResult')
    if (!results.length) return turn(CALENDAR_TOOL, { date: '2026-10-20', resource: 'mock:personal' })
    if (results.length === 1) return turn(CALENDAR_EVENT_TOOL, { eventId: 'mock-20261020-1', resource: 'mock:personal' })
    if (results.length === 2) return turn(CALENDAR_WRITE_TOOL, { resource: 'mock:personal', eventId: 'mock-20261020-1', expectedStart: '2026-10-20T09:30:00+08:00', expectedEnd: '2026-10-20T10:30:00+08:00', start: '2026-10-20T11:00:00+08:00', end: '2026-10-20T12:00:00+08:00' })
    return text()
  } })
  const task = await s.create({ botId: 'calendar' }); await s.send(task.taskId, '审批并执行模拟动作')
  const waiting = await until(() => s.get(task.taskId), (x) => x.runtime.checkpoint?.phase === 'awaitApproval'), approvalId = waiting.approvals.activeId
  await s.decideApproval(task.taskId, approvalId, { decision: 'approved' }); const before = await idle(s, task.taskId)
  assert.equal(before.approvals.items[0].receipt.result.ok, true)
  const { MockCalendar } = await import('./approvals.mjs'), calendarBefore = await s.harness.snapshot(MockCalendar, undefined, context)
  await edit(s); const { task: after } = await migrate(s, task.taskId)
  assert.deepEqual(after.approvals, before.approvals); assert.deepEqual(after.messages, before.messages)
  assert.deepEqual(await s.harness.snapshot(MockCalendar, undefined, context), calendarBefore)
  await s.decideApproval(task.taskId, approvalId, { decision: 'approved' }) // Exact decision retry is an existing read-only idempotent path.
  await assert.rejects(s.decideApproval(task.taskId, approvalId, { decision: 'rejected', reason: '不能改写历史决定' }))
  assert.deepEqual(await s.harness.snapshot(MockCalendar, undefined, context), calendarBefore)
})

test('03 in-flight tool blocks migration until real result commits; existing successful result then survives unchanged', async (t) => {
  let release, entered; const held = new Promise((r) => { release = r }), ready = new Promise((r) => { entered = r })
  const { store: s } = await fixture(t, { toolImpl: async (args) => { entered(); await held; return readMockSchedule(args) }, modelReply: async (_m, { context: ctx }) => {
    if (ctx.messages.some((m) => m.role === 'toolResult')) return text()
    const call = { type: 'toolCall', id: 'inflight-tool', name: CALENDAR_TOOL, arguments: { resource: 'mock:personal', date: '2026-10-20' } }
    return { ...text(), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
  } })
  t.after(release)
  const task = await changedTask(s), input = confirm(await s.previewMigration(task.taskId))
  await s.send(task.taskId, '延迟工具'); await ready
  await assert.rejects(s.migrateConfiguration(task.taskId, input), denied('TASK_MIGRATION_BUSY'))
  release(); const before = await idle(s, task.taskId), { task: after } = await migrate(s, task.taskId)
  assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.callUsage, before.callUsage)
})
