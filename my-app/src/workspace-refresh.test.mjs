import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createWorkspaceRefresh, workspacePermissionKey, isWorkspacePermissionError, applyWorkspaceReceipt, WORKSPACE_REFRESH_MS } from './workspace-refresh.mjs'

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function clock() {
  let now = 0, next = 0
  const tasks = new Map()
  return {
    setTimeout(fn, delay) { const id = ++next; tasks.set(id, { fn, at: now + delay }); return id },
    clearTimeout(id) { tasks.delete(id) },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const task = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!task) break
        now = task[1].at; tasks.delete(task[0]); task[1].fn(); await flush()
      }
      now = end; await flush()
    },
    count: () => tasks.size
  }
}
function setup(options = {}) {
  const timers = clock(), reads = [], errors = [], invalidations = []
  const controller = createWorkspaceRefresh({ timers, load: async read => { reads.push(read) }, onError: error => errors.push(error), onInvalidate: reason => invalidations.push(reason), ...options })
  controller.setScope('private:scope-a')
  return { controller, timers, reads, errors, invalidations }
}

test('visible active scope loads immediately and polls every 15 seconds, with no inactive startup requests', async () => {
  const { controller, timers, reads } = setup()
  await flush(); assert.equal(reads.length, 0)
  controller.setActive(true); await flush(); assert.equal(reads.length, 1)
  await timers.advance(14999); assert.equal(reads.length, 1)
  await timers.advance(1); assert.equal(reads.length, 2)
  await timers.advance(30000); assert.equal(reads.length, 4)
  assert.equal(WORKSPACE_REFRESH_MS, 15000)
  controller.dispose(); assert.equal(timers.count(), 0)
})

test('configured slow intervals are bounded to 15 seconds', async () => {
  const { controller, timers, reads } = setup({ interval: 60000 })
  controller.setActive(true); await flush(); await timers.advance(15000)
  assert.equal(reads.length, 2); controller.dispose()
})

test('hidden documents stop timers and requests; foreground recovery loads immediately', async () => {
  const { controller, timers, reads } = setup()
  controller.setActive(true); await flush()
  const prior = reads[0]
  controller.setEnvironment(false, true)
  assert.equal(prior.isCurrent(), false); assert.equal(prior.signal.aborted, false)
  await controller.request(); await timers.advance(90000)
  assert.equal(reads.length, 1); assert.equal(timers.count(), 0)
  controller.setEnvironment(true, true); await flush()
  assert.equal(reads.length, 2); controller.dispose()
})

test('offline pauses reads; online resumes only if the panel and document are visible', async () => {
  const { controller, timers, reads } = setup()
  controller.setEnvironment(true, false); controller.setActive(true)
  await timers.advance(45000); assert.equal(reads.length, 0)
  controller.setEnvironment(false, true); await flush(); assert.equal(reads.length, 0)
  controller.setEnvironment(true, true); await flush(); assert.equal(reads.length, 1)
  controller.setActive(false); await timers.advance(45000); assert.equal(reads.length, 1)
  controller.setActive(true); await flush(); assert.equal(reads.length, 2)
  controller.dispose()
})

test('concurrent invalidations merge to one follow-up instead of overlapping reads', async () => {
  let finish
  const reads = []
  const { controller } = setup({ load: read => { reads.push(read); if (reads.length === 1) return new Promise(resolve => { finish = resolve }) } })
  controller.setActive(true); await flush()
  void controller.request(); void controller.request(); void controller.request()
  await flush(); assert.equal(reads.length, 1)
  finish(); await flush(); assert.equal(reads.length, 2)
  controller.dispose()
})

test('scope switch aborts the old Bot/date/token read and rejects late responses', async () => {
  const reads = [], applied = []
  const { controller } = setup({ load: read => new Promise(resolve => { reads.push({ read, resolve: () => { if (read.isCurrent()) applied.push(read); resolve() } }) }) })
  controller.setActive(true); await flush()
  controller.setScope('private:scope-b'); await flush()
  assert.equal(reads[0].read.signal.aborted, true)
  assert.equal(reads[0].read.isCurrent(), false)
  reads[0].resolve(); reads[1].resolve(); await flush()
  assert.deepEqual(applied, [reads[1].read]); controller.dispose()
})

test('fresh mutation reconciliation invalidates pre-write reads before fetching server truth', async () => {
  const reads = []
  const { controller } = setup({ load: read => { reads.push(read); return new Promise(() => {}) } })
  controller.setActive(true); await flush()
  void controller.request(true); await flush()
  assert.equal(reads.length, 2)
  assert.equal(reads[0].signal.aborted, true); assert.equal(reads[0].isCurrent(), false)
  controller.dispose()
})

