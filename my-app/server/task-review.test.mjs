import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context'
import {openTaskStore} from './fixtures/authorized-task-store.mjs'
import {TaskCard,ChatInput,ChatQueue,ChatTask} from './tasks.mjs'
import {collaborationService,publishChildResult} from './collaboration.mjs'
import {createChatTask} from './task-creation.mjs'
import {COLLABORATION_TOOLS} from './collaboration-tools.mjs'
import {REVIEW_TOOL,validReviewArgs} from './review-tools.mjs'
import {listBots} from './bots.mjs'
import {TaskApprovals,requestCalendarApproval} from './approvals.mjs'
import {TaskBlockers} from './blockers.mjs'
import {readMockEvent} from './tools.mjs'
const cfg={baseUrl:'https://fixture.invalid/v1',model:'review-fixture',apiKey:'fixture'}
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
let seq=0
const turn=(name,args)=>{const call={type:'toolCall',id:`review-${++seq}`,name,arguments:args};return {...text(''),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:cfg.model,stopReason:'toolUse',timestamp:Date.now()}}}
const assignment={operationId:'one-child',botId:'calendar',goal:'模拟两版交付',completionCriteria:['包含模拟来源及校验码']}
const abortable=signal=>new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})
async function until(s,id,fn){for(let i=0;i<500;i++){const t=await s.get(id);if(fn(t))return t;await delay(10)}assert.fail(JSON.stringify((await s.get(id)).runtime))}
const service=s=>collaborationService({TaskCard,ChatInput,bots:s.bots(),createTask:(tx,input,creationConversationId)=>createChatTask(tx,input,{ChatTask,TaskCard,ChatInput,ChatQueue,creationConversationId,configuredModels:[]})})
const decide=(s,p,r,changes={})=>s.harness.commit(async tx=>service(s).review(tx,await tx.doc(TaskCard,p),{name:REVIEW_TOOL,arguments:{operationId:'decision-1',childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,revision:r.result?.revision??1,expectedState:'submitted',decision:'accept',reason:'满足全部标准',...changes}},r.parentInputId),context)
async function fixture(t,{automatic=false,childTools=[],premature=false,readBeforeReview=false,childLimit}={}) {
 const dir=await mkdtemp(join(tmpdir(),'pidot-review-04-')),file=join(dir,'test.sqlite'),stores=new Set();let parentCalls=0,childCalls=0
 const modelReply=async(_m,o)=>{
  if(o.parametersBotId!=='todo') {childCalls++;assert.ok(childCalls===1||JSON.stringify(o.context.messages).includes('具体补充校验码'));return text(childCalls===1?'第一版，模拟来源':'第二版，模拟来源与校验码REVIEW-42')}
  parentCalls++
  if(parentCalls===1)return turn('task_assign',assignment)
  if(!automatic){if(premature)return text('整体成功（模型错误声明）');await abortable(o.signal);return text('not reached')}
  const r=(await store.get(parentId)).collaborations[0]
  if(r.businessStatus==='accepted')return text('主管根据受控accept完成原工作')
  if(readBeforeReview && parentCalls===2)return turn('collaborators_list',{})
  return turn(REVIEW_TOOL,{operationId:'revision-'+r.result.revision,childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,revision:r.result.revision,expectedState:'submitted',decision:r.result.revision===1?'request-rework':'accept',reason:r.result.revision===1?'具体补充校验码REVIEW-42并注明模拟来源':'第二版包含校验码及模拟来源，满足标准'})
 }
 const open=async()=>{const s=await openTaskStore({file,bots:listBots(cfg),modelReply});stores.add(s);return s}
 const close=async s=>{await s.close();stores.delete(s)}
 t.after(async()=>{for(const s of stores)await s.close();await rm(dir,{recursive:true,force:true})})
 const store=await open(),tools=[...COLLABORATION_TOOLS,REVIEW_TOOL]
 await store.updateCapabilityPool({requestId:'review-consent',operation:'grant',tools:[...tools,...childTools],resources:[]})
 for(const id of ['todo','calendar']) {const {bot}=await store.getBotConfiguration(id);await store.updateBotConfiguration(id,{requestId:'review-config-'+id,expectedVersion:bot.configRef.version,description:bot.description,tools:id==='todo'?tools:childTools,resources:[],...(id==='calendar'&&childLimit?{parameters:{callLimits:childLimit}}:{})})}
 const p=await store.create({botId:'todo'}),parentId=p.taskId
 await store.send(parentId,'委派两版并验收')
 if(automatic)return {s:store,p,open,close}
 const ready=await until(store,parentId,x=>x.collaborations[0]?.consumedEntryId)
 return {s:store,p,r:ready.collaborations[0],open,close}
}
test('04 actual tool loop submits, reworks same identity/input/context, accepts revision two with cumulative usage',async t=>{
 const {s,p}=await fixture(t,{automatic:true});const done=await until(s,p.taskId,x=>x.activeInputId===null)
 const r=done.collaborations[0],child=await s.get(r.childTaskId)
 assert.equal(r.businessStatus,'accepted');assert.equal(r.acceptedRevision,2);assert.equal(r.reworkCount,1);assert.equal(r.revisions.length,2);assert.equal(r.decisions.length,2);assert.equal(child.callUsage.modelCalls,2);assert.equal(r.revisions[0].accepted,false);assert.equal(r.result.accepted,true);assert.equal(r.revisions[1].basis.inputId,r.childInputId);assert.ok(r.revisions[1].basis.reworkDecisionEntryId);assert.equal((await s.list()).length,2);assert.ok(done.messages.at(-1).content.includes('accept'));assert.equal(child.parameters.tools.length,0)
})
test('04 concurrent identical decisions are durable idempotent; conflicting and stale decisions rejected',async t=>{
 const {s,p,r}=await fixture(t);const results=await Promise.all([decide(s,p.taskId,r),decide(s,p.taskId,r)])
 assert.equal(results.filter(x=>x.replayed).length,1)
 const reordered={reason:'满足全部标准',decision:'accept',expectedState:'submitted',revision:1,rootWorkId:r.rootWorkId,childTaskId:r.childTaskId,operationId:'decision-1'}
 assert.equal((await s.harness.commit(async tx=>service(s).review(tx,await tx.doc(TaskCard,p.taskId),{name:REVIEW_TOOL,arguments:reordered},r.parentInputId),context)).replayed,true)
 await assert.rejects(decide(s,p.taskId,r,{reason:'changed'}),e=>e.code==='REVIEW_CONFLICT')
 await assert.rejects(decide(s,p.taskId,r,{operationId:'different'}),e=>e.code==='REVIEW_STALE')
 await assert.rejects(decide(s,p.taskId,r,{operationId:'stale',revision:9}),e=>e.code==='REVIEW_STALE')
 assert.equal((await s.get(p.taskId)).collaborations[0].decisions.length,1)
})
test('04 Chief, executor and unrelated task cannot accept; wrong work/input and malformed args denied',async t=>{
 const {s,p,r}=await fixture(t);const chief=await s.create({botId:'chief'}),other=await s.create({botId:'todo'})
 for(const id of [chief.taskId,r.childTaskId,other.taskId])await assert.rejects(decide(s,id,r),e=>['COLLABORATION_NOT_AUTHORIZED','REVIEW_NOT_AUTHORIZED','REVIEW_IDENTITY_DENIED'].includes(e.code))
 await assert.rejects(decide(s,p.taskId,r,{rootWorkId:'another-work'}),e=>e.code==='REVIEW_IDENTITY_DENIED')
 await assert.rejects(decide(s,p.taskId,{...r,parentInputId:r.parentInputId+1}),e=>e.code==='REVIEW_IDENTITY_DENIED')
 for(const patch of [{reason:' '},{revision:0},{expectedState:'accepted'},{decision:'approved'},{extra:'field'}])assert.equal(validReviewArgs({arguments:{operationId:'test',childTaskId:1,rootWorkId:'root',revision:1,expectedState:'submitted',decision:'accept',reason:'why',...patch}}),false)
})
test('04 accepted is terminal for this work; late result cannot replace revision and direct child input is denied',async t=>{
 const {s,p,r}=await fixture(t);await decide(s,p.taskId,r)
 await s.harness.commit(tx=>publishChildResult(tx,r.childTaskId,r.childInputId,{status:'submitted',content:'late replacement'}),context)
 assert.equal((await s.get(p.taskId)).collaborations[0].result.content,r.result.content)
 await assert.rejects(s.send(r.childTaskId,'绕开主管新工作'),e=>e.code==='REVIEW_CHILD_INPUT_DENIED')
 await assert.rejects(s.steer(r.childTaskId,{message:'改写已验收工作'}),e=>e.code==='REVIEW_CHILD_INPUT_DENIED')
 await assert.rejects(s.previewMigration(r.childTaskId),e=>e.code==='TASK_MIGRATION_BUSY')
})
test('04 revoked review capability and executor capability reject both decision and replay',async t=>{
 const {s,p,r}=await fixture(t);await decide(s,p.taskId,r);await s.revokeTool('todo',REVIEW_TOOL)
 await assert.rejects(decide(s,p.taskId,r),e=>e.code==='REVIEW_NOT_AUTHORIZED')
})
test('04 cancellation and deactivation block decisions without reactivating child',async t=>{
 const {s,p,r}=await fixture(t);await s.deactivateBot('calendar',{confirm:true})
 await assert.rejects(decide(s,p.taskId,r),e=>e.code==='BOT_INACTIVE');assert.equal((await s.get(p.taskId)).collaborations[0].decisions.length,0)
 await s.cancel(p.taskId,{})
 await assert.rejects(decide(s,p.taskId,r),e=>e.code==='TASK_CANCELLED'||e.code==='TASK_UNAVAILABLE')
})
test('04 pending blocker or unknown action forbids acceptance and rework',async t=>{
 const {s,p,r}=await fixture(t)
 await s.harness.commit(async tx=>{(await tx.doc(TaskApprovals,r.childTaskId)).items.push({id:999,operation:{id:'unknown'},receipt:null})},context)
 await assert.rejects(decide(s,p.taskId,r),e=>e.code==='REVIEW_CHILD_BUSY')
 await s.harness.commit(async tx=>{(await tx.doc(TaskApprovals,r.childTaskId)).items=[];(await tx.doc(TaskBlockers,r.childTaskId)).activeId=888},context)
 await assert.rejects(decide(s,p.taskId,r,{decision:'request-rework',reason:'具体补充校验码'}),e=>e.code==='REVIEW_CHILD_BUSY')
})
test('04 real rework reaches original cumulative limit without new task, polling or implicit allowance',async t=>{
 const {s,p,r}=await fixture(t,{childLimit:{modelCalls:1,toolCalls:10}})
 await decide(s,p.taskId,r,{decision:'request-rework',reason:'具体补充校验码'})
 const child=await until(s,r.childTaskId,x=>x.runtime.checkpoint?.lastOutcome==='limited')
 assert.equal(child.callUsage.modelCalls,1);assert.equal(child.runtime.checkpoint.lastInputId,r.childInputId);assert.equal(child.activeInputId,null)
 const count=(await s.get(p.taskId)).callUsage.modelCalls;await delay(50);assert.equal((await s.get(p.taskId)).callUsage.modelCalls,count);assert.equal((await s.list()).length,2)
})
test('04 durable decisions and exact revision/history survive store reopen',async t=>{
 const {s,p,r,close,open}=await fixture(t);await decide(s,p.taskId,r)
 const before=(await s.get(p.taskId)).collaborations[0];await close(s);const next=await open();const after=(await next.get(p.taskId)).collaborations[0]
 assert.deepEqual(after,before);assert.equal((await decide(next,p.taskId,r)).replayed,true)
})
test('04 same-input successful action replay never dispatches again; changed arguments require new exact approval',async t=>{
 const {s,r}=await fixture(t)
 const args={resource:'mock:personal',eventId:'mock-20261020-1',expectedStart:'2026-10-20T09:30:00+08:00',expectedEnd:'2026-10-20T10:30:00+08:00',start:'2026-10-20T11:00:00+08:00',end:'2026-10-20T12:00:00+08:00'}
 await s.harness.commit(async tx=>{
  const card=await tx.doc(TaskCard,r.childTaskId),state=await tx.doc(TaskApprovals,r.childTaskId)
  state.items.push({id:701,inReplyTo:r.childInputId,arguments:args,receipt:{result:{ok:true,data:{simulated:true,eventId:args.eventId}}}})
  const replay=await requestCalendarApproval(tx,card,Object.fromEntries(Object.entries(args).reverse()),r.childInputId,702,'same',readMockEvent)
  assert.equal(replay.replayed,true);assert.equal(state.activeId,null);assert.equal(state.items.length,1)
  const changed=await requestCalendarApproval(tx,card,{...args,start:'2026-10-20T13:00:00+08:00',end:'2026-10-20T14:00:00+08:00'},r.childInputId,703,'changed',readMockEvent)
  assert.equal(changed.data.status,'waiting-for-user-approval');assert.notEqual(changed.data.approvalId,701);assert.equal(state.items.at(-1).decision,null)
 },context)
})
test('04 live supervisor review revocation prevents rework',async t=>{
 const {s,p,r}=await fixture(t,{childTools:['report_blocker']});await s.revokeTool('todo',REVIEW_TOOL)
 await assert.rejects(decide(s,p.taskId,r,{decision:'request-rework',reason:'具体补充校验码'}),e=>e.code==='REVIEW_NOT_AUTHORIZED')
 assert.equal((await s.get(p.taskId)).collaborations[0].reworkCount,0)
})
test('04 racing accept/rework commits exactly one decision, never both',async t=>{
 const {s,p,r}=await fixture(t)
 const result=await Promise.allSettled([decide(s,p.taskId,r),decide(s,p.taskId,r,{operationId:'racing-rework',decision:'request-rework',reason:'具体补充校验码'})])
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1)
 assert.equal((await s.get(p.taskId)).collaborations[0].decisions.length,1)
})
test('04 model completion words cannot clear parent input while required child is unaccepted, and wait does not poll',async t=>{
 const {s,p}=await fixture(t,{premature:true});const waiting=await until(s,p.taskId,x=>x.runtime.checkpoint?.phase==='awaitChildren'&&x.collaborations[0]?.consumedEntryId)
 assert.notEqual(waiting.activeInputId,null);assert.ok(waiting.messages.at(-1).intermediate);assert.ok(waiting.messages.at(-1).content.startsWith('【主管验收未完成'))
 const count=waiting.callUsage.modelCalls;await delay(80);assert.equal((await s.get(p.taskId)).callUsage.modelCalls,count)
})
test('04 rework revision returns on original parent work after reopen, no new identity or reset usage',async t=>{
 const {s,p,r,close,open}=await fixture(t)
 await decide(s,p.taskId,r,{decision:'request-rework',reason:'具体补充校验码REVIEW-42'})
 const revised=await until(s,r.childTaskId,x=>x.collaborations[0]?.result?.revision===2)
 await close(s);const next=await open(),restored=await next.get(r.childTaskId)
 assert.equal(restored.taskId,r.childTaskId);assert.equal(restored.conversationId,revised.conversationId);assert.deepEqual(restored.callUsage,revised.callUsage);assert.equal(restored.collaborations[0].revisions.length,2)
 await decide(next,p.taskId,restored.collaborations[0],{operationId:'accept-revision-two'})
 assert.equal((await next.get(p.taskId)).collaborations[0].acceptedRevision,2)
})

