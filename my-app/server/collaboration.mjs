import { workspaceHistoryAllowed, workspaceShareAllowed } from './workspace-grants.mjs'
import { assertGroupTask } from './groups.mjs'
import { resolveContinuousSource, resolveContinuousOrigin } from './continuous-origin.mjs'
import { markDirty } from './detector-state.mjs'
import { REVIEW_TOOL, validReviewArgs } from './review-tools.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { COLLABORATION_TOOLS, validCollaborationArgs } from './collaboration-tools.mjs'
import { createHash } from 'node:crypto'
import { BotDirectory, assertBotActive } from './bot-directory.mjs'
import { ToolAccess, toolSets, CallUsage, callLimits } from './tools.mjs'
import { TaskInputError } from './task-config.mjs'
import { assertNotCancelled, TaskCancellation, readCancelledArchive } from './cancellation.mjs'
import { SessionLifecycle } from './session-lifecycle.mjs'
import { MainSessions, mirrorToMain } from './main-session.mjs'

// Relationships/receipts only: execution remains in the existing Harness phases.
export const Collaboration = defineDoc({kind:'pidot.collaboration',version:1,scope:'session',initial:()=>({items:[],stops:[]})})
const isContinuousTask=card=>card?.executionPolicy?.kind==='continuous'
const sameContinuousBinding=(a,b,{submission=false}={})=>a&&b&&['rootTaskId','rootInputId','goalRevision','planRevision','stepId',...(submission?['submissionRevision']:[])].every(key=>a[key]===b[key])
const copy=x=>JSON.parse(JSON.stringify(x))
const fail=(code,message)=>{throw new TaskInputError(409,code,message)}
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const assignmentReceipt = r => copy(Object.fromEntries(['version','id','rootWorkId','parentTaskId','parentInputId','supervisorBotId','executorBotId','childTaskId','childInputId','createdAt','groupId','sourceMessageId','continuousBinding'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]])))
// Directed targets advance through the existing reply/awaitChildren phases. Each commit creates at
// most one Task row; the relation is the durable cursor used after a restart or a review round.

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
    if (card.kind === 'group' && Array.isArray(input.data.targetBotIds) && input.data.targetBotIds.length && !directed) fail('GROUP_TARGET_FIXED','本输入目标由认证用户固定，管理员不能额外派发。')
    const directory=await tx.doc(BotDirectory)
    const { group, source, origin } = await resolveContinuousSource(tx, card, {TaskCard,ChatInput,bots})
    let binding = null
    if (isContinuousTask(card)) {
      await guardContinuousRoot(tx, card, {dispatch:true})
      const progress = await tx.doc((await import('./continuous-task.mjs')).TaskProgress, card.taskId), step = progress.steps.find(row => row.stepId === progress.currentStepId)
      if (!step || step.kind === 'verify' || step.status !== 'active' || step.goalRevision !== card.taskState.goalRevision) fail('CONTINUOUS_STEP_NOT_READY','只能为当前活动执行步骤委派。')
      binding = {rootTaskId:card.taskId,rootInputId:entryId,goalRevision:card.taskState.goalRevision,planRevision:progress.planRevision,stepId:step.stepId,submissionRevision:(step.submissionRevision??0)+1}
    }
    const targets=directory.items.filter(b=>b.id!==card.bot.id && b.status!=='inactive' && (!group || group.memberBotIds.includes(b.id)))
    if ((group || binding) && !toolSets(card,bots,await tx.doc(ToolAccess)).authorized.includes(REVIEW_TOOL)) fail('REVIEW_NOT_AUTHORIZED','群协作必须已有精确验收许可。')
    if(call.name==='collaborators_list') return {ok:true,data:{collaborators:targets.map(({id,name,description})=>({id,name,description}))}}
    const a=call.arguments, key=`${card.taskId}:${entryId}:${a.operationId}`
    const signature=hash([a.botId,a.goal,a.completionCriteria,...(a.sharedRecords?[a.sharedRecords]:[])])
    const prior=state.items.find(i=>i.id===key)
    if(prior) {if(binding && !sameContinuousBinding(prior.continuousBinding,binding,{submission:true})) fail('CONTINUOUS_REVISION_CONFLICT','原委派属于其他步骤或目标修订。');if(prior.signature!==signature) fail('COLLABORATION_REQUEST_CONFLICT','同一操作标识不能改变参数。'); await assertBotActive(tx,prior.executorBotId); return {ok:true,data:assignmentReceipt(prior),replayed:true}}
    if(!targets.some(b=>b.id===a.botId)) fail('COLLABORATION_TARGET_DENIED','目标须为存在且活跃的不同Bot。')
    let sharedRows=[]
    if(a.sharedRecords?.length) {const {sharedInformationService}=await import('./shared-information.mjs');sharedRows=await sharedInformationService({TaskCard,ChatInput,bots}).prepareLinks(tx,card,entryId,a.sharedRecords)}
    if (directed && (!(input.data.targetBotIds ?? []).includes(a.botId) || a.goal !== input.data.content)) fail('GROUP_TARGET_FIXED','不能改选认证输入的目标或目标指令。')
    const childTaskId=await createTask(tx,{botId:a.botId,title:a.goal.slice(0,100),taskState:{goal:a.goal,completionCriteria:a.completionCriteria}}, (await tx.task(card.taskId)).conversationId, group && !binding ? { conversationId: card.conversationId, at: entryId } : undefined)
    const child=await tx.doc(TaskCard,childTaskId)
    // Ordinary delegation copies a goal and completion criteria, never the parent's source
    // transcript. The executor uses its own live tools for any source access it needs.
    if (group && (!workspaceShareAllowed(source, child, await tx.doc(ToolAccess)) || !await workspaceHistoryAllowed(tx, child, toolSets(child,bots,await tx.doc(ToolAccess))))) fail('COLLABORATION_NOT_AUTHORIZED','群上下文需要目标独立完整来源许可。')
    // The brief is the only parent context copied to the independent conversation.
    const relation={version:1,id:key,signature,rootWorkId:`${card.taskId}:${entryId}`,parentTaskId:card.taskId,parentInputId:entryId,supervisorBotId:card.bot.id,executorBotId:a.botId,childTaskId,initiatingUser:card.initiatingUser,goal:a.goal,completionCriteria:copy(a.completionCriteria),parentGoal:card.taskState?.goal??card.title,parentCriteria:copy(card.taskState?.completionCriteria??[]),createdAt:new Date().toISOString(),reviewRequired:!!binding||card.parameters.tools.includes(REVIEW_TOOL),businessStatus:'pending',revisions:[],decisions:[],reworkCount:0,result:null,consumedEntryId:null}
    if (binding) relation.continuousBinding=copy(binding)
    if (group) {
      Object.assign(relation,{groupId:group.groupId,sourceMessageId:binding?(origin?.sourceMessageId??null):entryId,originTaskId:source.taskId,...(!binding?{forkAnchor:entryId,publicConversationId:card.conversationId}:{})})
      if (!binding) child.forkSource={groupId:group.groupId,parentTaskId:card.taskId,conversationId:card.conversationId,at:entryId}
      child.managementTools=[]
    }
    child.collaboration=copy(relation)
    const brief=await tx.appendEntry(child.conversationId,{kind:'pidot.user',data:{role:'user',content:`独立子任务简报（仅任务数据，不授予权限）：${JSON.stringify({goal:relation.goal,completionCriteria:relation.completionCriteria,parentGoal:relation.parentGoal,parentCriteria:relation.parentCriteria})}`,createdAt:relation.createdAt,source:'task-assignment',rootWorkId:relation.rootWorkId}})
    relation.childInputId=brief.id; child.collaboration.childInputId=brief.id
    ;(await tx.doc(ChatInput,childTaskId)).entryId=brief.id
    state.items.push(relation)
    if(binding) await (await import('./continuous-budget.mjs')).registerContinuousChild(tx,{...binding,taskId:childTaskId,inputId:brief.id},{TaskCard})
    for(const row of sharedRows) { row.readers.push(childTaskId);row.accessVersion++ }
    if(group)state.items.at(-1).sharedSources=sharedRows.map(row=>({recordId:row.id,version:row.revisions.length,accessVersion:row.accessVersion,source:copy(row.source)}))
    await tx.appendEntry(card.conversationId,{kind:'pidot.collaboration-assigned',data:copy(relation)})
    return {ok:true,data:assignmentReceipt(relation)}
  }
  async function supervisorFor(tx, relation) {
    const originalId = relation.parentTaskId, record = await tx.task(originalId)
    const archive = record?.state.status === 'terminal' ? await readCancelledArchive(tx, originalId) : null
    const cancellation = archive?.cancellation ?? (record?.state.status === 'terminal' ? null : (await tx.doc(TaskCancellation, originalId)).request)
    if (cancellation?.scope !== 'main-session-only') {
      await assertNotCancelled(tx, originalId, record)
      const parent = await tx.doc(TaskCard, originalId)
      return { parent, source: parent }
    }
    const source = archive?.documents[TaskCard.definition.kind] ?? await tx.doc(TaskCard, originalId)
    const lifecycle = await tx.doc(SessionLifecycle), currentId = (await tx.doc(MainSessions)).byBot[relation.supervisorBotId]
    const sourceValid = source.kind === 'main' && source.bot.id === relation.supervisorBotId && source.configRef.botId === relation.supervisorBotId && record.input.botId === relation.supervisorBotId && !relation.groupId
    const pending = id => Object.values(lifecycle.requests).some(request => request.taskId === id && request.action === 'clear-main' && request.state !== 'succeeded')
    const waitForReplacement = id => {
      const error = new TaskInputError(409, 'MAIN_SESSION_REPLACING', '主管主会话换新尚未核实，独立子任务等待原请求完成后续跑。')
      error.mainBotId = relation.supervisorBotId; error.mainTaskId = id
      throw error
    }
    if (sourceValid && currentId === originalId && pending(originalId)) waitForReplacement(originalId)
    let next = originalId
    const visited = new Set()
    while (next !== currentId && !visited.has(next)) {
      visited.add(next)
      const cleared = lifecycle.deleted[String(next)]
      if (cleared?.action !== 'clear-main' || cleared.botId !== relation.supervisorBotId || !Number.isSafeInteger(cleared.replacementTaskId)) break
      next = cleared.replacementTaskId
    }
    if (!sourceValid || !currentId || next !== currentId || currentId === originalId) {
      fail('TASK_CANCELLED', '原主管主会话尚未核实换新，不能恢复子任务。')
    }
    const currentRecord = await tx.task(currentId)
    const currentArchive = currentRecord.state.status === 'terminal' ? await readCancelledArchive(tx, currentId) : null
    const currentCancellation = currentArchive?.cancellation ?? (currentRecord.state.status === 'terminal' ? null : (await tx.doc(TaskCancellation, currentId)).request)
    if (currentCancellation?.scope === 'main-session-only' && pending(currentId)) waitForReplacement(currentId)
    await assertNotCancelled(tx, currentId, currentRecord)
    const parent = await tx.doc(TaskCard, currentId)
    if (parent.kind !== 'main' || parent.bot.id !== relation.supervisorBotId || parent.configRef.botId !== relation.supervisorBotId || parent.conversationId === source.conversationId) {
      fail('COLLABORATION_IDENTITY_DENIED', '换新主会话必须属于原主管 Bot 并使用独立上下文。')
    }
    return { parent, source }
  }
  async function guardContinuousRoot(tx,card,{dispatch=false}={}) {
    await resolveContinuousOrigin(tx,card,{TaskCard,ChatInput,bots})
    if(!dispatch) return
    const control=await (await import('./continuous-control.mjs')).continuousDispatchState(tx,card,card.executionPolicy.rootInputId)
    if(!control.allowed) {const error=new TaskInputError(409,'CONTINUOUS_DISPATCH_STOPPED','持续目标暂停、受限、修订或已经结束，禁止下一派发。');error.control=control;throw error}
  }
  async function guard(tx,taskId,{issueDecision=false}={}) {
    await assertWorkOpen(tx,taskId)
    const state=await tx.doc(Collaboration), r=state.items.find(i=>i.childTaskId===taskId)
    if(!r) {
      const own=await tx.doc(TaskCard,taskId)
      if(isContinuousTask(own)) await guardContinuousRoot(tx,own)
      const activeInput=(await tx.doc(ChatInput,taskId)).entryId
      if(state.items.some(i=>i.parentTaskId===taskId&&i.parentInputId===activeInput)) await authorize(tx,await tx.doc(TaskCard,taskId))
      return
    }
    // A completed main clear changes the entry point, never the original work identity.
    const { parent, source } = await supervisorFor(tx, r)
    await authorize(tx,parent)
    if(r.continuousBinding) {
      await guardContinuousRoot(tx,parent)
      if(r.continuousBinding.rootTaskId!==parent.taskId||r.continuousBinding.rootInputId!==parent.executionPolicy.rootInputId||r.continuousBinding.goalRevision!==parent.taskState.goalRevision) fail('CONTINUOUS_REVISION_CONFLICT','执行者属于已替换的目标修订。')
      const progress=await tx.doc((await import('./continuous-task.mjs')).TaskProgress,parent.taskId),step=progress.steps.find(row=>row.stepId===r.continuousBinding.stepId)
      if(!step||step.goalRevision!==r.continuousBinding.goalRevision||step.status==='superseded') fail('CONTINUOUS_REVISION_CONFLICT','原步骤已替换，不能继续派发。')
    }
    const childCard = await tx.doc(TaskCard, taskId)
    const access = await tx.doc(ToolAccess)
    if (!await workspaceHistoryAllowed(tx, childCard, toolSets(childCard, bots, access)) ||
      r.groupId && (!await workspaceHistoryAllowed(tx, source, toolSets(source, bots, access)) || !await workspaceHistoryAllowed(tx, parent, toolSets(parent, bots, access)) ||
        !workspaceShareAllowed(source, childCard, access) || !workspaceShareAllowed(parent, childCard, access))) fail('COLLABORATION_NOT_AUTHORIZED','工作区派生来源已失效。')
    if (r.groupId) { const {group:g}=await resolveContinuousSource(tx,parent,{TaskCard,ChatInput,bots}); if (!g || g.groupId!==r.groupId || !g.memberBotIds.includes(r.executorBotId)) fail('GROUP_TARGET_DENIED','群来源与执行者绑定失效。') }
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
    const items=(await tx.doc(Collaboration)).items.filter(i=>i.parentTaskId===card.taskId && i.parentInputId===entryId &&
      (!i.continuousBinding || i.continuousBinding.goalRevision===card.taskState?.goalRevision))
    if(!items.length) return false
    await authorize(tx,card)
    if(isContinuousTask(card)) await resolveContinuousOrigin(tx,card,{TaskCard,ChatInput,bots})
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
    if(!r || !r.reviewRequired || r.parentTaskId!==card.taskId || r.supervisorBotId!==card.bot.id || r.rootWorkId!==a.rootWorkId || r.parentInputId!==entryId) fail('REVIEW_IDENTITY_DENIED','仅原工作绑定主管能验收，不接受pipi或执行者旁路。')
    await assertNotCancelled(tx,r.childTaskId,await tx.task(r.childTaskId))
    await assertBotActive(tx,r.executorBotId)
    const child=await tx.doc(TaskCard,r.childTaskId)
    if(child.bot.id!==r.executorBotId || child.configRef.botId!==r.executorBotId || (await tx.conversation(child.conversationId))?.owner?.taskId!==r.childTaskId) fail('REVIEW_IDENTITY_DENIED','子任务绑定错误。')
    if(r.continuousBinding) await guardContinuousRoot(tx,card,{dispatch:true})
    const signature=hash(Object.entries(a).sort(([a],[b])=>a.localeCompare(b))), prior=r.decisions?.find(d=>d.operationId===a.operationId)
    if(prior) {if(prior.signature!==signature) fail('REVIEW_CONFLICT','同一决定标识参数冲突。');return {ok:true,data:copy(prior),replayed:true}}
    if((await tx.doc(ChatInput,card.taskId)).entryId!==entryId) fail('REVIEW_WORK_INACTIVE','原主管输入已结束，不能验收其他工作。')
    if(r.continuousBinding) {
      await guardContinuousRoot(tx,card,{dispatch:true})
      if(!sameContinuousBinding(a.continuousBinding,r.continuousBinding,{submission:true})||r.continuousBinding.goalRevision!==card.taskState.goalRevision) fail('REVIEW_STALE','验收须绑定当前目标及原步骤的精确修订。')
      const progress=await tx.doc((await import('./continuous-task.mjs')).TaskProgress,card.taskId),step=progress.steps.find(row=>row.stepId===r.continuousBinding.stepId)
      if(!step||step.goalRevision!==card.taskState.goalRevision||step.status==='superseded'||step.submissionRevision+1!==r.continuousBinding.submissionRevision) fail('REVIEW_STALE','原步骤已提交、替换或修订。')
      if(a.decision==='accept'&&!await validContinuousChildResult(tx,card,r,r.result,{TaskCard,ChatInput,bots})) fail('CONTINUOUS_EVIDENCE_UNAVAILABLE','子结果没有当前可核实的合法成功依据。')
    } else if(a.continuousBinding) fail('REVIEW_IDENTITY_DENIED','普通工作不能指定持续目标身份。')
    if(r.continuousBinding&&a.decision==='request-rework'&&(r.reworkCount??0)>=2) fail('REVIEW_REWORK_LIMIT','已经返工两次；保留原结果与用量，请用户决定后续处理。')
    if(r.groupId&&(await (await import('./group-result-provenance.mjs')).projectGroupResult(tx,card,r,r.result,{TaskCard,ChatInput,bots}))?.visibility==='permission-denied')fail('SHARED_DENIED','结果来源或精确版本已不可读，不能验收。')
    if(r.businessStatus!=='submitted'||r.result?.status!=='submitted'||r.result.revision!==a.revision) fail('REVIEW_STALE','结果已接受、已打回或修订过期；请依据最新提交。')
    const slot=await tx.doc(ChatInput,r.childTaskId), approvals=await tx.doc(TaskApprovals,r.childTaskId), blockers=await tx.doc(TaskBlockers,r.childTaskId)
    if(slot.entryId!==null || approvals.activeId!==null || blockers.activeId!==null || approvals.items.some(i=>i.operation&&!i.receipt||r.continuousBinding&&uncertainApproval(i)) || blockers.items.some(i=>i.status==='pending')) fail('REVIEW_CHILD_BUSY','子任务仍有执行、阻塞或未知动作，不允许验收或返工。')
    const decision={version:1,operationId:a.operationId,signature,decision:a.decision,reason:a.reason,revision:a.revision,expectedState:a.expectedState,childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,parentInputId:entryId,supervisorTaskId:card.taskId,supervisorBotId:card.bot.id,criteria:copy(r.completionCriteria),createdAt:new Date().toISOString(),source:'bound-supervisor-tool',...(r.continuousBinding?{continuousBinding:copy(r.continuousBinding)}:{})}
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
    const record=await tx.task(taskId)
    if(record?.state.status==='terminal') await assertNotCancelled(tx,taskId,record)
    const state=await tx.doc(Collaboration), r=state.items.find(i=>i.childTaskId===taskId)
    const input=r?.parentInputId??(await tx.doc(ChatInput,taskId)).entryId
    const root=r?.rootWorkId??`${taskId}:${input}`
    if((state.stops??[]).some(s=>s.rootWorkId===root)) fail('COLLABORATION_STOPPED','本项根工作已停止；不能派发、返工、回答或续跑。')
  }
  // One group input may address several members. Each target keeps its own proven task_assign path (one
  // commit per target: reads, then its writes); failures stop the remaining targets rather than half-write.
  async function dispatchDirected(tx,card,entryId) {
    if (card.kind !== 'group') return
    const input = await tx.entry(entryId), targets = input?.data.targetBotIds
    if (!Array.isArray(targets) || !targets.length) return
    const group = await assertGroupTask(tx,card)
    for (const target of targets) if (!group.memberBotIds.includes(target)) fail('GROUP_TARGET_DENIED','目标不属于本群。')
    const others = targets.filter(target => target !== card.bot.id)
    if (!others.length) return
    const links = await tx.doc(Collaboration)
    const relations = links.items.filter(r=>r.parentTaskId===card.taskId&&r.parentInputId===entryId)
    const assigned = new Set(relations.map(r=>r.executorBotId))
    const pending = others.filter(target=>!assigned.has(target))
    if (!pending.length) return false
    const usage=await tx.doc(CallUsage,card.taskId),limits=callLimits(card.parameters)
    const limited=usage.modelCalls>=limits.modelCalls?'modelCalls':usage.toolCalls>=limits.toolCalls?'toolCalls':limits.totalTokens!==undefined&&(usage.unknownTokenCalls>0||usage.totalTokens>=limits.totalTokens)?'totalTokens':null
    if(limited)return {limited}
    // One target goes through task_assign in this transaction. The next target is dispatched after
    // awaitChildren returns to reply, so no commit needs two Task rows or a write followed by a read.
    await execute(tx,card,{name:'task_assign',arguments:{operationId:`directed-input:${pending[0]}`,botId:pending[0],goal:input.data.content,completionCriteria:['回答原群消息中的请求，并说明结果依据']}},entryId,{directed:true})
    usage.toolCalls += 1
    return { remaining: pending.slice(1) }
  }

  return {execute,guard,collect,review,assertWorkOpen,dispatchDirected}
}

