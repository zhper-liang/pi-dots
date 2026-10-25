import { openTaskStore } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
import { COLLABORATION_TOOLS } from '../collaboration-tools.mjs'
const [file,boundary]=process.argv.slice(2)
if(!file?.startsWith('/tmp/'))throw Error('Isolated test database only')
const config={baseUrl:'https://fixture.invalid/v1',model:'collaboration-fixture',apiKey:'fixture-only'}
let calls=0
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
const store=await openTaskStore({file,bots:listBots(config),modelReply:async(_m,o)=>{
 if(o.parametersBotId==='todo'&&++calls===1){const call={type:'toolCall',id:'assign-before-kill',name:'task_assign',arguments:{operationId:'stable-kill',botId:'calendar',goal:'isolated brief',completionCriteria:['return result']}};return {...text(''),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:config.model,stopReason:'toolUse',timestamp:Date.now()}}}
 if(o.parametersBotId==='calendar'&&boundary==='created')await new Promise(()=>{})
 return text(o.parametersBotId==='todo'?'parent after result':'child result before kill')
}})
const {bot}=await store.getBotConfiguration('todo')
await store.updateBotConfiguration('todo',{requestId:'kill-assignment',expectedVersion:bot.configRef.version,description:bot.description,tools:COLLABORATION_TOOLS,resources:[]})
const p=await store.create({botId:'todo'})
let emitted=false
store.harness.subscribeCommits(({changes})=>{
 const target=boundary==='created'?'pidot.collaboration-assigned':boundary==='published'?'pidot.model-reply':'pidot.collaboration-result'
 const entry=changes.find(c=>c.type==='entry'&&c.value.kind===target&&(boundary!=='published'||c.value.data.content==='child result before kill'))
 if(entry&&!emitted){emitted=true;console.log('CHECKPOINT '+JSON.stringify({parentTaskId:p.taskId,boundary}));process.kill(process.pid,'SIGSTOP')}
})
await store.send(p.taskId,'root work before kill')
setTimeout(()=>{console.error('boundary timeout');process.exit(3)},15000)