// Joint acceptance exposed a result-consumption/tool-loop deadlock: a successful
// or denied evidence read must not park before the model can actually review.
test('06 consumed submitted result permits an intermediate tool then exact review, not premature awaitChildren',async t=>{
 const {s,p}=await fixture(t,{automatic:true,readBeforeReview:true})
 const done=await until(s,p.taskId,x=>x.activeInputId===null)
 const r=done.collaborations[0], child=await s.get(r.childTaskId)
 assert.equal(r.businessStatus,'accepted');assert.equal(r.acceptedRevision,2)
 assert.equal(r.decisions.length,2);assert.equal(child.callUsage.modelCalls,2)
 assert.ok(done.messages.some(m=>m.toolName==='collaborators_list'&&m.result.ok))
 assert.equal(done.runtime.checkpoint.phase,'awaitInput')
})

test('06 accepted idle children remain readable after same-DB restart, no terminal document retirement or model redispatch',async t=>{
 const {s,p,close,open}=await fixture(t,{automatic:true,readBeforeReview:true})
 await until(s,p.taskId,x=>x.activeInputId===null)
 const parent=await s.get(p.taskId), id=parent.collaborations[0].childTaskId
 const child=await until(s,id,x=>x.runtime.checkpoint.phase==='awaitInput')
 await close(s);const next=await open();await delay(60)
 const stable=v=>JSON.parse(JSON.stringify(v,(k,x)=>k==='status'&&['running','pending'].includes(x)?'resumable':x))
 const after=await next.get(id);assert.deepEqual(stable(after),stable(child))
 assert.deepEqual(stable(await next.get(p.taskId)),stable(parent))
 assert.equal((await next.list()).length,2)
 assert.ok(['running','pending'].includes(after.runtime.status));assert.equal(after.callUsage.modelCalls,2)
})
