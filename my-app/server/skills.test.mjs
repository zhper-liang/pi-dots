import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createApiServer } from './app.mjs'
import { SKILL_DIRECTORY, TaskSkills } from './skills.mjs'

const skillId = 'calendar-conflict-analysis'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'skill-fixture', apiKey: 'never-store-me' }
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss9-'))
  const directory = join(dir, 'skills')
  await cp(SKILL_DIRECTORY, directory, { recursive: true })
  const requests = [], stores = []
  const open = async () => {
    const store = await openTaskStore({ file: join(dir, 'task.sqlite'), bots: listBots(config), skillDirectory: directory,
      modelReply: async (_message, { context: request }) => {
        requests.push(request)
        return { mode: 'model', reply: { content: '模拟日程分析：冲突、依据、建议。' }, execution: { usage: { totalTokens: 15 } } }
      }, ...options })
    stores.push(store); return store
  }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store: await open(), open, requests, directory }
}
async function settled(store, id) {
  for (let n = 0; n < 300; n++) {
    const task = await store.get(id)
    if (task.activeInputId === null) return task
    await delay(10)
  }
  throw new Error('Skill fixture did not settle')
}
const activate = (store, id) => store.activateSkill(id, { skillId })

test('local Skill catalog declares metadata and dependency requirements without injecting rules automatically', async (t) => {
  const { store, requests } = await fixture(t)
  const [skill] = await store.skillCatalog()
  assert.equal(skill.id, skillId); assert.equal(skill.name, '日程冲突分析'); assert.equal(skill.version, '1.1.0')
  assert.equal(skill.available, true); assert.ok(skill.applicability); assert.ok(skill.description)
  assert.deepEqual(skill.requiredTools, ['calendar_read_schedule', 'calendar_read_event', 'skill_read_resource']); assert.equal(skill.rules, undefined)
  const task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, '你好'); await settled(store, task.taskId)
  assert.doesNotMatch(requests[0].systemPrompt, /活动 Skill（用户显式指定/)
})

test('explicit activation saves full pinned rules, reference and audit in Task Document before any model work', async (t) => {
  const { store, requests } = await fixture(t)
  const task = await store.create({ botId: 'calendar' })
  const active = await activate(store, task.taskId)
  // The only visible trace is the one-line Skill card (a system entry, never model context).
  assert.equal(requests.length, 0); assert.deepEqual(active.messages.map(m => [m.role, m.systemKind, m.skillStatus]), [['system', 'skill', 'active']])
  assert.equal(active.skillState.active.length, 1)
  const skill = active.skillState.active[0]
  assert.equal(skill.ref.version, '1.1.0'); assert.match(skill.ref.sha256, /^[a-f0-9]{64}$/)
  assert.match(skill.rules, /max\(两项开始\)/); assert.match(skill.rules, /冲突.*依据.*建议/)
  assert.equal(active.skillState.history[0].status, 'active'); assert.equal(active.skillState.lastFailure, null)
  await store.harness.commit(async (tx) => {
    const state = await tx.doc(TaskSkills, task.taskId)
    assert.equal(state.active[0].rules, skill.rules)
    const event = await tx.entry(state.active[0].activationEntryId)
    assert.equal(event.kind, 'pidot.skill-activation'); assert.equal(event.conversationId, task.conversationId)
  }, context)
  assert.deepEqual(active.parameters.tools, task.parameters.tools)
  await store.send(task.taskId, '按已激活 Skill 分析2026-10-20模拟日程')
  await settled(store, task.taskId)
  assert.ok(requests[0].systemPrompt.includes(skill.rules)); assert.ok(requests[0].systemPrompt.includes(skill.ref.sha256))
})

