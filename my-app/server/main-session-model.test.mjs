import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { mainInputModel, beginMainInput, projectMainCard, MainSessions } from './main-session.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { CallUsage, ToolAccess } from './tools.mjs'
import { listBots } from './bots.mjs'
import { openTaskStore, TaskCard } from './tasks.mjs'

const config = { baseUrl: 'https://t10.fixture.invalid/v1', model: 'model-a', apiKey: 'synthetic-t10-isolated' }
const models = [{ id: 'model-a' }, { id: 'model-b' }]
const parameters = () => structuredClone(listBots(config)[0].defaults)
const card = (kind = 'main') => ({ kind, taskId: 1, conversationId: 10, bot: { id: 'chief' }, parameters: parameters() })
const code = expected => error => error.code === expected

test('T10 mainInputModel freezes a safe id and never mutates task settings or accepts endpoint/key overrides', () => {
  const main = card(), before = structuredClone(main)
  assert.deepEqual(mainInputModel(main, { model: { id: 'model-b' } }, models), { id: 'model-b' })
  assert.deepEqual(mainInputModel(main), { id: 'model-a' })
  assert.deepEqual(main, before)
  assert.throws(() => mainInputModel(main, { model: { id: 'unknown' } }, models), code('MODEL_NOT_CONFIGURED'))
  for (const model of [null, 'model-b', {}, { id: 'bad model' }, { id: 'model-b', baseUrl: 'https://denied.invalid' }, { id: 'model-b', apiKey: 'synthetic-denied' }]) {
    assert.throws(() => mainInputModel(main, { model }, models), code('INVALID_PARAMETERS'))
  }
  assert.equal(mainInputModel(card('chat')), undefined)
  assert.throws(() => mainInputModel(card('chat'), { model: { id: 'model-b' } }, models), code('MODEL_FIXED'))
  const mainTest = card(); mainTest.parameters.mode = 'test'
  assert.equal(mainInputModel(mainTest), undefined)
  assert.throws(() => mainInputModel(mainTest, { model: { id: 'model-b' } }, models), code('MODEL_UNAVAILABLE'))
})

test('T10 input boundary pins model only once and preserves historical lifetime usage', async () => {
  const main = card()
  const usage = { inputEntryId: 100, modelCalls: 2, toolCalls: 1, totalTokens: 14, unknownTokenCalls: 0, lifetime: { modelCalls: 3, toolCalls: 2, totalTokens: 21, unknownTokenCalls: 0 } }
  const tx = {
    doc: async token => token === CallUsage ? usage : token === MainSessions ? { children: {} } : assert.fail('unexpected doc'),
    entry: async id => ({ id, kind: 'pidot.user', conversationId: main.conversationId, data: { model: { id: 'model-b' } } }),
  }
  await beginMainInput(tx, main, 101)
  assert.equal(main.parameters.model.id, 'model-b')
  assert.deepEqual(usage.lifetime, { modelCalls: 5, toolCalls: 3, totalTokens: 35, unknownTokenCalls: 0 })
  usage.modelCalls = 1; usage.totalTokens = 7
  await beginMainInput(tx, main, 101)
  assert.equal(usage.modelCalls, 1)
  assert.equal(usage.totalTokens, 7)
  assert.equal(usage.lifetime.totalTokens, 35)
  assert.equal(Object.hasOwn(main, 'mainModelSelection'), false)
})

test('T10 projected main card retains per-input model and thinking while refreshing only live access', async () => {
  const main = card(); main.parameters.model.id = 'model-b'; main.parameters.thinkingLevel = 'high'
  const tx = { doc: async token => token === BotDirectory ? { items: [{ id: 'chief', defaults: parameters() }] } : token === ToolAccess ? { assignments: { chief: { tools: ['history_read'], resources: ['workspace:local'] } } } : assert.fail('unexpected doc') }
  const view = await projectMainCard(tx, main)
  assert.equal(view.parameters.model.id, 'model-b')
  assert.equal(view.parameters.thinkingLevel, 'high')
  assert.deepEqual(view.parameters.tools, ['history_read'])
  assert.equal(main.parameters.model.id, 'model-b')
})

