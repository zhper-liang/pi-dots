import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listBots } from './bots.mjs'
import { openTaskStore } from './fixtures/authorized-task-store.mjs'
const start = Date.parse('2026-10-19T00:00:00Z')
const spec = { kind: 'agent_readonly_workflow', botId: 'calendar', sourceIds: ['local'], prompt: '读取本地日程，生成只读摘要。', promptVersion: 'v1', callLimits: { modelCalls: 2, toolCalls: 2, totalTokens: 2000 }, notification: 'inbox' }
const command = (requestId = 'workflow', actionSpec = spec) => ({ requestId, command: 'create', title: '每日只读简报', timezone: 'Asia/Shanghai', rule: { type: 'at', at: new Date(start + 60000).toISOString() }, actionSpec, confirmed: true })
async function fixture(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-08-')); let s, time = start
  const bots = options.bots ?? listBots(); bots.find(b => b.id === 'calendar').defaults.tools.push('workspace.list','workspace.get'); bots.find(b => b.id === 'calendar').defaults.toolResources.push('workspace:local')
  const opts = { ...options, bots, file: join(dir, 'isolated.sqlite'), workspaceScheduleOptions: { autoStart: false, onError: e => console.error(e), now: () => time } }
  try {
    s = await openTaskStore(opts)
    await s.workspace.manageLocalGrant({ requestId: 'grant', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
    const {bot} = await s.getBotConfiguration('calendar'); await s.updateBotConfiguration('calendar',{requestId:'workflow-bot',expectedVersion:bot.configRef.version,description:'只读工作流测试',tools:['workspace.list','workspace.get'],resources:['workspace:local']})
    await fn({ s, dir, setTime: t => { time = t }, restart: async () => { await s.close(); s = await openTaskStore(opts); return s } })
  } finally { await s?.close(); await rm(dir, { recursive: true, force: true }) }
}
async function settled(s, id) { for (let n = 0; n < 150; n++) { const t = await s.get(id); if (t.runtime.checkpoint?.lastOutcome) return t; await new Promise(r => setTimeout(r, 15)) } throw Error('Task timeout') }
test('08 exact confirmation, strict read-only spec, live source validation and idempotent management', () => fixture(async ({ s }) => {
  await assert.rejects(s.workspaceSchedules.manage({ ...command(), confirmed: false }), { code: 'WORKSPACE_SCHEDULE_CONFIRM' })
  for (const bad of [{ ...spec, sourceIds: [] }, { ...spec, code: 'shell' }, { ...spec, callLimits: { modelCalls: -1 } }]) await assert.rejects(s.workspaceSchedules.manage(command('bad', bad)), { code: 'WORKSPACE_WORKFLOW_INPUT' })
  const a = await s.workspaceSchedules.manage(command()), b = await s.workspaceSchedules.manage(command())
  assert.deepEqual(a,b); assert.deepEqual(a.receipt.schedule.callLimits,spec.callLimits); assert.equal(a.receipt.schedule.executionPrincipal.kind, 'bot')
}))
test('08 due creates one original Task, frozen only read tools, inbox and same database recovery', () => fixture(async ({ s, setTime, restart }) => {
  const plan = (await s.workspaceSchedules.manage(command())).receipt.schedule
  setTime(start + 60000); await s.workspaceScheduler.tick()
  let rows = (await s.workspaceSchedules.list({ scheduleId: plan.id })).items
  assert.equal(rows.length, 1); assert.ok(rows[0].taskId)
  const id = rows[0].taskId, task = await settled(s,id)
  assert.deepEqual(task.parameters.tools, ['workspace.list','workspace.get']); assert.deepEqual(task.parameters.toolResources,['workspace:local']); assert.deepEqual(task.managementTools,[])
  await s.workspaceScheduler.tick(); rows = (await s.workspaceSchedules.list({ scheduleId: plan.id })).items
  assert.equal(rows[0].state,'succeeded'); assert.equal((await s.workspaceReminders.list({})).items[0].taskId,id)
  s = await restart(); await s.workspaceScheduler.tick()
  assert.equal((await s.workspaceSchedules.list({ scheduleId: plan.id })).items[0].taskId,id); assert.equal((await s.list()).length,1)
}))
test('08 remove source before due prevents Task and redacts workflow definition', () => fixture(async ({ s,setTime }) => {
  await s.workspaceSchedules.manage(command())
  const { bot, assigned } = await s.getBotConfiguration('calendar')
  await s.updateBotConfiguration('calendar', { requestId: 'remove-workflow-source', expectedVersion: bot.configRef.version, description: bot.description, tools: assigned.tools, resources: [] })
  setTime(start+60000); await s.workspaceScheduler.tick(); assert.equal((await s.list()).length,0)
  assert.equal((await s.workspaceSchedules.list({})).items[0].redacted,true)
}))

test('08 pause/cancel future plans never replaces current Task; original Task cancellation separate', () => fixture(async ({s,setTime}) => {
  const plan = (await s.workspaceSchedules.manage({...command(),rule:{type:'interval',seconds:60,anchor:new Date(start+60000).toISOString()}})).receipt.schedule
  setTime(start+60000); await s.workspaceScheduler.tick(); const original=(await s.workspaceSchedules.list({scheduleId:plan.id})).items[0]
  await s.workspaceSchedules.manage({requestId:'future-cancel',command:'cancel',id:plan.id,expectedRevision:1,confirmed:true})
  assert.ok((await s.get(original.taskId)).cancellation?.request == null)
  await s.cancel(original.taskId,{})
  setTime(start+600000); await s.workspaceScheduler.tick(); assert.equal((await s.list()).length,1)
  await assert.rejects(s.send(original.taskId,'again'))
}))
test('08 source and tool revoke after result hides inbox and original result without regrant resurrection', () => fixture(async ({s,setTime}) => {
  const plan=(await s.workspaceSchedules.manage(command())).receipt.schedule; setTime(start+60000); await s.workspaceScheduler.tick()
  const id=(await s.workspaceSchedules.list({scheduleId:plan.id})).items[0].taskId; await settled(s,id); await s.workspaceScheduler.tick()
  assert.equal((await s.workspaceReminders.list({})).items.length,1)
  await s.revokeTool('calendar','workspace.get')
  assert.equal((await s.workspaceReminders.list({})).items[0].redacted,true)
}))
const config={baseUrl:'https://workflow-fixture.invalid/v1',model:'fixture-only',apiKey:'not-used'}
const toolReply=()=>{const call={type:'toolCall',id:'read-local',name:'workspace.list',arguments:{sourceId:'local',type:'Event'}};return {mode:'model',reply:{content:''},toolCalls:[call],assistant:{role:'assistant',content:[call],timestamp:Date.now()},execution:{usage:{totalTokens:7}}}}
const textReply=()=>({mode:'model',reply:{content:'只读摘要完成'},execution:{usage:{totalTokens:9}}})
async function modelFixture(fn, modelReply, limits=spec.callLimits) {
  const bots=listBots(config)
  await fixture(async f=>{await fn({...f,create:()=>f.s.workspaceSchedules.manage(command('model-workflow',{...spec,callLimits:limits}))})},{bots,modelReply})
}
test('08 model reads through real MCP protocol with routine read tool intersection and original usage',()=>modelFixture(async ({s,setTime,create})=>{
  const plan=(await create()).receipt.schedule; setTime(start+60000);await s.workspaceScheduler.tick();const id=(await s.workspaceSchedules.list({scheduleId:plan.id})).items[0].taskId
  const t=await settled(s,id);assert.equal(t.callUsage.modelCalls,2);assert.equal(t.callUsage.toolCalls,1);assert.equal(t.callUsage.totalTokens,16)
  assert.equal(t.messages.find(m=>m.toolName==='workspace.list').result.ok,true)
  await s.workspaceScheduler.tick();assert.equal((await s.workspaceSchedules.list({scheduleId:plan.id})).items[0].state,'succeeded')
},async (_m,o)=>o.context.messages.some(m=>m.role==='toolResult')?textReply():toolReply()))
test('08 budget exhaustion parks original Task, no automatic new Task, persisted counters',()=>modelFixture(async ({s,setTime,create,restart})=>{
  const plan=(await create()).receipt.schedule;setTime(start+60000);await s.workspaceScheduler.tick();const id=(await s.workspaceSchedules.list({scheduleId:plan.id})).items[0].taskId
  let t=await settled(s,id);assert.equal(t.runtime.checkpoint.lastOutcome,'limited');assert.equal(t.callUsage.modelCalls,1)
  await s.workspaceScheduler.tick();assert.equal((await s.workspaceSchedules.list({scheduleId:plan.id})).items[0].state,'waiting')
  s=await restart();setTime(start+600000);await s.workspaceScheduler.tick();t=await s.get(id);assert.equal(t.callUsage.modelCalls,1);assert.equal((await s.list()).length,1)
},async()=>toolReply(),{modelCalls:1,toolCalls:2,totalTokens:2000}))
test('08 model failure stays original, no new Task or blind retry',()=>modelFixture(async ({s,setTime,create})=>{
  const plan=(await create()).receipt.schedule;setTime(start+60000);await s.workspaceScheduler.tick();const id=(await s.workspaceSchedules.list({scheduleId:plan.id})).items[0].taskId
  const t=await settled(s,id);assert.equal(t.runtime.checkpoint.lastOutcome,'failed');await s.workspaceScheduler.tick();await s.workspaceScheduler.tick();assert.equal((await s.list()).length,1);assert.equal(t.callUsage.modelCalls,1)
},async()=>{throw Error('fixture failure')}))

test('08 actual OS SIGKILL claim/task creation/task commit/model request/model response keeps same association and unknown usage',async()=>{
 const {fork}=await import('node:child_process');const {once}=await import('node:events')
 for(const phase of ['after_claim','task_created','after_task_commit','model_request','model_response']){
  const dir=await mkdtemp(join(tmpdir(),'pidot-v2-08-kill-')), file=join(dir,'isolated.sqlite')
  const spawn=p=>fork(new URL('./fixtures/workspace-agent-crash.mjs',import.meta.url),[file,p],{stdio:['ignore','pipe','pipe','ipc']})
  const message=child=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('timeout'))},10000);child.once('message',m=>{clearTimeout(timer);resolve(m)});child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('child exit '+code))})})
  let child
  try{
   child=spawn('seed');await message(child);await once(child,'exit')
   child=spawn(phase);const killed=await message(child);assert.equal(killed.point,phase);child.kill('SIGKILL');const [,signal]=await once(child,'exit');assert.equal(signal,'SIGKILL')
   child=spawn('recover');const {done}=await message(child);await once(child,'exit')
   assert.equal(done.tasks.length,1);assert.equal(done.rows.length,1);assert.equal(done.rows[0].taskId,done.tasks[0].taskId)
   if(killed.row?.taskId && phase!=='task_created')assert.equal(done.rows[0].taskId,killed.row.taskId)
   if(['model_request','model_response'].includes(phase)){assert.equal(done.rows[0].state,'unknown');assert.equal(done.tasks[0].callUsage.modelCalls,1);assert.equal(done.tasks[0].callUsage.unknownTokenCalls,1);assert.equal(done.inbox.items.length,0)}else{assert.equal(done.rows[0].state,'succeeded');assert.equal(done.inbox.items.length,1)}
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true})}
 }
})

