import {openTaskStore} from '../tasks.mjs'
import {listBots} from '../bots.mjs'
import {COLLABORATION_TOOLS} from '../collaboration-tools.mjs'
const [file,boundary]=process.argv.slice(2)
if(!file?.startsWith('/tmp/pidot-controls-05-'))throw Error('Isolated test DB only')
const cfg={baseUrl:'https://fixture.invalid/v1',model:'controls-fixture',apiKey:'fixture'}
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
let n=0,calls=0
const turn=(name,args)=>{const c={type:'toolCall',id:`kill-${++n}`,name,arguments:args};return {...text(''),toolCalls:[c],assistant:{role:'assistant',content:[c],api:'openai-completions',provider:'fixture',model:cfg.model,stopReason:'toolUse',timestamp:Date.now()}}}
const s=await openTaskStore({file,bots:listBots(cfg),modelReply:async(_m,o)=>o.parametersBotId==='todo'?(++calls===1?turn('task_assign',{operationId:'only-child',botId:'calendar',goal:'原工作',completionCriteria:['模拟来源']}):text('处理中间通知')):turn('report_blocker',{question:'等待信息',requiredInformation:'模拟值',assignee:'supervisor'})})
for(const id of ['todo','calendar']){const {bot}=await s.getBotConfiguration(id);await s.updateBotConfiguration(id,{requestId:'kill-config-'+id,expectedVersion:bot.configRef.version,description:bot.description,tools:id==='todo'?COLLABORATION_TOOLS:['report_blocker'],resources:[]})}
const p=await s.create({botId:'todo'});await s.send(p.taskId,'原输入')
let r
for(let i=0;i<500;i++){const state=await s.get(p.taskId);r=state.collaborations[0];if(r&&(await s.get(r.childTaskId)).blockers.activeId&&state.callUsage.unknownTokenCalls===0&&state.runtime.checkpoint.phase==='awaitChildren')break;await new Promise(r=>setTimeout(r,10))}
let fired=false
s.harness.subscribeCommits(({changes})=>{
 const target=boundary==='root'?'pidot.collaboration-stopped':'pidot.task-cancelled'
 if(!fired&&changes.some(c=>c.type==='entry'&&c.value.kind===target)){fired=true;console.log('CHECKPOINT '+JSON.stringify({parentTaskId:p.taskId,childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,parentUsage:calls,boundary}));process.kill(process.pid,'SIGSTOP')}
})
if(boundary==='root')await s.stopWork(p.taskId,{rootWorkId:r.rootWorkId});else await s.cancel(p.taskId,{})
setTimeout(()=>process.exit(3),20000)
