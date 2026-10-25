import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {openTaskStore} from '../tasks.mjs'
import {listBots} from '../bots.mjs'
import {issueConfig,issueModel,configureIssues} from './group-issues-model.mjs'
const [dir,phase]=process.argv.slice(2)
if(!dir?.startsWith('/tmp/pidot-issues-kill-'))throw Error('Isolated directory required')
setInterval(()=>{},1000)
let saved,holdReview=false
const store=await openTaskStore({file:join(dir,'isolated.sqlite'),bots:listBots(issueConfig),modelReply:async(m,o)=>{
 if(o.parametersBotId==='todo'&&phase==='review'&&o.context.messages.some(m=>typeof m.content==='string'&&m.content.includes('宿主关联的子任务结果'))) {holdReview=true;await new Promise(()=>{})}
 return issueModel(m,o)
}})
await configureIssues(store)
const {task}=await store.createGroup({requestId:'issues-kill-group',title:'群事项恢复',adminBotId:'todo',memberBotIds:['todo','calendar']})
saved={taskId:task.taskId,groupId:task.groupId}
await store.send(task.taskId,{message:'执行问题审批返工',targetBotId:'calendar',requestId:'issues-kill-input'})
let answered=false,approved=false
for(;;){const p=await store.get(task.taskId),c=p.groupIssues[0];if(c){
 const b=c.blockers.items.find(b=>b.assignee==='user'&&b.status==='pending')
 if(b&&!answered){if(phase==='blocker'){await writeFile(join(dir,'checkpoint.json'),JSON.stringify({...saved,childTaskId:c.taskId,blocker:b}));await new Promise(()=>{})}await store.resolveBlocker(c.taskId,b.id,{answer:'用户选下午',version:b.version,rootWorkId:b.rootWorkId,inReplyTo:b.inReplyTo});answered=true}
 const a=c.approvals.items.find(a=>a.status==='pending')
 if(a&&!approved){if(phase==='approval'){await writeFile(join(dir,'checkpoint.json'),JSON.stringify({...saved,childTaskId:c.taskId,approvalId:a.id}));await new Promise(()=>{})}await store.decideApproval(c.taskId,a.id,{decision:'approved'});approved=true}
 if(phase==='accepted'&&p.activeInputId===null&&p.collaborations[0]?.businessStatus==='accepted'){const child=await store.get(c.taskId);await writeFile(join(dir,'checkpoint.json'),JSON.stringify({...saved,childTaskId:c.taskId,conversationId:p.conversationId,childConversationId:child.conversationId,inputId:p.collaborations[0].parentInputId,collaborations:p.collaborations,totals:p.collaborationOverview.totals}));await new Promise(()=>{})}
 if(holdReview){await writeFile(join(dir,'checkpoint.json'),JSON.stringify({...saved,childTaskId:c.taskId,revision:p.collaborations[0].result.revision}));await new Promise(()=>{})}
 }await new Promise(r=>setTimeout(r,10))}
