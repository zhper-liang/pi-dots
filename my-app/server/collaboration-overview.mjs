import { sharedInformationService } from './shared-information.mjs'
import { Collaboration } from './collaboration.mjs'
import { BotDirectory } from './bot-directory.mjs'
import { GroupResultSources, projectGroupResult } from './group-result-provenance.mjs'
import { TaskCancellation, readCancelledArchive } from './cancellation.mjs'
import { callLimits, toolSets, ToolAccess } from './tools.mjs'
// Read-only aggregation of existing owned Documents. Never a second execution ledger.
export async function collaborationOverview(tx,id,tokens) {
  const {TaskCard,ChatInput,CallUsage,TaskApprovals,TaskBlockers,ChatQueue}=tokens
  const state=await tx.doc(Collaboration), own=state.items.find(r=>r.childTaskId===id)
  const parentId=own?.parentTaskId??id, rows=state.items.filter(r=>r.parentTaskId===parentId)
  const parentRecord=await tx.task(parentId)
  const parentArchive=parentRecord.state.status==='terminal'?await readCancelledArchive(tx,parentId):null
  const parentCard=parentArchive?parentArchive.documents[TaskCard.definition.kind]:await tx.doc(TaskCard,parentId)
  if(!rows.length&&parentCard.kind!=='group')return null
  const directory=await tx.doc(BotDirectory), access=await tx.doc(ToolAccess)
  const nodes=[], controlEvents=[]
  let sourceCard
  for(const taskId of new Set([parentId,...rows.map(r=>r.childTaskId)])) {
    const record=await tx.task(taskId)
    const archive=record.state.status==='terminal'?await readCancelledArchive(tx,taskId):null
    if(record.state.status==='terminal'&&!archive) {
      const relation=rows.find(r=>r.childTaskId===taskId)
      nodes.push({taskId,botId:record.input.botId,botName:'执行者（故障结束）',role:'executor',botStatus:'active',runtime:{status:'terminal',checkpoint:{lastOutcome:'failed'}},activeInputId:null,usage:{},limits:{},pending:[],rootWorkId:relation?.rootWorkId,businessStatus:'failed'})
      continue
    }
    const doc=token=>archive?archive.documents[token.definition.kind]:tx.doc(token,taskId)
    const card=await doc(TaskCard), slot=await doc(ChatInput), approvals=await doc(TaskApprovals), blockers=await doc(TaskBlockers)
    if(taskId===id)sourceCard=card
    const relation=rows.find(r=>r.childTaskId===taskId)
    const cancellation=archive?.cancellation??(record.state.status==='terminal'?null:(await tx.doc(TaskCancellation,taskId)).request)
    if(cancellation)controlEvents.push({id:`cancel:${taskId}:${cancellation.entryId}`,kind:'task-cancelled',taskId,rootWorkId:relation?.rootWorkId??`${taskId}:${cancellation.activeInputId}`,at:cancellation.requestedAt})
    const queue=ChatQueue?await doc(ChatQueue):null
    const sources=relation&&record.state.status!=='terminal'?(await tx.doc(GroupResultSources,taskId)).inputs[relation.childInputId]??[]:[]
    let restricted=sources.length>0&&(await projectGroupResult(tx,parentCard,relation,{sources,inReplyTo:relation.childInputId},tokens)).visibility==='permission-denied'
    const bot=directory.items.find(b=>b.id===card.bot.id), sets=toolSets(card,directory.items,access)
    if (!await (await import('./workspace-grants.mjs')).workspaceHistoryAllowed(tx, card, sets)) restricted = true
    nodes.push({taskId,groupId:taskId===parentId?parentCard.groupId:undefined,rootWorkId:relation?.rootWorkId,sourceMessageId:relation?.sourceMessageId,businessStatus:relation?.businessStatus,queueLength:queue?.entryIds.length??0,botId:card.bot.id,botName:card.bot.name,role:taskId===parentId?'supervisor':'executor',botStatus:bot ? (bot.status??'active') : 'inactive',runtime:JSON.parse(JSON.stringify(record.state)),activeInputId:slot.entryId,usage:JSON.parse(JSON.stringify(await doc(CallUsage))),limits:callLimits(card.parameters),cancelled:!!cancellation||record.abortRequested,permissionRevoked:card.parameters.tools.some(n=>!sets.authorized.includes(n))||card.parameters.toolResources.some(n=>!sets.resources.includes(n)),pending:restricted?[]:[...blockers.items.filter(b=>b.status==='pending'&&!cancellation&&!(state.stops??[]).some(s=>s.rootWorkId===b.rootWorkId)).map(b=>({kind:'blocker',id:b.id,version:b.version,assignee:b.assignee,summary:b.question,createdAt:b.createdAt})),...approvals.items.filter(a=>!a.stoppedBy&&!cancellation&&!a.receipt&&(!a.decision||a.operation)).map(a=>({kind:'approval',id:a.id,summary:a.toolName,createdAt:a.createdAt}))]})
  }
  const events=[...controlEvents]
  for(const r of rows) {
    const source=await tx.entry(r.parentInputId)
    events.push({id:`route:${r.id}`,kind:'routed',taskId:r.parentTaskId,rootWorkId:r.rootWorkId,at:source?.createdAt??r.createdAt})
    if(r.consumedEntryId){const receipt=await tx.entry(r.consumedEntryId);events.push({id:`consumed:${r.id}:${r.consumedEntryId}`,kind:'reported-to-supervisor',taskId:r.parentTaskId,rootWorkId:r.rootWorkId,at:receipt?.data.createdAt??r.result?.submittedAt})}
  }
  for(const n of nodes) {
    const bot=directory.items.find(b=>b.id===n.botId)
    if(bot?.status==='inactive')events.push({id:`inactive:${n.taskId}:${bot.deactivatedAt}`,at:bot.deactivatedAt,kind:'bot-inactive',taskId:n.taskId,rootWorkId:rows.find(r=>r.childTaskId===n.taskId)?.rootWorkId??'supervisor'})
    if(n.permissionRevoked)events.push({id:`permission:${n.taskId}`,kind:'permission-revoked',taskId:n.taskId,rootWorkId:rows.find(r=>r.childTaskId===n.taskId)?.rootWorkId??'supervisor'})
    for(const i of n.pending)events.push({id:`pending:${n.taskId}:${i.kind}:${i.id}:${i.version??0}`,at:i.createdAt,kind:`pending-${i.kind}`,taskId:n.taskId,rootWorkId:rows.find(r=>r.childTaskId===n.taskId)?.rootWorkId??'supervisor'})
  }
  // Use the same current shared-access projection, not raw shared Document bodies.
  for(const row of await sharedInformationService({TaskCard,ChatInput,bots:directory.items}).userView(tx,sourceCard)) if(!row.status) events.push({id:`shared:${row.recordId}:${row.version}:${row.accessVersion}`,at:row.createdAt,kind:'shared-access',taskId:row.source.taskId,rootWorkId:row.rootWorkId})
  const parent=nodes.find(n=>n.taskId===parentId)
  const activeInputId=parent.activeInputId??(parent.runtime.checkpoint?.lastOutcome==='limited'?parent.runtime.checkpoint.lastInputId:null)
  const roots=[...new Map(rows.map(r=>[r.rootWorkId,{rootWorkId:r.rootWorkId,parentInputId:r.parentInputId}])).values()]
  for(const stop of (state.stops??[]).filter(s=>s.parentTaskId===parentId))if(!roots.some(r=>r.rootWorkId===stop.rootWorkId))roots.push({rootWorkId:stop.rootWorkId,parentInputId:stop.parentInputId})
  if(parentCard.kind==='group'&&activeInputId!=null&&!roots.some(r=>r.parentInputId===activeInputId))roots.push({rootWorkId:`${parentId}:${activeInputId}`,parentInputId:activeInputId})
  const totals=nodes.reduce((sum,n)=>{for(const key of Object.keys(sum))sum[key]+=n.usage[key]??0;return sum},{modelCalls:0,toolCalls:0,totalTokens:0,unknownTokenCalls:0})
  return JSON.parse(JSON.stringify({version:1,parentTaskId:parentId,groupId:parentCard.groupId,activeRootWorkId:activeInputId==null?null:`${parentId}:${activeInputId}`,roots,totals,nodes,stops:(state.stops??[]).filter(s=>s.parentTaskId===parentId),events:events.concat(rows.flatMap(r=>[{id:`assigned:${r.id}`,rootWorkId:r.rootWorkId,at:r.createdAt,kind:'assigned',taskId:r.childTaskId},...(r.blockers??[]).map(b=>({id:`blocker:${b.id}:${b.version}`,rootWorkId:r.rootWorkId,at:b.createdAt,kind:'blocker',taskId:r.childTaskId})),...(r.decisions??[]).map(d=>({id:`review:${d.entryId}`,rootWorkId:r.rootWorkId,at:d.createdAt,kind:d.decision,taskId:r.childTaskId})),...(r.revisions??[]).map(v=>({id:`result:${r.id}:${v.revision}`,rootWorkId:r.rootWorkId,at:v.submittedAt,kind:v.status,taskId:r.childTaskId}))]).concat((state.stops??[]).filter(s=>s.parentTaskId===parentId).map(s=>({id:`stop:${s.entryId}`,rootWorkId:s.rootWorkId,at:s.requestedAt,kind:'root-stopped',taskId:s.parentTaskId})))).sort((a,b)=>(a.at??'').localeCompare(b.at??'')||a.id.localeCompare(b.id))}))
}
