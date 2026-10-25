import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { GroupDirectory } from './groups.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createApiServer } from './app.mjs'
const input = { requestId:'group-test-001', title:'日程与待办群', adminBotId:'todo', memberBotIds:['calendar','todo'] }
async function fixture(t, options={}) {
 const dir=await mkdtemp(join(tmpdir(),'pidot-groups-')), file=join(dir,'isolated.sqlite')
 const store=await openTaskStore({file,...options});t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})});return {store,file}
}
async function until(fn,predicate){for(let i=0;i<400;i++){const r=await fn();if(predicate(r))return r;await new Promise(r=>setTimeout(r,15))}throw Error('Timed out')}
test('group creation is atomic/idempotent; immutable members, non-Chief and private isolation',async t=>{
 const {store}=await fixture(t)
 const [a,b]=await Promise.all([store.createGroup(input),store.createGroup(input)])
 assert.equal(a.group.groupId,b.group.groupId);assert.equal((await store.listGroups()).length,1)
 assert.equal(a.task.kind,'group');assert.equal(a.task.bot.id,'todo');assert.deepEqual(a.task.managementTools,[])
 assert.ok(a.task.toolSets.authorized.includes('report_blocker'));assert.equal(a.task.group.members.length,2)
 await assert.rejects(store.createGroup({...input,title:'different'}),{code:'GROUP_REQUEST_CONFLICT'})
 for(const value of [{memberBotIds:['todo']},{memberBotIds:['todo','todo']},{adminBotId:'chief'},{memberBotIds:['todo','absent']},{initiatingUser:'another'}]) await assert.rejects(store.createGroup({...input,requestId:crypto.randomUUID(),...value}))
 assert.equal((await store.list()).length,1)
 await assert.rejects(store.assertBotTask('todo',a.task.taskId),{code:'TASK_NOT_FOUND'})
 assert.deepEqual(await store.list('todo'),[])
 const privateTask=await store.create({botId:'todo'})
 assert.notEqual(privateTask.conversationId,a.task.conversationId);assert.equal(privateTask.kind,'chat')
 const accepted=await store.send(a.task.taskId,'请整理今天的事项')
 const done=await until(()=>store.get(a.task.taskId),v=>v.messages.some(m=>m.inReplyTo===accepted.messageId&&m.role==='assistant'))
 assert.equal(done.bot.id,'todo');assert.equal((await store.get(privateTask.taskId)).messages.length,0)
 await assert.rejects(store.send(a.task.taskId,'@calendar 整理'),{code:'GROUP_MENTION_UNSUPPORTED'})
 await assert.rejects(store.send(a.task.taskId,'请 @calendar 整理'),{code:'GROUP_MENTION_UNSUPPORTED'})
 await store.send(a.task.taskId,'邮箱 a@example.com，引用 `@calendar` 不作为执行目标\n> @calendar 引用\n```\n@calendar code\n```')
})
test('group HTTP authentication, wrong bindings, structured mentions and fixed membership',async t=>{
 const {store}=await fixture(t);const token='group-fixture-token-not-for-production';const server=createApiServer({token,tasks:store});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
 const base=`http://127.0.0.1:${server.address().port}`, req=(path,method='GET',body)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
 assert.equal((await fetch(base+'/api/groups')).status,401)
 let res=await req('/api/groups','POST',input);assert.equal(res.status,201);const {group,task}=await res.json()
 assert.equal((await req('/api/groups','POST',input)).status,200)
 assert.equal((await req(`/api/groups/${group.groupId}`)).status,200)
 assert.equal((await req(`/api/bots/todo/tasks/${task.taskId}`)).status,404)
 assert.equal((await req(`/api/groups/${crypto.randomUUID()}`)).status,404)
 assert.equal((await req(`/api/groups/${group.groupId}/members`,'PATCH',{})).status,404)
 res=await req(`/api/groups/${group.groupId}/messages`,'POST',{message:'hello',targetBotId:'calendar'});assert.equal(res.status,400);assert.equal((await res.json()).error.code,'INVALID_GROUP_TARGET')
 await store.harness.commit(async tx=>{(await tx.doc(GroupDirectory)).items[0].initiatingUser='other-user'},context)
 assert.equal((await req(`/api/groups/${group.groupId}`)).status,404)
 assert.equal((await req(`/api/tasks/${task.taskId}/messages`,'POST',{message:'hello'})).status,404)
})
test('group create rollback leaves no task and retry succeeds',async t=>{
 let fail=true; const {store}=await fixture(t,{beforeCommit:()=>{if(fail)throw Error('creation boundary')}})
 await assert.rejects(store.createGroup(input));assert.equal((await store.list()).length,0)
 fail=false;assert.equal((await store.createGroup(input)).created,true)
})
test('persisted group creation and first input reopen without duplicate identity or reply',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pidot-group-reopen-'));const file=join(dir,'isolated.sqlite');let store=await openTaskStore({file})
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
 const first=await store.createGroup(input);await store.close();store=await openTaskStore({file})
 assert.equal((await store.createGroup(input)).group.taskId,first.group.taskId)
 const accepted=await store.send(first.group.taskId,'保持群身份')
 await until(()=>store.get(first.group.taskId),v=>v.messages.some(m=>m.inReplyTo===accepted.messageId&&m.role==='assistant'))
 await store.close();store=await openTaskStore({file});const done=await store.getGroup(first.group.groupId)
 assert.equal(done.messages.filter(m=>m.inReplyTo===accepted.messageId&&m.role==='assistant').length,1)
 assert.equal(done.conversationId,first.group.conversationId)
 await store.deactivateBot('todo',{confirm:true});await assert.rejects(store.send(done.taskId,'no'),{code:'BOT_INACTIVE'})
 await assert.rejects(store.createGroup({...input,requestId:'new-group-after-disable'}),{code:'BOT_INACTIVE'})
 assert.equal((await store.getGroup(first.group.groupId)).group.members.find(b=>b.id==='todo').status,'inactive')
})

