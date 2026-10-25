import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {openTaskStore} from '../tasks.mjs'
import {listBots} from '../bots.mjs'
import {COLLABORATION_TOOLS} from '../collaboration-tools.mjs'
const [dir,phase]=process.argv.slice(2)
if(!dir?.startsWith('/tmp/pidot-directed-kill-'))throw Error('Isolated directory required')
setInterval(()=>{},1000)
const config={baseUrl:'https://fixture.invalid/v1',model:'directed-recovery',apiKey:'fixture-only'}
let saved,childCalls=0,parentCalls=0
const hold=async()=>{await writeFile(join(dir,'checkpoint.json'),JSON.stringify({...saved,childCalls,parentCalls}));await new Promise(()=>{})}
const store=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(config),beforeCommit:async ()=>{if(saved&&phase==='before-dispatch')await hold()},modelReply:async(_m,o)=>{
 if(o.parametersBotId==='calendar'){childCalls++;if(phase==='dispatched')await hold();return {mode:'model',reply:{content:'恢复边界的专业结果'},execution:{usage:{totalTokens:5}}}}
 parentCalls++;if(phase==='collected')await hold()
 return {mode:'model',reply:{content:'submitted尚未验收'},execution:{usage:{totalTokens:5}}}
}})
const {bot}=await store.getBotConfiguration('todo');await store.updateBotConfiguration('todo',{requestId:'kill-config',expectedVersion:bot.configRef.version,description:bot.description,tools:[...COLLABORATION_TOOLS,'task_review'],resources:[]})
const {task}=await store.createGroup({requestId:'kill-group-create',title:'群定向恢复',adminBotId:'todo',memberBotIds:['todo','calendar']})
saved={taskId:task.taskId,groupId:task.groupId}
const input={message:'恢复时只执行一个目标',targetBotId:'calendar',requestId:'kill-directed-input'}
const sent=await store.send(task.taskId,input);saved.messageId=sent.messageId
await new Promise(()=>{})