test('source changes/removal and normal reopen preserve old full version while new Task receives new rules', async (t) => {
  const { store, open, directory, requests } = await fixture(t)
  const task = await store.create({ botId: 'calendar' }); const first = await activate(store, task.taskId)
  const rulesFile = join(directory, skillId, 'SKILL.md'), manifestFile = join(directory, skillId, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')); manifest.version = '2.0.0'
  await writeFile(manifestFile, JSON.stringify(manifest)); await writeFile(rulesFile, '# v2 独有新规则')
  const fresh = await store.create({ botId: 'calendar' }); const upgraded = await activate(store, fresh.taskId)
  assert.equal(upgraded.skillState.active[0].ref.version, '2.0.0')
  assert.notEqual(upgraded.skillState.active[0].ref.sha256, first.skillState.active[0].ref.sha256)
  await rm(join(directory, skillId), { recursive: true })
  await store.close(); const reopened = await open()
  const restored = await activate(reopened, task.taskId)
  assert.deepEqual(restored.skillState.active[0], first.skillState.active[0])
  await reopened.send(task.taskId, '继续按固定规则分析2026-10-20')
  const done = await settled(reopened, task.taskId)
  assert.equal(done.runtime.checkpoint.lastOutcome, 'completed')
  assert.ok(requests[0].systemPrompt.includes(first.skillState.active[0].rules)); assert.doesNotMatch(requests[0].systemPrompt, /v2 独有新规则/)
})

test('revoked dependency fails durably; regrant lets the original Task activate', async (t) => {
  const { store, open, requests } = await fixture(t)
  const task = await store.create({ botId: 'calendar' })
  await store.revokeTool('calendar', 'calendar_read_event')
  const failed = await activate(store, task.taskId)
  assert.equal(failed.skillState.active.length, 0)
  assert.equal(failed.skillState.lastFailure.error.code, 'SKILL_DEPENDENCY_MISSING')
  assert.deepEqual(failed.skillState.lastFailure.error.missing, ['calendar_read_event'])
  const card = failed.messages.find(m => m.systemKind === 'skill')
  assert.deepEqual([card.skillStatus, card.skillError.code], ['failed', 'SKILL_DEPENDENCY_MISSING'])
  await store.close(); const reopened = await open()
  assert.deepEqual((await reopened.get(task.taskId)).skillState, failed.skillState)
  // A failed load no longer blocks the next message; the Task answers without the Skill.
  await reopened.send(task.taskId, '分析'); const answered = await settled(reopened, task.taskId)
  assert.equal(answered.runtime.checkpoint.lastOutcome, 'completed'); assert.equal(requests.length, 1)
  assert.doesNotMatch(requests[0].systemPrompt, /活动 Skill（固定完整版本）/)
  await reopened.updateToolAccess('calendar', { revoked: [] })
  const recovered = await activate(reopened, task.taskId)
  assert.equal(recovered.skillState.lastFailure, null); assert.equal(recovered.skillState.history.length, 2)
  assert.equal(recovered.skillState.active.length, 1)
  const fresh = await reopened.create({ botId: 'calendar' })
  assert.equal((await activate(reopened, fresh.taskId)).skillState.lastFailure, null)
})

for (const dependency of ['tool', 'resource', 'script']) {
  test(`missing ${dependency} dependency never activates or expands authorization`, async (t) => {
    const { store, directory } = await fixture(t)
    const path = join(directory, skillId, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
    if (dependency === 'tool') manifest.requiredTools.push('calendar_write_event')
    if (dependency === 'resource') manifest.requiredResources.push('real:calendar')
    if (dependency === 'script') manifest.scripts.push('unsafe.sh')
    await writeFile(path, JSON.stringify(manifest))
    const task = await store.create({ botId: 'calendar' }); const result = await activate(store, task.taskId)
    assert.equal(result.skillState.active.length, 0); assert.equal(result.skillState.lastFailure.error.code, 'SKILL_DEPENDENCY_MISSING')
    assert.deepEqual(result.parameters, task.parameters)
  })
}

test('inapplicable Bot and deterministic test Task expose failure, not false activation', async (t) => {
  const { store } = await fixture(t)
  const chief = await store.create({ botId: 'chief' })
  assert.equal((await activate(store, chief.taskId)).skillState.lastFailure.error.code, 'SKILL_NOT_APPLICABLE')
  const other = await fixture(t, { bots: listBots() })
  const task = await other.store.create({ botId: 'calendar' })
  assert.equal((await activate(other.store, task.taskId)).skillState.lastFailure.error.code, 'SKILL_MODEL_REQUIRED')
})

for (const kind of ['missing', 'empty', 'oversize', 'manifest']) {
  test(`invalid local Skill (${kind}) fails closed with a persisted readable reason`, async (t) => {
    const { store, directory } = await fixture(t)
    const rules = join(directory, skillId, 'SKILL.md')
    if (kind === 'missing') await rm(rules)
    if (kind === 'empty') await writeFile(rules, ' ')
    if (kind === 'oversize') await writeFile(rules, 'x'.repeat(32769))
    if (kind === 'manifest') await writeFile(join(directory, skillId, 'manifest.json'), '{}')
    assert.equal((await store.skillCatalog())[0].available, false)
    const task = await store.create({ botId: 'calendar' }); const failed = await activate(store, task.taskId)
    assert.equal(failed.skillState.active.length, 0); assert.equal(failed.skillState.lastFailure.error.code, 'SKILL_LOAD_FAILED')
    assert.doesNotMatch(JSON.stringify(failed.skillState), new RegExp(directory))
  })
}

test('active rules are isolated per Task and repeat activation is idempotent for snapshots', async (t) => {
  const { store, requests } = await fixture(t)
  const a = await store.create({ botId: 'calendar' }), b = await store.create({ botId: 'calendar' })
  await activate(store, a.taskId); const again = await activate(store, a.taskId)
  assert.equal(again.skillState.active.length, 1); assert.equal(again.skillState.history.length, 2)
  await store.send(b.taskId, '你好'); await settled(store, b.taskId)
  assert.doesNotMatch(requests[0].systemPrompt, /活动 Skill（用户显式指定/)
  assert.equal((await store.get(b.taskId)).skillState.active.length, 0)
})

test('cannot mutate Skill while model is running or use activation to clear limited waiting', async (t) => {
  let release, entered
  const waiting = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const { store } = await fixture(t, { modelReply: async () => { entered(); await gate; return { mode: 'model', reply: { content: 'ok' }, execution: { usage: { totalTokens: 1 } } } } })
  const task = await store.create({ botId: 'calendar' })
  await store.send(task.taskId, '开始'); await waiting
  try { await assert.rejects(activate(store, task.taskId), { code: 'TASK_BUSY' }) } finally { release() }
  await settled(store, task.taskId)
  const limited = await store.create({ botId: 'calendar', parameters: { callLimits: { modelCalls: 0 } } })
  await store.send(limited.taskId, '开始'); await settled(store, limited.taskId)
  await assert.rejects(activate(store, limited.taskId), { code: 'TASK_LIMITED' })
})

test('revocation after activation still denies actual Skill tool calls through existing permission gate', async (t) => {
  const call = { type: 'toolCall', id: 'denied', name: 'calendar_read_schedule', arguments: { date: '2026-10-20', resource: 'mock:personal' } }
  let executions = 0
  const { store } = await fixture(t, { toolImpl: () => { executions++; throw new Error('must not execute') },
    modelReply: async (_message, { context: request }) => request.messages.some((item) => item.role === 'toolResult')
      ? { mode: 'model', reply: { content: '权限已撤销，未读取日程。' }, execution: { usage: { totalTokens: 1 } } }
      : { mode: 'model', reply: { content: '' }, toolCalls: [call], assistant: { role: 'assistant', content: [call], stopReason: 'toolUse', timestamp: Date.now(), api: 'openai-completions', provider: 'bb-api', model: config.model }, execution: { usage: { totalTokens: 1 } } } })
  const task = await store.create({ botId: 'calendar' }); await activate(store, task.taskId)
  await store.revokeTool('calendar', call.name); await store.send(task.taskId, '分析2026-10-20')
  const done = await settled(store, task.taskId)
  assert.equal(executions, 0); assert.equal(done.messages.find((item) => item.role === 'tool').result.ok, false)
  assert.deepEqual(done.parameters.tools, task.parameters.tools)
})

test('Skill HTTP routes require auth, validate input/method/id, and read back success/failure', async (t) => {
  const { store } = await fixture(t)
  const server = createApiServer({ token: 'skill-test-token', tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { Authorization: 'Bearer skill-test-token', 'Content-Type': 'application/json' }
  assert.equal((await fetch(`${base}/api/skills`)).status, 401)
  assert.equal((await fetch(`${base}/api/skills`, { headers, method: 'POST' })).status, 405)
  assert.equal((await (await fetch(`${base}/api/skills`, { headers })).json()).skills[0].available, true)
  const task = await store.create({ botId: 'calendar' }), path = `${base}/api/tasks/${task.taskId}/skills`
  // GET lists the Skills this Task can pick with "/"; PUT stays refused.
  const listed = await (await fetch(path, { headers })).json()
  assert.deepEqual(listed.skills.map(s => [s.id, s.available]), [[skillId, true]])
  assert.equal((await fetch(path, { headers, method: 'PUT' })).status, 405)
  for (const body of [{ skillId: '../secret' }, { skillId, rules: 'override' }, { skillId: [] }, {}]) {
    assert.equal((await fetch(path, { headers, method: 'POST', body: JSON.stringify(body) })).status, 400)
  }
  assert.equal((await fetch(`${base}/api/tasks/999999/skills`, { headers, method: 'POST', body: JSON.stringify({ skillId }) })).status, 404)
  const response = await fetch(path, { headers, method: 'POST', body: JSON.stringify({ skillId }) })
  assert.equal(response.status, 200); assert.equal((await response.json()).task.skillState.active[0].ref.version, '1.1.0')
  const failed = await fetch(path, { headers, method: 'POST', body: JSON.stringify({ skillId: 'unknown' }) })
  assert.equal((await failed.json()).task.skillState.lastFailure.error.code, 'SKILL_NOT_FOUND')
  assert.equal((await (await fetch(`${base}/api/tasks/${task.taskId}`, { headers })).json()).task.skillState.history.length, 2)
})

test('queued follow-ups end prior Skill phase and receive one ordered reply each', async (t) => {
  let release, entered
  const waiting = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const seen = []
  const { store } = await fixture(t, { modelReply: async (message, { context: request }) => {
    seen.push({ message, request })
    if (seen.length === 1) { entered(); await gate }
    return { mode: 'model', reply: { content: `回应：${message}` }, execution: { usage: { totalTokens: 1 } } }
  } })
  const task = await store.create({ botId: 'calendar' }); const activated = await activate(store, task.taskId)
  await store.send(task.taskId, '第一条'); await waiting
  const second = await store.send(task.taskId, '第二条'), third = await store.send(task.taskId, '第三条')
  assert.equal(second.status, 'queued'); assert.equal(third.status, 'queued')
  try { await assert.rejects(activate(store, task.taskId), { code: 'TASK_BUSY' }) } finally { release() }
  const done = await settled(store, task.taskId)
  assert.equal(done.queueLength, 0); assert.deepEqual(seen.map(({message}) => message), ['第一条', '第二条', '第三条'])
  assert.ok(seen[0].request.systemPrompt.includes(activated.skillState.active[0].rules))
  for (const {request} of seen.slice(1)) assert.ok(!request.systemPrompt.includes(activated.skillState.active[0].rules))
  assert.equal(done.skillState.active.length, 0)
  assert.equal(done.skillState.history.at(-1).status, 'inactive')
  assert.equal(done.messages.filter((m) => m.role === 'assistant' && !m.assistant).length, 3)
})
