import { openTaskStore } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
const [file,phase]=process.argv.slice(2), start=Date.parse('2026-10-19T00:00:00Z'), hold=setInterval(()=>{},1000)
const config={baseUrl:'https://crash-fixture.invalid/v1',model:'fixture-only',apiKey:'unused'}
const pause=async(point,row)=>{if(point===phase){process.send?.({point,row});await new Promise(()=>{})}}
const s=await openTaskStore({file,bots:listBots(config),workspaceScheduleOptions:{autoStart:false,now:()=>start+(phase==='seed'?0:60000),boundary:pause},modelReply:async()=>({mode:'model',reply:{content:'isolated crash completion'},execution:{usage:{totalTokens:11}}})})
if(phase==='seed'){
 await s.workspace.manageLocalGrant({requestId:'grant',sourceId:'local',enabled:true,expectedEpoch:0,confirmed:true})
 const {bot}=await s.getBotConfiguration('calendar');await s.updateBotConfiguration('calendar',{requestId:'workflow-bot',expectedVersion:bot.configRef.version,description:'crash only',tools:['workspace.list','workspace.get'],resources:['workspace:local']})
 const p=await s.workspaceSchedules.manage({requestId:'plan',command:'create',title:'crash',timezone:'UTC',rule:{type:'at',at:new Date(start+60000).toISOString()},actionSpec:{kind:'agent_readonly_workflow',botId:'calendar',sourceIds:['local'],prompt:'只读简报',promptVersion:'v1',notification:'inbox',callLimits:{modelCalls:2,toolCalls:2,totalTokens:2000}},confirmed:true})
 process.send?.({seeded:p.receipt.schedule})
}else{
 await s.workspaceScheduler.tick()
 for(let n=0;n<150;n++){const plans=await s.workspaceSchedules.list({});const rows=(await s.workspaceSchedules.list({scheduleId:plans.items[0].id})).items;if(rows[0]?.taskId){const t=await s.get(rows[0].taskId);if(t.runtime.checkpoint?.lastOutcome){await s.workspaceScheduler.tick();process.send?.({done:{plans:await s.workspaceSchedules.list({}),rows:(await s.workspaceSchedules.list({scheduleId:plans.items[0].id})).items,tasks:await s.list(),inbox:await s.workspaceReminders.list({})}});break}}await new Promise(r=>setTimeout(r,10))}
}
await s.close();clearInterval(hold)
