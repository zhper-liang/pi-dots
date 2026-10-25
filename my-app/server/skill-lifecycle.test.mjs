import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { TaskCard } from './tasks.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { SKILL_DIRECTORY, TaskSkills, executeSkillTool } from './skills.mjs'
import { skillTools } from './skill-tools.mjs'
import { checkToolCall, toolSets } from './tools.mjs'
import { MAX_TOOL_RESULT_BYTES } from './tool-results.mjs'

const skillId = 'calendar-conflict-analysis'
const referenceId = 'adjustment-checklist'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'lifecycle-fixture', apiKey: 'never-persist' }
const call = (name, args = { skillId }) => ({ type: 'toolCall', id: `call-${name}`, name, arguments: args })
const answer = (content = '测试分析完成') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 5 } } })
function toolReply(calls) {
  return { ...answer(''), toolCalls: calls, assistant: { role: 'assistant', content: calls,
    api: 'openai-completions', provider: 'fixture', model: 'lifecycle-fixture', stopReason: 'toolUse', timestamp: Date.now() } }
}
async function fixture(t, script = () => answer(), parameters = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-iss10-'))
  const directory = join(dir, 'skills'), requests = [], stores = []
  await cp(SKILL_DIRECTORY, directory, { recursive: true })
  const open = async () => {
    const store = await openTaskStore({ file: join(dir, 'test.sqlite'), skillDirectory: directory,
      bots: listBots(config), modelReply: async (message, { context: request }) => {
        requests.push({ message, request }); return script(message, request, requests.length)
      } })
    stores.push(store); return store
  }
  t.after(async () => { for (const store of stores) await store.close(); await rm(dir, { force: true, recursive: true }) })
  const store = await open(), task = await store.create({ botId: 'calendar', ...(Object.keys(parameters).length ? { parameters } : {}) })
  return { store, task, directory, open, requests }
}
async function send(store, id, text = '分析2026-10-20日程冲突') {
  await store.send(id, text)
  for (let n = 0; n < 500; n++) {
    const task = await store.get(id)
    assert.notEqual(task.runtime.status, 'terminal')
    if (task.activeInputId === null) return task
    await delay(5)
  }
  assert.fail('Skill lifecycle did not settle')
}
const receipts = (task) => task.messages.filter((item) => item.role === 'tool')

test('Bot discovers only brief catalog, selects full rules, reads reference, deactivates and removes inactive text from follow-up', async (t) => {
  const { store, task, requests } = await fixture(t, (_message, request, n) => {
    if (n === 1) {
      assert.match(request.systemPrompt, /本 Bot 可用 Skill 简要目录.*日程冲突分析/)
      assert.doesNotMatch(request.systemPrompt, /必须执行的步骤|10:30–11:15/)
      return toolReply([call('skill_activate')])
    }
    if (n === 2) {
      assert.match(request.systemPrompt, /必须执行的步骤/)
      assert.doesNotMatch(request.systemPrompt, /将第二项移到10:30–11:15/)
      return toolReply([call('skill_read_resource', { skillId, referenceId })])
    }
    if (n === 3) return toolReply([call('skill_deactivate')])
    return answer(n === 4 ? '冲突、依据、建议：模拟分析完成' : '无关问题的正常回答')
  })
  const done = await send(store, task.taskId)
  assert.deepEqual(done.skillState.active, [])
  assert.deepEqual(done.skillState.history.map((item) => item.status), ['active', 'inactive'])
  assert.equal(done.skillState.history[0].source, 'model-selection')
  assert.equal(done.skillState.history[1].source, 'model-phase-ended')
  const read = receipts(done).find((item) => item.toolName === 'skill_read_resource').result.data
  assert.equal(read.source, `local:${skillId}/references/adjustment-checklist.md`)
  assert.equal(read.taskId, task.taskId); assert.equal(read.conversationId, task.conversationId)
  assert.equal(read.coverage, 'complete'); assert.equal(read.nextOffset, null)
  assert.equal(read.sha256.length, 64); assert.equal(done.skillState.resourceAccesses.length, 1)
  assert.equal(done.callUsage.toolCalls, 3)
  assert.doesNotMatch(requests[3].request.systemPrompt, /必须执行的步骤/)
  assert.doesNotMatch(JSON.stringify(requests[3].request.messages), /将第二项移到10:30–11:15|必须执行的步骤/)
  await send(store, task.taskId, '解释什么是闭包')
  assert.doesNotMatch(requests.at(-1).request.systemPrompt, /必须执行的步骤/)
  assert.doesNotMatch(JSON.stringify(requests.at(-1).request.messages), /将第二项移到10:30–11:15|必须执行的步骤/)
})

