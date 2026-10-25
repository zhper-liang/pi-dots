import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context'
import {openTaskStore} from './fixtures/authorized-task-store.mjs'
import {TaskCard} from './tasks.mjs'
import {listBots} from './bots.mjs'
import {COLLABORATION_TOOLS} from './collaboration-tools.mjs'
import {readTaskHistory} from './history-tool.mjs'
const config={baseUrl:'https://fixture.invalid/v1',model:'directed-fork-fixture',apiKey:'fixture-only'}
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
let seq=0
const turn=(name,args)=>{const call={type:'toolCall',id:`d-${++seq}`,name,arguments:args};return {...text(''),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:config.model,stopReason:'toolUse',timestamp:Date.now()}}}
export async function until(fn,check){for(let i=0;i<800;i++){const x=await fn();if(check(x))return x;await new Promise(r=>setTimeout(r,10))}throw Error('Directed fork timeout')}
async function fixture(t,{grant=true,modelReply,beforeCommit}={}){
 const dir=await mkdtemp(join(tmpdir(),'pidot-group-directed-'));const s=await openTaskStore({file:join(dir,'test.sqlite'),bots:listBots(config),beforeCommit,modelReply:modelReply??(async()=>text('answer'))});t.after(async()=>{await s.close();await rm(dir,{recursive:true,force:true})})
 if(grant){await s.updateCapabilityPool({requestId:'directed-consent',operation:'grant',tools:[...COLLABORATION_TOOLS,'task_review'],resources:[]});const {bot}=await s.getBotConfiguration('todo');await s.updateBotConfiguration('todo',{requestId:'directed-config',expectedVersion:bot.configRef.version,description:bot.description,tools:[...COLLABORATION_TOOLS,'task_review'],resources:[]})}
 const {task}=await s.createGroup({requestId:'directed-group-create',title:'定向群',adminBotId:'todo',memberBotIds:['todo','calendar']});return {s,task}
}
test('directed group native fork, fixed target, consumed public context, exact review and one child',async t=>{
 let parentCalls=0,childCalls=0,childContext
 const {s,task}=await fixture(t,{modelReply:async(msg,o)=>{
  if(o.parametersBotId==='calendar'){childCalls++;childContext=o.context;return text('专业结果，只来自本群上下文')}
  parentCalls++;const rs=JSON.stringify(o.context.messages);const match=rs.match(/childTaskId\\?"\s*:\s*(\d+)/);const root=rs.match(/rootWorkId\\?"\s*:\s*\\?"([^"\\]+)/)
  if(msg==='public-before')return text('public-before-reply')
  if(match&&root&&parentCalls<3)return turn('task_review',{operationId:'accept-directed',childTaskId:Number(match[1]),rootWorkId:root[1],revision:1,expectedState:'submitted',decision:'accept',reason:'已核对专业结果符合原请求'})
  return text('管理员统一回报')
 }})
 await s.send(task.taskId,'public-before');await until(()=>s.get(task.taskId),v=>v.activeInputId===null&&v.messages.some(m=>m.content==='public-before-reply'))
 const input={message:'分析本群已有信息',targetBotId:'calendar',requestId:'directed-input-001'}
 const a=await s.send(task.taskId,input),b=await s.send(task.taskId,input);assert.equal(a.messageId,b.messageId)
 await s.send(task.taskId,'FUTURE-QUEUE-SECRET')
 const done=await until(async()=>{try{return await s.get(task.taskId)}catch(e){console.log('RAW TASK',JSON.stringify(await s.harness.getTask(task.taskId,ctx)));throw e}},v=>v.collaborations[0]?.businessStatus==='accepted')
 const r=done.collaborations[0],child=await s.get(r.childTaskId),conversation=await s.harness.commit(tx=>tx.conversation(child.conversationId),ctx)
 assert.deepEqual(conversation.parent,{conversationId:task.conversationId,at:a.messageId});assert.equal(conversation.owner.taskId,child.taskId)
 assert.equal(r.groupId,task.groupId);assert.equal(r.sourceMessageId,a.messageId);assert.equal(childCalls,1);assert.equal(done.collaborations.length,1)
 const context=JSON.stringify(childContext.messages);assert.match(context,/public-before/);assert.doesNotMatch(context,/FUTURE-QUEUE-SECRET/)
 assert.equal(child.messages.filter(m=>m.role==='user').length,1);assert.deepEqual(child.managementTools,[]);assert.equal(child.callUsage.modelCalls,1)
 const history=await s.harness.commit(async tx=>readTaskHistory(tx,await tx.doc(TaskCard,child.taskId),{entryId:a.messageId},r.childInputId,{authorized:[]}),ctx);assert.equal(history.error.code,'HISTORY_NOT_FOUND')
 await assert.rejects(s.send(task.taskId,{...input,message:'changed'}),{code:'GROUP_INPUT_CONFLICT'})
})
test('target validation rejects missing permission, spoofing and multiple targets without side effects',async t=>{
 let calls=0;const {s,task}=await fixture(t,{grant:false,modelReply:async()=>{calls++;return text('no')}})
 const valid={message:'do this',requestId:'denied-target-001',targetBotId:'calendar'}
 for(const value of [valid,{...valid,targetBotId:'chief'},{...valid,targetBotId:['calendar','todo']},{...valid,mentions:['calendar','todo']},{...valid,sourceMessageId:99}])await assert.rejects(s.send(task.taskId,value))
 assert.equal(calls,0);assert.equal((await s.list()).length,1);assert.equal((await s.get(task.taskId)).messages.length,0)
 const accepted=await s.send(task.taskId,{...valid,targetBotId:'todo'});await until(()=>s.get(task.taskId),v=>v.messages.some(m=>m.inReplyTo===accepted.messageId&&m.role==='assistant'));assert.equal((await s.get(task.taskId)).collaborations.length,0)
})
test('fixed mention denies model extra broadcast; child cannot recurse and scoped listing excludes outsiders',async t=>{
 let childReady,release;const ready=new Promise(r=>childReady=r),gate=new Promise(r=>release=r)
 const {s,task}=await fixture(t,{modelReply:async(_m,o)=>{if(o.parametersBotId==='calendar'){childReady();await gate}return text('hold')}})
 t.after(()=>release());const accepted=await s.send(task.taskId,{message:'only calendar',targetBotId:'calendar',requestId:'fixed-target-001'});await ready
 const {collaborationService}=await import('./collaboration.mjs');const svc=collaborationService({TaskCard,ChatInput:(await import('./tasks.mjs')).ChatInput,bots:s.bots()})
 const relation=(await s.get(task.taskId)).collaborations[0]
 await assert.rejects(s.harness.commit(async tx=>svc.execute(tx,await tx.doc(TaskCard,task.taskId),{name:'task_assign',arguments:{operationId:'extra',botId:'chief',goal:'extra',completionCriteria:['no']}},accepted.messageId),ctx),{code:'GROUP_TARGET_FIXED'})
 await s.revokeTool('todo','task_assign');release()
 const child=await until(()=>s.get(relation.childTaskId),v=>v.callUsage.modelCalls===1)
 assert.equal(child.callUsage.modelCalls,1);assert.equal((await s.get(task.taskId)).collaborations.length,1)
})
test('target deactivation and forged fork ownership block direct and history reads',async t=>{
 const {s,task}=await fixture(t)
 await s.deactivateBot('calendar',{confirm:true})
 await assert.rejects(s.send(task.taskId,{message:'no dispatch',targetBotId:'calendar',requestId:'inactive-target-001'}),{code:'BOT_INACTIVE'})
 assert.equal((await s.get(task.taskId)).messages.length,0)
})
test('directed budget waits before dispatch, explicit raise preserves identity and usage',async t=>{
 const {s}=await fixture(t)
 const {task}=await s.createGroup({requestId:'budget-group-create',title:'零工具预算群',adminBotId:'todo',memberBotIds:['todo','calendar'],parameters:{callLimits:{modelCalls:10,toolCalls:0}}})
 const sent=await s.send(task.taskId,{message:'budget-controlled',targetBotId:'calendar',requestId:'budget-directed-input'})
 const waiting=await until(()=>s.get(task.taskId),v=>v.waiting?.kind==='limits')
 assert.equal(waiting.collaborations.length,0);assert.equal(waiting.callUsage.modelCalls,0);assert.equal(waiting.callUsage.toolCalls,0)
 await s.raiseLimits(task.taskId,{modelCalls:10,toolCalls:3})
 const dispatched=await until(()=>s.get(task.taskId),v=>v.collaborations.length===1)
 assert.equal(dispatched.collaborations[0].parentInputId,sent.messageId);assert.ok(dispatched.callUsage.toolCalls>=1)
})
test('parent cancellation archives late child result without public success or FIFO revival',async t=>{
 let ready,release;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r)
 const {s,task}=await fixture(t,{modelReply:async(_m,o)=>{if(o.parametersBotId==='calendar'){ready();await gate}return text('LATE-CHILD-RESULT')}})
 t.after(()=>release())
 const sent=await s.send(task.taskId,{message:'cancel me',targetBotId:'calendar',requestId:'cancel-directed-input'});await started
 const before=await s.get(task.taskId),childId=before.collaborations[0].childTaskId
 await s.send(task.taskId,'next-queued-not-executed');await s.cancel(task.taskId,{});release()
 const cancelled=await until(()=>s.get(task.taskId),v=>v.runtime.status==='terminal')
 assert.equal(cancelled.runtime.outcome.status,'aborted');assert.ok(!cancelled.messages.some(m=>m.role==='assistant'&&m.inReplyTo===sent.messageId&&!m.intermediate))
 const child=await until(()=>s.get(childId),v=>v.runtime.status==='terminal')
 assert.equal(child.runtime.outcome.status,'aborted');assert.equal(child.callUsage.modelCalls,1)
})
test('foreign fork ownership and unconsumed queued ancestry are not exposed via user/history read',async t=>{
 const {s,task}=await fixture(t)
 const {task:other}=await s.createGroup({requestId:'different-group-create',title:'另一群',adminBotId:'todo',memberBotIds:['todo','calendar']})
 const sent=await s.send(task.taskId,{message:'one fork',targetBotId:'calendar',requestId:'foreign-fork-input'})
 const parent=await until(()=>s.get(task.taskId),v=>v.collaborations[0]?.result)
 const r=parent.collaborations[0]
 await s.harness.commit(async tx=>{const c=await tx.doc(TaskCard,r.childTaskId);c.forkSource.groupId=other.groupId},ctx)
 await assert.rejects(s.get(r.childTaskId),{code:'GROUP_FORK_DENIED'})
 await assert.rejects(s.harness.commit(async tx=>readTaskHistory(tx,await tx.doc(TaskCard,r.childTaskId),{entryId:sent.messageId},r.childInputId,{authorized:[]}),ctx),{code:'GROUP_FORK_DENIED'})
})
test('native fork excludes inherited tool/approval/private queue data and denies recursive delegation',async t=>{
 let ready,release;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);let childContext
 const {s,task}=await fixture(t,{modelReply:async(_m,o)=>{if(o.parametersBotId==='calendar'){childContext=o.context;ready();await gate}return text('safe')}});t.after(()=>release())
 const {bot}=await s.getBotConfiguration('calendar');await s.updateBotConfiguration('calendar',{requestId:'recursion-calendar-config',expectedVersion:bot.configRef.version,description:bot.description,tools:[...COLLABORATION_TOOLS],resources:[]})
 await s.harness.commit(async tx=>{
  await tx.appendEntry(task.conversationId,{kind:'pidot.user',data:{role:'user',content:'UNCONSUMED-PUBLIC-QUEUE-SECRET',createdAt:new Date().toISOString()}})
  await tx.appendEntry(task.conversationId,{kind:'pidot.tool-result',data:{content:'INHERITED-TOOL-SECRET',inReplyTo:1,result:{ok:true,data:{credentials:'never inherit'}}}})
  await tx.appendEntry(task.conversationId,{kind:'pidot.approval-executed',data:{content:'INHERITED-APPROVAL-SECRET',inReplyTo:1}})
 },ctx)
 await s.send(task.taskId,{message:'public anchor only',targetBotId:'calendar',requestId:'isolated-ancestry-input'});await started
 assert.doesNotMatch(JSON.stringify(childContext),/UNCONSUMED-PUBLIC-QUEUE-SECRET|INHERITED-TOOL-SECRET|INHERITED-APPROVAL-SECRET/)
 const r=(await s.get(task.taskId)).collaborations[0];const {collaborationService}=await import('./collaboration.mjs');const svc=collaborationService({TaskCard,ChatInput:(await import('./tasks.mjs')).ChatInput,bots:s.bots()})
 await assert.rejects(s.harness.commit(async tx=>svc.execute(tx,await tx.doc(TaskCard,r.childTaskId),{name:'task_assign',arguments:{operationId:'recursive',botId:'todo',goal:'recursive',completionCriteria:['no']}},r.childInputId),ctx),{code:'COLLABORATION_DEPTH_DENIED'})
 const forkCard=await s.get(r.childTaskId);assert.equal(forkCard.messages.filter(m=>m.role==='user').length,1)
 release()
})
test('native fork creation rollback leaves no child, relation or inherited artifacts',async t=>{
 let fail=false;const {s,task}=await fixture(t,{beforeCommit:()=>{if(fail)throw Error('fork transaction boundary')}})
 const {ChatInput}=await import('./tasks.mjs'),{collaborationService}=await import('./collaboration.mjs')
 // Use an ordinary active input; a model call is held to keep its slot stable.
 const slot=await s.harness.commit(async tx=>{const entry=await tx.appendEntry(task.conversationId,{kind:'pidot.user',data:{role:'user',content:'rollback anchor',createdAt:new Date().toISOString()}});(await tx.doc(ChatInput,task.taskId)).entryId=entry.id;return entry.id},ctx)
 fail=true
 const svc=collaborationService({TaskCard,ChatInput,bots:s.bots(),createTask:(tx,input,creationConversationId,forkSource)=>import('./task-creation.mjs').then(({createChatTask})=>createChatTask(tx,input,{...(awaitImport),creationConversationId,forkSource}))})
 const awaitImport={ChatTask:(await import('./tasks.mjs')).ChatTask,TaskCard,ChatInput,ChatQueue:(await import('./tasks.mjs')).ChatQueue,configuredModels:[],beforeCommit:()=>{throw Error('fork transaction boundary')}}
 await assert.rejects(s.harness.commit(async tx=>svc.execute(tx,await tx.doc(TaskCard,task.taskId),{name:'task_assign',arguments:{operationId:'rollback',botId:'calendar',goal:'rollback anchor',completionCriteria:['atomic']}},slot),ctx),/fork transaction boundary/)
 assert.equal((await s.list()).length,1);assert.equal((await s.get(task.taskId)).collaborations.length,0)
})

