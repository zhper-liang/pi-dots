import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context'
import {openTaskStore} from './fixtures/authorized-task-store.mjs'
import {TaskCard,ChatInput,ChatQueue,ChatTask} from './tasks.mjs'
import {Collaboration,collaborationService} from './collaboration.mjs'
import {createChatTask} from './task-creation.mjs'
import {listBots} from './bots.mjs'
import {COLLABORATION_TOOLS} from './collaboration-tools.mjs'
import {MockCalendar} from './approvals.mjs'
import {buildTaskContext} from './task-context.mjs'
import {createApiServer} from './app.mjs'
import {once} from 'node:events'
const cfg={baseUrl:'https://fixture.invalid/v1',model:'controls-fixture',apiKey:'fixture'}
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
let seq=0
const turn=(name,args)=>{const call={type:'toolCall',id:`control-${++seq}`,name,arguments:args};return {...text(''),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:cfg.model,stopReason:'toolUse',timestamp:Date.now()}}}
const assignment={operationId:'child-one',botId:'calendar',goal:'仅模拟协作',completionCriteria:['注明模拟来源']}
async function until(s,id,check){for(let i=0;i<600;i++){const v=await s.get(id);if(check(v))return v;await delay(10)}throw Error(`timeout ${id}: ${JSON.stringify((await s.get(id)).runtime)}`)}
async function fixture(t,{modelReply,limit,childTools=[],parentTools=[],childResources=[],calendarWriteImpl,childLimit}={}){
 const dir=await mkdtemp(join(tmpdir(),'pidot-controls-05-')),file=join(dir,'test.sqlite'),stores=new Set();let parentCalls=0
 const reply=modelReply??(async(_m,o)=>o.parametersBotId==='todo'?(++parentCalls===1?turn('task_assign',assignment):text('主管如实收到取消，不自动重建')):turn('report_blocker',{question:'模拟项目代号？',requiredInformation:'项目代号',assignee:'user'}))
 const open=async()=>{const s=await openTaskStore({file,bots:listBots(cfg),modelReply:reply,calendarWriteImpl});stores.add(s);return s}
 const close=async s=>{await s.close();stores.delete(s)}
 t.after(async()=>{for(const s of stores)await s.close();await rm(dir,{recursive:true,force:true})})
 const s=await open(),tools=[...new Set([...COLLABORATION_TOOLS,'report_blocker',...childTools,...parentTools])]
 await s.updateCapabilityPool({requestId:'control-consent',operation:'grant',tools,resources:childResources})
 for(const id of ['todo','calendar']){const {bot}=await s.getBotConfiguration(id);await s.updateBotConfiguration(id,{requestId:'control-config-'+id,expectedVersion:bot.configRef.version,description:bot.description,tools:id==='todo'?[...COLLABORATION_TOOLS,...parentTools]:['report_blocker',...childTools],resources:id==='calendar'?childResources:[],...(id==='todo'&&limit?{parameters:{callLimits:{modelCalls:limit,toolCalls:10}}}:id==='calendar'&&childLimit?{parameters:{callLimits:{modelCalls:childLimit,toolCalls:10}}}:{})})}
 const p=await s.create({botId:'todo'});await s.send(p.taskId,'委派模拟工作')
 const parent=await until(s,p.taskId,x=>x.collaborations.length>0),r=parent.collaborations[0]
 return {s,p,r,open,close,file}
}
const svc=s=>collaborationService({TaskCard,ChatInput,bots:s.bots(),createTask:(tx,input,creationConversationId)=>createChatTask(tx,input,{ChatTask,TaskCard,ChatInput,ChatQueue,creationConversationId,configuredModels:[]})})
test('05 root stop is durable/idempotent, cancels only matching children, FIFO survives and same Bot unrelated Task stays live',async t=>{
 const {s,p,r}=await fixture(t);await until(s,r.childTaskId,x=>x.blockers.activeId!==null)
 const other=await s.create({botId:'calendar'})
 const usageBefore=(await s.get(p.taskId)).callUsage.modelCalls
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId})
 await until(s,r.childTaskId,x=>x.runtime.status==='terminal')
 const after=await until(s,p.taskId,x=>x.activeInputId===null)
 assert.equal(after.cancellation,null);assert.equal(after.collaborationOverview.stops.length,1);assert.equal(after.collaborations[0].result.status,'cancelled');assert.equal(after.collaborations[0].consumedEntryId,null);assert.ok(after.blockers.related.every(b=>b.status==='cancelled'))
 await Promise.all([s.stopWork(p.taskId,{rootWorkId:r.rootWorkId}),s.stopWork(p.taskId,{rootWorkId:r.rootWorkId})]);assert.equal((await s.get(p.taskId)).collaborationOverview.stops.length,1)
 assert.equal((await s.get(other.taskId)).cancellation,null)
 await s.send(p.taskId,'下一项普通FIFO输入');await until(s,p.taskId,x=>x.activeInputId===null&&x.messages.some(m=>m.content==='主管如实收到取消，不自动重建'))
 assert.equal((await s.get(p.taskId)).callUsage.modelCalls,usageBefore+1)
})
test('05 single child cancellation reports cancelled, supervisor replans once without creating replacement or accepting success',async t=>{
 const {s,p,r}=await fixture(t);await until(s,r.childTaskId,x=>x.blockers.activeId!==null)
 await until(s,p.taskId,x=>x.runtime.checkpoint?.phase==='awaitChildren'&&x.callUsage.unknownTokenCalls===0)
 const count=(await s.get(p.taskId)).callUsage.modelCalls
 await s.cancel(r.childTaskId,{})
 const done=await until(s,p.taskId,x=>x.activeInputId===null)
 assert.equal(done.collaborations.length,1);assert.equal(done.collaborations[0].result.status,'cancelled');assert.equal(done.collaborations[0].result.accepted,false);assert.ok(done.collaborations[0].consumedEntryId);assert.equal(done.callUsage.modelCalls,count+1)
})
test('05 parent session cancellation before child notice propagates durable intents and never resumes parent',async t=>{
 let releaseChild,pc=0
 const childHold=new Promise(resolve=>{releaseChild=resolve})
 // Hold before report_blocker publishes its durable parent notice. Observing the
 // child blocker alone does NOT prove the parent is still on model attempt one.
 t.after(()=>releaseChild())
 const events=[]
 const {s,p,r}=await fixture(t,{modelReply:async(_m,o)=>{
  if(o.parametersBotId==='todo') {events.push('parent-model-start');return ++pc===1?turn('task_assign',assignment):text('unexpected resume')}
  events.push('child-model-start');await childHold
  return turn('report_blocker',{question:'模拟项目代号？',requiredInformation:'项目代号',assignee:'user'})
 }})
 await until(s,p.taskId,x=>x.runtime.checkpoint?.phase==='awaitChildren')
 await until(s,r.childTaskId,()=>events.includes('child-model-start'))
 assert.equal((await s.get(r.childTaskId)).blockers.activeId,null)
 const cancelled=await s.cancel(p.taskId,{})
 assert.ok(cancelled.cancellation.entryId);events.push('cancel-committed')
 releaseChild()
 const parent=await until(s,p.taskId,x=>x.runtime.status==='terminal')
 const child=await until(s,r.childTaskId,x=>x.runtime.status==='terminal')
 assert.ok(child.cancellation.entryId)
 assert.equal(parent.callUsage.modelCalls,1);assert.equal(pc,1)
 assert.deepEqual(events.filter(e=>e!=='child-model-start'),['parent-model-start','cancel-committed'])
})
test('09 parent notice model started before cancellation keeps its receipt but never resumes after commit or reopen',async t=>{
 let releaseNotice,pc=0
 const noticeHold=new Promise(resolve=>{releaseNotice=resolve})
 t.after(()=>releaseNotice())
 const events=[]
 const {s,p,r,open,close}=await fixture(t,{modelReply:async(_m,o)=>{
  if(o.parametersBotId!=='todo')return turn('report_blocker',{question:'模拟项目代号？',requiredInformation:'项目代号',assignee:'user'})
  events.push('parent-model-start-'+(++pc))
  if(pc===1)return turn('task_assign',assignment)
  await noticeHold
  return text('取消前已开始的通知回复')
 }})
 await until(s,p.taskId,()=>pc===2)
 const cancelled=await s.cancel(p.taskId,{})
 assert.ok(cancelled.cancellation.entryId);events.push('cancel-committed')
 assert.equal(pc,2)
 releaseNotice()
 const parent=await until(s,p.taskId,x=>x.runtime.status==='terminal'&&x.messages.some(m=>m.afterCancellation&&m.content==='取消前已开始的通知回复'))
 const child=await until(s,r.childTaskId,x=>x.runtime.status==='terminal')
 assert.ok(child.cancellation.entryId)
 assert.equal(parent.callUsage.modelCalls,2);assert.equal(parent.callUsage.unknownTokenCalls,0)
 assert.deepEqual(events,['parent-model-start-1','parent-model-start-2','cancel-committed'])
 await close(s)
 const next=await open(),after=await next.get(p.taskId)
 assert.equal(after.cancellation.entryId,parent.cancellation.entryId)
 assert.deepEqual(after.callUsage,parent.callUsage)
 assert.equal(after.runtime.status,'terminal');assert.equal(pc,2)
 assert.equal((await next.get(r.childTaskId)).cancellation.entryId,child.cancellation.entryId)
})
test('05 persisted stop survives reopen; unchanged usage, original identities and zero redispatch',async t=>{
 const {s,p,r,open,close}=await fixture(t);await until(s,r.childTaskId,x=>x.blockers.activeId!==null)
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});await until(s,r.childTaskId,x=>x.runtime.status==='terminal');await until(s,p.taskId,x=>x.activeInputId===null)
 const before=await s.get(p.taskId),child=await s.get(r.childTaskId);await close(s);const next=await open();await delay(40)
 const after=await next.get(p.taskId);assert.deepEqual(after.collaborations,before.collaborations);assert.deepEqual(after.collaborationOverview.stops,before.collaborationOverview.stops);assert.deepEqual(after.callUsage,before.callUsage);assert.equal((await next.get(r.childTaskId)).conversationId,child.conversationId)
})
test('05 stop committed before propagation resumes cancellation on reopen, not business work',async t=>{
 const {s,p,r,open,close}=await fixture(t);await until(s,r.childTaskId,x=>x.blockers.activeId!==null)
 await until(s,p.taskId,x=>x.runtime.checkpoint?.phase==='awaitChildren'&&x.callUsage.unknownTokenCalls===0)
 const usageBefore=(await s.get(p.taskId)).callUsage
 await s.harness.commit(async tx=>{const state=await tx.doc(Collaboration);state.stops??=[];state.stops.push({version:1,rootWorkId:r.rootWorkId,parentTaskId:p.taskId,parentInputId:r.parentInputId,entryId:999,requestedAt:new Date().toISOString()})},context)
 await close(s);const next=await open();await until(next,r.childTaskId,x=>x.runtime.status==='terminal');const after=await until(next,p.taskId,x=>x.activeInputId===null);assert.deepEqual(after.callUsage,usageBefore)
})
for(const botId of ['todo','calendar'])test(`05 deactivate ${botId} parks responsibility chain without cancel/reassign and original pending retained`,async t=>{
 const {s,p,r,open,close}=await fixture(t);await until(s,r.childTaskId,x=>x.blockers.activeId!==null)
 await until(s,p.taskId,x=>x.runtime.checkpoint?.phase==='awaitChildren'&&x.callUsage.unknownTokenCalls===0)
 await s.deactivateBot(botId,{confirm:true});const before=await s.get(p.taskId)
 const child=await s.get(r.childTaskId)
 await assert.rejects(s.resolveBlocker(r.childTaskId,child.blockers.activeId,{answer:'should not resume'}),e=>e.code==='BOT_INACTIVE')
 assert.equal(child.cancellation,null);assert.equal(before.cancellation,null);assert.ok(before.collaborationOverview.nodes.some(n=>n.botId===botId&&n.botStatus==='inactive'))
 await close(s);const next=await open();await delay(30);assert.deepEqual((await next.get(p.taskId)).callUsage,before.callUsage);assert.equal((await next.get(r.childTaskId)).blockers.activeId,child.blockers.activeId)
})
test('05 stale root or wrong supervisor cannot stop another work; malformed input rejected',async t=>{
 const {s,p,r}=await fixture(t)
 await assert.rejects(s.stopWork(r.childTaskId,{rootWorkId:r.rootWorkId}),e=>e.code==='WORK_NOT_FOUND')
 await assert.rejects(s.stopWork(p.taskId,{rootWorkId:'other-root'}),e=>e.code==='WORK_NOT_FOUND')
 await assert.rejects(s.stopWork(p.taskId,{}),e=>e.code==='INVALID_WORK_STOP')
})
test('05 root stop wins blocker response and new delegation guard without new grants',async t=>{
 const {s,p,r}=await fixture(t);const child=await until(s,r.childTaskId,x=>x.blockers.activeId!==null)
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId})
 await assert.rejects(s.resolveBlocker(r.childTaskId,child.blockers.activeId,{answer:'late'}),e=>['COLLABORATION_STOPPED','TASK_CANCELLED','TASK_UNAVAILABLE'].includes(e.code))
 await assert.rejects(s.harness.commit(async tx=>svc(s).execute(tx,await tx.doc(TaskCard,p.taskId),{name:'task_assign',arguments:{...assignment,operationId:'late-new'}},r.parentInputId),context),e=>['COLLABORATION_STOPPED','COLLABORATION_INPUT_DENIED'].includes(e.code))
 assert.equal((await s.get(p.taskId)).collaborations.length,1)
})
test('05 parent limit keeps launched child result; no model resumes until explicit original limit increase',async t=>{
 let pc=0
 const {s,p,r}=await fixture(t,{limit:1,modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++pc===1?turn('task_assign',assignment):text('提额后原工作收取')):text('子结果合法完成；模拟来源')})
 const limited=await until(s,p.taskId,x=>x.runtime.checkpoint?.lastOutcome==='limited')
 assert.equal(limited.collaborations[0].result.content,'子结果合法完成；模拟来源');assert.equal(limited.callUsage.modelCalls,1);assert.equal((await s.get(r.childTaskId)).cancellation,null)
 await delay(30);assert.equal(pc,1)
 await s.raiseLimits(p.taskId,{modelCalls:3});const done=await until(s,p.taskId,x=>x.activeInputId===null&&x.messages.some(m=>m.content==='提额后原工作收取'));assert.equal(done.callUsage.modelCalls,2);assert.equal(done.collaborations.length,1)
})
test('05 stop interrupts in-flight supervisor, archives actual late model receipt, never executes its tool turn',async t=>{
 let pc=0,release,entered;const held=new Promise(r=>release=r),ready=new Promise(r=>entered=r)
 const {s,p,r}=await fixture(t,{modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++pc===1?turn('task_assign',assignment):(entered(),await held,turn('task_assign',{...assignment,operationId:'must-not-run'}))):text('模拟来源')})
 await ready;await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});release()
 const done=await until(s,p.taskId,x=>x.activeInputId===null)
 assert.equal(done.collaborations.length,1);assert.equal(done.callUsage.modelCalls,2);assert.equal(done.callUsage.unknownTokenCalls,0);assert.ok(done.messages.some(m=>m.afterControlStop||m.assistant?.content?.some(c=>c.name==='task_assign')))
})
test('05 API root stop authenticates, binds Bot scope and reports exact stop state; stable read projection pending dedupes',async t=>{
 const {s,p,r}=await fixture(t);await until(s,r.childTaskId,x=>x.blockers.activeId!==null)
 const server=createApiServer({token:'control-05-test-only-authentication-token',tasks:s});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
 const url=`http://127.0.0.1:${server.address().port}`
 assert.equal((await fetch(url+`/api/tasks/${p.taskId}/stop-work`,{method:'POST'})).status,401)
 const h={Authorization:'Bearer control-05-test-only-authentication-token','Content-Type':'application/json'}
 assert.equal((await fetch(url+`/api/bots/calendar/tasks/${p.taskId}/stop-work`,{method:'POST',headers:h,body:JSON.stringify({rootWorkId:r.rootWorkId})})).status,404)
 const before=await s.get(p.taskId);assert.deepEqual(before.collaborationOverview, (await s.get(p.taskId)).collaborationOverview)
 assert.ok(before.collaborationOverview.nodes.every(n=>n.botStatus==='active'),'legacy seeded Bot without status is active, not visually deactivated')
 const response=await fetch(url+`/api/bots/todo/tasks/${p.taskId}/stop-work`,{method:'POST',headers:h,body:JSON.stringify({rootWorkId:r.rootWorkId})});assert.equal(response.status,200);assert.equal((await response.json()).task.collaborationOverview.stops.length,1)
})

