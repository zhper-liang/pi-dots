// Ticket 06: deterministic cross-feature acceptance; not real-provider evidence.
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
import { executeManagement } from './chief-management.mjs'
const config = { baseUrl:'https://fixture.invalid/v1', model:'joint-multi-bot', apiKey:'fixture-only' }
const reply = content => ({ mode:'model', reply:{content}, execution:{usage:{totalTokens:7}} })
async function fixture(t, modelReply = async message => reply(`回执:${message}`)) {
  const dir=await mkdtemp(join(tmpdir(),'pidot-06-')), file=join(dir,'isolated.sqlite'), stores=new Set()
  const open=async()=>{const s=await openTaskStore({file,bots:listBots(config,{contextWindows:{[config.model]:65536}}),modelReply});stores.add(s);return s}
  const close=async s=>{await s.close();stores.delete(s)}
  t.after(async()=>{for(const s of stores)await s.close();await rm(dir,{recursive:true,force:true})})
  return {s:await open(),open,close}
}
async function until(read, check) { for(let n=0;n<800;n++){const value=await read();if(check(value))return value;await delay(5)}assert.fail('06 acceptance boundary timeout') }
const idle=(s,id)=>until(()=>s.get(id),t=>t.activeInputId===null && t.runtime.checkpoint?.phase==='awaitInput')
const manage=(s,chief,args,inputId)=>s.harness.commit(async tx=>executeManagement(tx,await tx.doc(TaskCard,chief.taskId),{name:'bot_manage',arguments:args},inputId,[listBots(config)[0].defaults.model]),context)
const create=(s,c,name,id)=>manage(s,c,{action:'create',name,description:`仅处理${name}私有输入`,profile:'general'},id)

test('06 Chief creates specialists; old Tasks gain live tools and honor revocation, deactivation and reopen',async t=>{
  const contexts=[]
  const f=await fixture(t,async(message,options)=>{contexts.push(structuredClone(options.context));return reply(`回执:${message}`)}),s=f.s
  const chief=await s.create({botId:'chief'})
  const a=(await create(s,chief,'松树联合验收',100)).data.bot,b=(await create(s,chief,'海风联合验收',101)).data.bot
  assert.notEqual(a.id,b.id)
  const ta=await s.create({botId:a.id,taskState:{constraints:['保留用户约束']}}),tb=await s.create({botId:b.id})
  await s.send(ta.taskId,'仅松树可见-A');const before=await idle(s,ta.taskId)
  await s.send(tb.taskId,'仅海风可见-B');await idle(s,tb.taskId)
  assert.ok(!JSON.stringify(contexts[1]).includes('仅松树可见-A'))
  await s.updateCapabilityPool({requestId:'06-explicit-user-pool',operation:'grant',tools:['calendar_read_schedule'],resources:['mock:personal']})
  const configured=await manage(s,chief,{action:'configure',botId:a.id,expectedVersion:a.configRef.version,description:'新版摘要职责',tools:['calendar_read_schedule'],resources:['mock:personal']},102)
  assert.equal(configured.ok,true)
  assert.deepEqual((await s.get(ta.taskId)).configRef,ta.configRef)
  assert.deepEqual((await s.get(ta.taskId)).parameters.tools,ta.parameters.tools)
  assert.ok((await s.get(ta.taskId)).toolSets.authorized.includes('calendar_read_schedule'))
  const fresh=await s.create({botId:a.id})
  assert.deepEqual(fresh.parameters.tools,['calendar_read_schedule'])
  assert.deepEqual((await s.get(ta.taskId)).callUsage,before.callUsage)
  assert.deepEqual((await s.get(tb.taskId)).configRef,tb.configRef)
  await s.updateCapabilityPool({requestId:'06-user-revokes-tool',operation:'revoke',tools:['calendar_read_schedule'],resources:[]})
  assert.ok(!(await s.get(ta.taskId)).toolSets.authorized.includes('calendar_read_schedule'))
  const stopped=await manage(s,chief,{action:'deactivate',botId:a.id,expectedVersion:fresh.configRef.version,confirm:true},103)
  assert.equal(stopped.ok,true)
  await assert.rejects(s.send(ta.taskId,'不应派发'),e=>e.code==='BOT_INACTIVE')
  await s.send(tb.taskId,'海风继续独立对话');const active=await idle(s,tb.taskId)
  assert.ok(!JSON.stringify(contexts.at(-1)).includes('仅松树可见-A'))
  assert.equal((await s.get(ta.taskId)).cancellation,null)
  await f.close(s);const reopened=await f.open()
  assert.equal((await create(reopened,chief,'松树联合验收',100)).replayed,true)
  assert.equal((await reopened.getBotConfiguration(a.id)).versions.length,2)
  assert.equal(reopened.bots().find(bot=>bot.id===a.id).status,'inactive')
  assert.deepEqual((await reopened.get(tb.taskId)).callUsage,active.callUsage)
  assert.equal((await reopened.get(ta.taskId)).migrationHistory.length,0)
})

