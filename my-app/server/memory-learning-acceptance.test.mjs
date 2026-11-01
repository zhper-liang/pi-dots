import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { createSkillImportService } from './skill-import.mjs'
import { SKILL_DIRECTORY, skillCapabilityCatalog } from './skills.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { MemoryExtraction } from './memory-learning-queue.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'learning-acceptance', apiKey: 'isolated-acceptance-only' }
const fact = '验收项目：运行环境为Linux'
const text = content => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
let sequence = 0
const turn = (name, args) => {
  const content = [{ type: 'toolCall', id: `acceptance-${++sequence}`, name, arguments: args }]
  return { ...text(''), toolCalls: content, assistant: { role: 'assistant', content, timestamp: Date.now() } }
}
async function settled(store, id) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const task = await store.get(id)
    if (task.activeInputId === null && task.runtime.checkpoint?.phase === 'awaitInput') return task
    assert.notEqual(task.runtime.status, 'terminal', `Task ${id} terminated`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`Task ${id} did not settle`)
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-learning-acceptance-'))
  const imports = createSkillImportService({ dataDirectory: join(root, 'skills') })
  const scripts = new Map(), derived = [], calls = [], mains = new Set()
  const directory = { builtinDirectory: SKILL_DIRECTORY, userSkills: imports }
  const modelReply = async (_message, options) => {
    calls.push(structuredClone({ taskId: options.taskId, purpose: options.purpose, context: options.context }))
    if (options.purpose === 'memory-extraction') {
      const sources = JSON.parse(options.context.messages[0].content).entries
      const verified = sources.find(source => source.kind === 'tool-result' && source.content.includes(fact))
      if (!verified) return text(JSON.stringify({ memory: [], preferences: [], skills: [] }))
      const sourceEntries = [{ taskId: verified.taskId, entryId: verified.entryId }]
      return text(JSON.stringify({ memory: [{ content: fact, sourceEntries }], preferences: [], skills: [{
        methodKey: 'acceptance:inspect-linux', name: '验收环境检查', description: '读取验收项目的环境并核验输出',
        applicability: '只适用于验收项目的环境检查', rules: '读取环境信息，核对命令退出成功及输出，再报告验收项目的环境。', sourceEntries,
      }] }))
    }
    return (mains.has(options.taskId) ? scripts.get(options.taskId) : derived)?.shift() ?? text('已完成')
  }
  const options = { file: join(root, 'tasks.sqlite'), bots: listBots(config), modelReply,
    skillDirectory: directory, readCapabilityCatalog: tx => skillCapabilityCatalog(directory, { tx }),
    memoryOptions: { enabled: true }, memoryFiles: { enabled: true },
  }
  let store = await openTaskStore(options)
  const rememberMains = async () => { for (const id of Object.values(await store.mainSessions())) mains.add(id) }
  await rememberMains()
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  return { get store() { return store }, root, imports, directory, scripts, derived, calls, mains,
    async reopen() { await store.close(); directory.userSkills = imports; store = await openTaskStore(options); await rememberMains() },
    async say(id, message, ...replies) { scripts.set(id, replies); await store.send(id, message); return settled(store, id) },
  }
}

