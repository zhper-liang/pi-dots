import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {once} from 'node:events'
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context'
import {openTaskStore,TaskCard} from './tasks.mjs'
import {createApiServer} from './app.mjs'
import {listBots} from './bots.mjs'
import {issueConfig,configureIssues,issueModel} from './fixtures/group-issues-model.mjs'
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
export async function until(fn,p){for(let i=0;i<900;i++){const v=await fn();if(p(v))return v;await new Promise(r=>setTimeout(r,10))}throw Error('group controls timeout')}
async function fixture(t,modelReply=issueModel){
 const dir=await mkdtemp(join(tmpdir(),'pidot-group-controls-')),file=join(dir,'test.sqlite');let s
 const open=async()=>s=await openTaskStore({file,bots:listBots(issueConfig),modelReply})
 await open();await configureIssues(s)
 t.after(async()=>{await s.close();await rm(dir,{recursive:true,force:true})})
 const {task:p}=await s.createGroup({requestId:'controls05-group',title:'连续工作群',adminBotId:'todo',memberBotIds:['todo','calendar','chief']})
 return {get s(){return s},p,async reopen(){await s.close();return open()}}
}
async function waiting(s,p,id='controls05-input'){
 await s.send(p.taskId,{message:'模拟控制工作',targetBotId:'calendar',requestId:id})
 return until(()=>s.get(p.taskId),p=>p.groupIssues[0]?.blockers.items.some(b=>b.assignee==='user'))
}
test('group current root without child can stop idempotently; FIFO next work and other group survive',async t=>{
 const f=await fixture(t,async(m,o)=>{if(m==='hold')await new Promise(resolve=>o.signal.addEventListener('abort',resolve,{once:true}));return text('普通回报:'+m)})
 const {s,p}=f,{task:other}=await s.createGroup({requestId:'controls05-other',title:'另一个群',adminBotId:'todo',memberBotIds:['todo','calendar']})
 const a=await s.send(p.taskId,'hold');await until(()=>s.get(p.taskId),p=>p.callUsage.modelCalls===1)
 await assert.rejects(s.stopWork(other.taskId,{rootWorkId:`${p.taskId}:${a.messageId}`}),{code:'WORK_NOT_FOUND'})
 await s.send(p.taskId,'second');const rootWorkId=`${p.taskId}:${a.messageId}`
 const before=await s.get(p.taskId);assert.equal(before.collaborationOverview.nodes[0].queueLength,1);assert.equal(before.collaborationOverview.activeRootWorkId,rootWorkId)
 await s.stopWork(p.taskId,{rootWorkId});await s.stopWork(p.taskId,{rootWorkId})
 const done=await until(()=>s.get(p.taskId),p=>p.activeInputId===null&&p.messages.some(m=>m.content==='普通回报:second'))
 assert.equal(done.cancellation,null);assert.equal(done.collaborationOverview.stops.length,1);assert.equal(done.callUsage.modelCalls,2);assert.equal((await s.get(other.taskId)).cancellation,null)
 const next=await f.reopen();assert.deepEqual((await next.get(p.taskId)).callUsage,done.callUsage);assert.equal((await next.get(p.taskId)).queueLength,0)
})
test('group root stop retains historical accepted child, cancels only current work and never revives across restart',async t=>{
 const f=await fixture(t);const {s,p}=f
 // First round accepted using the already tested original issue flow.
 let v=await waiting(s,p),c=v.groupIssues[0],b=c.blockers.items.find(b=>b.assignee==='user')
 await s.resolveBlocker(c.taskId,b.id,{answer:'下午',version:b.version,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo})
 v=await until(()=>s.get(p.taskId),p=>p.groupIssues[0].approvals.activeId)
 await s.decideApproval(c.taskId,v.groupIssues[0].approvals.activeId,{decision:'approved'})
 v=await until(()=>s.get(p.taskId),p=>p.activeInputId===null&&p.collaborations[0].businessStatus==='accepted')
 const accepted=structuredClone(v.collaborations[0]);const childBefore=await s.get(c.taskId)
 await s.send(p.taskId,{message:'第二轮独立工作',targetBotId:'calendar',requestId:'controls05-second'})
 v=await until(()=>s.get(p.taskId),p=>p.groupIssues.length===2&&p.groupIssues[1].blockers.activeId)
 const r=v.collaborations[1];await s.send(p.taskId,'停止后第三轮普通群消息')
 await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId})
 v=await until(()=>s.get(p.taskId),p=>p.activeInputId===null&&p.collaborations[1].businessStatus==='cancelled')
 assert.deepEqual(v.collaborations[0],accepted);assert.equal((await s.get(c.taskId)).runtime.status,'running');assert.deepEqual((await s.get(c.taskId)).callUsage,childBefore.callUsage)
 assert.equal(v.cancellation,null);assert.equal(v.queueLength,0)
 const sum=v.collaborationOverview.nodes.reduce((a,n)=>a+n.usage.modelCalls,0);assert.equal(v.collaborationOverview.totals.modelCalls,sum)
 const next=await f.reopen(),after=await next.get(p.taskId);assert.deepEqual(after.collaborations,v.collaborations);assert.deepEqual(after.collaborationOverview.totals,v.collaborationOverview.totals)
})
test('group-qualified single-child cancellation and limits bind membership, auth and original task only',async t=>{
 const {s,p}=await fixture(t);const v=await waiting(s,p),c=v.groupIssues[0]
 const server=createApiServer({token:'controls05-test',tasks:s});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))})
 const base=`http://127.0.0.1:${server.address().port}`,req=(path,method='POST',body={},auth=true)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer controls05-test'}:{})},body:JSON.stringify(body)})
 const path=`/api/groups/${p.groupId}/children/${c.taskId}`
 assert.equal((await req(path+'/cancel','POST',{},false)).status,401)
 const {task:other}=await s.createGroup({requestId:'controls05-foreign',title:'另群',adminBotId:'todo',memberBotIds:['todo','calendar']})
 assert.equal((await req(`/api/groups/${other.groupId}/children/${c.taskId}/cancel`)).status,404)
 assert.equal((await req(path+'/limits','PATCH',{modelCalls:50,toolCalls:50})).status,409) // busy original issue cannot be bypassed by raising limits
 assert.equal((await req(path+'/cancel')).status,200);assert.equal((await req(path+'/cancel')).status,200)
 const done=await until(()=>s.get(p.taskId),p=>p.activeInputId===null&&p.collaborations[0].businessStatus==='cancelled')
 assert.equal(done.cancellation,null);assert.equal(done.collaborations.length,1);assert.notEqual(done.collaborations[0].businessStatus,'accepted')
 assert.ok(done.collaborationOverview.nodes.find(n=>n.taskId===c.taskId).cancelled)
 await s.send(p.taskId,'继续同群普通消息');await until(()=>s.get(p.taskId),p=>p.activeInputId===null)
})
test('group admin and executor inactivity block dispatch and restore without replacement; revoked budget never broadens permission',async t=>{
 for(const botId of ['todo','calendar']){
  const {s,p}=await fixture(t);const v=await waiting(s,p),r=v.collaborations[0];await s.deactivateBot(botId,{confirm:true})
  const after=await s.get(p.taskId);assert.ok(after.collaborationOverview.nodes.some(n=>n.botId===botId&&n.botStatus==='inactive'))
  const c=after.groupIssues[0],b=c.blockers.items.find(b=>b.assignee==='user')
  await assert.rejects(s.resolveBlocker(c.taskId,b.id,{answer:'迟到回答',version:b.version,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo}),{code:'BOT_INACTIVE'})
  assert.equal(after.collaborations.length,1);assert.equal(after.collaborations[0].childTaskId,r.childTaskId)
 }
 const {s,p}=await fixture(t);let v=await waiting(s,p);const child=v.groupIssues[0]
 await s.revokeTool('calendar','calendar_read_schedule');await assert.rejects(s.raiseLimits(child.taskId,{modelCalls:99,toolCalls:99}),{code:'TASK_BUSY'})
 v=await s.get(p.taskId);assert.equal(v.collaborationOverview.nodes.find(n=>n.taskId===child.taskId).permissionRevoked,true)
 await s.stopWork(p.taskId,{rootWorkId:v.collaborations[0].rootWorkId})
 await s.updateToolAccess('calendar',{revoked:[]})
 assert.equal((await until(()=>s.get(p.taskId),p=>p.collaborations[0].businessStatus==='cancelled')).collaborations[0].businessStatus,'cancelled')
})
test('group overview hides revoked shared issue bodies just like groupIssues projection',async t=>{
 const {s,p}=await fixture(t);const v=await waiting(s,p),child=v.groupIssues[0]
 const {GroupResultSources}=await import('./group-result-provenance.mjs')
 await s.harness.commit(async tx=>{const c=await tx.doc(TaskCard,child.taskId);(await tx.doc(GroupResultSources,child.taskId)).inputs[c.collaboration.childInputId]=[{recordId:'revoked-controls-source',version:1,accessVersion:1}]},context)
 const after=await s.get(p.taskId);assert.deepEqual(after.collaborationOverview.nodes.find(n=>n.taskId===child.taskId).pending,[])
 assert.doesNotMatch(JSON.stringify(after.collaborationOverview),/模拟用户偏好问题/)
})