test('05 stopped parent in awaitBlocker wakes original watch, ends only root and permits next FIFO input',async t=>{
 let calls=0
 const {s,p,r}=await fixture(t,{parentTools:['report_blocker'],modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++calls===1?turn('task_assign',assignment):calls===2?turn('report_blocker',{question:'主管也需要信息',requiredInformation:'用户输入',assignee:'user'}):text('后续独立工作')):turn('report_blocker',{question:'子事项',requiredInformation:'信息',assignee:'supervisor'})})
 await until(s,p.taskId,x=>x.runtime.checkpoint?.phase==='awaitBlocker')
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId})
 await until(s,p.taskId,x=>x.activeInputId===null);await until(s,r.childTaskId,x=>x.runtime.status==='terminal')
 await s.send(p.taskId,'不受旧工作停止污染');const done=await until(s,p.taskId,x=>x.activeInputId===null&&x.messages.some(m=>m.content==='后续独立工作'));assert.equal(done.callUsage.modelCalls,3)
 const restored=await s.harness.commit(async tx=>buildTaskContext(tx,await tx.doc(TaskCard,p.taskId),done.messages.find(m=>m.content==='不受旧工作停止污染').id,{bots:s.bots()}),context)
 assert.ok(!JSON.stringify(restored.messages).includes('主管也需要信息'))
})
test('05 deactivate supervisor aborts only related in-flight child signal, late actual receipt retained, no continuation',async t=>{
 let pc=0,release,entered,childSignal;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r)
 const {s,r}=await fixture(t,{modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++pc===1?turn('task_assign',assignment):text('not reached')):(childSignal=o.signal,entered(),await gate,text('真实迟到模拟子结果'))})
 await ready;const other=await s.create({botId:'calendar'})
 await s.deactivateBot('todo',{confirm:true});assert.equal(childSignal.aborted,true);release()
 const child=await until(s,r.childTaskId,x=>x.messages.some(m=>m.content==='真实迟到模拟子结果'))
 assert.equal(child.callUsage.unknownTokenCalls,0);assert.equal(child.cancellation,null);assert.equal((await s.get(other.taskId)).cancellation,null);await delay(20);assert.equal(pc,1)
})
test('05 executor naturally hits own limit without replacement or parent cancellation; explicit increase resumes same input',async t=>{
 let pc=0,cc=0
 const {s,p,r}=await fixture(t,{childLimit:1,childTools:['calendar_read_schedule'],childResources:['mock:personal'],modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++pc===1?turn('task_assign',assignment):text('主管收取合法原结果')):++cc===1?turn('calendar_read_schedule',{date:'2026-10-20',resource:'mock:personal'}):text('同一子任务提额后交付，模拟来源')})
 const before=await until(s,r.childTaskId,x=>x.runtime.checkpoint?.lastOutcome==='limited')
 assert.equal(before.callUsage.modelCalls,1);assert.equal(before.activeInputId,null)
 const parent=await s.get(p.taskId);assert.equal(parent.collaborations.length,1);assert.equal(parent.cancellation,null);await delay(25);assert.equal(pc,1)
 await s.raiseLimits(r.childTaskId,{modelCalls:3})
 const done=await until(s,p.taskId,x=>x.activeInputId===null)
 const child=await s.get(r.childTaskId);assert.equal(child.conversationId,before.conversationId);assert.equal(child.callUsage.modelCalls,2);assert.equal(child.cancellation,null);assert.equal(done.collaborations.length,1);assert.ok(done.collaborations[0].consumedEntryId)
})

