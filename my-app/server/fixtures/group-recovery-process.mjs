import {openTaskStore} from '../tasks.mjs'
import {listBots} from '../bots.mjs'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
const [dir,phase]=process.argv.slice(2)
setInterval(()=>{},1000)
if(!dir?.startsWith('/tmp/pidot-group-kill-'))throw Error('Isolated directory required')
const input={requestId:'group-kill-request',title:'群恢复夹具',adminBotId:'todo',memberBotIds:['todo','calendar']}
const config={baseUrl:'https://fixture.invalid/v1',model:'group-recovery',apiKey:'fixture-only'}
const hold=async data=>{await writeFile(join(dir,'checkpoint.json'),JSON.stringify(data));await new Promise(()=>{})}
let saved
const store=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(config),beforeCommit:phase==='before-create'?data=>hold(data):undefined,
 modelReply:async()=>{if(phase==='inflight')await hold(saved);return {mode:'model',reply:{content:'群恢复夹具回复'},execution:{usage:{totalTokens:4}}}}})
const {group,task}=await store.createGroup(phase==='inflight'?{...input,parameters:{callLimits:{modelCalls:1,toolCalls:0,totalTokens:1000}}}:input);saved={group,taskId:task.taskId,conversationId:task.conversationId}
if(phase==='created')await hold(saved)
const accepted=await store.send(task.taskId,'首条群消息，不得重复');saved.messageId=accepted.messageId
if(phase==='replied') {
 for(let i=0;i<500;i++){const state=await store.get(task.taskId);if(state.activeInputId===null&&state.messages.some(m=>m.role==='assistant'))await hold(saved);await new Promise(r=>setTimeout(r,10))}
 throw Error('Reply checkpoint timeout')
}
await new Promise(()=>{})