test('final reply closes explicitly active phase even without model deactivation, history preserves full version', async (t) => {
  const { store, task } = await fixture(t)
  const active = await store.activateSkill(task.taskId, { skillId })
  const done = await send(store, task.taskId)
  assert.equal(done.skillState.active.length, 0)
  assert.equal(done.skillState.pinned[0].rules, active.skillState.active[0].rules)
  assert.equal(done.skillState.history.at(-1).source, 'phase-completed')
})

test('inactive pinned rules and reference survive source update/removal and normal reopen, new Task gets new version', async (t) => {
  const { store, task, directory, open, requests } = await fixture(t)
  const old = await store.activateSkill(task.taskId, { skillId }); await send(store, task.taskId)
  const manifestPath = join(directory, skillId, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.version = '2.0.0'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(join(directory, skillId, 'SKILL.md'), '# v2 new rules')
  await writeFile(join(directory, skillId, 'references/adjustment-checklist.md'), 'v2 new reference')
  const fresh = await store.create({ botId: 'calendar' })
  assert.equal((await store.activateSkill(fresh.taskId, { skillId })).skillState.active[0].ref.version, '2.0.0')
  await rm(join(directory, skillId), { recursive: true }); await store.close()
  const reopened = await open()
  const again = await reopened.activateSkill(task.taskId, { skillId })
  assert.deepEqual(again.skillState.active[0].ref, old.skillState.active[0].ref)
  assert.equal(again.skillState.active[0].resources[0].content, old.skillState.active[0].resources[0].content)
  await send(reopened, task.taskId)
  assert.match(requests.at(-1).request.systemPrompt, /日程冲突分析/)
  assert.doesNotMatch(requests.at(-1).request.systemPrompt, /v2 new/)
})

test('reference reading is bounded Unicode paging with exact provenance, not an instruction source', async (t) => {
  const { store, task, directory } = await fixture(t, (_message, _request, n) => n === 1
    ? toolReply([call('skill_read_resource', { skillId, referenceId, offset: 3, limit: 512 })]) : answer())
  const content = '🙂中'.repeat(2000)
  await writeFile(join(directory, skillId, 'references/adjustment-checklist.md'), content)
  await store.activateSkill(task.taskId, { skillId })
  const done = await send(store, task.taskId), result = receipts(done)[0].result
  assert.equal(result.ok, true)
  assert.equal(result.data.content, Array.from(content).slice(3, 515).join(''))
  assert.equal(result.data.nextOffset, 515); assert.equal(result.data.coverage, 'partial')
  assert.equal(result.data.totalCharacters, 4000)
  assert.equal(result.data.trust, 'untrusted-reference-data-not-instructions')
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_TOOL_RESULT_BYTES)
})

test('inactive/foreign Task resources and traversal inputs cannot be read', async (t) => {
  const { store, task } = await fixture(t, (_message, _request, n) => n === 1 ? toolReply([
    call('skill_read_resource', { skillId, referenceId }),
    call('skill_read_resource', { skillId, referenceId: '../../secret' }),
    call('skill_activate', { skillId, rules: 'expand permissions' }),
  ]) : answer())
  const other = await store.create({ botId: 'calendar' }); await store.activateSkill(other.taskId, { skillId })
  const done = await send(store, task.taskId)
  assert.deepEqual(receipts(done).map((item) => item.result.error.code), ['SKILL_NOT_ACTIVE', 'TOOL_INVALID_ARGUMENTS', 'TOOL_INVALID_ARGUMENTS'])
  assert.equal(done.skillState.resourceAccesses?.length ?? 0, 0)
  assert.equal((await store.get(other.taskId)).skillState.active.length, 1)
})

