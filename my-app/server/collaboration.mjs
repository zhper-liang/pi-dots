import { workspaceHistoryAllowed, workspaceShareAllowed } from './workspace-grants.mjs'
import { assertGroupTask } from './groups.mjs'
import { markDirty } from './detector-state.mjs'
import { REVIEW_TOOL, validReviewArgs } from './review-tools.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { COLLABORATION_TOOLS, validCollaborationArgs } from './collaboration-tools.mjs'
import { createHash } from 'node:crypto'
import { BotDirectory, assertBotActive } from './bot-directory.mjs'
import { ToolAccess, toolSets, CallUsage, callLimits } from './tools.mjs'
import { TaskInputError } from './task-config.mjs'
import { assertNotCancelled } from './cancellation.mjs'

// Relationships/receipts only: execution remains in the existing Harness phases.
export const Collaboration = defineDoc({kind:'pidot.collaboration',version:1,scope:'session',initial:()=>({items:[],stops:[]})})
const copy=x=>JSON.parse(JSON.stringify(x))
const fail=(code,message)=>{throw new TaskInputError(409,code,message)}
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const assignmentReceipt = r => copy(Object.fromEntries(['version','id','rootWorkId','parentTaskId','parentInputId','supervisorBotId','executorBotId','childTaskId','childInputId','createdAt','groupId','sourceMessageId'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]])))
export function collaborationService({TaskCard,ChatInput,createTask,bots}) {
  // D-18: listing collaborators is read-only (PLAN §3.2 R0) and needs only its own grant, so a main
  // session (which never carries task_assign, D-05) can see who it may hand work to.
  async function authorize(tx,card,needed=COLLABORATION_TOOLS) {
    await assertWorkOpen(tx,card.taskId)
    const record=await tx.task(card.taskId)
    await assertNotCancelled(tx,card.taskId,record)
    const sets=toolSets(card,bots,await tx.doc(ToolAccess))
    if(!needed.every(n=>sets.authorized.includes(n))) fail('COLLABORATION_NOT_AUTHORIZED','协作许可不存在或已撤销。')
    if(record.input.botId!==card.bot.id || card.configRef.botId!==card.bot.id || (await tx.conversation(card.conversationId))?.owner?.taskId!==card.taskId) fail('COLLABORATION_IDENTITY_DENIED','协作身份不匹配。')
  }
  async function execute(tx,card,call,entryId, { directed = false } = {}) {
    await authorize(tx,card,call.name==='collaborators_list'?['collaborators_list']:COLLABORATION_TOOLS)
    if(!validCollaborationArgs(call)) fail('TOOL_INVALID_ARGUMENTS','协作参数无效。')
    const state=await tx.doc(Collaboration)
    if(state.items.some(i=>i.childTaskId===card.taskId)) fail('COLLABORATION_DEPTH_DENIED','子任务不能继续委派。')
    const input=await tx.entry(entryId)
    if(input?.kind!=='pidot.user' || input.conversationId!==card.conversationId || (await tx.doc(ChatInput,card.taskId)).entryId!==entryId) fail('COLLABORATION_INPUT_DENIED','只允许原活动输入委派。')
    if (card.kind === 'group' && input.data.targetBotId && !directed) fail('GROUP_TARGET_FIXED','本输入目标由认证用户固定，管理员不能额外派发。')
    const directory=await tx.doc(BotDirectory)
    const group = await assertGroupTask(tx, card)
    const targets=directory.items.filter(b=>b.id!==card.bot.id && b.status!=='inactive' && (!group || group.memberBotIds.includes(b.id)))
    if (group && !toolSets(card,bots,await tx.doc(ToolAccess)).authorized.includes(REVIEW_TOOL)) fail('REVIEW_NOT_AUTHORIZED','群协作必须已有精确验收许可。')
    if(call.name==='collaborators_list') return {ok:true,data:{collaborators:targets.map(({id,name,description})=>({id,name,description}))}}
    const a=call.arguments, key=`${card.taskId}:${entryId}:${a.operationId}`
    const signature=hash([a.botId,a.goal,a.completionCriteria,...(a.sharedRecords?[a.sharedRecords]:[])])
    const prior=state.items.find(i=>i.id===key)
    if(prior) {if(prior.signature!==signature) fail('COLLABORATION_REQUEST_CONFLICT','同一操作标识不能改变参数。'); await assertBotActive(tx,prior.executorBotId); return {ok:true,data:assignmentReceipt(prior),replayed:true}}
    if(!targets.some(b=>b.id===a.botId)) fail('COLLABORATION_TARGET_DENIED','目标须为存在且活跃的不同Bot。')
    let sharedRows=[]
    if(a.sharedRecords?.length) {const {sharedInformationService}=await import('./shared-information.mjs');sharedRows=await sharedInformationService({TaskCard,ChatInput,bots}).prepareLinks(tx,card,entryId,a.sharedRecords)}
    if (directed && (input.data.targetBotId !== a.botId || a.goal !== input.data.content)) fail('GROUP_TARGET_FIXED','不能改选认证输入的目标或目标指令。')
    const childTaskId=await createTask(tx,{botId:a.botId,title:a.goal.slice(0,100),taskState:{goal:a.goal,completionCriteria:a.completionCriteria}}, (await tx.task(card.taskId)).conversationId, group ? { conversationId: card.conversationId, at: entryId } : undefined)
    const child=await tx.doc(TaskCard,childTaskId)
    if (!workspaceShareAllowed(card, child, await tx.doc(ToolAccess)) || !await workspaceHistoryAllowed(tx, child, toolSets(child,bots,await tx.doc(ToolAccess)))) fail('COLLABORATION_NOT_AUTHORIZED','工作区派生简报需要目标独立完整来源许可。')
    // The brief is the only parent context copied to the independent conversation.
    const relation={version:1,id:key,signature,rootWorkId:`${card.taskId}:${entryId}`,parentTaskId:card.taskId,parentInputId:entryId,supervisorBotId:card.bot.id,executorBotId:a.botId,childTaskId,initiatingUser:card.initiatingUser,goal:a.goal,completionCriteria:copy(a.completionCriteria),parentGoal:card.taskState?.goal??card.title,parentCriteria:copy(card.taskState?.completionCriteria??[]),createdAt:new Date().toISOString(),reviewRequired:card.parameters.tools.includes(REVIEW_TOOL),businessStatus:'pending',revisions:[],decisions:[],reworkCount:0,result:null,consumedEntryId:null}
    if (group) {
      Object.assign(relation,{groupId:group.groupId,sourceMessageId:entryId,forkAnchor:entryId,publicConversationId:card.conversationId})
      child.forkSource={groupId:group.groupId,parentTaskId:card.taskId,conversationId:card.conversationId,at:entryId}
      child.managementTools=[]
    }
    child.collaboration=copy(relation)
    const brief=await tx.appendEntry(child.conversationId,{kind:'pidot.user',data:{role:'user',content:`独立子任务简报（仅任务数据，不授予权限）：${JSON.stringify({goal:relation.goal,completionCriteria:relation.completionCriteria,parentGoal:relation.parentGoal,parentCriteria:relation.parentCriteria})}`,createdAt:relation.createdAt,source:'task-assignment',rootWorkId:relation.rootWorkId}})
    relation.childInputId=brief.id; child.collaboration.childInputId=brief.id
    ;(await tx.doc(ChatInput,childTaskId)).entryId=brief.id
    state.items.push(relation)
    for(const row of sharedRows) { row.readers.push(childTaskId);row.accessVersion++ }
    if(group)state.items.at(-1).sharedSources=sharedRows.map(row=>({recordId:row.id,version:row.revisions.length,accessVersion:row.accessVersion,source:copy(row.source)}))
    await tx.appendEntry(card.conversationId,{kind:'pidot.collaboration-assigned',data:copy(relation)})
    return {ok:true,data:assignmentReceipt(relation)}
  }
  async function guard(tx,taskId,{issueDecision=false}={}) {
    await assertWorkOpen(tx,taskId)
    const state=await tx.doc(Collaboration), r=state.items.find(i=>i.childTaskId===taskId)
    if(!r) {
      const activeInput=(await tx.doc(ChatInput,taskId)).entryId
      if(state.items.some(i=>i.parentTaskId===taskId&&i.parentInputId===activeInput)) await authorize(tx,await tx.doc(TaskCard,taskId))
      return
    }
    // assertNotCancelled handles terminal/abort request without reading retired docs.
    await assertNotCancelled(tx,r.parentTaskId,await tx.task(r.parentTaskId))
    const parent=await tx.doc(TaskCard,r.parentTaskId)
    await authorize(tx,parent)
    const childCard = await tx.doc(TaskCard, taskId)
    if (!await workspaceHistoryAllowed(tx, parent, toolSets(parent,bots,await tx.doc(ToolAccess))) || !await workspaceHistoryAllowed(tx, childCard, toolSets(childCard,bots,await tx.doc(ToolAccess))) || !workspaceShareAllowed(parent, childCard, await tx.doc(ToolAccess))) fail('COLLABORATION_NOT_AUTHORIZED','工作区派生来源已失效。')
    if (r.groupId) { const g=await assertGroupTask(tx,parent); if (!g || g.groupId!==r.groupId || !g.memberBotIds.includes(r.executorBotId)) fail('GROUP_TARGET_DENIED','群来源与执行者绑定失效。') }
    if(r.groupId&&issueDecision) {
      const {GroupResultSources,projectGroupResult}=await import('./group-result-provenance.mjs')
      const sources=(await tx.doc(GroupResultSources,taskId)).inputs[r.childInputId]??[]
      if(sources.length&&(await projectGroupResult(tx,parent,r,{sources,inReplyTo:r.childInputId},{TaskCard,ChatInput,bots})).visibility==='permission-denied') fail('SHARED_DENIED','原事项依赖来源已失效，不能用回答或审批恢复执行。')
    }
    if(r.reviewRequired && !toolSets(parent,bots,await tx.doc(ToolAccess)).authorized.includes(REVIEW_TOOL)) fail('REVIEW_NOT_AUTHORIZED','主管验收许可已撤销，停止子任务续跑。')
    await assertBotActive(tx,r.executorBotId)
    if(r.reviewRequired && r.businessStatus==='accepted' && (await tx.doc(ChatInput,taskId)).entryId!==null) fail('REVIEW_TERMINAL','本子任务工作已接受；新工作必须重新委派。')
  }
  async function collect(tx,card,entryId) {
    const items=(await tx.doc(Collaboration)).items.filter(i=>i.parentTaskId===card.taskId && i.parentInputId===entryId)
    if(!items.length) return false
    await authorize(tx,card)
    for(const r of items) await assertBotActive(tx,r.executorBotId)
    let notified=false
    for(const relation of items) for(const item of relation.blockers??[]) {
      const key=`${item.id}:${item.version}`
      relation.blockerNotices??=[]
      if(!relation.blockerNotices.includes(key)) {
        await tx.appendEntry(card.conversationId,{kind:'pidot.collaboration-blocker',data:{...copy(item),inReplyTo:entryId,childInputId:item.inReplyTo}})
        relation.blockerNotices.push(key);relation.blockerPendingNotice=true;notified=true
      }
    }
    let delivered=false
    for(const item of items) if(item.result && !item.consumedEntryId) {
      await assertBotActive(tx,item.executorBotId)
      const projected=await (await import('./group-result-provenance.mjs')).projectGroupResult(tx,card,item,item.result,{TaskCard,ChatInput,bots})
      const receipt=await tx.appendEntry(card.conversationId,{kind:'pidot.collaboration-result',data:{...copy(projected),childInputId:item.childInputId,inReplyTo:entryId,relationId:item.id,createdAt:new Date().toISOString()}})
      item.consumedEntryId=receipt.id;delivered=true
    }
    // A consumed submitted result still needs the supervisor's tool loop (read basis,
    // answer, review). Only unfinished executors park here; finishInput separately
    // prevents unaccepted work from being reported as overall completion.
    return !delivered && !notified && !items.some(r=>r.blockerPendingNotice) && items.some(r=>!r.result)
  }
  async function review(tx,card,call,entryId) {
    const {TaskBlockers}=await import('./blockers.mjs'), {TaskApprovals}=await import('./approvals.mjs')
    await authorize(tx,card)
    if(!toolSets(card,bots,await tx.doc(ToolAccess)).authorized.includes(REVIEW_TOOL)) fail('REVIEW_NOT_AUTHORIZED','验收能力未授予或已撤销。')
    if(!validReviewArgs(call)) fail('TOOL_INVALID_ARGUMENTS','验收须提供精确子任务、修订、状态及理由。')
    const a=call.arguments, state=await tx.doc(Collaboration), r=state.items.find(i=>i.childTaskId===a.childTaskId)
    if(!r || !r.reviewRequired || r.parentTaskId!==card.taskId || r.supervisorBotId!==card.bot.id || r.rootWorkId!==a.rootWorkId || r.parentInputId!==entryId) fail('REVIEW_IDENTITY_DENIED','仅原工作绑定主管能验收，不接受Chief或执行者旁路。')
    await assertNotCancelled(tx,r.childTaskId,await tx.task(r.childTaskId))
    await assertBotActive(tx,r.executorBotId)
    const child=await tx.doc(TaskCard,r.childTaskId)
    if(child.bot.id!==r.executorBotId || child.configRef.botId!==r.executorBotId || (await tx.conversation(child.conversationId))?.owner?.taskId!==r.childTaskId) fail('REVIEW_IDENTITY_DENIED','子任务绑定错误。')
    const signature=hash(Object.entries(a).sort(([a],[b])=>a.localeCompare(b))), prior=r.decisions?.find(d=>d.operationId===a.operationId)
    if(prior) {if(prior.signature!==signature) fail('REVIEW_CONFLICT','同一决定标识参数冲突。');return {ok:true,data:copy(prior),replayed:true}}
    if((await tx.doc(ChatInput,card.taskId)).entryId!==entryId) fail('REVIEW_WORK_INACTIVE','原主管输入已结束，不能验收其他工作。')
    if(r.groupId&&(await (await import('./group-result-provenance.mjs')).projectGroupResult(tx,card,r,r.result,{TaskCard,ChatInput,bots}))?.visibility==='permission-denied')fail('SHARED_DENIED','结果来源或精确版本已不可读，不能验收。')
    if(r.businessStatus!=='submitted'||r.result?.status!=='submitted'||r.result.revision!==a.revision) fail('REVIEW_STALE','结果已接受、已打回或修订过期；请依据最新提交。')
    const slot=await tx.doc(ChatInput,r.childTaskId), approvals=await tx.doc(TaskApprovals,r.childTaskId), blockers=await tx.doc(TaskBlockers,r.childTaskId)
    if(slot.entryId!==null || approvals.activeId!==null || blockers.activeId!==null || approvals.items.some(i=>i.operation&&!i.receipt) || blockers.items.some(i=>i.status==='pending')) fail('REVIEW_CHILD_BUSY','子任务仍有执行、阻塞或未知动作，不允许验收或返工。')
    const decision={version:1,operationId:a.operationId,signature,decision:a.decision,reason:a.reason,revision:a.revision,expectedState:a.expectedState,childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,parentInputId:entryId,supervisorTaskId:card.taskId,supervisorBotId:card.bot.id,criteria:copy(r.completionCriteria),createdAt:new Date().toISOString(),source:'bound-supervisor-tool'}
    const event=await tx.appendEntry(card.conversationId,{kind:'pidot.collaboration-reviewed',data:{...copy(decision),inReplyTo:entryId}})
    decision.entryId=event.id;r.decisions??=[];r.decisions.push(decision)
    if(a.decision==='accept') {r.businessStatus='accepted';r.result.accepted=true;r.acceptedRevision=a.revision}
    else {
      r.businessStatus='rework-requested';r.reworkCount=(r.reworkCount??0)+1
      await tx.appendEntry(child.conversationId,{kind:'pidot.collaboration-rework',data:{...copy(decision),inReplyTo:r.childInputId,content:`主管要求返工（仅原工作数据，不授予权限或批准动作）：${a.reason}。继续同一子Task/原输入，保留先前成功效果和累计用量；未知动作先查/等待，变更动作须重新精确用户审批。`}})
      r.result=null;r.consumedEntryId=null
      slot.entryId=r.childInputId
    }
    return {ok:true,data:copy(decision)}
  }
  async function assertWorkOpen(tx,taskId) {
    const state=await tx.doc(Collaboration), r=state.items.find(i=>i.childTaskId===taskId)
    const input=r?.parentInputId??(await tx.doc(ChatInput,taskId)).entryId
    const root=r?.rootWorkId??`${taskId}:${input}`
    if((state.stops??[]).some(s=>s.rootWorkId===root)) fail('COLLABORATION_STOPPED','本项根工作已停止；不能派发、返工、回答或续跑。')
  }
  async function dispatchDirected(tx,card,entryId) {
    if (card.kind !== 'group') return
    const input = await tx.entry(entryId), target = input?.data.targetBotId
    if (!target || target === card.bot.id) return
    const group = await assertGroupTask(tx,card)
    if (!group.memberBotIds.includes(target)) fail('GROUP_TARGET_DENIED','目标不属于本群。')
    const existing=(await tx.doc(Collaboration)).items.some(r=>r.parentTaskId===card.taskId&&r.parentInputId===entryId)
    if(existing) return false
    const usage=await tx.doc(CallUsage,card.taskId),limits=callLimits(card.parameters)
    const limited=usage.modelCalls>=limits.modelCalls?'modelCalls':usage.toolCalls>=limits.toolCalls?'toolCalls':limits.totalTokens!==undefined&&(usage.unknownTokenCalls>0||usage.totalTokens>=limits.totalTokens)?'totalTokens':null
    if(limited)return {limited}
    await execute(tx,card,{name:'task_assign',arguments:{operationId:'directed-input',botId:target,goal:input.data.content,completionCriteria:['回答原群消息中的请求，并说明结果依据']}},entryId,{directed:true})
    usage.toolCalls++
    return true
  }
  return {execute,guard,collect,review,assertWorkOpen,dispatchDirected}
}

