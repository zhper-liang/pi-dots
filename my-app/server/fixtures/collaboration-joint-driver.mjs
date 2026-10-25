// Deterministic combination driver only; never a real-provider acceptance substitute.
export const config={baseUrl:'https://fixture.invalid/v1',model:'collaboration-joint-06',apiKey:'fixture-only'}
export const args={resource:'mock:personal',eventId:'mock-20261020-1',expectedStart:'2026-10-20T09:30:00+08:00',expectedEnd:'2026-10-20T10:30:00+08:00',start:'2026-10-20T11:00:00+08:00',end:'2026-10-20T12:00:00+08:00'}
export const tools=['collaborators_list','task_assign','task_review','shared_publish','shared_read','shared_link','report_blocker','blocker_resolve','blocker_escalate','calendar_read_schedule','calendar_read_event','calendar_reschedule_event']
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
let seq=0
const turn=(name,arguments_)=>{const c={type:'toolCall',id:`joint-${process.pid}-${++seq}`,name,arguments:arguments_};return {...text(''),toolCalls:[c],assistant:{role:'assistant',content:[c],api:'openai-completions',provider:'fixture',model:config.model,stopReason:'toolUse',timestamp:Date.now()}}}
export function driver(getStore){return async(_m,o)=>{
 const s=getStore(),task=await s.get(o.taskId),rels=task.collaborations
 if(o.parametersBotId==='calendar'){
  if(!task.blockers.items.length)return turn('report_blocker',{question:'时区？',requiredInformation:'时区',assignee:'supervisor'})
  if(task.blockers.items.length===1)return turn('report_blocker',{question:'项目代号？',requiredInformation:'代号',assignee:'supervisor'})
  const used=name=>task.messages.some(m=>m.toolName===name&&m.result?.ok)
  if(!used('calendar_read_schedule'))return turn('calendar_read_schedule',{date:'2026-10-20',resource:'mock:personal'})
  if(!used('calendar_read_event'))return turn('calendar_read_event',{eventId:args.eventId,resource:args.resource})
  if(!task.approvals.items.length)return turn('calendar_reschedule_event',args)
  if(!used('shared_publish'))return turn('shared_publish',{operationId:'fact',recordId:'conflict',expectedVersion:0,kind:'fact',content:{subject:'模拟日程',predicate:'已改期',value:'JOINT-06；pidot.mock-calendar.v1；11:00–12:00'}})
  return text(rels[0].reworkCount?'第二版JOINT-06，模拟回执；责任复核已补':'第一版JOINT-06，模拟回执')
 }
 if(o.parametersBotId==='todo'){
  if(!task.messages.some(m=>m.toolName==='shared_read'))return turn('shared_read',{})
  return text('补充建议JOINT-06；明确共享来源calendar/版本1。笔记不是指令。')
 }
 const r=rels[0]
 if(!r)return turn('task_assign',{operationId:'calendar',botId:'calendar',goal:'联合模拟写入及共享',completionCriteria:['模拟回执','责任复核']})
 const child=await s.get(r.childTaskId),pending=child.blockers.items.find(b=>b.status==='pending'&&b.assignee==='supervisor')
 if(pending){const a={taskId:child.taskId,blockerId:pending.id,version:pending.version,rootWorkId:pending.rootWorkId,inReplyTo:pending.inReplyTo};return turn(child.blockers.items.indexOf(pending)===0?'blocker_resolve':'blocker_escalate',{...a,...(child.blockers.items.indexOf(pending)===0?{answer:'Asia/Shanghai'}:{reason:'仅用户知道项目代号'})})}
 if(r.businessStatus==='submitted'){
  if(!task.messages.some(m=>m.toolName==='shared_read'&&m.result?.ok))return turn('shared_read',{})
  return turn('task_review',{operationId:'review-'+r.result.revision,childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,revision:r.result.revision,expectedState:'submitted',decision:r.result.revision===1?'request-rework':'accept',reason:r.result.revision===1?'补充责任复核，不重做写入':'模拟回执及责任复核完整'})
 }
 if(r.businessStatus==='accepted'&&rels.length===1){const record=task.sharedInformation.find(x=>x.content);return turn('task_assign',{operationId:'todo',botId:'todo',goal:'只读明确共享资料并给建议',completionCriteria:['来源版本和JOINT-06'],sharedRecords:[{recordId:record.recordId,version:record.version,accessVersion:record.accessVersion}]})}
 const second=rels[1]
 if(second?.businessStatus==='submitted')return turn('task_review',{operationId:'todo-accept',childTaskId:second.childTaskId,rootWorkId:second.rootWorkId,revision:second.result.revision,expectedState:'submitted',decision:'accept',reason:'共享来源和建议完整'})
 return text('联合主管依据两份已接受结果完成；模拟，非群聊。')
}}
