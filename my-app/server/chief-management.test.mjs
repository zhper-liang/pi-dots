import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { TaskCard } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { executeManagement } from './chief-management.mjs'
import { MANAGEMENT_TOOLS, validManagementArgs } from './management-tools.mjs'
import { toolSets, ToolAccess } from './tools.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'chief-fixture', apiKey: 'fixture-only' }
const text = (content = '完成，以工具回执为准') => ({ mode: 'model', reply: { content }, execution: { usage: { totalTokens: 7 } } })
let seq = 0
const turn = (name, args) => { const call = { type: 'toolCall', id: `chief-${++seq}`, name, arguments: args }; return { ...text(''), toolCalls: [call], assistant: { role: 'assistant', content: [call], api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } } }
async function fixture(t, modelReply = async () => text()) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-05-')), file = join(dir, 'tasks.sqlite'), stores = new Set()
  const open = async () => { const s = await openTaskStore({ file, bots: listBots(config), modelReply }); stores.add(s); return s }
  const close = async s => { await s.close(); stores.delete(s) }
  t.after(async () => { for (const s of stores) await s.close(); await rm(dir, { recursive: true, force: true }) })
  return { store: await open(), open, close }
}
async function until(s, id, check) { for (let i = 0; i < 500; i++) { const task = await s.get(id); if (check(task)) return task; await delay(10) } assert.fail('Chief Task did not settle') }
const idle = (s,id) => until(s,id,t => t.activeInputId === null && t.runtime.checkpoint?.phase === 'awaitInput')
async function call(s, task, args, entryId = 100, name = 'bot_manage') {
  return s.harness.commit(async tx => executeManagement(tx, await tx.doc(TaskCard, task.taskId), { name, arguments: args }, entryId, [listBots(config)[0].defaults.model]), context)
}
const creation = { action: 'create', name: '松树研究员', description: '只做研究摘要，不调用日历', profile: 'general' }
// This fixture sets an ask rule for management changes to exercise exact approval.
async function decideCard(s, id, decision = 'approved') {
  const waiting = await until(s, id, t => t.runtime.checkpoint?.phase === 'awaitApproval' && t.approvals.activeId !== null)
  const item = waiting.approvals.items.find(i => i.id === waiting.approvals.activeId)
  assert.equal(item.toolName, 'bot_manage'); assert.equal(item.allowAlways, true)
  await s.decideApproval(id, item.id, { decision }); return item
}
test('05 model Chief create/configure/deactivate uses durable shared contracts and UI provenance', async t => {
  let next = creation
  let stage = 0
  const f = await fixture(t, async (_message, options) => {
    assert.ok(options.context.tools.some(x => x.name === 'bot_manage'))
    return stage++ % 2 === 0 ? turn('bot_manage', next) : text()
  }), s = f.store
  const chief = await s.create({ botId: 'chief' }); await s.send(chief.taskId,'创建松树研究员，职责只做研究摘要'); let task = await idle(s,chief.taskId)
  let receipts = task.messages.filter(m => m.toolName === 'bot_manage'); assert.equal(receipts[0].result.ok,true)
  const created = receipts[0].result.data; assert.equal(created.executingChief,'chief'); assert.equal(created.taskId,chief.taskId); assert.equal(created.initiatingUser,'authenticated-user'); assert.match(created.entry.href,/#bot=bot-/)
  const bot = created.bot, old = await s.create({ botId: bot.id })
  next = { action:'configure', botId:bot.id, expectedVersion:bot.configRef.version, description:'新职责：写简短研究报告', tools:[], resources:[] }
  await s.send(chief.taskId,'将松树研究员改成写简短研究报告');await decideCard(s,chief.taskId);task = await idle(s,chief.taskId)
  const updated = s.bots().find(b=>b.id===bot.id);assert.notEqual(updated.configRef.version,bot.configRef.version)
  assert.equal((await s.get(old.taskId)).configRef.version,bot.configRef.version)
  assert.equal((await s.create({botId:bot.id})).configRef.version,updated.configRef.version)
  next = {action:'deactivate',botId:bot.id,expectedVersion:updated.configRef.version,confirm:true}
  await s.send(chief.taskId,'确认停用松树研究员');await decideCard(s,chief.taskId);task=await idle(s,chief.taskId)
  assert.equal(s.bots().find(b=>b.id===bot.id).status,'inactive');assert.ok(await s.get(old.taskId))
  await assert.rejects(s.send(old.taskId,'继续'),e=>e.code==='BOT_INACTIVE')
  const view = await s.getBotConfiguration(bot.id);assert.equal(view.audit.filter(a=>a.source==='chief-management').length,6)
})
test('05 persisted stable operations replay across call IDs and restart without creating versions or bots twice',async t=>{
  const f=await fixture(t),s=f.store,task=await s.create({botId:'chief'})
  const one=await call(s,task,creation);assert.equal(one.ok,true)
  const two=await call(s,task,creation);assert.equal(two.replayed,true);assert.deepEqual(two.data,one.data)
  assert.equal((await call(s,task,{...creation,description:'不同参数'})).error.code,'MANAGEMENT_REQUEST_CONFLICT')
  await f.close(s);const reopened=await f.open();assert.equal((await call(reopened,task,creation)).replayed,true)
  assert.equal(reopened.bots().filter(b=>b.name===creation.name).length,1)
  const bot=one.data.bot,args={action:'configure',botId:bot.id,expectedVersion:bot.configRef.version,description:'更新',tools:[],resources:[]}
  const updated=await call(reopened,task,args,101);assert.equal(updated.ok,true)
  assert.equal((await call(reopened,task,args,101)).replayed,true)
  assert.equal((await reopened.getBotConfiguration(bot.id)).versions.length,2)
})
test('05 specialists and prompt impersonation cannot manage even with forged fixed tool names',async t=>{
  const {store:s}=await fixture(t),task=await s.create({botId:'todo'})
  await s.harness.commit(async tx=>{const card=await tx.doc(TaskCard,task.taskId);card.managementTools=[...MANAGEMENT_TOOLS];card.parameters.tools=[...MANAGEMENT_TOOLS]},context)
  const result=await call(s,task,creation);assert.equal(result.error.code,'MANAGEMENT_NOT_AUTHORIZED')
  const card=await s.harness.snapshot(TaskCard,task.taskId,context),access=await s.harness.snapshot(ToolAccess,undefined,context)
  assert.ok(!toolSets(card,s.bots(),access).authorized.includes('bot_manage'))
})
test('05 live revocation and old Chief without explicit server snapshot fail closed',async t=>{
  const {store:s}=await fixture(t),task=await s.create({botId:'chief'})
  await s.harness.commit(async tx=>{(await tx.doc(ToolAccess)).revoked.chief=['bot_manage']},context)
  assert.equal((await call(s,task,creation)).error.code,'MANAGEMENT_NOT_AUTHORIZED')
  await s.harness.commit(async tx=>{(await tx.doc(ToolAccess)).revoked.chief=[];delete (await tx.doc(TaskCard,task.taskId)).managementTools},context)
  assert.equal((await call(s,task,creation)).error.code,'MANAGEMENT_NOT_AUTHORIZED')
})
test('S3 management assigns installed tools without granting Chief business tools',async t=>{
  const {store:s}=await fixture(t),task=await s.create({botId:'chief'})
  const bot=(await call(s,task,creation)).data.bot
  const result=await call(s,task,{action:'configure',botId:bot.id,expectedVersion:bot.configRef.version,description:'读取日程',tools:['calendar_read_schedule'],resources:['mock:personal']},102)
  assert.equal(result.ok,true)
  assert.deepEqual((await s.getBotConfiguration(bot.id)).assigned,{tools:['calendar_read_schedule'],resources:['mock:personal']})
  assert.ok(!(await s.get(task.taskId)).toolSets.authorized.includes('calendar_read_schedule'))
})
test('05 exact IDs required; ambiguous names never choose a target; Chief self-change forbidden',async t=>{
  const {store:s}=await fixture(t),task=await s.create({botId:'chief'})
  for(const target of ['日程助理','cal','不存在'])assert.equal((await call(s,task,{action:'deactivate',botId:target,expectedVersion:'1',confirm:true},++seq)).error.code,'BOT_NOT_FOUND')
  assert.equal((await call(s,task,{action:'deactivate',botId:'chief',expectedVersion:s.bots()[0].configRef.version,confirm:true})).error.code,'CHIEF_MANAGEMENT_FORBIDDEN')
})
test('05 concurrent shared HTTP-contract edit and Chief CAS gives a single version; stale operation cannot rebase',async t=>{
  const {store:s}=await fixture(t),task=await s.create({botId:'chief'}),bot=(await call(s,task,creation)).data.bot
  const args={action:'configure',botId:bot.id,expectedVersion:bot.configRef.version,description:'Chief更新',tools:[],resources:[]}
  const results=await Promise.allSettled([s.updateBotConfiguration(bot.id,{requestId:'web-concurrent-edit',expectedVersion:bot.configRef.version,description:'网页更新',tools:[],resources:[]}),call(s,task,args,104)])
  assert.equal((await s.getBotConfiguration(bot.id)).versions.length,2)
  assert.ok(results.some(r=>r.status==='fulfilled'))
  const stale=await call(s,task,args,105);assert.equal(stale.error.code,'CONFIG_VERSION_CONFLICT')
  const current=(await s.getBotConfiguration(bot.id)).bot
  assert.equal((await call(s,task,{...args,expectedVersion:current.configRef.version},105)).error.code,'MANAGEMENT_REQUEST_CONFLICT')
})
test('05 strict arguments prevent identity overrides, migration, pool grant and missing confirmation',()=>{
  for(const args of [{...creation,initiatingUser:'admin'},{action:'grant'},{action:'migrate',botId:'todo'},{action:'deactivate',botId:'todo',expectedVersion:'1'}, {...creation,tools:['bot_manage']}])assert.equal(validManagementArgs({name:'bot_manage',arguments:args}),false)
})
test('S3 inspect includes inactive history targets and current assignments',async t=>{
  const {store:s}=await fixture(t),task=await s.create({botId:'chief'});await s.deactivateBot('todo',{confirm:true})
  const result=await call(s,task,{},109,'bot_inspect');assert.equal(result.ok,true);assert.equal(result.data.bots.find(b=>b.botId==='todo').status,'inactive');assert.ok(result.data.bots.find(b=>b.botId==='todo').assigned)
})
test('05 missing/ambiguous necessary target uses original blocker loop without an action',async t=>{
  let stage=0
  const {store:s}=await fixture(t,async()=>stage++===0?turn('report_blocker',{question:'你指的是哪个Bot？请提供明确名称。',requiredInformation:'明确目标Bot',assignee:'user'}):text())
  const task=await s.create({botId:'chief'});await s.send(task.taskId,'停用那个助理')
  const waiting=await until(s,task.taskId,t=>t.runtime.checkpoint?.phase==='awaitBlocker')
  assert.equal(waiting.messages.find(m=>m.toolName==='report_blocker').result.ok,true)
  assert.equal((await s.harness.snapshot(BotDirectory,undefined,context)).chiefReceipts,undefined)
  assert.ok(s.bots().every(b=>b.status!=='inactive'))
})
test('05 Chief deactivation while target executes aborts transport and preserves late actual result/history',async t=>{
  let enteredResolve,finishResolve,signal,version,stage=0
  const entered=new Promise(r=>enteredResolve=r),finish=new Promise(r=>finishResolve=r)
  const f=await fixture(t,async(_message,options)=>{
    if(options.parametersBotId==='todo'){signal=options.signal;enteredResolve();await finish;return text('停用后到达的真实回执')}
    return stage++===0?turn('bot_manage',{action:'deactivate',botId:'todo',expectedVersion:version,confirm:true}):text()
  }),s=f.store,chief=await s.create({botId:'chief'}),target=await s.create({botId:'todo'})
  await s.send(target.taskId,'执行中');await entered
  version=s.bots().find(b=>b.id==='todo').configRef.version
  await s.send(chief.taskId,'确认停用待办助理')
  const card=await decideCard(s,chief.taskId)
  const managed=await idle(s,chief.taskId),receipt=managed.approvals.items.find(i=>i.id===card.id).receipt
  assert.equal(receipt.result.ok,true);assert.equal(signal.aborted,true)
  assert.equal(managed.messages.find(m=>m.toolName==='bot_manage').result.data.status,'waiting-for-user-approval')
  finishResolve()
  const late=await until(s,target.taskId,t=>t.messages.some(m=>m.content.includes('停用后到达')))
  assert.equal(late.cancellation,null)
  await f.close(s);const reopened=await f.open();assert.equal(reopened.bots().find(b=>b.id==='todo').status,'inactive')
  assert.equal((await call(reopened,chief,{action:'deactivate',botId:'todo',expectedVersion:version,confirm:true},card.inReplyTo)).replayed,true)
  await assert.rejects(reopened.send(target.taskId,'不该执行'),e=>e.code==='BOT_INACTIVE')
})
test('S1 restored management permission is usable by the existing Chief Task',async t=>{
  const {store:s}=await fixture(t),task=await s.create({botId:'chief'})
  await s.revokeTool('chief','bot_manage')
  assert.equal((await call(s,task,creation)).error.code,'MANAGEMENT_NOT_AUTHORIZED')
  await s.updateToolAccess('chief',{revoked:[]})
  assert.equal((await call(s,task,creation)).ok,true)
})
test('S1 Chief configuration gives an existing target Task the newly assigned tool',async t=>{
  const {store:s}=await fixture(t),chief=await s.create({botId:'chief'}),bot=(await call(s,chief,creation)).data.bot,old=await s.create({botId:bot.id})
  const result=await call(s,chief,{action:'configure',botId:bot.id,expectedVersion:bot.configRef.version,description:'用户已明确授权的模拟日程读取',tools:['calendar_read_schedule'],resources:['mock:personal']},301)
  assert.equal(result.ok,true)
  assert.ok((await s.get(old.taskId)).toolSets.authorized.includes('calendar_read_schedule'))
  assert.deepEqual((await s.getBotConfiguration(bot.id)).assigned,{tools:['calendar_read_schedule'],resources:['mock:personal']})
  assert.ok(!(await s.get(chief.taskId)).toolSets.authorized.includes('calendar_read_schedule'))
})
test('05 invalid create model is atomic; no residual Bot, request or version after rejection',async t=>{
  const {store:s}=await fixture(t),chief=await s.create({botId:'chief'})
  const before=await s.harness.snapshot(BotDirectory,undefined,context)
  const result=await call(s,chief,{...creation,parameters:{model:{provider:'unknown',api:'openai-completions',id:'unconfigured',baseUrl:'https://fixture.invalid/v1'}}},302)
  assert.equal(result.ok,false)
  const after=await s.harness.snapshot(BotDirectory,undefined,context)
  assert.equal(after.items.length,before.items.length);assert.deepEqual(after.requests,before.requests);assert.deepEqual(after.configurations,before.configurations)
})
test('05 malformed runtime management attempts are rejected independently of model schema',async t=>{
  const {store:s}=await fixture(t),chief=await s.create({botId:'chief'})
  for(const args of [{...creation,tools:['bot_manage']},{action:'grant'},{...creation,initiatingUser:'admin'}])assert.equal((await call(s,chief,args,++seq)).error.code,'TOOL_INVALID_ARGUMENTS')
})