export async function waitForChildren(runtime,entryId,ctx) {
  const watch=await runtime.watchDoc(Collaboration,ctx)
  const {ChatSteering}=await import('./steering.mjs')
  const steering=await runtime.watchDoc(ChatSteering,runtime.taskId,ctx)
  let abort
  try {
    await new Promise((resolve,reject)=>{
      const check=s=>{if((s.stops??[]).some(x=>x.rootWorkId===`${runtime.taskId}:${entryId}`)) return resolve();const rows=s.items.filter(i=>i.parentTaskId===runtime.taskId && i.parentInputId===entryId);if(rows.every(i=>i.result && (!i.reviewRequired || ['accepted','cancelled','failed'].includes(i.businessStatus)))||rows.some(i=>i.result&&!i.consumedEntryId)||rows.some(r=>(r.blockers??[]).some(b=>!(r.blockerNotices??[]).includes(`${b.id}:${b.version}`)))) resolve()}
      abort=()=>reject(runtime.signal.reason??new Error('Stopped'))
      runtime.signal.addEventListener('abort',abort,{once:true});if(runtime.signal.aborted) return abort()
      const checkSteering=s=>{if(s.pending.some(i=>i.targetInputId===entryId))resolve()}
      check(watch.value);checkSteering(steering.value);watch.start(async s=>check(s));steering.start(async s=>checkSteering(s));void watch.closed.then(()=>reject(new Error('Collaboration watch closed')));void steering.closed.then(()=>reject(new Error('Steering watch closed')))
    })
  } finally {runtime.signal.removeEventListener('abort',abort);await Promise.all([watch.stop(),steering.stop()])}
}