const uncertainApproval=item=>item.status==='unknown'||item.receipt?.unknown===true||item.receipt?.error?.unknown===true||['unknown','pending','prepared'].includes(item.receipt?.data?.state??item.receipt?.data?.status??item.receipt?.data?.outcome)
const nonEvidenceTools = new Set(['task_assign','task_review','task_create','report_blocker','blocker_resolve','blocker_escalate',
  'shared_publish','shared_link','shared_read','work_plan','work_submit','work_complete','tool_result_read',
  'task_history_read','session_history_read','session_search','skill_activate','skill_deactivate','skill_read_resource','memory_edit','memory_review'])

/** Review dereferences host receipts again. A result body's claims or copied status are never proof. */
async function validContinuousChildResult(tx, root, relation, result, services) {
  const {successfulContinuousResult,continuousArtifactVersion}=await import('./continuous-evidence.mjs')
  if (!result || result.status !== 'submitted' || !sameContinuousBinding(result.continuousBinding,relation.continuousBinding,{submission:true}) ||
    !Array.isArray(result.evidenceRefs) || !result.evidenceRefs.length || result.evidenceRefs.length > 1000) return false
  const { TaskCard, bots } = services
  const record=await tx.task(relation.childTaskId)
  if(!record||record.state.status==='terminal') return false
  const child=await tx.doc(TaskCard,relation.childTaskId),access=await tx.doc(ToolAccess),sets=toolSets(child,bots,access)
  if(child.bot.id!==relation.executorBotId||child.configRef.botId!==relation.executorBotId||
    (await tx.conversation(child.conversationId))?.owner?.taskId!==child.taskId||!await workspaceHistoryAllowed(tx,child,sets)) return false
  const projected=await (await import('./group-result-provenance.mjs')).projectGroupResult(tx,root,relation,result,services)
  if(projected?.visibility==='permission-denied') return false
  const history=await (await import('./history-tool.mjs')).readTaskHistory(tx,child,{},relation.childInputId,sets,{collect:true})
  for(const ref of result.evidenceRefs) {
    const entry=history.visible.find(row=>row.id===ref.entryId)
    if(ref.taskId!==child.taskId||!entry||entry.byTaskId!==child.taskId||entry.conversationId!==child.conversationId||
      entry.kind!=='pidot.tool-result'||entry.data.inReplyTo!==relation.childInputId||!history.sourceAllowed(entry)||
      !sameContinuousBinding(entry.data.continuousBinding,relation.continuousBinding,{submission:true})||
      nonEvidenceTools.has(entry.data.toolName)||!sets.authorized.includes(entry.data.toolName)||
      entry.data.arguments?.resource&&!sets.resources.includes(entry.data.arguments.resource)||
      entry.data.arguments?.sourceId&&!sets.resources.includes(`workspace:${entry.data.arguments.sourceId}`)||
      !successfulContinuousResult(entry.data.result)) return false
    if(['read','write','edit'].includes(entry.data.toolName)&&!continuousArtifactVersion(entry,history.visible,history.sourceAllowed,relation.continuousBinding,{inputId:relation.childInputId})) return false
  }
  return true
}