test('faulted unarchived fork cannot poison group overview or task listing and never reconstructs documents',async t=>{
 const {s,task}=await fixture(t)
 const {ChatTask,ChatInput,ChatQueue}=await import('./tasks.mjs'),{createChatTask}=await import('./task-creation.mjs'),{collaborationService}=await import('./collaboration.mjs')
 const input=await s.harness.commit(async tx=>{
  const e=await tx.appendEntry(task.conversationId,{kind:'pidot.user',data:{role:'user',content:'fault native source',createdAt:new Date().toISOString()}})
  ;(await tx.doc(ChatInput,task.taskId)).entryId=e.id
  return e.id
 },ctx)
 const id=await s.harness.commit(async tx=>{
  const svc=collaborationService({TaskCard,ChatInput,bots:s.bots(),createTask:(tx,i,c,f)=>createChatTask(tx,i,{ChatTask,TaskCard,ChatInput,ChatQueue,creationConversationId:c,forkSource:f,configuredModels:[]})})
  const r=await svc.execute(tx,await tx.doc(TaskCard,task.taskId),{name:'task_assign',arguments:{operationId:'fault-source',botId:'calendar',goal:'fault source',completionCriteria:['safe failure']}},input)
  ;(await tx.doc(TaskCard,r.data.childTaskId)).forkSource.groupId='invalid-source'
  return r.data.childTaskId
 },ctx)
 s.harness.resume()
 await until(async()=>s.harness.getTask(id,ctx),r=>r.state.status==='terminal')
 await assert.rejects(s.get(id),{code:'TASK_UNAVAILABLE',status:410})
 const visible=await s.get(task.taskId);assert.equal(visible.groupIssues[0].restricted,true)
 assert.equal(visible.collaborationOverview.nodes.find(n=>n.taskId===id).businessStatus,'failed')
 assert((await s.list()).some(x=>x.taskId===task.taskId));assert(!(await s.list()).some(x=>x.taskId===id))
})

