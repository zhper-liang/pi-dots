import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {openTaskStore} from '../tasks.mjs'
import {listBots} from '../bots.mjs'
import {sharingModel,groupSharingConfig,configureSharing} from './group-sharing-model.mjs'
const [dir,phase]=process.argv.slice(2)
if(!dir?.startsWith('/tmp/pidot-sharing-kill-'))throw Error('Isolated directory required')
setInterval(()=>{},1000)
let saved,atomicB=false
const hold=async()=>{await writeFile(join(dir,'checkpoint.json'),JSON.stringify(saved));await new Promise(()=>{})}
const store=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(groupSharingConfig),beforeCommit:async()=>{if(saved&&atomicB&&phase==='atomic-rollback')await hold()},modelReply:async(m,o)=>{
 if(o.parametersBotId==='chief'&&phase==='b-waiting')await hold()
 if(o.parametersBotId==='todo'&&phase==='result-collected'&&o.context.messages.some(m=>typeof m.content==='string'&&m.content.includes('B建议09:30')))await hold()
 const result=await sharingModel(m,o)
 if(result.toolCalls?.some(c=>c.name==='task_assign'&&c.arguments.operationId==='b')&&phase==='atomic-rollback')atomicB=true
 return result
}})
await configureSharing(store)
const {task}=await store.createGroup({requestId:'sharing-recovery-group',title:'共享恢复',adminBotId:'todo',memberBotIds:['todo','calendar','chief']})
saved={taskId:task.taskId,groupId:task.groupId}
const sent=await store.send(task.taskId,'完成A事实到B建议')
saved.inputId=sent.messageId
await new Promise(()=>{})