for(const boundary of ['root','session'])test(`05 SIGKILL after ${boundary} stop intent before propagation: durable stop wins same-DB recovery`,async t=>{
 const {spawn}=await import('node:child_process')
 const dir=await mkdtemp(join(tmpdir(),'pidot-controls-05-')),file=join(dir,'crash.sqlite')
 const child=spawn(process.execPath,[new URL('./fixtures/collaboration-controls-process.mjs',import.meta.url).pathname,file,boundary],{stdio:['ignore','pipe','pipe']})
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
 const exit=once(child,'exit');t.after(async()=>{child.kill('SIGKILL');await rm(dir,{recursive:true,force:true})})
 for(let i=0;i<1000&&!output.includes('CHECKPOINT ');i++)await delay(10)
 assert.ok(output.includes('CHECKPOINT '),output);const checkpoint=JSON.parse(output.split('CHECKPOINT ')[1].split('\n')[0]);child.kill('SIGKILL');await exit
 let calls=0;const s=await openTaskStore({file,bots:listBots(cfg),modelReply:async()=>{calls++;return text('must not resume')}});t.after(()=>s.close())
 await until(s,checkpoint.childTaskId,x=>x.runtime.status==='terminal')
 const parent=await until(s,checkpoint.parentTaskId,x=>boundary==='root'?x.activeInputId===null:x.runtime.status==='terminal')
 assert.equal(calls,0);assert.equal(parent.callUsage.modelCalls,checkpoint.parentUsage);assert.equal(parent.collaborations.length,1);assert.equal(parent.collaborations[0].result.status,'cancelled');assert.equal(parent.collaborations[0].consumedEntryId,null)
})