test('06 per-Bot FIFO remains independent while another Bot is stopped with queued input',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve});t.after(()=>release())
  const requests=[]
  const {s}=await fixture(t,async message=>{requests.push(message);if(message==='A-first')await gate;return reply(message)})
  const chief=await s.create({botId:'chief'}),a=(await create(s,chief,'队列松树',200)).data.bot,b=(await create(s,chief,'队列海风',201)).data.bot
  const ta=await s.create({botId:a.id}),tb=await s.create({botId:b.id})
  await s.send(ta.taskId,'A-first');await until(()=>requests,r=>r.includes('A-first'))
  assert.equal((await s.send(ta.taskId,'A-queued')).status,'queued')
  await s.send(tb.taskId,'B-first');await idle(s,tb.taskId)
  await s.send(tb.taskId,'B-second');await idle(s,tb.taskId)
  assert.deepEqual(requests,['A-first','B-first','B-second'])
  assert.equal((await manage(s,chief,{action:'deactivate',botId:a.id,expectedVersion:a.configRef.version,confirm:true},202)).ok,true)
  release();await until(()=>s.get(ta.taskId),v=>v.messages.some(m=>m.role==='assistant'))
  assert.ok(!requests.includes('A-queued'))
  assert.equal((await s.get(tb.taskId)).botLifecycle,'active')
  assert.equal((await s.get(ta.taskId)).cancellation,null)
})

test('06 shared Chief/web edits use CAS; duplicates and restart never rebase or multiply effects',async t=>{
  const f=await fixture(t),s=f.s,chief=await s.create({botId:'chief'}),a=(await create(s,chief,'并发联合验收',300)).data.bot
  const args={action:'configure',botId:a.id,expectedVersion:a.configRef.version,description:'Chief新职责',tools:[],resources:[]}
  const results=await Promise.allSettled([manage(s,chief,args,301),s.updateBotConfiguration(a.id,{requestId:'06-web-edit',expectedVersion:a.configRef.version,description:'网页新职责',tools:[],resources:[]})])
  assert.equal(results.filter(r=>r.status==='fulfilled' && (r.value.ok??true)).length,1)
  assert.equal((await s.getBotConfiguration(a.id)).versions.length,2)
  const stale=await manage(s,chief,args,302);assert.equal(stale.error.code,'CONFIG_VERSION_CONFLICT')
  const latest=(await s.getBotConfiguration(a.id)).bot
  assert.equal((await manage(s,chief,{...args,expectedVersion:latest.configRef.version},302)).error.code,'MANAGEMENT_REQUEST_CONFLICT')
  await f.close(s);const reopened=await f.open()
  assert.equal((await manage(reopened,chief,args,302)).replayed,true)
  assert.equal((await reopened.getBotConfiguration(a.id)).versions.length,2)
  assert.equal((await create(reopened,chief,'并发联合验收',300)).replayed,true)
})