test('hidden/unmounted in-flight reads abort and can never commit even if fetch ignores abort', async () => {
  const reads = []
  const { controller, timers } = setup({ load: read => { reads.push(read); return new Promise(() => {}) } })
  controller.setActive(true); await flush()
  controller.setEnvironment(false, true)
  assert.equal(reads[0].signal.aborted, true); assert.equal(reads[0].isCurrent(), false)
  controller.setEnvironment(true, true); await flush(); controller.dispose()
  assert.equal(reads[1].signal.aborted, true); assert.equal(reads[1].isCurrent(), false)
  await timers.advance(60000); assert.equal(reads.length, 2); assert.equal(timers.count(), 0)
})

test('hung requests time out before the next bounded poll and never block future updates', async () => {
  const reads = [], errors = []
  const { controller, timers } = setup({ load: read => { reads.push(read); return new Promise(() => {}) }, onError: error => errors.push(error) })
  controller.setActive(true); await flush()
  await timers.advance(12000)
  assert.equal(errors.length, 1); assert.equal(errors[0].name, 'TimeoutError')
  assert.equal(reads[0].isCurrent(), false)
  await timers.advance(3000); assert.equal(reads.length, 2)
  controller.dispose()
})

test('failed reads report once and retry automatically; aborted errors do not mutate current UI', async () => {
  const { controller, timers, errors, reads } = setup({ load: async read => { reads.push(read); throw Error('offline') } })
  controller.setActive(true); await flush(); assert.equal(errors.length, 1)
  await timers.advance(15000); assert.equal(errors.length, 2)
  controller.dispose()
})

test('permission invalidation clears projection and rejects old identity without exposing scope keys', async () => {
  const { controller, reads, invalidations } = setup()
  controller.setActive(true); await flush()
  const identity = controller.capture()
  controller.invalidate(); await flush()
  assert.equal(controller.sameIdentity(identity), false)
  assert.deepEqual(invalidations, ['scope', 'permission'])
  assert.equal(reads.length, 2); controller.dispose()
})

test('permission fingerprint is stable under ordering, includes external epoch and scope, excludes display metadata', () => {
  const local = [{ id: 'local', authorized: true, grantEpoch: 1 }]
  const a = { id: 'f-a', authorized: true, readScope: 'full', epoch: 2 }
  const b = { id: 'f-b', authorized: false, readScope: 'none', epoch: 4 }
  const original = workspacePermissionKey(local, [a, b])
  assert.equal(original, workspacePermissionKey(local, [b, { ...a, title: 'renamed' }]))
  assert.notEqual(original, workspacePermissionKey(local, [{ ...a, epoch: 3 }, b]))
  assert.notEqual(original, workspacePermissionKey(local, [{ ...a, readScope: 'busy' }, b]))
  assert.notEqual(original, workspacePermissionKey(local, [a]))
  for (const error of [{ status: 401 }, { status: 403 }, { name: 'WORKSPACE_FORBIDDEN' }, { name: 'WORKSPACE_EXTERNAL_REVOKED' }]) assert.equal(isWorkspacePermissionError(error), true)
  assert.equal(isWorkspacePermissionError(Error('network')), false)
})

test('successful receipts project create/update/delete with verified ID/version before reconciliation', () => {
  const operation = { state: 'succeeded', receipt: { target: { id: 'event' }, version: 3 } }
  const input = { sourceId: 'local', type: 'Event', action: 'create', data: { title: 'new', start: '2026-10-29T09:00:00Z' } }
  const added = applyWorkspaceReceipt([], input, operation)
  assert.equal(added[0].version, 3); assert.equal(added[0].id, 'event')
  const updated = applyWorkspaceReceipt(added, { ...input, action: 'update', data: { title: 'updated' } }, operation)
  assert.equal(updated[0].title, 'updated'); assert.equal(updated[0].start, input.data.start)
  const removed = applyWorkspaceReceipt(updated, { ...input, action: 'delete', data: undefined }, { ...operation, receipt: { ...operation.receipt, deletedAt: '2026-10-29T12:00:00Z' } })
  assert.equal(removed[0].deletedAt, '2026-10-29T12:00:00Z')
  for (const op of [{ state: 'unknown' }, { state: 'succeeded', receipt: { target: { id: 'new' } } }]) assert.equal(applyWorkspaceReceipt(added, input, op), added)
})

