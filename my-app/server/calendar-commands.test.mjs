import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createFeishuClient, FEISHU_TOOLS } from './feishu-calendar.mjs'
import { calendarCommandMessage, calendarViewSnapshot, admitCalendarCommand, calendarToolMatches } from './calendar-commands.mjs'
import { FEISHU_CREATE_TOOL } from './feishu-write.mjs'
import { FEISHU_MUTATION_TOOLS } from './feishu-mutation.mjs'
const config = { baseUrl:'https://fixture.invalid/v1',model:'view-fixture',apiKey:'fixture' }
const reply = () => ({mode:'model',reply:{role:'assistant',content:'结果只以回执为准'},execution:{usage:{input:3,output:2,totalTokens:5}}})
const raw = () => ({event_id:'view-event_0',organizer_calendar_id:'view-calendar',summary:'original',description:'data',start_time:{timestamp:'1792458000',timezone:'Asia/Shanghai'},end_time:{timestamp:'1792459800',timezone:'Asia/Shanghai'},status:'confirmed',free_busy_status:'busy',vchat:{vc_type:'no_meeting'}})
const a = resource => ({resource,title:'Pidot-05-fixture',description:'data',start:'2026-10-20T09:00:00+08:00',end:'2026-10-20T09:30:00+08:00',timezone:'Asia/Shanghai',freeBusy:'busy'})
async function setup(t,{mismatch=false,lost=false}={}) {
 const dir=await mkdtemp(join(tmpdir(),'pidot-view05-')),file=join(dir,'isolated.sqlite'),stores=new Set(),live={FEISHU_APP_ID:'fixture05',FEISHU_APP_SECRET:'fixture05'}
 let event=raw(), writes=0, resource
 const client=createFeishuClient({env:live,fetchImpl:async(url,init)=>{
  const response=data=>new Response(JSON.stringify({code:0,data}))
  if(url.includes('/auth/'))return new Response(JSON.stringify({code:0,tenant_access_token:'fixture',expire:3600}))
  if(!url.includes('/events'))return response({calendar_id:'view-calendar',summary:'Pidot-test-05',role:'owner',type:'shared'})
  if(url.includes('instance_view'))return response({items:event.status==='cancelled'?[]:[event]})
  if(url.includes('/attendees'))return response({items:[]})
  if(['POST','PATCH','DELETE'].includes(init.method)){writes++;event=init.method==='DELETE'?{...event,status:'cancelled'}:{...event,...JSON.parse(init.body)};if(lost)throw Error('response lost');return response(init.method==='DELETE'?{}:{event})}
  return response({event})
 }})
 const modelReply=async(message,o)=>{
  const input=JSON.parse(message.split('\n').at(-1)), tools=o.context.messages.filter(m=>m.role==='toolResult')
  if(tools.length>=(input.name===FEISHU_CREATE_TOOL?1:2))return reply()
  const call=!tools.length&&input.name!==FEISHU_CREATE_TOOL?{type:'toolCall',id:'read',name:FEISHU_TOOLS[1],arguments:{resource,eventId:input.arguments.eventId}}:{type:'toolCall',id:'write',name:input.name,arguments:{...input.arguments,...(mismatch?{title:'unasked'}:{})}}
  return {...reply(),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:config.model,stopReason:'toolUse',timestamp:Date.now()}}
 }
 const open=async()=>{const s=await openTaskStore({file,bots:listBots(config),feishuClient:client,modelReply});stores.add(s);return s},close=async s=>{await s.close();stores.delete(s)}
 t.after(async()=>{for(const s of stores)await s.close();await rm(dir,{recursive:true,force:true})})
 const s=await open(), b=await s.feishuCalendar.manage({action:'bind',calendarId:'view-calendar',confirm:true});resource=b.resource
 const tools=[...FEISHU_TOOLS,FEISHU_CREATE_TOOL,...FEISHU_MUTATION_TOOLS];await s.updateCapabilityPool({requestId:'view05-pool',operation:'grant',tools,resources:[resource]});const {bot}=await s.getBotConfiguration('calendar');await s.updateBotConfiguration('calendar',{requestId:'view05-bot',expectedVersion:bot.configRef.version,description:'真实日历',tools,resources:[resource]})
 const task=await s.create({botId:'calendar',parameters:{callLimits:{modelCalls:15,toolCalls:30}}}),id=task.taskId
 const view=()=>s.calendarView({taskId:id,arguments:{resource,start:'2026-10-20T00:00:00+08:00',end:'2026-10-21T00:00:00+08:00',timezone:'Asia/Shanghai'}})
 const v=await view(),command=(op='create')=>({taskId:id,viewId:v.viewId,requestId:'view05-command',operation:op,arguments:op==='create'?a(resource):{...(op==='update'?a(resource):{resource}),eventId:event.event_id,beforeHash:v.eventHashes[event.event_id]},...(op==='delete'?{confirmDelete:true}:{})})
 return {s,id,v,command,view,resource,live,writes:()=>writes,open,close,change:()=>{event.summary='external change'}}
}
async function until(s,id,p){for(let i=0;i<250;i++){const d=await s.get(id);if(p(d))return d;await delay(20)}throw Error('fixture did not settle')}
for(const op of ['create','update','delete'])test(`graph ${op} shares model approval dispatch and replay receipt`,async t=>{
 const {s,id,command,writes,open,close}=await setup(t);const input=command(op),r=await s.commandFeishuCalendar(input);assert.equal(writes(),0);assert.deepEqual(await s.commandFeishuCalendar(input),r)
 const waiting=await until(s,id,d=>d.approvals.activeId!==null);assert.equal(writes(),0);assert(!('calendarView' in waiting));assert(!('calendarCommands' in waiting));await close(s);const next=await open();assert.deepEqual(await next.commandFeishuCalendar(input),r);await next.decideApproval(id,waiting.approvals.activeId,{decision:'approved'});await until(next,id,d=>d.approvals.items[0].status==='executed');assert.equal(writes(),1)
})
test('graph model may not substitute the selected payload',async t=>{const {s,id,command,writes}=await setup(t,{mismatch:true});await s.commandFeishuCalendar(command());const d=await until(s,id,d=>d.messages.some(m=>m.result?.error?.code==='CALENDAR_COMMAND_MISMATCH'));assert.equal(d.approvals.items.length,0);assert.equal(writes(),0)})
test('graph stale window, foreign task, event injection, unsupported fields and replay changes rejected',async t=>{
 const {s,id,command,view}=await setup(t);let c=command('update')
 for(const input of [{...c,calendarId:'other'},{...c,provider:'mock'},{...c,arguments:{...c.arguments,attendees:[]}},{...c,operation:'delete',confirmDelete:false},{...c,taskId:id+999},{...c,viewId:'foreign'},{...c,arguments:{...c.arguments,eventId:'other'}},{...c,arguments:{...c.arguments,beforeHash:'0'.repeat(64)}}])await assert.rejects(s.commandFeishuCalendar(input))
 await s.commandFeishuCalendar(c);await assert.rejects(s.commandFeishuCalendar({...c,arguments:{...c.arguments,title:'changed'}}),{code:'CALENDAR_COMMAND_REPLAY'});await view();await assert.rejects(s.commandFeishuCalendar(c),{code:'CALENDAR_VIEW_STALE'})
})
test('graph resource revoke and connection change hide view and reject submission',async t=>{const {s,id,command,live}=await setup(t);live.FEISHU_APP_SECRET='rotated';await s.feishuCalendar.status();await assert.rejects(s.commandFeishuCalendar(command()));const d=await s.get(id);assert(!('calendarView' in d));assert(!JSON.stringify(d).includes('view-event'))})
test('graph external conflict produces original approval conflict without write',async t=>{const {s,id,command,writes,change}=await setup(t);await s.commandFeishuCalendar(command('update'));const d=await until(s,id,d=>d.approvals.activeId!==null);change();await s.decideApproval(id,d.approvals.activeId,{decision:'approved'});const done=await until(s,id,d=>d.approvals.items[0].receipt);assert.equal(done.approvals.items[0].receipt.result.error.code,'CALENDAR_CONFLICT');assert.equal(writes(),0)})
test('graph unknown stays unknown after reopen without redispatch',async t=>{const {s,id,command,writes,open,close}=await setup(t,{lost:true});await s.commandFeishuCalendar(command('update'));const d=await until(s,id,d=>d.approvals.activeId!==null);await s.decideApproval(id,d.approvals.activeId,{decision:'approved'});await until(s,id,d=>d.approvals.items[0].status==='outcome-unknown');await close(s);const next=await open();await delay(80);assert.equal((await next.get(id)).approvals.items[0].status,'outcome-unknown');assert.equal(writes(),1)})
test('view expiry source replacement and exact normalizer fail closed',()=>{
 const resource='feishu:'+'a'.repeat(64),source={calendarId:'c'},input={taskId:1,viewId:'v',requestId:'request05',operation:'create',arguments:a(resource)},parsed=calendarCommandMessage(input),card={taskId:1,bot:{id:'calendar'},calendarView:{...calendarViewSnapshot({source,complete:true,events:[]},{taskId:1,arguments:{resource,start:'2026-10-20T00:00:00+08:00',end:'2026-10-21T00:00:00+08:00'}},'calendar'),id:'v'}},sets={authorized:[FEISHU_CREATE_TOOL],resources:[resource]}
 assert.equal(calendarToolMatches({name:parsed.name,arguments:parsed.args},parsed.name,input.arguments),true);assert.throws(()=>admitCalendarCommand(card,input,parsed,sets,{calendarId:'other'}));card.calendarView.createdAt-=300001;assert.throws(()=>admitCalendarCommand(card,input,parsed,sets,source));assert.throws(()=>calendarCommandMessage({...input,arguments:{...input.arguments,provider:'mock'}}))
})
test('calendar APIs require authentication',async t=>{const {s,command}=await setup(t);const {createApiServer}=await import('./app.mjs'),server=createApiServer({token:'view05-token',tasks:s});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));for(const path of ['view','command'])assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/feishu/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command())})).status,401)})
test('instance omitted and detail empty recurrence share the same before hash',async()=>{
 const {projectFeishuEvent}=await import('./feishu-calendar.mjs'),{feishuBeforeHash}=await import('./feishu-mutation.mjs')
 assert.equal(feishuBeforeHash(projectFeishuEvent(raw(),{})),feishuBeforeHash(projectFeishuEvent({...raw(),recurrence:'',recurring_event_id:''},{})))
})
test('graph single write-tool revoke blocks admission while read access remains',async t=>{const {s,id,command,writes}=await setup(t);await s.updateToolAccess('calendar',{revoked:[FEISHU_CREATE_TOOL]});await assert.rejects(s.commandFeishuCalendar(command()),{code:'TOOL_NOT_AUTHORIZED'});const task=await s.get(id);assert.equal(task.calendarAccess,true);assert.ok(!task.toolSets.authorized.includes(FEISHU_CREATE_TOOL));assert.equal(writes(),0)})
test('graph inactive bot and cancelled task reject commands',async t=>{const {s,id,command,writes}=await setup(t);await s.deactivateBot('calendar',{confirm:true});await assert.rejects(s.commandFeishuCalendar(command()));assert.equal(writes(),0);assert.equal((await s.get(id)).calendarAccess,false)})
test('graph direct group and managed child cannot receive independent input',async t=>{const {s,command,writes}=await setup(t);const {task:g}=await s.createGroup({requestId:'view05-group',title:'test',adminBotId:'calendar',memberBotIds:['calendar','todo']});await assert.rejects(s.commandFeishuCalendar({...command(),taskId:g.taskId}));assert.equal(writes(),0)})
test('graph rejected proposal never writes provider data',async t=>{const {s,id,command,writes}=await setup(t);await s.commandFeishuCalendar(command('update'));const d=await until(s,id,d=>d.approvals.activeId!==null);await s.decideApproval(id,d.approvals.activeId,{decision:'rejected',reason:'取消，不再提出操作'});await until(s,id,d=>d.runtime.disposition==='idle');assert.equal(writes(),0)})