test('learning host acceptance: derived success survives main replacement, is learned once, found and revoked at every reuse', async t => {
  const f = await fixture(t)
  const oldMain = (await f.store.mainSessions()).chief
  f.derived.push(turn('bash', { command: `printf '${fact}'` }), text('环境检查已完成'))
  const parent = await f.say(oldMain, '请派任务检查验收项目环境', turn('task_create', {
    operationId: 'inspect-environment', goal: '检查验收项目环境', completionCriteria: ['命令成功并获得环境信息'],
  }))
  const created = parent.messages.find(message => message.toolName === 'task_create')?.result
  assert.equal(created?.ok, true, JSON.stringify(created))
  const child = await settled(f.store, created.data.taskId)
  const receipt = child.messages.find(message => message.toolName === 'bash')
  assert.equal(receipt.result.ok, true)
  assert.equal((await f.store.getBotMemory('chief')).memory.items.length, 0, 'reply delivery does not immediately review')
  assert.equal(f.calls.filter(call => call.purpose === 'memory-extraction').length, 0)
  const fresh = await f.store.clearMainSession(oldMain, { requestId: 'acceptance-clear', confirmed: true })
  const main = fresh.replacementTaskId
  f.mains.add(main)
  await f.store.memoryWorker.tick()
  const documents = await f.store.getBotMemory('chief')
  assert.equal(documents.memory.items.length, 1, JSON.stringify(documents.learning))
  assert.equal(documents.memory.items[0].content, fact)
  assert.deepEqual(documents.memory.items[0].sourceEntries, [{ taskId: child.taskId, entryId: receipt.id }])
  assert.match(await readFile(join(f.root, 'bot-workspaces/bots/chief/MEMORY.md'), 'utf8'), /验收项目：运行环境为Linux/)
  const learned = (await f.imports.skillCatalog()).skills.filter(skill => skill.source?.kind === 'learned')
  assert.equal(learned.length, 1, JSON.stringify(documents.learning))
  assert.equal(learned[0].source.ownerBotId, 'chief')
  assert.ok((await f.store.getBotCapabilities('chief')).items.some(item => item.id === `skill:${learned[0].id}`))
  assert.ok(!(await f.store.getBotCapabilities('todo')).items.some(item => item.id === `skill:${learned[0].id}`))
  const reviews = f.calls.filter(call => call.purpose === 'memory-extraction').length
  await f.reopen()
  await f.store.memoryWorker.tick()
  assert.equal(f.calls.filter(call => call.purpose === 'memory-extraction').length, reviews, 'completed evidence is not reviewed after restart')
  assert.equal((await f.imports.skillCatalog()).skills.filter(skill => skill.source?.kind === 'learned').length, 1)
  const found = await f.say(main, '上次验收项目环境是什么', turn('session_search', { query: fact }))
  const results = found.messages.filter(message => message.toolName === 'session_search').at(-1)?.result
  assert.equal(results?.ok, true, JSON.stringify(results))
  const hit = results.data.entries.find(entry => entry.taskId === child.taskId && entry.entryId === receipt.id)
  assert.ok(hit, JSON.stringify(results))
  const read = await f.say(main, '查看上次核验的原始依据', turn('session_history_read', { historyRef: hit.historyRef, limit: 1024 }))
  assert.match(read.messages.filter(message => message.toolName === 'session_history_read').at(-1).result.data.text, /验收项目：运行环境为Linux/)
  const used = await f.say(main, '使用验收环境检查方法', turn('skill_activate', { skillId: learned[0].id }))
  const activated = used.messages.filter(message => message.toolName === 'skill_activate').at(-1)?.result
  assert.equal(activated?.ok, true, JSON.stringify(activated))
  const usingMethod = f.calls.filter(call => call.taskId === main && !['memory-extraction', 'context-compaction'].includes(call.purpose)).at(-1)
  assert.match(usingMethod.context.systemPrompt, /读取环境信息，核对命令退出成功及输出/, 'activation must actually provide the validated rules to the next model call')
  await f.store.deleteSession(child.taskId, { requestId: 'acceptance-delete-source', confirmed: true })
  const denied = await f.say(main, '查看已删除来源', turn('session_history_read', { historyRef: hit.historyRef }))
  assert.equal(denied.messages.filter(message => message.toolName === 'session_history_read').at(-1).result.ok, false)
  assert.ok(!(await f.store.getBotCapabilities('chief')).items.some(item => item.id === `skill:${learned[0].id}`))
  const after = await f.say(main, '验收项目环境的信息还可用吗')
  const last = f.calls.filter(call => call.taskId === main && !['memory-extraction', 'context-compaction'].includes(call.purpose)).at(-1)
  assert.doesNotMatch(last.context.systemPrompt, /Bot记忆：验收项目：运行环境为Linux/)
  assert.doesNotMatch(last.context.systemPrompt, /读取验收项目的环境并核验输出/, 'invalid learned descriptions also disappear from the model catalog')
  assert.equal(after.activeInputId, null)
  const reviewOffset = f.calls.length
  await f.store.memoryWorker.tick()
  const laterReviews = f.calls.slice(reviewOffset).filter(call => call.purpose === 'memory-extraction')
  assert.ok(laterReviews.length > 0, 'fresh legal user inputs remain reviewable')
  for (const call of laterReviews) {
    const input = JSON.parse(call.context.messages[0].content)
    assert.ok(!input.existing.memory.some(content => content.includes(fact)), 'review context cannot reintroduce a deleted source')
    assert.ok(!input.methods.some(method => method.description?.includes('读取验收项目的环境并核验输出')), 'background method catalog has the same live source checks')
  }
})