/** LR-02 callback: exact result and matching supervisor decision, with current live provenance. */
export async function resolveContinuousChildEvidence(tx, root, ref, expected, services) {
  const denied=()=>({ok:false})
  if(!isContinuousTask(root)||root.taskId!==expected.rootTaskId||root.executionPolicy.rootInputId!==expected.rootInputId||
    root.taskState.goalRevision!==expected.goalRevision||ref?.kind!=='child-result') return denied()
  const relation=(await tx.doc(Collaboration)).items.find(row=>row.id===ref.relationId&&row.parentTaskId===root.taskId&&row.parentInputId===expected.rootInputId)
  if(!relation||!sameContinuousBinding(relation.continuousBinding,expected,{submission:true})) return denied()
  const result=relation.result?.revision===ref.revision?relation.result:relation.revisions?.find(row=>row.revision===ref.revision)
  const decision=relation.decisions?.find(row=>row.decision==='accept'&&row.revision===ref.revision&&
    row.childTaskId===relation.childTaskId&&row.supervisorTaskId===root.taskId&&row.supervisorBotId===root.bot.id&&
    sameContinuousBinding(row.continuousBinding,expected,{submission:true}))
  if(!result||!decision) return denied()
  try {
    await resolveContinuousOrigin(tx,root,services)
    await assertBotActive(tx,relation.executorBotId)
    const {TaskApprovals}=await import('./approvals.mjs'),{TaskBlockers}=await import('./blockers.mjs')
    const approvals=await tx.doc(TaskApprovals,relation.childTaskId),blockers=await tx.doc(TaskBlockers,relation.childTaskId)
    if(approvals.items.some(item=>item.operation&&!item.receipt||item.status==='pending'||uncertainApproval(item))||blockers.items.some(item=>item.status==='pending')) return denied()
    if(!await validContinuousChildResult(tx,root,relation,result,services)) return denied()
  } catch(error) {if(error instanceof TaskInputError)return denied();throw error}
  const {continuousEvidenceFingerprint}=await import('./continuous-evidence.mjs')
  const fingerprints=[]
  for(const ref of result.evidenceRefs) {
    const entry=await tx.entry(ref.entryId)
    const fingerprint=continuousEvidenceFingerprint(entry.data.toolName,entry.data.arguments,entry.data.result)
    if(fingerprint)fingerprints.push(fingerprint)
  }
  return {ok:true,evidence:{kind:'independent-review',ref:copy(ref),binding:copy(expected),basis:'bound-supervisor-review',
    quality:'independently-reviewed',fingerprint:fingerprints.length?`child:${hash([...new Set(fingerprints)].sort())}`:null,scope:'reviewed-child-result'}}
}