test('05 root stop during irreversible external effect preserves actual late receipt and single effect, no parent revival',async t=>{
 let pc=0,cc=0,entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
 const args={resource:'mock:personal',eventId:'mock-20261020-1',expectedStart:'2026-10-20T09:30:00+08:00',expectedEnd:'2026-10-20T10:30:00+08:00',start:'2026-10-20T11:00:00+08:00',end:'2026-10-20T12:00:00+08:00'}
 const {s,p,r}=await fixture(t,{childTools:['calendar_reschedule_event','calendar_read_schedule','calendar_read_event'],childResources:['mock:personal'],modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++pc===1?turn('task_assign',assignment):text('not reached')):++cc===1?turn('calendar_read_schedule',{date:'2026-10-20',resource:'mock:personal'}):cc===2?turn('calendar_read_event',{eventId:args.eventId,resource:'mock:personal'}):turn('calendar_reschedule_event',args),calendarWriteImpl:async(_operation,{execute})=>{const result=await execute();entered();await gate;return result}})
 const waiting=await until(s,r.childTaskId,x=>x.approvals.activeId!==null)
 await s.decideApproval(r.childTaskId,waiting.approvals.activeId,{decision:'approved'});await started
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});release()
 const child=await until(s,r.childTaskId,x=>x.runtime.status==='terminal'&&x.approvals.items[0].receipt)
 assert.equal(child.approvals.items[0].receipt.result.ok,true);assert.equal(child.approvals.items[0].receipt.source,'tool')
 const ledger=await s.harness.snapshot(MockCalendar,undefined,context);assert.equal(ledger.events[args.eventId].start,args.start);assert.equal(Object.keys(ledger.operations).length,1)
 const done=await until(s,p.taskId,x=>x.activeInputId===null);assert.equal(done.collaborations[0].result.status,'cancelled');assert.equal(done.collaborations[0].consumedEntryId,null);assert.equal(done.callUsage.modelCalls,1)
})
test('05 stop serializes against stale approval; after stop cannot approve or verify action, original pending audit preserved',async t=>{
 let pc=0,cc=0
 const args={resource:'mock:personal',eventId:'mock-20261020-1',expectedStart:'2026-10-20T09:30:00+08:00',expectedEnd:'2026-10-20T10:30:00+08:00',start:'2026-10-20T11:00:00+08:00',end:'2026-10-20T12:00:00+08:00'}
 const {s,p,r}=await fixture(t,{childTools:['calendar_reschedule_event','calendar_read_schedule','calendar_read_event'],childResources:['mock:personal'],modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++pc===1?turn('task_assign',assignment):text('not reached')):++cc===1?turn('calendar_read_schedule',{date:'2026-10-20',resource:'mock:personal'}):cc===2?turn('calendar_read_event',{eventId:args.eventId,resource:'mock:personal'}):turn('calendar_reschedule_event',args)})
 const waiting=await until(s,r.childTaskId,x=>x.approvals.activeId!==null)
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId})
 await assert.rejects(s.decideApproval(r.childTaskId,waiting.approvals.activeId,{decision:'approved'}),e=>['COLLABORATION_STOPPED','TASK_CANCELLED','TASK_UNAVAILABLE'].includes(e.code))
 const child=await until(s,r.childTaskId,x=>x.runtime.status==='terminal');assert.equal(child.approvals.items[0].decision,null)
 assert.equal((await s.harness.snapshot(MockCalendar,undefined,context)).events[args.eventId],undefined)
})