test('group FIFO, explicit steering, budget and cancellation retain existing controls',async t=>{
 const {listBots}=await import('./bots.mjs')
 const {store}=await fixture(t,{bots:listBots({baseUrl:'https://fixture.invalid/v1',model:'group-fixture',apiKey:'fixture-only'}),modelReply:async()=>({mode:'model',reply:{content:'group fixture response'},execution:{usage:{totalTokens:3}}})})
 const {task}=await store.createGroup({...input,parameters:{callLimits:{modelCalls:0,toolCalls:0}}})
 const e=await store.send(task.taskId,'budget first')
 await until(()=>store.get(task.taskId),v=>v.waiting?.kind==='limits')
 const q=await store.send(task.taskId,'queued second');assert.equal(q.status,'queued')
 await assert.rejects(store.steer(task.taskId,{message:'@calendar hidden dispatch'}),{code:'GROUP_MENTION_UNSUPPORTED'})
 await store.steer(task.taskId,{message:'only organize, no external writes'})
 let state=await store.get(task.taskId);assert.equal(state.pendingSteerIds.length,1);assert.deepEqual(state.queuedInputIds,[q.messageId])
 await store.raiseLimits(task.taskId,{modelCalls:5,toolCalls:0})
 state=await until(()=>store.get(task.taskId),v=>v.activeInputId===null&&v.queueLength===0&&v.messages.filter(m=>m.role==='assistant').length===2)
 assert.equal(state.messages.find(m=>m.inReplyTo===e.messageId&&m.role==='assistant').deliveryStatus,undefined)
 assert.equal(state.callUsage.modelCalls,2);assert.equal(state.messageControl.appliedSteerIds.length,1)
 await store.cancel(task.taskId,{});await assert.rejects(store.send(task.taskId,'not revived'),{code:'TASK_CANCELLED'})
 assert.equal((await store.get(task.taskId)).kind,'group')
})