export async function waitForChildren(runtime,entryId,ctx) {
  const watch=await runtime.watchDoc(Collaboration,ctx)
  const continuous=watch.value.items.some(row=>row.parentTaskId===runtime.taskId&&row.parentInputId===entryId&&row.continuousBinding)
  const progress=continuous?await runtime.watchDoc((await import('./continuous-task.mjs')).TaskProgress,runtime.taskId,ctx):null
  const budget=continuous?await runtime.watchDoc((await import('./continuous-task.mjs')).ContinuousBudget,runtime.taskId,ctx):null
  const {ChatSteering}=await import('./steering.mjs')
  const steering=await runtime.watchDoc(ChatSteering,runtime.taskId,ctx)
  let abort,timer
  try {
    await new Promise((resolve,reject)=>{
      const check=s=>{if(progress&&(progress.value.controlIntent||progress.value.pendingGoalRevision||progress.value.finalOutcome))return resolve();if((s.stops??[]).some(x=>x.rootWorkId===`${runtime.taskId}:${entryId}`)) return resolve();const rows=s.items.filter(i=>i.parentTaskId===runtime.taskId && i.parentInputId===entryId&&(!i.continuousBinding||i.continuousBinding.goalRevision===progress?.value.goalRevision));if(rows.every(i=>i.result && (!i.reviewRequired || ['accepted','cancelled','failed'].includes(i.businessStatus)))||rows.some(i=>i.result&&!i.consumedEntryId)||rows.some(r=>(r.blockers??[]).some(b=>!(r.blockerNotices??[]).includes(`${b.id}:${b.version}`)))) resolve()}
      abort=()=>reject(runtime.signal.reason??new Error('Stopped'))
      runtime.signal.addEventListener('abort',abort,{once:true});if(runtime.signal.aborted) return abort()
      const checkSteering=s=>{if(s.pending.some(i=>i.targetInputId===entryId))resolve()}
      if(budget){const deadline=()=>{clearTimeout(timer);const remaining=Date.parse(budget.value.deadlineAt)-Date.now();if(remaining<=0)resolve();else if(Number.isFinite(remaining))timer=setTimeout(deadline,Math.min(remaining,2147483647))};budget.start(deadline);deadline()}
      check(watch.value);checkSteering(steering.value);watch.start(async s=>check(s));progress?.start(()=>check(watch.value));steering.start(async s=>checkSteering(s));void watch.closed.then(()=>reject(new Error('Collaboration watch closed')));void steering.closed.then(()=>reject(new Error('Steering watch closed')))
    })
  } finally {clearTimeout(timer);runtime.signal.removeEventListener('abort',abort);await Promise.all([watch.stop(),steering.stop(),progress?.stop(),budget?.stop()])}
}