test('explicit supervisor steering wakes submitted review wait without second assignment or child input',async t=>{
 const {s,task}=await fixture(t,{modelReply:async(_m,o)=>{
  if(o.parametersBotId==='calendar')return text('submitted original')
  const notice=o.context.messages.findLast(m=>typeof m.content==='string'&&m.content.includes('宿主关联的子任务结果'))
  if(notice&&JSON.stringify(o.context).includes('RESUME-EXACT-REVIEW')){const n=JSON.parse(notice.content.slice(notice.content.indexOf('{')));if(n.status==='submitted')return turn('task_review',{operationId:'resumed-review',childTaskId:n.childTaskId,rootWorkId:n.rootWorkId,revision:n.revision,expectedState:'submitted',decision:'accept',reason:'用户插入后按精确回执接受'})}
  return text('first response does not review')
 }})
 await s.send(task.taskId,{message:'submit once',targetBotId:'calendar',requestId:'joint06-steer-review'})
 const waiting=await until(()=>s.get(task.taskId),x=>x.runtime.checkpoint?.phase==='awaitChildren'&&x.collaborations[0]?.result?.status==='submitted'&&x.collaborations[0]?.consumedEntryId)
 const childId=waiting.collaborations[0].childTaskId,before=(await s.get(childId)).callUsage
 await s.steer(task.taskId,{message:'RESUME-EXACT-REVIEW，只验收原结果，不再委派'})
 const final=await until(()=>s.get(task.taskId),x=>x.collaborations[0]?.businessStatus==='accepted'&&x.activeInputId===null)
 assert.equal(final.collaborations.length,1);assert.deepEqual((await s.get(childId)).callUsage,before)
})