async function fixture(t, modelReply) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-t10-model-'))
  const bots = listBots(config)
  bots.find(bot => bot.id === 'calendar').defaults.model.id = 'model-b'
  const s = await openTaskStore({ file: join(dir, 'isolated.sqlite'), bots, modelReply })
  t.after(async () => { await s.close(); await rm(dir, { recursive: true, force: true }) })
  return s
}
async function until(s, id, check) {
  for (let i = 0; i < 1000; i++) {
    const view = await s.get(id)
    if (check(view)) return view
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('T10 isolated task did not reach expected boundary')
}
const settled = (s, id) => until(s, id, view => view.activeInputId === null && view.runtime.checkpoint?.phase === 'awaitInput')
const response = () => ({ mode: 'model', reply: { content: 'isolated reply' }, execution: { usage: { totalTokens: 7 } } })

// These tests intentionally use the actual store's send admission, not a replacement wrapper.
test('T10 store next input uses selected model without rewriting old messages/usage or standalone snapshot', async t => {
  const seen = []
  const s = await fixture(t, async (_message, opts) => { seen.push(structuredClone({ taskId: opts.taskId, parameters: opts.parameters })); return response() })
  const id = (await s.mainSessions()).chief
  await s.send(id, 'first input'); const first = await settled(s, id)
  const oldMessages = structuredClone(first.messages)
  const oldUsage = await s.harness.snapshot(CallUsage, id, context)
  const child = await s.create({ botId: 'chief', title: 'frozen independent Task' })
  await s.send(id, 'second input', undefined, { model: { id: 'model-b' } }); const second = await settled(s, id)
  assert.deepEqual(seen.filter(item => item.taskId === id).map(item => item.parameters.model.id), ['model-a', 'model-b'])
  assert.deepEqual(second.messages.slice(0, oldMessages.length), oldMessages)
  const nextUsage = await s.harness.snapshot(CallUsage, id, context)
  assert.equal(nextUsage.lifetime.totalTokens, oldUsage.totalTokens)
  assert.equal(nextUsage.totalTokens, 7)
  assert.equal((await s.get(child.taskId)).parameters.model.id, 'model-a')
  assert.equal(Object.hasOwn(await s.harness.snapshot(TaskCard, id, context), 'mainModelSelection'), false)
  const before = await s.get(id)
  await assert.rejects(s.send(id, 'rejected', undefined, { model: { id: 'unconfigured' } }), code('MODEL_NOT_CONFIGURED'))
  assert.deepEqual((await s.get(id)).messages, before.messages)
  await assert.rejects(s.send(child.taskId, 'rejected', undefined, { model: { id: 'model-b' } }), code('MODEL_FIXED'))
})

test('T10 store queued inputs capture individual models without switching a running call', async t => {
  const seen = []
  let release
  const held = new Promise(resolve => { release = resolve })
  t.after(() => release())
  const s = await fixture(t, async (_message, opts) => {
    const id = opts.parameters.model.id
    seen.push({ taskId: opts.taskId, id })
    if (seen.length === 1) await held
    assert.equal(opts.parameters.model.id, id)
    return response()
  })
  const id = (await s.mainSessions()).chief
  await s.send(id, 'running input')
  await until(s, id, () => seen.length === 1)
  await s.send(id, 'queued model b', undefined, { model: { id: 'model-b' } })
  await s.send(id, 'queued model a', undefined, { model: { id: 'model-a' } })
  assert.equal((await s.get(id)).parameters.model.id, 'model-a')
  release()
  await until(s, id, view => view.activeInputId === null && seen.length === 3 && view.runtime.checkpoint?.phase === 'awaitInput')
  assert.deepEqual(seen.map(item => item.id), ['model-a', 'model-b', 'model-a'])
})