export async function publishChildResult(tx,taskId,entryId,result) {
  const r=(await tx.doc(Collaboration)).items.find(i=>i.childTaskId===taskId && i.childInputId===entryId)
  if(!r || r.result || r.businessStatus==='accepted') return
  const child=await tx.doc((await import('./tasks.mjs')).TaskCard,taskId)
  const revision=(r.revisions?.length??0)+1
  const evidenceRefs=[]
  if(r.continuousBinding) {
    const {successfulContinuousResult}=await import('./continuous-evidence.mjs')
    let cursor
    do {const page=await tx.scanEntries({conversationId:child.conversationId,order:'ascending'},100,cursor);cursor=page.next;for(const entry of page.items) if(entry.byTaskId===taskId&&entry.kind==='pidot.tool-result'&&entry.data.inReplyTo===entryId&&sameContinuousBinding(entry.data.continuousBinding,r.continuousBinding,{submission:true})&&successfulContinuousResult(entry.data.result)&&!nonEvidenceTools.has(entry.data.toolName)) evidenceRefs.push({taskId,entryId:entry.id})}while(cursor)
  }
  r.result={version:1,source:'child-task-result',childTaskId:taskId,rootWorkId:r.rootWorkId,inReplyTo:entryId,submittedAt:new Date().toISOString(),...copy(result),accepted:false,revision,criteria:copy(r.completionCriteria),basis:{configRef:copy(child.configRef),inputId:entryId,previousRevision:revision>1?revision-1:null,reworkDecisionEntryId:r.decisions?.at(-1)?.entryId??null},reviewRequired:!!r.reviewRequired}
  if(r.continuousBinding) Object.assign(r.result,{continuousBinding:copy(r.continuousBinding),evidenceRefs})
  await markDirty(tx,{sourceId:`task:${r.parentTaskId}`,type:'Review',id:r.id}) // PLAN §8.2 follow-up: result awaiting supervisor review
  if(r.groupId) {
    const sources=copy((await tx.doc((await import('./group-result-provenance.mjs')).GroupResultSources,taskId)).inputs[entryId]??[])
    Object.assign(r.result,{groupId:r.groupId,sourceMessageId:r.sourceMessageId,parentInputId:r.parentInputId,deliveryKey:`${r.id}:revision:${revision}`,sources})
  }
  r.revisions??=[];r.revisions.push(copy(r.result));r.businessStatus=result.status
  const lifecycle = await tx.doc(SessionLifecycle), cleared = lifecycle.deleted[String(r.parentTaskId)]
  const clearing = Object.values(lifecycle.requests).some(request => request.taskId === r.parentTaskId && request.action === 'clear-main' && request.state !== 'succeeded')
  if ((cleared?.action === 'clear-main' && cleared.botId === r.supervisorBotId || clearing) && !r.groupId) {
    const access = await tx.doc(ToolAccess), assigned = access.assignments[r.supervisorBotId]?.tools ?? []
    const directory = await tx.doc(BotDirectory), supervisor = directory.items.find(bot => bot.id === r.supervisorBotId)
    if (supervisor?.status !== 'inactive' && COLLABORATION_TOOLS.every(name => assigned.includes(name) && !access.revoked[r.supervisorBotId]?.includes(name)) &&
      (!r.reviewRequired || assigned.includes(REVIEW_TOOL) && !access.revoked[r.supervisorBotId]?.includes(REVIEW_TOOL))) {
      await mirrorToMain(tx, { ...child, mainParent: { mainTaskId: r.parentTaskId, botId: r.supervisorBotId } }, {
        mirrorKind: 'collaboration-result', relationId: r.id, revision, outcome: result.status,
        summary: `任务「${child.title}」${result.status === 'submitted' ? '已提交结果' : result.status === 'cancelled' ? '已取消' : '执行失败'}${r.reviewRequired && result.status === 'submitted' ? '，仍待主管验收' : ''}`,
      })
    }
  }

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
