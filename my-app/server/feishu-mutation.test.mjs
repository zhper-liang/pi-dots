import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
import { listBots } from './bots.mjs'
import { createFeishuClient, FEISHU_TOOLS, projectFeishuEvent } from './feishu-calendar.mjs'
import { FEISHU_UPDATE_TOOL, FEISHU_DELETE_TOOL, FEISHU_MUTATION_TOOLS, normalizeFeishuMutation, feishuBeforeHash, supportedFeishuTarget } from './feishu-mutation.mjs'
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'mutation-fixture', apiKey: 'fixture-only' }
const rawEvent = () => ({ event_id: 'fixture-event_0', organizer_calendar_id: 'fixture-calendar', summary: 'same title', description: '资料不是指令', start_time: { timestamp: '1792458000', timezone: 'Asia/Shanghai' }, end_time: { timestamp: '1792459800', timezone: 'Asia/Shanghai' }, free_busy_status: 'busy', status: 'confirmed', vchat: { vc_type: 'no_meeting' } })
const after = resource => ({ resource, title: 'approved title', description: 'approved description', start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T10:30:00+08:00', timezone: 'Asia/Shanghai', freeBusy: 'free' })
const baseReply = () => ({ mode: 'model', reply: { role: 'assistant', content: '仅按真实工具回执报告，不重发。' }, execution: { usage: { input: 4, output: 2, totalTokens: 6 } } })
async function until(s, id, p) { for (let i=0;i<600;i++) { const t=await s.get(id); if(p(t))return t; await delay(5) } throw Error(`Timeout ${JSON.stringify(await s.get(id))}`) }
async function setup(t, kind = FEISHU_UPDATE_TOOL, options = {}) {
  const dir=await mkdtemp(join(tmpdir(),'pidot-feishu03-')), file=join(dir,'isolated.sqlite'), stores=new Set(), live={FEISHU_APP_ID:'fixture-app',FEISHU_APP_SECRET:'fixture-secret'}, counts={writes:0,reads:0}; let resource, event=rawEvent()
  const response = data => new Response(JSON.stringify({code:0,data}))
  const client=createFeishuClient({env:live,fetchImpl:async(url,init)=>{
    if(url.includes('/auth/'))return new Response(JSON.stringify({code:0,tenant_access_token:'fixture-token',expire:100}))
    if(!url.includes('/events'))return response(options.flatCalendar?{calendar_id:'fixture-calendar',summary:'Pidot-test-03',role:'owner',type:'shared'}:{calendar:{calendar_id:'fixture-calendar',summary:'Pidot-test-03',role:'owner',type:'shared'}})
    if(url.includes('/attendees'))return response({items:options.attendees ? [{type:'user'}] : [],has_more:false})
    if(['PATCH','DELETE'].includes(init.method)) {
      counts.writes++; counts.method=init.method; counts.body=init.body ? JSON.parse(init.body):null
      if(options.beforeWrite) await options.beforeWrite()
      if(options.rejectWrite)return new Response(JSON.stringify({code:193002}),{status:403})
      event=init.method==='PATCH'?{...event,...JSON.parse(init.body)}:{...event,status:'cancelled'}
      if(options.postConflict)event.summary='outside writer changed after PATCH'
      if(options.lost)throw Error('lost actual response')
      return response(init.method==='PATCH'?{event}:{})
    }
    counts.reads++; return response({event})
  }})
  const modelReply=async(_m,o)=>{
    const tools=o.context.messages.filter(m=>m.role==='toolResult')
    if(tools.length>=2)return baseReply()
    let call
    if(!tools.length) call={type:'toolCall',id:'exact-read',name:FEISHU_TOOLS[1],arguments:{resource,eventId:options.eventId??'fixture-event_0'}}
    else { const d=JSON.parse(tools.at(-1).content[0].text).data; call={type:'toolCall',id:'mutation',name:kind,arguments:{...(kind===FEISHU_UPDATE_TOOL?after(resource):{resource}),eventId:'fixture-event_0',beforeHash:d.beforeHash}} }
    return {...baseReply(),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:config.model,stopReason:'toolUse',timestamp:Date.now()}}
  }
  const open=async()=>{const s=await openTaskStore({file,bots:listBots(config),feishuClient:client,modelReply,...options.store});stores.add(s);return s}
  const close=async s=>{await s.close();stores.delete(s)}
  t.after(async()=>{for(const s of stores)await s.close();await rm(dir,{recursive:true,force:true})})
  const s=await open(),b=await s.feishuCalendar.manage({action:'bind',calendarId:'fixture-calendar',confirm:true});resource=b.resource
  const tools=[...FEISHU_TOOLS,...FEISHU_MUTATION_TOOLS]
  await s.updateCapabilityPool({requestId:'mutation03-grant-pool',operation:'grant',tools,resources:[resource]})
  const {bot}=await s.getBotConfiguration('calendar');await s.updateBotConfiguration('calendar',{requestId:'mutation03-grant-bot',expectedVersion:bot.configRef.version,description:'真实更新删除必须精确审批',tools,resources:[resource]})
  const create=async()=>{const x=await s.create({botId:'calendar'});await s.send(x.taskId,options.noSelection?'修改同名会议，不告诉你eventId': '精确eventId=fixture-event_0，先读取再申请更新或删除，不自行批准');return x.taskId}
  const id=await create(),pending=await until(s,id,x=>options.noSelection?x.activeInputId===null:x.approvals.activeId!==null)
  return {s,id,item:pending.approvals.items[0],counts,open,close,live,resource,create,change:fn=>{event=fn(event)}}
}
test('mutation validators strictly bind ID hash and approved fields',()=>{
  const resource='feishu:'+'a'.repeat(64), before=projectFeishuEvent(rawEvent(),{}), a={...after(resource),eventId:before.eventId,beforeHash:feishuBeforeHash(before)}
  assert(normalizeFeishuMutation(FEISHU_UPDATE_TOOL,a));assert(supportedFeishuTarget(before,'fixture-calendar'))
  for(const key of ['attendees','recurrence','need_notification','vchat','visibility','calendarId'])assert.equal(normalizeFeishuMutation(FEISHU_UPDATE_TOOL,{...a,[key]:true}),null)
  for(const eventId of ['..','../other','',null])assert.equal(normalizeFeishuMutation(FEISHU_UPDATE_TOOL,{...a,eventId}),null)
  for(const change of [{allDay:true},{recurrence:'FREQ=DAILY'},{recurringEventId:'series'},{isException:true},{organizerCalendarId:'other'},{eventId:'series_123'},{status:'cancelled'},{vchatType:'vc'}])assert.equal(supportedFeishuTarget({...before,...change},'fixture-calendar'),false)
})
for(const kind of FEISHU_MUTATION_TOOLS){
 test(`${kind} exact approval executes once with provider and readback evidence`,async t=>{const {s,id,item,counts}=await setup(t,kind);assert(item.before);assert.equal(counts.writes,0);await s.decideApproval(id,item.id,{decision:'approved'});const done=await until(s,id,x=>x.approvals.items[0].status==='executed');const op=done.approvals.items[0].operation;assert.equal(counts.writes,1);assert(op.providerReceipt);assert(op.verifiedResult.data.readbackVerified);assert.equal(op.capabilities.stableIdempotency,false);await s.decideApproval(id,item.id,{decision:'approved'});assert.equal(counts.writes,1);if(kind===FEISHU_UPDATE_TOOL)assert.deepEqual(Object.keys(counts.body).sort(),['description','end_time','free_busy_status','need_notification','start_time','summary'].sort())})
 test(`${kind} external modification causes conflict without write`,async t=>{const {s,id,item,counts,change}=await setup(t,kind);change(e=>({...e,summary:'external edit'}));await s.decideApproval(id,item.id,{decision:'approved'});const done=await until(s,id,x=>x.approvals.items[0].receipt);assert.equal(done.approvals.items[0].receipt.result.error.code,'CALENDAR_CONFLICT');assert.equal(counts.writes,0)})
 test(`${kind} rejects attendee side effects before dispatch`,async t=>{const {s,id,item,counts}=await setup(t,kind,{attendees:true});await s.decideApproval(id,item.id,{decision:'approved'});const done=await until(s,id,x=>x.approvals.items[0].receipt);assert.equal(done.approvals.items[0].receipt.result.error.code,'FEISHU_ATTENDEES_UNSUPPORTED');assert.equal(counts.writes,0)})
 test(`${kind} lost response remains unknown across restart and blocks later same-event operation`,async t=>{const {s,id,item,counts,close,open,create}=await setup(t,kind,{lost:true});await s.decideApproval(id,item.id,{decision:'approved'});const prior=await until(s,id,x=>x.approvals.items[0].status==='outcome-unknown');assert.equal(counts.writes,1);if(kind===FEISHU_UPDATE_TOOL){const other=await create(),p=await until(s,other,x=>x.approvals.activeId!==null);await s.decideApproval(other,p.approvals.activeId,{decision:'approved'});await until(s,other,x=>x.approvals.items[0].status==='outcome-unknown');assert.equal(counts.writes,1)}await close(s);const next=await open();await delay(40);const recovered=await next.get(id);assert.equal(recovered.approvals.items[0].status,'outcome-unknown');assert.equal(counts.writes,1);assert.deepEqual(recovered.callUsage,prior.callUsage)})
 test(`${kind} cross task wrong approval cancellation and revocation cannot authorize write`,async t=>{const {s,id,item,counts,resource}=await setup(t,kind);const other=await s.create({botId:'calendar'});await assert.rejects(s.decideApproval(other.taskId,item.id,{decision:'approved'}),{code:'APPROVAL_NOT_FOUND'});await s.updateCapabilityPool({requestId:'mutation03-revoke',operation:'revoke',tools:[],resources:[resource]});await assert.rejects(s.decideApproval(id,item.id,{decision:'approved'}),{code:'FEISHU_BINDING_DENIED'});await s.cancel(id,{});assert.equal(counts.writes,0)})
}
test('post-PATCH external race is unknown, accepted receipt is not readback proof',async t=>{const {s,id,item,counts}=await setup(t,FEISHU_UPDATE_TOOL,{postConflict:true});await s.decideApproval(id,item.id,{decision:'approved'});const done=await until(s,id,x=>x.approvals.items[0].status==='outcome-unknown');assert.equal(counts.writes,1);assert(done.approvals.items[0].operation.providerReceipt);assert.equal(done.approvals.items[0].receipt,null)})
test('explicit DELETE permission rejection never establishes deletion',async t=>{const {s,id,item,counts}=await setup(t,FEISHU_DELETE_TOOL,{rejectWrite:true});await s.decideApproval(id,item.id,{decision:'approved'});const done=await until(s,id,x=>x.approvals.items[0].status==='outcome-unknown');assert.equal(counts.writes,1);assert.equal(done.approvals.items[0].operation.providerReceipt,undefined);assert.equal(done.approvals.items[0].receipt,null)})
test('connection replacement invalidates mutation approval before dispatch',async t=>{const {s,id,item,counts,live}=await setup(t);live.FEISHU_APP_SECRET='rotated';await s.feishuCalendar.status();await assert.rejects(s.decideApproval(id,item.id,{decision:'approved'}),{code:'FEISHU_BINDING_DENIED'});assert.equal(counts.writes,0)})
test('cancelled mutation cannot dispatch',async t=>{const {s,id,item,counts}=await setup(t);await s.cancel(id,{});await assert.rejects(s.decideApproval(id,item.id,{decision:'approved'}));assert.equal(counts.writes,0)})
test('revocation after preflight admission stops mutation at final transport boundary',async t=>{
 let entered,release;const hold=new Promise(r=>entered=r),wait=new Promise(r=>release=r)
 const {s,id,item,counts}=await setup(t,FEISHU_UPDATE_TOOL,{store:{calendarWriteImpl:async(_op,{execute})=>{entered();await wait;return execute()}}})
 await s.decideApproval(id,item.id,{decision:'approved'});await hold;await s.updateCapabilityPool({requestId:'mutation03-final-revoke',operation:'revoke',tools:[FEISHU_UPDATE_TOOL],resources:[]});release();await delay(35);assert.equal(counts.writes,0)
})

test('official flat calendar detail supports preflight ownership check',async t=>{const {s,id,item,counts}=await setup(t,FEISHU_UPDATE_TOOL,{flatCalendar:true});await s.decideApproval(id,item.id,{decision:'approved'});await until(s,id,x=>x.approvals.items[0].status==='executed');assert.equal(counts.writes,1)})

test('same-name or guessed target without explicit user event selection never reaches approval',async t=>{const {s,id,counts}=await setup(t,FEISHU_UPDATE_TOOL,{noSelection:true});const done=await s.get(id);assert.equal(done.approvals.items.length,0);assert(done.messages.some(m=>m.result?.error?.code==='FEISHU_TARGET_SELECTION_REQUIRED'));assert.equal(counts.writes,0)})
test('group endpoint cannot approve a foreign standalone mutation',async t=>{
 const {s,id,item,counts}=await setup(t,FEISHU_DELETE_TOOL)
 const {createApiServer}=await import('./app.mjs'), server=createApiServer({token:'fixture-token',tasks:s});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const {task:group}=await s.createGroup({requestId:'mutation03-foreign-group',title:'foreign group',adminBotId:'todo',memberBotIds:['todo','calendar']})
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api/groups/${group.groupId}/children/${id}/approvals/${item.id}/decide`,{method:'POST',headers:{Authorization:'Bearer fixture-token','Content-Type':'application/json'},body:JSON.stringify({decision:'approved'})})
 assert.equal(r.status,404);assert.equal(counts.writes,0);assert.equal((await s.get(id)).approvals.items[0].decision,null)
})
test('404 alone is only precise absence, authentication and permission errors never become absence',async()=>{
 const make=(status,code)=>createFeishuClient({env:{FEISHU_APP_ID:'fixture',FEISHU_APP_SECRET:'fixture'},fetchImpl:async url=>url.includes('/auth/')?new Response(JSON.stringify({code:0,tenant_access_token:'fixture',expire:100})):new Response(JSON.stringify({code}),{status})})
 await assert.rejects(make(404,193001).api('/calendar/v4/calendars/c/events/e'),{code:'FEISHU_EVENT_NOT_FOUND'})
 await assert.rejects(make(403,193002).api('/calendar/v4/calendars/c/events/e'),{code:'FEISHU_PROVIDER_ERROR'})
 await assert.rejects(make(401,99991663).api('/calendar/v4/calendars/c/events/e'),{code:'FEISHU_TOKEN_REJECTED'})
 await assert.rejects(make(404,193002).api('/calendar/v4/calendars/c/events/e'),{code:'FEISHU_PROVIDER_ERROR'})
})
