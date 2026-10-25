import { assertGroupTask } from './groups.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { createHash } from 'node:crypto'
import { Collaboration } from './collaboration.mjs'
import { ToolAccess, toolSets } from './tools.mjs'
import { assertBotActive } from './bot-directory.mjs'
import { assertNotCancelled } from './cancellation.mjs'
import { TaskInputError } from './task-config.mjs'
import { validSharedArgs } from './shared-tools.mjs'
import { workspaceHistoryAllowed, workspaceShareAllowed, workspaceUsedResources, workspaceUsedTools } from './workspace-grants.mjs'
export const SharedInformation=defineDoc({kind:'pidot.shared-information',version:1,scope:'session',initial:()=>({records:[],operations:[]})})
const copy=x=>JSON.parse(JSON.stringify(x))
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const fail=(code,message)=>{throw new TaskInputError(409,code,message)}
export function sharedInformationService({TaskCard,ChatInput,bots}) {
 async function scope(tx,card,entryId) {
  await assertNotCancelled(tx,card.taskId,await tx.task(card.taskId));await assertBotActive(tx,card.bot.id)
  const sets=toolSets(card,bots,await tx.doc(ToolAccess))
  const record=await tx.task(card.taskId)
  if(record.input.botId!==card.bot.id||card.configRef.botId!==card.bot.id||(await tx.conversation(card.conversationId))?.owner?.taskId!==card.taskId)fail('SHARED_DENIED','共享身份不匹配。')
  const state=await tx.doc(Collaboration), child=state.items.find(i=>i.childTaskId===card.taskId)
  const inputId=entryId??(await tx.doc(ChatInput,card.taskId)).entryId
  const rootWorkId=child?.rootWorkId??`${card.taskId}:${inputId}`
  if((state.stops??[]).some(s=>s.rootWorkId===rootWorkId))fail('SHARED_DENIED','本根工作已停止，不能继续共享访问。')
  const relations=state.items.filter(i=>i.rootWorkId===rootWorkId)
  if(!relations.length)fail('SHARED_DENIED','尚无对应协作工作。')
  const root=await tx.doc(TaskCard,relations[0].parentTaskId)
  await assertNotCancelled(tx,root.taskId,await tx.task(root.taskId));await assertBotActive(tx,root.bot.id)
  if(!toolSets(root,bots,await tx.doc(ToolAccess)).authorized.includes('task_assign'))fail('SHARED_DENIED','主管协作权限已撤销。')
  const group=await assertGroupTask(tx,root)
  if(group) {
   if(relations.some(r=>r.groupId!==group.groupId||r.parentTaskId!==root.taskId||!group.memberBotIds.includes(r.executorBotId)) || card.taskId!==root.taskId&&!relations.some(r=>r.childTaskId===card.taskId&&r.executorBotId===card.bot.id))fail('SHARED_DENIED','群共享身份或同根关系不匹配。')
  } else if(relations.some(r=>r.groupId)||card.kind==='group'||card.forkSource)fail('SHARED_DENIED','群与私聊来源不匹配。')
  return {sets,rootWorkId,relations,root,groupId:group?.groupId}
 }
 async function readable(tx,card,row,s,seen=new Set()) {
  if (!await (await import('./feishu-calendar.mjs')).feishuTaskAllowed(tx,card,s.sets)) return false
  if(seen.has(row.id))return false;seen.add(row.id)
  if((row.groupId??null)!==(s.groupId??null)||row.supervisorTaskId!==s.root.taskId||row.rootWorkId!==s.rootWorkId||!s.sets.authorized.includes('shared_read')||![row.source.taskId,row.supervisorTaskId,...row.readers].includes(card.taskId))return false
  await assertBotActive(tx,row.source.botId)
  if((await tx.task(row.source.taskId))?.state.status==='terminal')return false
  const author=await tx.doc(TaskCard,row.source.taskId)
  if(s.groupId && (author.taskId!==s.root.taskId&&!s.relations.some(r=>r.childTaskId===author.taskId&&r.executorBotId===row.source.botId)||author.bot.id!==row.source.botId))return false
  const access=await tx.doc(ToolAccess), authorSets=toolSets(author,bots,access)
  if (!await (await import('./feishu-calendar.mjs')).feishuTaskAllowed(tx,author,authorSets)) return false
  if (!workspaceShareAllowed(author, card, access) || !await workspaceHistoryAllowed(tx, author, authorSets) || !await workspaceHistoryAllowed(tx, card, s.sets)) return false
  for(const id of row.dependencies??[]){const origin=(await tx.doc(SharedInformation)).records.find(r=>r.id===id);if(!origin||!await readable(tx,card,origin,s,new Set(seen)))return false}
  return row.resources.every(r=>s.sets.resources.includes(r)&&authorSets.resources.includes(r))&&row.resourceTools.every(t=>authorSets.authorized.includes(t)&&s.sets.authorized.includes(['calendar_feishu_create_event','calendar_feishu_update_event','calendar_feishu_delete_event'].includes(t)?'calendar_feishu_read_event':t))
 }
 function view(r) {return copy({recordId:r.id,kind:r.kind,groupId:r.groupId,visibility:'restricted-task',rootWorkId:r.rootWorkId,source:r.source,version:r.revisions.length,accessVersion:r.accessVersion,readers:r.readers,content:r.revisions.at(-1).content,createdAt:r.revisions.at(-1).createdAt})}
 async function list(tx,card,entryId) {
  const s=await scope(tx,card,entryId), rows=[]
  for(const r of (await tx.doc(SharedInformation)).records)if(await readable(tx,card,r,s))rows.push(view(r))
  return rows.slice(-20)
 }
 async function execute(tx,card,call,entryId) {
  if(!validSharedArgs(call))fail('TOOL_INVALID_ARGUMENTS','共享schema或大小无效；禁止来源/控制字段。')
  const s=await scope(tx,card,entryId)
  if(!s.sets.authorized.includes(call.name))fail('SHARED_DENIED','共享工具未授权或已撤销。')
  if(!s.sets.authorized.includes('shared_read'))fail('SHARED_DENIED','发布和关联需要当前shared_read许可。')
  const input=await tx.entry(entryId)
  if(input?.conversationId!==card.conversationId||input.kind!=='pidot.user'||(await tx.doc(ChatInput,card.taskId)).entryId!==entryId)fail('SHARED_DENIED','只允许当前输入。')
  const a=call.arguments, doc=await tx.doc(SharedInformation)
  if(call.name==='shared_read') {
   let rows=await list(tx,card,entryId)
   if(a.recordId){const row=doc.records.find(r=>r.id===a.recordId);rows=row&&await readable(tx,card,row,s)?[view(row)]:[]}
   if(a.recordId&&!rows.some(r=>r.recordId===a.recordId))fail('SHARED_DENIED','记录不存在或当前不可读。')
   const selected=[];let bytes=100
   for(const r of rows){const size=Buffer.byteLength(JSON.stringify(r),'utf8');if(bytes+size>7000)break;bytes+=size;selected.push(r)}
   return {ok:true,data:{records:selected,truncated:selected.length<rows.length,notice:'只返回当前可读的有限条目；更多记录可通过主管提供的精确recordId读取，不枚举全库。'}}
  }
  const key=`${card.taskId}:${entryId}:${a.operationId}`,signature=hash([call.name,a]),prior=doc.operations.find(o=>o.key===key)
  if(prior){if(prior.signature!==signature)fail('SHARED_CONFLICT','操作标识冲突。');return {ok:true,data:copy(prior.receipt),replayed:true}}
  if(doc.operations.filter(o=>o.receipt.rootWorkId===s.rootWorkId).length>=1000)fail('SHARED_LIMIT','当前工作共享操作达到上限。')
  let row
  if(call.name==='shared_publish') {
   const id=`shared:${hash([s.rootWorkId,card.taskId,a.recordId])}`
   row=doc.records.find(r=>r.id===id)
   if((row?.revisions.length??0)!==a.expectedVersion)fail('SHARED_CONFLICT','内容版本已变化。')
   const dependencies=[]
   for(const origin of doc.records)if(origin.id!==id&&!(origin.dependencies??[]).includes(id)&&await readable(tx,card,origin,s))dependencies.push(origin.id)
   if(!row){if(doc.records.filter(r=>r.rootWorkId===s.rootWorkId).length>=100)fail('SHARED_LIMIT','工作共享记录达到上限。');row={id,...(s.groupId?{groupId:s.groupId}:{}),rootWorkId:s.rootWorkId,kind:a.kind,source:{botId:card.bot.id,taskId:card.taskId,inputId:entryId},dependencies,supervisorTaskId:s.root.taskId,readers:[],accessVersion:0,resources:copy([...new Set([...(card.parameters.toolResources??[]),...workspaceUsedResources(card)])]),resourceTools:[...new Set([...(card.parameters.tools??[]),...workspaceUsedTools(card)])].filter(t=>t.startsWith('calendar_')||t.startsWith('workspace.')||t==='tool_result_read'),revisions:[]};doc.records.push(row);row=doc.records.at(-1)}
   if(row.kind!==a.kind||row.revisions.length>=10)fail('SHARED_LIMIT','记录类型不可变或版本上限。')
   row.dependencies=[...new Set([...(row.dependencies??[]),...dependencies])]
   row.revisions.push({version:row.revisions.length+1,content:copy(a.content),createdAt:new Date().toISOString(),source:{...copy(row.source),inputId:entryId}})
  } else {
   row=doc.records.find(r=>r.id===a.recordId)
   if(!row||s.root.taskId!==card.taskId||!await readable(tx,card,row,s)||!s.relations.some(r=>r.childTaskId===a.targetTaskId))fail('SHARED_DENIED','仅主管可向同根直接子Task关联。')
   if(row.revisions.length!==a.expectedVersion||row.accessVersion!==a.expectedAccessVersion)fail('SHARED_CONFLICT','内容或访问版本已变化。')
   await assertBotActive(tx,(await tx.doc(TaskCard,a.targetTaskId)).bot.id)
   row.readers=row.readers.filter(id=>id!==a.targetTaskId);if(a.allow)row.readers.push(a.targetTaskId);row.accessVersion++
  }
  const receipt={recordId:row.id,version:row.revisions.length,accessVersion:row.accessVersion,rootWorkId:row.rootWorkId,source:copy(row.source),...(row.groupId?{groupId:row.groupId}:{})}
  doc.operations.push({key,signature,receipt:copy(receipt)})
  await tx.appendEntry(card.conversationId,{kind:'pidot.shared-write',data:{...receipt,operation:call.name,inReplyTo:entryId,createdAt:new Date().toISOString()}})
  return {ok:true,data:receipt}
 }
 async function userView(tx,card) {
  // Authenticated task-page viewer may see records for this Task's related work only.
  const relations=(await tx.doc(Collaboration)).items.filter(r=>r.parentTaskId===card.taskId||r.childTaskId===card.taskId),roots=new Set(relations.map(r=>r.rootWorkId))
  const records=(await tx.doc(SharedInformation)).records.filter(r=>roots.has(r.rootWorkId)&&[r.source.taskId,r.supervisorTaskId,...r.readers].includes(card.taskId))
  const visible=[]
  for(const row of records){try{const s=await scope(tx,card,relations.find(r=>r.rootWorkId===row.rootWorkId)?.parentInputId);if(await readable(tx,card,row,s)){visible.push({...view(row),revisions:copy(row.revisions)});continue}}catch(e){if(!(e instanceof TaskInputError))throw e}visible.push({recordId:row.id,status:'permission-denied',message:'当前共享或资源权限不足；内容已隐藏。'})}
  return visible
 }
 async function prepareLinks(tx,card,entryId,refs) {
  const s=await scope(tx,card,entryId)
  if(s.root.taskId!==card.taskId||!s.sets.authorized.includes('shared_read')||!s.sets.authorized.includes('shared_link'))fail('SHARED_DENIED','原子分享需要主管当前read/link许可。')
  const rows=[]
  for(const ref of refs) {
   const row=(await tx.doc(SharedInformation)).records.find(r=>r.id===ref.recordId)
   if(!row||!await readable(tx,card,row,s))fail('SHARED_DENIED','共享来源不可读。')
   if(row.revisions.length!==ref.version||row.accessVersion!==ref.accessVersion)fail('SHARED_CONFLICT','原子分享版本已变化。')
   if(rows.some(r=>r.id===row.id))fail('SHARED_CONFLICT','不允许重复来源。')
   rows.push(row)
  }
  return rows
 }
 async function validateContext(tx,card,entryId,versions=[]) {
  if(!versions.length)return
  const rows=await list(tx,card,entryId)
  for(const v of versions)if(!rows.some(r=>r.recordId===v.recordId&&r.version===v.version&&r.accessVersion===v.accessVersion))fail('SHARED_DENIED','共享依据在派发前变化或已撤回；拒绝发送过期上下文。')
 }
 return {execute,list,userView,validateContext,prepareLinks}
}