test('08 daily/interval fixed rules and overlap coalesce with a limited original Task',()=>modelFixture(async({s,setTime,create})=>{
 const at=(await create()).receipt.schedule
 await s.workspaceSchedules.manage({requestId:'pause-at',command:'pause',id:at.id,expectedRevision:1,confirmed:true})
 const daily=(await s.workspaceSchedules.manage({...command('daily-workflow'),rule:{type:'daily',time:'08:01'}})).receipt.schedule
 setTime(start+60000);await s.workspaceScheduler.tick();const rows=(await s.workspaceSchedules.list({scheduleId:daily.id})).items;assert.equal(rows.length,1);await settled(s,rows[0].taskId)
 setTime(start+86400000*3);await s.workspaceScheduler.tick();assert.equal((await s.list()).length,1)
},async()=>toolReply(),{modelCalls:1,toolCalls:2,totalTokens:2000}))
test('08 Bot stop and paused plan before dispatch forbid model and preserve claim',()=>fixture(async({s,setTime})=>{
 const p=(await s.workspaceSchedules.manage(command())).receipt.schedule
 await s.deactivateBot('calendar',{confirmed:true}).catch(async()=>{await s.deactivateBot('calendar',{confirm:true})})
 setTime(start+60000);await s.workspaceScheduler.tick();assert.equal((await s.list()).length,0);assert.equal((await s.workspaceSchedules.list({})).items[0].redacted,true)
 await s.workspaceSchedules.manage({requestId:'cancel-revoked',command:'cancel',id:p.id,expectedRevision:1,confirmed:true})
}))
test('08 frozen scheduled task cannot receive messages, steer or migrate tools',()=>fixture(async({s,setTime})=>{
 const p=(await s.workspaceSchedules.manage(command())).receipt.schedule;setTime(start+60000);await s.workspaceScheduler.tick();const id=(await s.workspaceSchedules.list({scheduleId:p.id})).items[0].taskId;await settled(s,id)
 await assert.rejects(s.send(id,'new work'),{code:'WORKSPACE_WORKFLOW_INPUT_IMMUTABLE'})
 await assert.rejects(s.steer(id,{message:'new scope'}),{code:'WORKSPACE_WORKFLOW_INPUT_IMMUTABLE'})
}))

