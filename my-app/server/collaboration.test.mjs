import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { TaskCard, ChatInput, ChatQueue, ChatTask } from './tasks.mjs'
import { createChatTask } from './task-creation.mjs'
import { Collaboration, collaborationService } from './collaboration.mjs'
import { COLLABORATION_TOOLS } from './collaboration-tools.mjs'
import { listBots } from './bots.mjs'
import { buildTaskContext } from './task-context.mjs'
const config={baseUrl:'https://fixture.invalid/v1',model:'collaboration-fixture',apiKey:'fixture-only'}
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
let seq=0
const turn=(name,args)=>{const call={type:'toolCall',id:`collab-${++seq}`,name,arguments:args};return {...text(''),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:config.model,stopReason:'toolUse',timestamp:Date.now()}}}
const args={operationId:'research-1',botId:'calendar',goal:'分析2026-10-20模拟日程',completionCriteria:['说明模拟来源']}
async function until(s,id,check){for(let i=0;i<500;i++){const t=await s.get(id);if(check(t))return t;await delay(10)}assert.fail(`Task ${id} timeout: ${JSON.stringify((await s.get(id)).runtime)}`)}
async function fixture(t,{modelReply=async()=>text('child data'),beforeCommit}={}){
 const dir=await mkdtemp(join(tmpdir(),'pidot-collab-01-')),file=join(dir,'test.sqlite'),stores=new Set()
 const open=async()=>{const s=await openTaskStore({file,bots:listBots(config),modelReply,beforeCommit});stores.add(s);return s}
 const close=async s=>{await s.close();stores.delete(s)}
 t.after(async()=>{for(const s of stores)await s.close();await rm(dir,{recursive:true,force:true})})
 const s=await open()
 await s.updateCapabilityPool({requestId:'collab-consent',operation:'grant',tools:COLLABORATION_TOOLS,resources:[]})
 const {bot}=await s.getBotConfiguration('todo')
 await s.updateBotConfiguration('todo',{requestId:'collab-assignment',expectedVersion:bot.configRef.version,description:bot.description,tools:COLLABORATION_TOOLS,resources:[]})
 return {s,open,close}
}
const service=s=>collaborationService({TaskCard,ChatInput,bots:s.bots(),createTask:(tx,input,creationConversationId)=>createChatTask(tx,input,{ChatTask,TaskCard,ChatInput,ChatQueue,creationConversationId,configuredModels:[]})})
async function active(s){const p=await s.create({botId:'todo'});const e=await s.send(p.taskId,'原始委派输入');return {p,entryId:e.messageId}}
const exec=(s,id,entryId,a=args,name='task_assign')=>s.harness.commit(async tx=>service(s).execute(tx,await tx.doc(TaskCard,id),{name,arguments:a},entryId),context)
test('01 non-Chief model supervisor delegates independent task, waits once and receives original-input data',async t=>{
 let parentCalls=0
 const f=await fixture(t,{modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++parentCalls===1?turn('task_assign',args):(parentCalls===2&&assert.ok(JSON.stringify(o.context.messages).includes('真实夹具子结果')),text('主管收取，尚未验收'))):text('真实夹具子结果；模拟来源')})
 const {s}=f,p=await s.create({botId:'todo'});await s.send(p.taskId,'请委派')
 const done=await until(s,p.taskId,x=>x.activeInputId===null&&x.messages.some(m=>m.content==='主管收取，尚未验收'))
 assert.equal(parentCalls,2);assert.equal(done.collaborations.length,1)
 const r=done.collaborations[0],child=await s.get(r.childTaskId)
 assert.notEqual(child.conversationId,p.conversationId);assert.equal(child.bot.id,'calendar');assert.ok(child.toolSets.authorized.includes('calendar_read_schedule'));assert.equal(r.result.accepted,false);assert.ok(r.consumedEntryId)
 const receiptCount=await s.harness.commit(async tx=>{const c=await tx.doc(TaskCard,p.taskId);await service(s).collect(tx,c,r.parentInputId);return (await tx.scanEntries({conversationId:c.conversationId},100)).items.filter(e=>e.kind==='pidot.collaboration-result').length},context)
 assert.equal(receiptCount,1)
 await s.send(p.taskId,'后续普通对话');await until(s,p.taskId,x=>x.activeInputId===null)
 const current=await s.get(p.taskId),last=current.messages.filter(m=>m.role==='user').at(-1)
 const ctx=await s.harness.commit(async tx=>buildTaskContext(tx,await tx.doc(TaskCard,p.taskId),last.id),context)
 assert.ok(!JSON.stringify(ctx.messages).includes('真实夹具子结果'))
 await f.close(s);const reopened=await f.open();assert.equal((await reopened.get(p.taskId)).collaborations[0].consumedEntryId,r.consumedEntryId)
})
test('01 active input identity, directory restriction, self/depth and distinct-operation semantics',async t=>{
 const {s}=await fixture(t);const {p,entryId}=await active(s)
 const dir=await exec(s,p.taskId,entryId,{},'collaborators_list');assert.ok(dir.data.collaborators.every(b=>Object.keys(b).sort().join(',')==='description,id,name'&&b.id!=='todo'))
 await assert.rejects(exec(s,p.taskId,entryId,{...args,botId:'todo'}),e=>e.code==='COLLABORATION_TARGET_DENIED')
 const a=await exec(s,p.taskId,entryId),b=await exec(s,p.taskId,entryId)
 assert.equal(a.data.childTaskId,b.data.childTaskId);assert.equal(b.replayed,true)
 await assert.rejects(exec(s,p.taskId,entryId,{...args,goal:'不同参数'}),e=>e.code==='COLLABORATION_REQUEST_CONFLICT')
 const second=await exec(s,p.taskId,entryId,{...args,operationId:'research-2'});assert.notEqual(second.data.childTaskId,a.data.childTaskId)
 await assert.rejects(exec(s,p.taskId,entryId+999),e=>e.code==='COLLABORATION_INPUT_DENIED')
 await assert.rejects(exec(s,a.data.childTaskId,a.data.childInputId),e=>e.code==='COLLABORATION_DEPTH_DENIED')
 assert.equal((await s.harness.snapshot(Collaboration,undefined,context)).items.length,2)
})
test('01 transaction fault leaves no orphan child or relationship',async t=>{
 let fault=false
 const {s}=await fixture(t,{beforeCommit:async()=>{if(fault)throw Error('injected creation fault')}})
 const {p,entryId}=await active(s);fault=true
 const before=await s.list()
 await assert.rejects(s.harness.commit(async tx=>{
  const svc=collaborationService({TaskCard,ChatInput,bots:s.bots(),createTask:(tx,input,creationConversationId)=>createChatTask(tx,input,{ChatTask,TaskCard,ChatInput,ChatQueue,creationConversationId,configuredModels:[],beforeCommit:async()=>{throw Error('injected')}})})
  return svc.execute(tx,await tx.doc(TaskCard,p.taskId),{name:'task_assign',arguments:args},entryId)
 },context),/injected/)
 assert.equal((await s.list()).length,before.length);assert.equal((await s.harness.snapshot(Collaboration,undefined,context)).items.length,0)
})
test('01 inactive input is denied; live revocation and root cancellation stop child recovery',async t=>{
 const {s}=await fixture(t);const old=await s.create({botId:'calendar'});await assert.rejects(exec(s,old.taskId,1,{},'collaborators_list'),e=>e.code==='COLLABORATION_INPUT_DENIED')
 const {p,entryId}=await active(s),r=(await exec(s,p.taskId,entryId)).data
 await s.revokeTool('todo','task_assign')
 await assert.rejects(s.harness.commit(tx=>service(s).guard(tx,r.childTaskId),context),e=>e.code==='COLLABORATION_NOT_AUTHORIZED')
 await s.cancel(p.taskId,{})
 await assert.rejects(s.harness.commit(tx=>service(s).guard(tx,r.childTaskId),context),e=>e.code==='TASK_CANCELLED'||e.code==='TASK_UNAVAILABLE')
})
test('01 durable awaitChildren survives reopen without polling or resetting budgets',async t=>{
 let release=false,parentCalls=0,childStarted=false
 const f=await fixture(t,{modelReply:async(_m,o)=>{
  if(o.parametersBotId==='todo')return ++parentCalls===1?turn('task_assign',args):text('recovered parent received child')
  childStarted=true
  if(!release)await new Promise((resolve,reject)=>{const abort=()=>reject(o.signal.reason);o.signal.addEventListener('abort',abort,{once:true});if(o.signal.aborted)abort()})
  return text('recovered child result')
 }})
 const p=await f.s.create({botId:'todo'});await f.s.send(p.taskId,'委派并等待')
 const waiting=await until(f.s,p.taskId,x=>x.runtime.checkpoint?.phase==='awaitChildren')
 await until(f.s,p.taskId,()=>childStarted);const usage=waiting.callUsage.modelCalls;await delay(40);assert.equal((await f.s.get(p.taskId)).callUsage.modelCalls,usage)
 await f.close(f.s);release=true;const s=await f.open();s.harness.resume()
 const done=await until(s,p.taskId,x=>x.activeInputId===null&&x.collaborations[0]?.consumedEntryId)
 assert.equal(done.callUsage.modelCalls,usage+1);assert.equal(done.collaborations.length,1);assert.equal(done.collaborations[0].result.content,'recovered child result')
})
test('01 executor depth rejected even if separately granted collaboration; inactive targets hidden',async t=>{
 const {s}=await fixture(t),{p,entryId}=await active(s)
 const {bot}=await s.getBotConfiguration('calendar');await s.updateBotConfiguration('calendar',{requestId:'executor-collab',expectedVersion:bot.configRef.version,description:bot.description,tools:COLLABORATION_TOOLS,resources:[]})
 const r=(await exec(s,p.taskId,entryId)).data
 await assert.rejects(exec(s,r.childTaskId,r.childInputId,{},'collaborators_list'),e=>e.code==='COLLABORATION_DEPTH_DENIED')
 await s.deactivateBot('calendar',{confirm:true})
 const d=await exec(s,p.taskId,entryId,{},'collaborators_list');assert.ok(!d.data.collaborators.some(b=>b.id==='calendar'))
 await assert.rejects(exec(s,p.taskId,entryId,{...args,operationId:'after-inactive'}),e=>e.code==='COLLABORATION_TARGET_DENIED')
})
test('01 cancelled child reports cancellation once; parent is not implicitly accepted',async t=>{
 const {s}=await fixture(t),{p,entryId}=await active(s),r=(await exec(s,p.taskId,entryId)).data
 await s.cancel(r.childTaskId,{})
 const parent=await until(s,p.taskId,x=>x.collaborations[0]?.result?.status==='cancelled')
 assert.equal(parent.collaborations[0].result.accepted,false)
})
test('01 child context contains only brief; late real result archives after root cancellation without supervisor resume',async t=>{
 let entered,release;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);let parentCalls=0,childContext
 const f=await fixture(t,{modelReply:async(_m,o)=>{
  if(o.parametersBotId==='todo')return ++parentCalls===1?turn('task_assign',args):text('unexpected parent resumed')
  childContext=o.context;entered();await held;return text('late actual child data')
 }})
 const p=await f.s.create({botId:'todo',title:'parent private title'});await f.s.send(p.taskId,'PARENT_PRIVATE_CHAT_NOT_IN_BRIEF');await started
 assert.ok(!JSON.stringify(childContext).includes('PARENT_PRIVATE_CHAT_NOT_IN_BRIEF'));assert.ok(JSON.stringify(childContext).includes(args.goal))
 await f.s.cancel(p.taskId,{});release()
 const r=(await f.s.get(p.taskId)).collaborations[0]
 await until(f.s,r.childTaskId,x=>x.messages.some(m=>m.content==='late actual child data'))
 await until(f.s,p.taskId,x=>x.collaborations[0]?.result?.status==='cancelled')
 const parent=await f.s.get(p.taskId);assert.equal(parentCalls,1);assert.equal(parent.collaborations[0].consumedEntryId,null);assert.equal(parent.collaborations[0].result.accepted,false);assert.equal(parent.runtime.status,'terminal')
})
test('01 revoke during child request saves actual reply but prevents next child tool and parent consumption',async t=>{
 let entered,release;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);let parentCalls=0
 const f=await fixture(t,{modelReply:async(_m,o)=>{
 if(o.parametersBotId==='todo')return ++parentCalls===1?turn('task_assign',args):text('must not resume')
 entered();await held;return text('actual result after revocation')
 }})
 const p=await f.s.create({botId:'todo'});await f.s.send(p.taskId,'委派');await started;await f.s.revokeTool('todo','task_assign');release()
 await until(f.s,p.taskId,x=>x.collaborations[0]?.result)
 await delay(30);const p2=await f.s.get(p.taskId);assert.equal(parentCalls,1);assert.equal(p2.collaborations[0].consumedEntryId,null)
})
for(const boundary of ['created','published','consumed'])test(`01 SIGKILL at ${boundary}: same relationship, original-input receipt exactly once and cumulative usage`,async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events')
 const dir=await mkdtemp(join(tmpdir(),'pidot-collab-kill-')),file=join(dir,'test.sqlite')
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const child=spawn(process.execPath,[new URL('./fixtures/collaboration-process.mjs',import.meta.url).pathname,file,boundary],{stdio:['ignore','pipe','pipe']})
 let buffer='',err=''
 child.stderr.on('data',s=>err+=s)
 let timer
 const checkpoint=await Promise.race([new Promise(resolve=>child.stdout.on('data',s=>{buffer+=s;const m=/CHECKPOINT (.+)\n/.exec(buffer);if(m)resolve(JSON.parse(m[1]))})),once(child,'exit').then(()=>{throw Error(`subprocess exited early ${err}`)}),new Promise((resolve,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error(`checkpoint timeout ${err}`))},18000)})])
 clearTimeout(timer)
 child.kill('SIGKILL');await once(child,'exit')
 const s=await openTaskStore({file,bots:listBots(config),modelReply:async(_m,o)=>{if(o.parametersBotId==='todo')assert.ok(JSON.stringify(o.context.messages).includes('child result'));return text(o.parametersBotId==='todo'?'parent recovered':'child result after recovery')}})
 t.after(()=>s.close());const before=await s.get(checkpoint.parentTaskId),usage=before.callUsage.modelCalls
 s.harness.resume()
 const done=await until(s,checkpoint.parentTaskId,x=>x.activeInputId===null&&x.collaborations[0]?.consumedEntryId)
 assert.equal(done.collaborations.length,1);assert.ok(done.callUsage.modelCalls>=usage);assert.equal(done.collaborations[0].result.accepted,false)
 const entries=await s.harness.commit(tx=>tx.scanEntries({conversationId:done.conversationId},100),context)
 assert.equal(entries.items.filter(e=>e.kind==='pidot.collaboration-result').length,1)
})