test('05 user root stop still settles deactivated supervisor without enabling it or resuming model',async t=>{
 const {s,p,r}=await fixture(t);await until(s,r.childTaskId,x=>x.blockers.activeId!==null)
 await until(s,p.taskId,x=>x.runtime.checkpoint.phase==='awaitChildren'&&x.callUsage.unknownTokenCalls===0)
 await s.deactivateBot('todo',{confirm:true});const count=(await s.get(p.taskId)).callUsage.modelCalls
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});const after=await until(s,p.taskId,x=>x.activeInputId===null)
 assert.equal(after.botLifecycle,'inactive');assert.equal(after.callUsage.modelCalls,count);await until(s,r.childTaskId,x=>x.runtime.status==='terminal')
})
test('05 root stop from parent limit wait retires only old input and does not raise cumulative limit',async t=>{
 let pc=0
 const {s,p,r}=await fixture(t,{limit:1,modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++pc===1?turn('task_assign',assignment):text('not reached')):text('模拟来源')})
 const before=await until(s,p.taskId,x=>x.runtime.checkpoint.lastOutcome==='limited')
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});const after=await until(s,p.taskId,x=>x.activeInputId===null&&x.runtime.checkpoint.lastOutcome==='work-stopped')
 assert.deepEqual(after.callUsage,before.callUsage);assert.deepEqual(after.effectiveCallLimits,before.effectiveCallLimits);assert.equal(pc,1)
})