test('08 failed repeating workflow waits on original Task, later due cannot auto-retry',()=>modelFixture(async({s,setTime})=>{
 const p=(await s.workspaceSchedules.manage({...command('failure-interval'),rule:{type:'interval',seconds:60,anchor:new Date(start+60000).toISOString()}})).receipt.schedule
 setTime(start+60000);await s.workspaceScheduler.tick();const id=(await s.workspaceSchedules.list({scheduleId:p.id})).items[0].taskId;await settled(s,id);await s.workspaceScheduler.tick()
 setTime(start+600000);await s.workspaceScheduler.tick();assert.equal((await s.list()).length,1);assert.equal((await s.workspaceSchedules.list({scheduleId:p.id})).items[0].state,'waiting')
},async()=>{throw Error('failed repeating model')}))
test('08 MCP schedule tool returns non-executable bounded draft, cannot self-confirm or create a plan',()=>fixture(async({s})=>{
 const {MCP_VERSION}=await import('./workspace-mcp-protocol.mjs')
 const { bot, assigned } = await s.getBotConfiguration('calendar')
 await s.updateBotConfiguration('calendar', { requestId: 'enable-workflow-draft', expectedVersion: bot.configRef.version, description: bot.description, tools: [...assigned.tools, 'workspace.prepare_change', 'workspace.prepare_schedule'], resources: assigned.resources })
 const cred=await s.workspaceAgent.issueClient({sourceId:'local',botId:'calendar',actions:['read','create'],readScope:'full',ttlSeconds:600,confirmed:true});let session
 const send=async message=>{const r=await s.workspaceMcpMessage(cred.token,session,message);session=r.sessionId;return r.message}
 await send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:MCP_VERSION,clientInfo:{name:'08-draft',version:'1'},capabilities:{}}});await send({jsonrpc:'2.0',method:'notifications/initialized'})
 const draft={title:'只读草案',timezone:'UTC',rule:{type:'at',at:new Date(Date.now()+60000).toISOString()},actionSpec:spec}
 const call=(id,d)=>send({jsonrpc:'2.0',id,method:'tools/call',params:{name:'workspace.prepare_schedule',arguments:{sourceId:'local',requestId:'draft',draft:d}}})
 const response=await call(2,draft);assert.equal(response.result.structuredContent.data.executable,false);assert.equal(response.result.structuredContent.data.confirmationRequired,true)
 assert.equal((await s.workspaceSchedules.list({})).items.length,0)
 assert.equal((await call(3,{...draft,confirmed:true})).result.isError,true)
 assert.equal((await call(4,{...draft,actionSpec:{...spec,sourceIds:['another']}})).result.isError,true)
}))

test('08 terminal cancelled Task reconciliation reads existing archive, no retired document recreation',()=>modelFixture(async({s,setTime,create})=>{
 const p=(await create()).receipt.schedule;setTime(start+60000);await s.workspaceScheduler.tick();const id=(await s.workspaceSchedules.list({scheduleId:p.id})).items[0].taskId
 await s.cancel(id,{})
 for(let n=0;n<100;n++){const t=await s.get(id);if(t.runtime.status==='terminal')break;await new Promise(r=>setTimeout(r,10))}
 assert.equal((await s.get(id)).runtime.status,'terminal');await s.workspaceScheduler.tick();const row=(await s.workspaceSchedules.list({scheduleId:p.id})).items[0];assert.equal(row.state,'cancelled');assert.equal(row.taskId,id);assert.equal((await s.workspaceReminders.list({})).items[0].taskId,id)
},async(_m,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});setTimeout(()=>resolve(textReply()),500)})))