test('group one child stop leaves sibling and unrelated group live; no accepted receipt fabricated',async t=>{
 let n=0
 const turn=(name,args)=>{const c={type:'toolCall',id:`siblings-${++n}`,name,arguments:args};return {...text(''),toolCalls:[c],assistant:{role:'assistant',content:[c],api:'openai-completions',provider:'fixture',model:issueConfig.model,stopReason:'toolUse',timestamp:Date.now()}}}
 const {s,p}=await fixture(t,async(m,o)=>{
  if(o.parametersBotId!=='todo')return turn('report_blocker',{question:'等待独立资料',requiredInformation:'资料',assignee:'user'})
  const receipts=o.context.messages.filter(m=>m.role==='toolResult'&&m.toolName==='task_assign')
  if(receipts.length<2)return turn('task_assign',{operationId:'sibling-'+receipts.length,botId:receipts.length?'chief':'calendar',goal:'独立等待资料',completionCriteria:['明确来源']})
  return text('主管如实保留未完成事项，不冒称成功')
 })
 // Give chief the same existing blocker capability, never grant management to another Bot.
 const {bot}=await s.getBotConfiguration('chief');await s.updateBotConfiguration('chief',{requestId:'controls05-chief',expectedVersion:bot.configRef.version,description:bot.description,tools:['report_blocker'],resources:[]})
 await s.send(p.taskId,'自主安排两个群成员子任务')
 let v=await until(()=>s.get(p.taskId),p=>p.groupIssues.length===2&&p.groupIssues.every(c=>c.blockers.activeId))
 const [a,b]=v.collaborations;await s.cancel(a.childTaskId,{})
 v=await until(()=>s.get(p.taskId),p=>p.collaborations[0].businessStatus==='cancelled')
 assert.equal(v.collaborations[1].businessStatus,'pending');assert.equal((await s.get(b.childTaskId)).cancellation,null);assert.equal((await s.get(b.childTaskId)).blockers.items[0].status,'pending')
 assert.equal(v.cancellation,null);assert.ok(v.collaborationOverview.events.some(e=>e.kind==='task-cancelled'&&e.taskId===a.childTaskId))
 await s.stopWork(p.taskId,{rootWorkId:a.rootWorkId});await until(()=>s.get(p.taskId),p=>p.activeInputId===null)
})

