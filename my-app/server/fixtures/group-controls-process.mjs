import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {openTaskStore} from '../tasks.mjs'
import {listBots} from '../bots.mjs'
import {issueConfig,configureIssues,issueModel} from './group-issues-model.mjs'
const [dir,phase]=process.argv.slice(2)
if(!dir?.startsWith('/tmp/pidot-controls-kill-'))throw Error('Isolated directory required')
setInterval(()=>{},1000)
const s=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(issueConfig),modelReply:async(m,o)=>phase==='plain'?new Promise(()=>{}):issueModel(m,o)})
await configureIssues(s)
const {task:p}=await s.createGroup({requestId:'controls05-kill',title:'恢复控制群',adminBotId:'todo',memberBotIds:['todo','calendar']})
const a=await s.send(p.taskId,phase==='plain'?'hold':{message:'原工作',targetBotId:'calendar',requestId:'controls05-kill-input'})
let v
for(;;){v=await s.get(p.taskId);if(phase==='plain'?v.callUsage.modelCalls===1:v.groupIssues[0]?.blockers.items.some(b=>b.assignee==='user'))break;await new Promise(r=>setTimeout(r,10))}
await s.send(p.taskId,'后续独立消息')
const rootWorkId=`${p.taskId}:${a.messageId}`,childTaskId=v.collaborations[0]?.childTaskId
if(phase==='single')await s.cancel(childTaskId,{})
else await s.stopWork(p.taskId,{rootWorkId})
// Kill after durable control request, without waiting for child settlement or queue consumption.
await writeFile(join(dir,'checkpoint.json'),JSON.stringify({taskId:p.taskId,groupId:p.groupId,rootWorkId,childTaskId}))
await new Promise(()=>{})