export async function publishChildResult(tx,taskId,entryId,result) {
  const r=(await tx.doc(Collaboration)).items.find(i=>i.childTaskId===taskId && i.childInputId===entryId)
  if(!r || r.result || r.businessStatus==='accepted') return
  const child=await tx.doc((await import('./tasks.mjs')).TaskCard,taskId)
  const revision=(r.revisions?.length??0)+1
  r.result={version:1,source:'child-task-result',childTaskId:taskId,rootWorkId:r.rootWorkId,inReplyTo:entryId,submittedAt:new Date().toISOString(),...copy(result),accepted:false,revision,criteria:copy(r.completionCriteria),basis:{configRef:copy(child.configRef),inputId:entryId,previousRevision:revision>1?revision-1:null,reworkDecisionEntryId:r.decisions?.at(-1)?.entryId??null},reviewRequired:!!r.reviewRequired}
  await markDirty(tx,{sourceId:`task:${r.parentTaskId}`,type:'Review',id:r.id}) // PLAN §8.2 follow-up: result awaiting supervisor review
  if(r.groupId) {
    const sources=copy((await tx.doc((await import('./group-result-provenance.mjs')).GroupResultSources,taskId)).inputs[entryId]??[])
    Object.assign(r.result,{groupId:r.groupId,sourceMessageId:r.sourceMessageId,parentInputId:r.parentInputId,deliveryKey:`${r.id}:revision:${revision}`,sources})
  }
  r.revisions??=[];r.revisions.push(copy(r.result));r.businessStatus=result.status

}

export async function acknowledgeBlockerNotice(tx,taskId,entryId) {
 for(const r of (await tx.doc(Collaboration)).items) if(r.parentTaskId===taskId&&r.parentInputId===entryId) r.blockerPendingNotice=false
}

// Wake only the original root wait. No polling and no second scheduler.
export async function watchRootStop(runtime,ctx) {
  const watch=await runtime.watchDoc(Collaboration,ctx)
  let rejectStop
  const promise=new Promise((_,reject)=>{rejectStop=reject})
  const check=state=>{if((state.stops??[]).some(s=>s.parentTaskId===runtime.taskId)) {
    // Active work identity must match, otherwise a historical stop would poison future inputs.
    return runtime.commit(async tx=>{
      const {ChatInput}=await import('./tasks.mjs'), input=(await tx.doc(ChatInput,runtime.taskId)).entryId
      if((state.stops??[]).some(s=>s.parentTaskId===runtime.taskId&&s.parentInputId===input))rejectStop(new TaskInputError(409,'COLLABORATION_STOPPED','原工作已停止。'))
    },ctx)
  }}
  await check(watch.value);watch.start(check)
  return {promise,stop:()=>watch.stop()}
}
