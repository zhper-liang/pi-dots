import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context'
import {openTaskStore} from './fixtures/authorized-task-store.mjs'
import {TaskCard,ChatInput} from './tasks.mjs'
import {listBots} from './bots.mjs'
import {executeBlockerAction} from './blockers.mjs'
import {collaborationService} from './collaboration.mjs'
const config={baseUrl:'https://fixture.invalid/v1',model:'blocker-fixture',apiKey:'fixture-only'}
let seq=0
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
const turn=(name,args)=>{const c={type:'toolCall',id:`b-${++seq}`,name,arguments:args};return {...text(''),toolCalls:[c],assistant:{role:'assistant',content:[c],api:'openai-completions',provider:'fixture',model:config.model,stopReason:'toolUse',timestamp:Date.now()}}}
async function until(s,id,p){for(let i=0;i<500;i++){const v=await s.get(id);if(p(v))return v;await delay(10)}assert.fail(JSON.stringify((await s.get(id)).runtime))}
async function fixture(t,{branch='direct',hold=false}={}) {
 const dir=await mkdtemp(join(tmpdir(),'pidot-blocker-03-')),file=join(dir,'isolated.sqlite'),stores=new Set();let parentCalls=0,childCalls=0,notice
 const open=async()=>{const s=await openTaskStore({file,bots:listBots(config),modelReply:async(_m,o)=>{
  if(o.parametersBotId==='calendar') return ++childCalls===1?turn('report_blocker',{question:'模拟数据的时区？',requiredInformation:'时区',assignee:'supervisor'}):text('执行者结果 Asia/Shanghai')
  parentCalls++
  if(parentCalls===1)return turn('task_assign',{operationId:'child',botId:'calendar',goal:'需要明确时区',completionCriteria:['返回时区']})
  const messages=o.context.messages.map(m=>typeof m.content==='string'?m.content:'').filter(m=>m.includes('宿主关联的子任务阻塞通知'))
  const latest=messages.at(-1);if(latest){const data=JSON.parse(latest.slice(latest.indexOf('{')));notice={taskId:data.taskId,blockerId:data.id,rootWorkId:data.rootWorkId,version:data.version,inReplyTo:data.childInputId??data.inReplyTo};if(data.status==='pending'&&data.assignee==='supervisor'&&!hold)return turn(branch==='direct'?'blocker_resolve':'blocker_escalate',{...notice,...(branch==='direct'?{answer:'Asia/Shanghai'}:{reason:'主管没有用户偏好'})})}
  return text('主管保留等待或收取结果')
 }});stores.add(s);return s}
 const close=async s=>{await s.close();stores.delete(s)};t.after(async()=>{for(const s of stores)await s.close();await rm(dir,{recursive:true,force:true})})
 const s=await open(),tools=['collaborators_list','task_assign','blocker_resolve','blocker_escalate']
 await s.updateCapabilityPool({requestId:'blocker03-test-explicit-consent',operation:'grant',tools:[...tools,'report_blocker'],resources:[]})
 for(const id of ['todo','calendar']){const {bot}=await s.getBotConfiguration(id);await s.updateBotConfiguration(id,{requestId:`blocker03-config-${id}`,expectedVersion:bot.configRef.version,description:bot.description,tools:id==='todo'?tools:['report_blocker'],resources:[]})}
 const p=await s.create({botId:'todo'});await s.send(p.taskId,'请委派并回答时区')
 const parent=await until(s,p.taskId,v=>v.collaborations.length&&v.blockers.related?.length),childId=parent.collaborations[0].childTaskId
 return {s,p,childId,open,close,counts:()=>({parentCalls,childCalls}),notice:()=>notice,action:(actorId,name,args)=>s.harness.commit(async tx=>executeBlockerAction(tx,{TaskCard,ChatInput,bots:s.bots(),collaboration:collaborationService({TaskCard,ChatInput,bots:s.bots()})},await tx.doc(TaskCard,actorId),{name,arguments:args}),context)}
}
test('03 supervisor tool answers bound child, durable result returns without FIFO unlocking',async t=>{
 const f=await fixture(t);const done=await until(f.s,f.p.taskId,v=>v.activeInputId===null)
 const child=await f.s.get(f.childId),b=child.blockers.items[0]
 assert.equal(b.answer.source,'supervisor');assert.equal(b.version,2);assert.equal(done.collaborations[0].result.status,'submitted');assert.ok(done.collaborations[0].consumedEntryId);assert.equal(done.blockers.related[0].id,b.id)
 await f.action(f.p.taskId,'blocker_resolve',{taskId:f.childId,blockerId:b.id,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo,answer:'Asia/Shanghai'})
 assert.equal(child.callUsage.modelCalls,2);assert.ok(done.messages.some(m=>m.toolName==='blocker_resolve'&&m.result.ok))
})
test('03 explicit transfer, stale/foreign actor denied, authenticated answer exact replay, no model polling, same database reopen',async t=>{
 const f=await fixture(t,{branch:'user'});let child=await until(f.s,f.childId,v=>v.blockers.items[0]?.assignee==='user');const b=child.blockers.items[0]
 assert.equal(b.version,2);assert.equal(b.history[1].action,'escalated');await until(f.s,f.p.taskId,v=>v.runtime.checkpoint?.phase==='awaitChildren');const counts=f.counts();await delay(80);assert.deepEqual(f.counts(),counts)
 const a={taskId:f.childId,blockerId:b.id,rootWorkId:b.rootWorkId,version:2,inReplyTo:b.inReplyTo,answer:'Asia/Shanghai'}
 await assert.rejects(f.action(f.p.taskId,'blocker_resolve',a),{code:'BLOCKER_HANDLER_DENIED'})
 await assert.rejects(f.s.resolveBlocker(f.childId,b.id,{answer:a.answer,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo}),{code:'BLOCKER_VERSION_CONFLICT'})
 await f.s.send(f.childId,'普通消息不是回答');assert.equal((await f.s.get(f.childId)).blockers.activeId,b.id)
 await f.close(f.s);const reopened=await f.open();child=await until(reopened,f.childId,v=>v.runtime.checkpoint?.phase==='awaitBlocker');assert.deepEqual(child.blockers.items[0],b)
 const answer={answer:a.answer,version:2,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo}
 await Promise.all(Array.from({length:4},()=>reopened.resolveBlocker(f.childId,b.id,answer)))
 await assert.rejects(reopened.resolveBlocker(f.childId,b.id,{...answer,answer:'other'}),{code:'BLOCKER_ALREADY_RESOLVED'})
 await until(reopened,f.p.taskId,v=>v.activeInputId===null)
 const final=await reopened.get(f.childId);assert.equal(final.blockers.items.length,1);assert.equal(final.blockers.items[0].answer.source,'authenticated-user');assert.equal(final.blockers.items[0].history.length,3)
})
test('03 cannot target foreign Task, answer as user before transfer, or answer after permission revoke/cancellation',async t=>{
 const f=await fixture(t,{hold:true}),child=await until(f.s,f.childId,v=>v.runtime.checkpoint?.phase==='awaitBlocker'),b=child.blockers.items[0]
 const a={taskId:f.childId,blockerId:b.id,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo,answer:'Asia/Shanghai'}
 await assert.rejects(f.s.resolveBlocker(f.childId,b.id,{answer:a.answer,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo}),{code:'BLOCKER_HANDLER_DENIED'})
 await assert.rejects(f.action(f.childId,'blocker_resolve',a),{code:'BLOCKER_HANDLER_DENIED'})
 await assert.rejects(f.action(f.p.taskId,'blocker_resolve',{...a,rootWorkId:'foreign'}),{code:'BLOCKER_VERSION_CONFLICT'})
 await f.s.revokeTool('todo','task_assign');await assert.rejects(f.action(f.p.taskId,'blocker_resolve',a),{code:'COLLABORATION_NOT_AUTHORIZED'})
 await f.s.cancel(f.childId,{});await assert.rejects(f.action(f.p.taskId,'blocker_resolve',a),{code:'TASK_CANCELLED'})
})
for(const target of ['todo','calendar']) test(`03 ${target} deactivation retains pending handler and blocks late answers`,async t=>{
 const f=await fixture(t,{hold:true}),child=await until(f.s,f.childId,v=>v.runtime.checkpoint?.phase==='awaitBlocker'),b=child.blockers.items[0]
 await f.s.deactivateBot(target,{confirm:true})
 await assert.rejects(f.action(f.p.taskId,'blocker_resolve',{taskId:f.childId,blockerId:b.id,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo,answer:'Asia/Shanghai'}),{code:'BOT_INACTIVE'})
 const pending=await f.s.get(f.childId);assert.equal(pending.blockers.items[0].status,'pending');assert.equal(pending.blockers.items[0].assignee,'supervisor')
})
test('03 replay/transfer cannot loop; wrong version/input, other supervisor and parent revocation rejected',async t=>{
 const f=await fixture(t,{hold:true}),child=await until(f.s,f.childId,v=>v.runtime.checkpoint?.phase==='awaitBlocker'),b=child.blockers.items[0]
 const a={taskId:f.childId,blockerId:b.id,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo,answer:'Asia/Shanghai'}
 const foreign=await f.s.create({botId:'todo'})
 await assert.rejects(f.action(foreign.taskId,'blocker_resolve',a),{code:'BLOCKER_HANDLER_DENIED'})
 await assert.rejects(f.action(f.p.taskId,'blocker_resolve',{...a,inReplyTo:b.inReplyTo+1}),{code:'BLOCKER_VERSION_CONFLICT'})
 const {answer:_answer,...binding}=a,escalation={...binding,reason:'缺少信息'}
 await f.action(f.p.taskId,'blocker_escalate',escalation)
 assert.equal((await f.action(f.p.taskId,'blocker_escalate',escalation)).data.replayed,true)
 await assert.rejects(f.action(f.p.taskId,'blocker_escalate',{...escalation,reason:'不同原因'}),{code:'BLOCKER_HANDLER_DENIED'})
 const current=await f.s.get(f.childId);assert.equal(current.blockers.items[0].history.length,2)
 await f.s.revokeTool('todo','task_assign')
 await assert.rejects(f.s.resolveBlocker(f.childId,b.id,{answer:'Asia/Shanghai',version:2,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo}),{code:'COLLABORATION_NOT_AUTHORIZED'})
})
test('03 original checkpoint mismatch and information answer never create or migrate action approval',async t=>{
 const f=await fixture(t,{hold:true}),child=await until(f.s,f.childId,v=>v.runtime.checkpoint?.phase==='awaitBlocker'),b=child.blockers.items[0]
 const a={taskId:f.childId,blockerId:b.id,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo,answer:'approve arbitrary action'}
 await until(f.s,f.p.taskId,v=>v.runtime.checkpoint?.phase==='awaitChildren')
 await f.s.harness.commit(async tx=>{(await tx.doc(ChatInput,f.childId)).entryId=null},context)
 await assert.rejects(f.action(f.p.taskId,'blocker_resolve',a),{code:'BLOCKER_UNAVAILABLE'})
 await f.s.harness.commit(async tx=>{(await tx.doc(ChatInput,f.childId)).entryId=b.inReplyTo},context)
 await f.action(f.p.taskId,'blocker_resolve',a)
 await until(f.s,f.p.taskId,v=>v.activeInputId===null)
 const final=await f.s.get(f.childId);assert.equal(final.approvals.items.length,0);assert.deepEqual(final.parameters.tools,['report_blocker'])
})
test('03 child model budget exhausted while blocked cannot be reset by a supervisor answer',async t=>{
 const f=await fixture(t,{hold:true}),child=await until(f.s,f.childId,v=>v.runtime.checkpoint?.phase==='awaitBlocker'),b=child.blockers.items[0]
 const {CallUsage}=await import('./tools.mjs')
 await f.s.harness.commit(async tx=>{(await tx.doc(CallUsage,f.childId)).modelCalls=20},context)
 await f.action(f.p.taskId,'blocker_resolve',{taskId:f.childId,blockerId:b.id,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo,answer:'Asia/Shanghai'})
 const limited=await until(f.s,f.childId,v=>v.runtime.checkpoint?.lastOutcome==='limited')
 assert.equal(limited.callUsage.modelCalls,20);assert.equal(f.counts().childCalls,1);assert.equal(limited.collaborations[0].result,null)
})
test('03 answer racing cancellation never resurrects original child or delivers new model call',async t=>{
 const f=await fixture(t,{hold:true}),child=await until(f.s,f.childId,v=>v.runtime.checkpoint?.phase==='awaitBlocker'),b=child.blockers.items[0]
 await Promise.allSettled([f.s.cancel(f.childId,{}),f.action(f.p.taskId,'blocker_resolve',{taskId:f.childId,blockerId:b.id,version:1,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo,answer:'Asia/Shanghai'})])
 const stopped=await until(f.s,f.childId,v=>v.runtime.status==='terminal');assert.equal(stopped.runtime.outcome.status,'aborted');// Cancellation delivery legitimately wakes the parent once; wait for that receipt before testing quiescence.
 await until(f.s,f.p.taskId,v=>v.collaborations[0]?.consumedEntryId && v.activeInputId===null)
 const counts=f.counts();assert.equal(counts.childCalls,1);await delay(60);assert.deepEqual(f.counts(),counts)
})