test('model activation uses identical dependency checks and failure audit without blocking its next explanatory reply', async (t) => {
  const { store, task } = await fixture(t, (_message, _request, n) => n === 1 ? toolReply([call('skill_activate')]) : answer('依赖工具已撤销，不能按Skill分析'))
  await store.revokeTool('calendar', 'calendar_read_event')
  const done = await send(store, task.taskId)
  assert.equal(receipts(done)[0].result.error.code, 'SKILL_DEPENDENCY_MISSING')
  assert.equal(done.skillState.history[0].status, 'failed')
  assert.equal(done.skillState.lastFailure, null)
  assert.equal(done.runtime.checkpoint.lastOutcome, 'completed')
  assert.deepEqual(done.parameters.tools, task.parameters.tools)
})

test('lifecycle controls honor live revocation on an existing Task', async (t) => {
  const { store, task } = await fixture(t, (_message, request, n) => {
    assert.ok(!request.tools.some((tool) => tool.name.startsWith('skill_')))
    return n === 1 ? toolReply([call('skill_activate')]) : answer()
  })
  await store.revokeTool('calendar', 'skill_activate')
  const done = await send(store, task.taskId)
  assert.ok(!done.toolSets.authorized.includes('skill_activate'))
  assert.deepEqual(done.skillState.active, [])
  const bots = listBots(config), bot = bots.find((bot) => bot.id === 'calendar')
  const card = { taskId: 55, bot, configRef: bot.configRef, parameters: bot.defaults }
  const sets = toolSets(card, bots, { assignments: { calendar: { tools: bot.defaults.tools, resources: bot.defaults.toolResources } }, revoked: { calendar: ['skill_activate'] } })
  assert.equal(checkToolCall({ card, sets, record: { id: 55, input: { botId: 'calendar' } }, conversation: { owner: { taskId: 55 } },
    call: call('skill_activate'), displayed: skillTools.map((tool) => tool.name) }).error.code, 'TOOL_NOT_AUTHORIZED')
})

test('limits preserve active rules for explicit resume then close the phase without replaying successful activation', async (t) => {
  const { store, task, requests } = await fixture(t, (_message, _request, n) => n === 1 ? toolReply([call('skill_activate')]) : answer(), { callLimits: { modelCalls: 1, toolCalls: 10 } })
  const limited = await send(store, task.taskId)
  assert.equal(limited.runtime.checkpoint.lastOutcome, 'limited')
  assert.equal(limited.skillState.active.length, 1)
  await assert.rejects(store.deactivateSkill(task.taskId, { skillId }), { code: 'TASK_LIMITED' })
  await store.raiseLimits(task.taskId, { modelCalls: 3 })
  let done
  for (let n = 0; n < 500; n++) { done = await store.get(task.taskId); if (done.activeInputId === null) break; await delay(5) }
  assert.equal(done.runtime.checkpoint.lastOutcome, 'completed')
  assert.equal(done.skillState.active.length, 0)
  assert.equal(done.skillState.history.filter((item) => item.status === 'active').length, 1)
  assert.match(requests[1].request.systemPrompt, /必须执行的步骤/)
  assert.equal(receipts(done).filter((item) => item.toolName === 'skill_activate').length, 1)
})