test('group original limited child raises exact same budget via scoped route without resetting usage or duplicating fork',async t=>{
 let calls=0
 const turn=(name,args)=>{const c={type:'toolCall',id:'budget-'+(++calls),name,arguments:args};return {...text(''),toolCalls:[c],assistant:{role:'assistant',content:[c],api:'openai-completions',provider:'fixture',model:issueConfig.model,stopReason:'toolUse',timestamp:Date.now()}}}
 const {s,p}=await fixture(t,async(_m,o)=>{
  if(o.parametersBotId==='calendar')return o.context.messages.some(m=>m.role==='toolResult')?text('提额后模拟资料结果'):turn('calendar_read_schedule',{resource:'mock:personal',date:'2026-10-19'})
  const found=o.context.messages.findLast(m=>typeof m.content==='string'&&m.content.includes('宿主关联的子任务结果'))
  if(found&&!o.context.messages.some(m=>m.role==='toolResult'&&m.toolName==='task_review')){const r=JSON.parse(found.content.slice(found.content.indexOf('{')));return turn('task_review',{operationId:'budget-accept',childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,revision:r.revision,expectedState:'submitted',decision:'accept',reason:'模拟资料满足原目标'})}
  return text('主管已收取原子任务')
 })
 const {bot}=await s.getBotConfiguration('calendar');await s.updateBotConfiguration('calendar',{requestId:'controls05-limited',expectedVersion:bot.configRef.version,description:bot.description,tools:bot.defaults.tools,resources:bot.defaults.toolResources,parameters:{callLimits:{modelCalls:1,toolCalls:10}}})
 await s.send(p.taskId,{message:'读取模拟资料',targetBotId:'calendar',requestId:'controls05-limits-input'})
 let v=await until(()=>s.get(p.taskId),p=>p.collaborationOverview.nodes.some(n=>n.role==='executor'&&n.runtime.checkpoint?.lastOutcome==='limited'))
 const child=v.collaborations[0].childTaskId,before=await s.get(child)
 const server=createApiServer({token:'budget05',tasks:s});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))})
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/groups/${p.groupId}/children/${child}/limits`,{method:'PATCH',headers:{Authorization:'Bearer budget05','Content-Type':'application/json'},body:JSON.stringify({modelCalls:4})});assert.equal(response.status,200)
 v=await until(()=>s.get(p.taskId),p=>p.activeInputId===null&&p.collaborations[0].businessStatus==='accepted')
 assert.equal(v.collaborations.length,1);assert.equal((await s.get(child)).conversationId,before.conversationId);assert.equal((await s.get(child)).callUsage.modelCalls,2);assert.ok(v.collaborationOverview.totals.totalTokens>=before.callUsage.totalTokens)
})

test('group stopped late child receipt remains actual usage, not success, not redispatch or next-root input',async t=>{
 let release,entered,childSignal;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r)
 const {s,p}=await fixture(t,async(m,o)=>{if(o.parametersBotId==='calendar'){childSignal=o.signal;entered();await hold;return text('实际迟到子结果，模拟来源')}return text('后续新工作独立回复')})
 await s.send(p.taskId,{message:'迟到回执工作',targetBotId:'calendar',requestId:'controls05-late'})
 await ready;const v=await s.get(p.taskId),r=v.collaborations[0]
 await s.send(p.taskId,'独立后续输入');await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});assert.equal(childSignal.aborted,true);release()
 const done=await until(()=>s.get(p.taskId),p=>p.activeInputId===null&&p.queueLength===0&&p.collaborations[0].businessStatus==='cancelled')
 const child=await s.get(r.childTaskId);assert.equal(child.callUsage.modelCalls,1);assert.equal(child.callUsage.unknownTokenCalls,0);assert.ok(child.messages.some(m=>m.content==='实际迟到子结果，模拟来源'))
 assert.equal(done.collaborations.length,1);assert.equal(done.collaborations[0].consumedEntryId,null);assert.equal(done.collaborations[0].acceptedRevision,undefined);assert.equal(done.cancellation,null)
 assert.equal(done.messages.filter(m=>m.content==='后续新工作独立回复').length,1)
})
