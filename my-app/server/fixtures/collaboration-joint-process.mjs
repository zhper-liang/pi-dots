import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {openTaskStore} from '../tasks.mjs'
import {listBots} from '../bots.mjs'
import {config,tools,driver} from './collaboration-joint-driver.mjs'
import {addRule} from '../policy.mjs'
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context'
const [dir,boundary]=process.argv.slice(2)
if(!dir?.startsWith('/tmp/pidot-joint-06-'))throw Error('isolated database only')
let store,parent,stopped=false
function stop(extra={}){if(stopped)return;stopped=true;writeFileSync(join(dir,'checkpoint.json'),JSON.stringify({parentTaskId:parent.taskId,boundary,...extra}));process.kill(process.pid,'SIGSTOP')}
store=await openTaskStore({file:join(dir,'test.sqlite'),bots:listBots(config),modelReply:driver(()=>store),calendarWriteImpl:async(_op,{execute})=>{const receipt=await execute();if(boundary==='effect')stop({effect:true});return receipt}})
for(const id of ['chief','calendar','todo']){const {bot}=await store.getBotConfiguration(id);await store.updateBotConfiguration(id,{requestId:'joint06-config-'+id,expectedVersion:bot.configRef.version,description:bot.description,tools,resources:['mock:personal']})}
await store.harness.commit(tx=>addRule(tx,{botId:'calendar',match:{tool:'calendar_reschedule_event'},effect:'ask'}),context)
parent=await store.create({botId:'chief'})
store.harness.subscribeCommits(({changes})=>{
 const entries=changes.filter(c=>c.type==='entry').map(c=>c.value)
 if(boundary==='assigned'&&entries.some(e=>e.kind==='pidot.collaboration-assigned'))stop()
 if(boundary==='answered'&&entries.some(e=>e.kind==='pidot.blocker-resolved'&&e.data.source==='authenticated-user'))stop()
 if(boundary==='submitted'&&entries.some(e=>e.kind==='pidot.collaboration-result'&&e.data.status==='submitted'))stop()
 if(boundary==='accepted'&&entries.some(e=>e.kind==='pidot.collaboration-reviewed'&&e.data.decision==='accept'))stop()
})
await store.send(parent.taskId,'联合场景，不是真实模型验收')
for(let n=0;n<1500;n++){
 const p=await store.get(parent.taskId),r=p.collaborations[0]
 if(r){const c=await store.get(r.childTaskId),b=c.blockers.items.find(b=>b.status==='pending'&&b.assignee==='user');if(b)await store.resolveBlocker(c.taskId,b.id,{answer:'JOINT-06',version:b.version,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo})
 const a=c.approvals.items.find(a=>!a.decision);if(a)await store.decideApproval(c.taskId,a.id,{decision:'approved'})}
 await new Promise(r=>setTimeout(r,10))
}
throw Error('boundary not reached')