test('05 stale repeated first-root stop never aborts second root in same supervisor long conversation',async t=>{
 let pc=0
 const {s,p,r}=await fixture(t,{modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++pc===1?turn('task_assign',assignment):pc===2?text('处理中间通知'):pc===3?turn('task_assign',{...assignment,operationId:'second-work'}):text('第二项通知')):turn('report_blocker',{question:'缺少信息',requiredInformation:'信息',assignee:'supervisor'})})
 await until(s,r.childTaskId,x=>x.blockers.activeId!==null);await until(s,p.taskId,x=>x.runtime.checkpoint.phase==='awaitChildren'&&x.callUsage.unknownTokenCalls===0)
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});await until(s,p.taskId,x=>x.activeInputId===null)
 await s.send(p.taskId,'第二项独立根工作');const second=await until(s,p.taskId,x=>x.collaborations.length===2),r2=second.collaborations[1]
 await until(s,r2.childTaskId,x=>x.blockers.activeId!==null)
 const before=await s.get(r2.childTaskId);await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});await delay(20)
 const after=await s.get(r2.childTaskId);assert.equal(after.cancellation,null);assert.equal(after.activeInputId,before.activeInputId);assert.equal(after.runtime.status,'running');assert.equal((await s.get(p.taskId)).activeInputId,r2.parentInputId)
})