test('snapshot reference integrity and dependency revocation are rechecked on every read', async (t) => {
  const { store, task } = await fixture(t)
  await store.activateSkill(task.taskId, { skillId })
  await store.revokeTool('calendar', 'calendar_read_event')
  await store.harness.commit(async (tx) => {
    const card = await tx.doc(TaskCard, task.taskId)
    const result = await executeSkillTool(tx, card, listBots(config), call('skill_read_resource', { skillId, referenceId }), 1)
    assert.equal(result.error.code, 'SKILL_DEPENDENCY_MISSING')
    const state = await tx.doc(TaskSkills, task.taskId)
    state.active[0].resources[0].content = 'corrupted'
    await assert.rejects(executeSkillTool(tx, card, listBots(config), call('skill_read_resource', { skillId, referenceId }), 1), (error) => error.code === 'SKILL_SNAPSHOT_INVALID')
  }, context)
})

test('large complete rules load into current system only, never an unreadable bounded tool result', async (t) => {
  const { store, task, directory, requests } = await fixture(t, (_message, _request, n) => n === 1 ? toolReply([call('skill_activate')]) : answer())
  const rules = '# Long pinned rules\n' + '完整规则正文。'.repeat(1000)
  await writeFile(join(directory, skillId, 'SKILL.md'), rules)
  const done = await send(store, task.taskId)
  assert.equal(receipts(done)[0].result.data.rulesLoaded, true)
  assert.equal(receipts(done)[0].result.data.bounded, undefined)
  assert.equal(receipts(done)[0].result.data.rules, undefined)
  assert.ok(requests[1].request.systemPrompt.includes(rules))
  assert.ok(!JSON.stringify(requests[1].request.messages).includes(rules))
})

test('original issue9 v1.0 Skill snapshot stays pinned while tools update live', async (t) => {
  const { createHash } = await import('node:crypto')
  const { store, task, directory, requests } = await fixture(t)
  const metadata = { id: skillId, name: '日程冲突分析', description: '原版', version: '1.0.0',
    applicability: '个人模拟日程', botIds: ['calendar'], requiredTools: ['calendar_read_schedule', 'calendar_read_event'],
    requiredResources: ['mock:personal'], scripts: [] }
  const rules = '# 1.0 固定规则，不能自动迁移'
  const ref = { id: skillId, version: '1.0.0', sha256: createHash('sha256').update(JSON.stringify(metadata) + '\n' + rules).digest('hex') }
  await store.harness.commit(async (tx) => {
    const state = await tx.doc(TaskSkills, task.taskId), card = await tx.doc(TaskCard, task.taskId)
    state.active.push({ ...metadata, rules, ref, source: `local:${skillId}/SKILL.md`, activatedAt: new Date().toISOString(), activationEntryId: 1 })
    card.parameters.tools = ['calendar_read_schedule', 'calendar_read_event']
  }, context)
  await rm(directory, { recursive: true })
  const first = await send(store, task.taskId)
  assert.equal(first.skillState.active.length, 0)
  const again = await store.activateSkill(task.taskId, { skillId })
  assert.deepEqual(again.skillState.active[0].ref, ref)
  assert.ok(requests[0].request.systemPrompt.includes(rules))
  assert.ok(requests[0].request.tools.some((tool) => tool.name.startsWith('skill_')))
  assert.deepEqual(again.parameters.tools, ['calendar_read_schedule', 'calendar_read_event'])
})

test('authenticated DELETE deactivates only idle Task state and persists audit, malformed requests never mutate', async (t) => {
  const { createApiServer } = await import('./app.mjs')
  const { once } = await import('node:events')
  const { store, task } = await fixture(t)
  await store.activateSkill(task.taskId, { skillId })
  const server = createApiServer({ token: 'iss10-test', tasks: store })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${task.taskId}/skills`
  const headers = { Authorization: 'Bearer iss10-test', 'Content-Type': 'application/json' }
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 401)
  assert.equal((await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ skillId, rules: 'override' }) })).status, 400)
  assert.equal((await store.get(task.taskId)).skillState.active.length, 1)
  const response = await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ skillId }) })
  assert.equal(response.status, 200)
  const { task: done } = await response.json()
  assert.equal(done.skillState.active.length, 0)
  assert.equal(done.skillState.history.at(-1).source, 'user-request')
  assert.equal(done.skillState.history.at(-1).status, 'inactive')
})