test('group member status never grants calendar tools; revocation protects existing group snapshots',async t=>{
 const {openTaskStore:authorized}=await import('./fixtures/authorized-task-store.mjs')
 const {CALENDAR_TOOL}=await import('./tools.mjs')
 const dir=await mkdtemp(join(tmpdir(),'pidot-group-revoke-'));const file=join(dir,'isolated.sqlite')
 const store=await authorized({file});t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
 const {task}=await store.createGroup({...input,adminBotId:'calendar'})
 assert.ok(task.toolSets.authorized.includes(CALENDAR_TOOL))
 await store.revokeTool('calendar',CALENDAR_TOOL)
 const state=await store.get(task.taskId);assert.ok(!state.toolSets.authorized.includes(CALENDAR_TOOL));assert.ok(state.parameters.tools.includes(CALENDAR_TOOL))
 await store.deactivateBot('todo',{confirm:true})
 assert.equal((await store.get(task.taskId)).group.members.find(b=>b.id==='todo').status,'inactive')
 await store.send(task.taskId,'admin still active')
 await until(()=>store.get(task.taskId),v=>v.activeInputId===null&&v.messages.some(m=>m.role==='assistant'))
})

test('group membership/binding tamper fails every history/control alias and private groups stay separate',async t=>{
 const {store}=await fixture(t);const {TaskCard}=await import('./tasks.mjs')
 const {task,group}=await store.createGroup(input), other=await store.createGroup({...input,requestId:'another-group-key',title:'另一个群'})
 const privateTask=await store.create({botId:'todo'})
 assert.notEqual(group.groupId,other.group.groupId)
 const token='group-alias-fixture',server=createApiServer({token,tasks:store});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
 const req=(path,method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
 assert.equal((await req(`/api/groups/${privateTask.taskId}`)).status,404)
 await store.harness.commit(async tx=>{(await tx.doc(TaskCard,task.taskId)).groupId=other.group.groupId},context)
 for(const [suffix,method,body] of [['','GET'],['/messages','POST',{message:'bad'}],['/steer','POST',{message:'bad'}],['/cancel','POST',{confirm:true}],['/skills','POST',{skillId:'bad'}],['/configuration-migration','GET']]) {
  assert.equal((await req(`/api/tasks/${task.taskId}${suffix}`,method,body)).status,404)
 }
 assert.equal((await req(`/api/groups/${group.groupId}`)).status,404)
 assert.equal((await req(`/api/groups/${other.group.groupId}`)).status,200)
})


test('group non-Chief does not inherit Chief permissions or permit legacy group delegation',async t=>{
 const {store}=await fixture(t)
 const {task}=await store.createGroup(input)
 const {TaskCard,ChatInput}=await import('./tasks.mjs'),{collaborationService}=await import('./collaboration.mjs')
 const {COLLABORATION_TOOLS}=await import('./collaboration-tools.mjs')
 const {group:chiefGroup,task:chiefTask}=await store.createGroup({...input,requestId:'chief-admin-group',adminBotId:'chief',memberBotIds:['chief','todo']})
 assert.ok(chiefTask.managementTools.length>0);assert.equal(chiefGroup.adminBotId,'chief');assert.deepEqual(task.managementTools,[])
 const privateTask=await store.create({botId:'todo'})
 await store.harness.commit(async tx=>{const card=await tx.doc(TaskCard,privateTask.taskId);delete card.kind;delete card.groupId},context)
 assert.equal((await store.get(privateTask.taskId)).bot.id,'todo')
 await store.send(privateTask.taskId,'legacy no group fields')
 await until(()=>store.get(privateTask.taskId),v=>v.activeInputId===null&&v.messages.some(m=>m.role==='assistant'))
 await store.updateCapabilityPool({requestId:'group-delegate-consent',operation:'grant',tools:COLLABORATION_TOOLS,resources:[]})
 const {bot}=await store.getBotConfiguration('todo')
 await store.updateBotConfiguration('todo',{requestId:'group-delegate-config',expectedVersion:bot.configRef.version,description:bot.description,tools:COLLABORATION_TOOLS,resources:[]})
 const {task:granted}=await store.createGroup({...input,requestId:'delegate-granted-group'})
 // Authorization comes first: with or without grants the old private delegation cannot run in a group.
 await assert.rejects(store.harness.commit(async tx=>collaborationService({TaskCard,ChatInput,bots:store.bots()}).execute(tx,await tx.doc(TaskCard,granted.taskId),{name:'task_assign',arguments:{}},1),context),e=>['TOOL_INVALID_ARGUMENTS','COLLABORATION_NOT_AUTHORIZED'].includes(e.code))
})