test('learning host acceptance: failed command and a temporary language request create no memory or learned method', async t => {
  const f = await fixture(t)
  const main = (await f.store.mainSessions()).chief
  const done = await f.say(main, '这封邮件用英文，检查一下验收项目环境', turn('bash', { command: `printf '${fact}'; exit 1` }))
  assert.equal(done.messages.find(message => message.toolName === 'bash').result.ok, false)
  await f.store.memoryWorker.tick()
  const documents = await f.store.getBotMemory('chief')
  assert.equal(documents.memory.items.length, 0)
  assert.equal(documents.preferences.items.length, 0)
  assert.equal((await f.imports.skillCatalog()).skills.length, 0)
  const evidence = f.calls.filter(call => call.purpose === 'memory-extraction').flatMap(call => JSON.parse(call.context.messages[0].content).entries)
  assert.ok(evidence.every(entry => entry.kind !== 'tool-result'), JSON.stringify(evidence))
})

test('learning host acceptance: automatic compaction commits a review together and immediately reviews original evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pidot-compaction-learning-'))
  const reviews = [], commits = []
  let ordinary = 0
  const stable = '验收项目路径 /workspace/acceptance-project'
  const summary = '这只是压缩摘要，不可作为长期事实来源。'
  const store = await openTaskStore({ file: join(root, 'tasks.sqlite'),
    bots: listBots(config, { maxOutputTokens: 1024, contextWindows: { [config.model]: 24000 } }),
    memoryOptions: { enabled: true },
    modelReply: async (_message, options) => {
      if (options.purpose === 'context-compaction') return text(summary)
      if (options.purpose === 'memory-extraction') {
        const sources = JSON.parse(options.context.messages[0].content).entries
        reviews.push(sources)
        const source = sources.find(entry => entry.content === stable)
        return text(JSON.stringify({ memory: source ? [{ content: stable, sourceEntries: [{ taskId: source.taskId, entryId: source.entryId }] }] : [], preferences: [] }))
      }
      return text(++ordinary === 1 ? '既往交流'.repeat(1800) : '继续完成')
    },
  })
  const unsubscribe = store.harness.subscribeCommits(({ changes }) => commits.push(changes.filter(change => change.type === 'document').map(change => change.record.kind)))
  t.after(async () => { unsubscribe(); await store.close(); await rm(root, { recursive: true, force: true }) })
  const task = await store.create({ botId: 'chief' })
  await store.send(task.taskId, stable)
  await settled(store, task.taskId)
  assert.equal(reviews.length, 0)
  await store.send(task.taskId, '继续处理')
  const compacted = await settled(store, task.taskId)
  assert.ok(compacted.compaction.revision > 0)
  assert.ok(commits.some(kinds => kinds.includes('pidot.context-compaction') && kinds.includes('pidot.memory-extraction')), 'review range is registered in the compaction commit')
  for (let attempt = 0; attempt < 200 && !(await store.getBotMemory('chief')).memory.items.some(item => item.content === stable); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(reviews.length > 0, 'automatic compaction does not wait one idle hour')
  assert.ok(reviews.flat().some(source => source.content === stable))
  assert.ok(!JSON.stringify(reviews).includes(summary), 'the summary is never evidence')
  assert.equal((await store.getBotMemory('chief')).memory.items.filter(item => item.content === stable).length, 1)
  const queue = await store.harness.snapshot(MemoryExtraction, undefined, context)
  assert.ok(Object.values(queue.jobs).some(job => job.trigger === 'compaction' && ['applied', 'no-change'].includes(job.state)))
  const before = reviews.length
  await store.memoryWorker.tick()
  assert.equal((await store.getBotMemory('chief')).memory.items.filter(item => item.content === stable).length, 1)
  assert.ok(reviews.length <= before + 1, 'only the later uncompressed input may require another review')
})