const board = await readFile(new URL('./CalendarBoard.tsx', import.meta.url), 'utf8')
const local = await readFile(new URL('./LocalWorkspace.tsx', import.meta.url), 'utf8')
const shell = await readFile(new URL('./UnifiedWorkspace.tsx', import.meta.url), 'utf8')
const hook = await readFile(new URL('./useWorkspaceRefresh.ts', import.meta.url), 'utf8')
const routines = await readFile(new URL('./BotRoutines.tsx', import.meta.url), 'utf8')
const inbox = await readFile(new URL('./InboxPage.tsx', import.meta.url), 'utf8')
const reminders = await readFile(new URL('./ReminderWorkspace.tsx', import.meta.url), 'utf8')

test('consumers use one shared hook, preserve mounted drafts and scroll, and remove normal manual refresh', () => {
  for (const source of [board, local]) {
    assert.match(source, /useWorkspaceRefresh\(\{/)
    assert.match(source, /workspacePermissionKey/)
    assert.match(source, /if \(after.key !== before.key\)/)
    assert.match(source, /applyWorkspaceReceipt/)
    assert.match(source, /void refresh\(true\)/)
    assert.doesNotMatch(source, /刷新本地工作区|aria-label="刷新日程"|setInterval\(\(\) => void check/)
  }
  assert.match(board, /\[mode, narrow\]/)
  assert.doesNotMatch(board, /\[mode, narrow, authorized\]/)
  assert.match(local, /await refresh\(true\); setReceipt\(op\)/)
  assert.doesNotMatch(local, /if \(await refresh\(/)
  assert.match(shell, /<BotRoutines bots=\{routineChoices\} refreshKey=\{refreshKey\} onChanged=\{onChanged\}/)
  assert.equal((shell.match(/<BotRoutines /g) ?? []).length, 1)
  assert.doesNotMatch(shell, /routineBot|items-panel-automation|自动化视图/)
  assert.match(shell, /<ScheduleWorkspace token=\{token\} view="runs"/)
  assert.match(shell, /<details className="tech-info"><summary>高级：全部计划<\/summary><ScheduleWorkspace token=\{token\} view="schedules"/)
  assert.doesNotMatch(shell, /setInterval|refreshRoutines/)
})

test('hook scopes reads to render identity and cleans up visibility/focus/online/offline listeners', () => {
  assert.match(hook, /identity.current === scope && read.isCurrent\(\)/)
  for (const event of ['visibilitychange', 'online', 'offline', 'focus']) {
    assert.ok(hook.includes(`addEventListener('${event}'`), event)
    assert.ok(hook.includes(`removeEventListener('${event}'`), event)
  }
  assert.match(hook, /instance.dispose\(\)/)
  assert.match(hook, /document.visibilityState !== 'hidden'/)
  assert.match(hook, /navigator.onLine !== false/)
})


test('one routine list spans robots, defaults new routines to Chief, and opens runs with their robot identity', () => {
  assert.equal((routines.match(/data\.items\.filter\(item => item\.actionSpec\?\.botId\)/g) ?? []).length, 2)
  assert.doesNotMatch(routines, /item\.actionSpec\?\.botId === botId|props\.botId|botName/)
  assert.match(routines, /routine\?\.actionSpec\?\.botId \?\? 'chief'/)
  assert.match(routines, /已删除的机器人/)
  assert.match(routines, /const readOnly = bot\?\.status === 'inactive'/)
  assert.match(routines, /disabled=\{busy \|\| !!pending \|\| readOnly/)
  assert.match(routines, /onOpenTask\(o\.taskId!, r\.actionSpec!\.botId\)/)
  assert.match(routines, /onOpenTask\(data\.receipt\.taskId, routine\.actionSpec!\.botId\)/)
  assert.match(routines, /key=\{props\.token\}/)
})

test('notifications keep attention and reminders, show no technical dumps, and preserve proposal-only reuse', () => {
  assert.match(inbox, />需要你处理\{/)
  assert.match(inbox, />提醒<\/h2>/)
  assert.match(inbox, /proposalTaskId === undefined && <section/)
  assert.match(inbox, /proposalTaskId !== undefined && items\.length === 0/)
  assert.match(inbox, /<ReminderWorkspace token=\{token\} onOpenTask=\{onOpenTask\}/)
  for (const source of [inbox, reminders]) {
    assert.doesNotMatch(source, /<summary>技术信息<\/summary>|JSON\.stringify\(\{ (id|taskId):/)
    assert.doesNotMatch(source, /<summary>诊断<\/summary>|仅应用内记录|工具组允许直接执行/)
  }
  assert.match(reminders, /<details className="tech-info"><summary>管理提醒<\/summary>/)
  assert.match(reminders, /定时任务运行完了，打开原会话看结果。/)
  assert.match(reminders, /到提醒时间了，看一下这件事。/)
  assert.doesNotMatch(shell, /关于通知状态/)
})
