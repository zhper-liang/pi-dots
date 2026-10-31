import {readMockEvent} from '../tools.mjs'
export const issueConfig={baseUrl:'https://fixture.invalid/v1',model:'group-issues-fixture',apiKey:'fixture-only'}
export const parentTools=['collaborators_list','task_assign','task_review','blocker_resolve','blocker_escalate']
export const childTools=['report_blocker','calendar_read_schedule','calendar_read_event','calendar_reschedule_event']
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
let seq=0
const turn=(name,args)=>{const c={type:'toolCall',id:`gi-${++seq}`,name,arguments:args};return {...text(''),toolCalls:[c],assistant:{role:'assistant',content:[c],api:'openai-completions',provider:'fixture',model:issueConfig.model,stopReason:'toolUse',timestamp:Date.now()}}}
export async function issueModel(_m,o) {
 const ms=o.context.messages, str=JSON.stringify(ms)
 if(o.parametersBotId==='calendar') {
  const results=ms.filter(m=>m.role==='toolResult')
  if(!str.includes('模拟时区问题'))return turn('report_blocker',{question:'模拟时区问题：请主管提供时区',requiredInformation:'时区',assignee:'supervisor'})
  if(!str.includes('模拟用户偏好问题'))return turn('report_blocker',{question:'模拟用户偏好问题：请由用户决定',requiredInformation:'个人偏好',assignee:'supervisor'})
  const last=results.at(-1)
  if(!results.some(r=>r.toolName==='calendar_read_schedule'))return turn('calendar_read_schedule',{resource:'mock:personal',date:'2026-10-19'})
  if(!results.some(r=>r.toolName==='calendar_read_event'))return turn('calendar_read_event',{resource:'mock:personal',eventId:'mock-20261019-1'})
  if(!results.some(r=>r.toolName==='calendar_reschedule_event')) {
   const before=readMockEvent({resource:'mock:personal',eventId:'mock-20261019-1'}).event
   return turn('calendar_reschedule_event',{resource:'mock:personal',eventId:before.id,expectedStart:before.start,expectedEnd:before.end,start:'2026-10-19T15:00:00+08:00',end:'2026-10-19T16:00:00+08:00'})
  }
  return text(str.includes('补充校验码GROUP-04')?'第二版模拟结果；校验码GROUP-04；已有成功操作不再执行。':`第一版模拟结果，审批回执 ${last?.toolName}`)
 }
 const notice=ms.filter(m=>typeof m.content==='string'&&m.content.includes('宿主关联的子任务阻塞通知')).at(-1)
 if(notice) {
  const n=JSON.parse(notice.content.slice(notice.content.indexOf('{')))
  if(n.status==='pending'&&n.assignee==='supervisor')return turn(n.question.includes('偏好')?'blocker_escalate':'blocker_resolve',{taskId:n.taskId,blockerId:n.id,version:n.version,rootWorkId:n.rootWorkId,inReplyTo:n.childInputId??n.inReplyTo,...(n.question.includes('偏好')?{reason:'个人偏好必须由认证用户决定'}:{answer:'Asia/Shanghai'})})
 }
 const result=ms.filter(m=>typeof m.content==='string'&&m.content.includes('宿主关联的子任务结果')).at(-1)
 if(result) {
  const n=JSON.parse(result.content.slice(result.content.indexOf('{')))
  if(str.includes('第二版满足标准'))return text('主管已精确接受第二版模拟结果。')
  return turn('task_review',{operationId:`review-${n.revision}`,childTaskId:n.childTaskId,rootWorkId:n.rootWorkId,revision:n.revision,expectedState:'submitted',decision:n.revision===1?'request-rework':'accept',reason:n.revision===1?'补充校验码GROUP-04；不要重复已成功动作':'第二版满足标准'})
 }
 return text('主管保留等待或已接受，按原工作回报。')
}

export async function configureIssues(s) {
 for(const id of ['todo','calendar']){const {bot}=await s.getBotConfiguration(id);await s.updateBotConfiguration(id,{requestId:'issues04-config-'+id,expectedVersion:bot.configRef.version,description:bot.description,tools:id==='todo'?parentTools:childTools,resources:id==='todo'?[]:['mock:personal']})}
 const {addRule,PolicyRules}=await import('../policy.mjs'),{BACKGROUND_CONTEXT}=await import('@earendil-works/chord/context')
 await s.harness.commit(async tx=>{const match={tool:'calendar_reschedule_event'};if(!(await tx.doc(PolicyRules)).items.some(r=>r.botId==='calendar'&&r.effect==='ask'&&r.match.tool===match.tool))await addRule(tx,{botId:'calendar',match,effect:'ask'})},BACKGROUND_CONTEXT)
}
