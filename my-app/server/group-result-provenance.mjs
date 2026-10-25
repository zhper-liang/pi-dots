import { defineDoc } from '@earendil-works/pi-durable'
export const GroupResultSources=defineDoc({kind:'pidot.group-result-sources',version:1,scope:'task',initial:()=>({inputs:{}})})
import { TaskInputError } from './task-config.mjs'

// Never trust a retained result body as an ACL. Recheck both author and reader.
export async function projectGroupResult(tx, card, relation, result, services) {
  if (!result) return result
  if (!relation.groupId) {
    const record = await tx.task(relation.childTaskId)
    const archive = record?.state.status === 'terminal' ? await (await import('./cancellation.mjs')).readCancelledArchive(tx, relation.childTaskId) : null
    const child = archive ? archive.documents[services.TaskCard.definition.kind] : record?.state.status === 'terminal' ? null : await tx.doc(services.TaskCard, relation.childTaskId)
    if (!child) return { ...result, content: '来源Task已结束，结果不可读取。', visibility: 'permission-denied', basis: undefined }
    if (!(child.parameters?.tools ?? []).some(n => n.startsWith('workspace.')) && !(card.parameters?.tools ?? []).some(n => n.startsWith('workspace.'))) return result
    const { workspaceHistoryAllowed, workspaceShareAllowed } = await import('./workspace-grants.mjs'), { toolSets, ToolAccess } = await import('./tools.mjs'), access = await tx.doc(ToolAccess)
    if (!workspaceShareAllowed(child, card, access) || !await workspaceHistoryAllowed(tx, child, toolSets(child, services.bots, access)) || !await workspaceHistoryAllowed(tx, card, toolSets(card, services.bots, access))) return { ...result, content: '工作区来源许可不足；派生结果隐藏。', visibility: 'permission-denied', basis: undefined }
    return result
  }
  try {
    if((await tx.task(relation.parentTaskId))?.state.status==='terminal')throw new TaskInputError(409,'SHARED_DENIED','原工作已停止。')
    const parent=await tx.doc(services.TaskCard,relation.parentTaskId)
    const group=await (await import('./groups.mjs')).assertGroupTask(tx,parent)
    if(!group || group.groupId!==relation.groupId || !group.memberBotIds.includes(relation.executorBotId) || ![relation.parentTaskId,relation.childTaskId].includes(card.taskId)) throw new TaskInputError(409,'SHARED_DENIED','结果来源不可访问。')
    const {assertBotActive}=await import('./bot-directory.mjs')
    await assertBotActive(tx,parent.bot.id);await assertBotActive(tx,relation.executorBotId)
    if((await tx.task(relation.childTaskId))?.state.status==='terminal')throw new TaskInputError(409,'SHARED_DENIED','结果作者工作已停止。')
    const { toolSets, ToolAccess } = await import('./tools.mjs')
    const { feishuTaskAllowed, isFeishuResource } = await import('./feishu-calendar.mjs')
    const childCard = await tx.doc(services.TaskCard, relation.childTaskId), access = await tx.doc(ToolAccess)
    const childSets = toolSets(childCard, services.bots, access), readerSets = toolSets(card, services.bots, access)
    const { workspaceShareAllowed, workspaceHistoryAllowed } = await import('./workspace-grants.mjs')
    if (!workspaceShareAllowed(childCard, card, access) || !await workspaceHistoryAllowed(tx, childCard, childSets) || !await workspaceHistoryAllowed(tx, card, readerSets) || !await feishuTaskAllowed(tx, childCard, childSets) || !await feishuTaskAllowed(tx, card, readerSets) || childSets.resources.filter(isFeishuResource).some(r => !readerSets.resources.includes(r))) throw new TaskInputError(409, 'SHARED_DENIED', '真实日历来源不可访问。')
    const refs=result.sources??[]
    if(refs.length) {
      const child=await tx.doc(services.TaskCard,relation.childTaskId), service=(await import('./shared-information.mjs')).sharedInformationService(services)
      await currentSources(tx,child,result.inReplyTo,refs,service)
      await currentSources(tx,card,relation.parentInputId,refs,service)
    }
    return result
  } catch(error) {
    if(!(error instanceof TaskInputError))throw error
    return {...result,content:'当前来源、版本或共享权限不足；受限结果已隐藏。',visibility:'permission-denied',sources:(result.sources??[]).map(({recordId,version})=>({recordId,version})),basis:undefined}
  }
}
export async function projectGroupRelations(tx,card,relations,services) {
  const output=[]
  for(const r of relations) {
    const result=await projectGroupResult(tx,card,r,r.result,services),revisions=await Promise.all((r.revisions??[]).map(v=>projectGroupResult(tx,card,r,v,services)))
    const hidden=result?.visibility==='permission-denied'||revisions.some(v=>v.visibility==='permission-denied')
    output.push({...r,...(hidden?{goal:'来源权限不足；派生简报隐藏。',completionCriteria:[],decisions:(r.decisions??[]).map(d=>({...d,reason:'来源权限不足；理由隐藏。'}))}:{}),result,revisions})
  }
  return output
}

export async function deniedGroupInputs(tx,card,entries,services) {
  if(card.kind!=='group'&&!card.forkSource)return new Set()
  const relations=(await tx.doc((await import('./collaboration.mjs')).Collaboration)).items
  const inputs=new Set(entries.filter(e=>e.kind==='pidot.shared-context').map(e=>e.data.inReplyTo)),denied=new Set()
  for(const r of relations.filter(r=>r.groupId&&r.parentTaskId===card.taskId)) {
    for(const result of r.revisions??[])if((await projectGroupResult(tx,card,r,result,services)).visibility==='permission-denied')denied.add(r.parentInputId)
  }
  for(const input of inputs) {
    const pins=entries.filter(e=>e.kind==='pidot.shared-context'&&e.data.inReplyTo===input).flatMap(e=>e.data.versions)
    try {await currentSources(tx,card,input,pins,(await import('./shared-information.mjs')).sharedInformationService(services))}catch(e){if(!(e instanceof TaskInputError))throw e;denied.add(input)}
  }
  return denied
}
export const hiddenGroupData = data => ({...Object.fromEntries(Object.entries(data).filter(([k])=>!['assistant','toolResult','result','arguments','execution','summary','constraints','goal','completionCriteria'].includes(k))),content:'当前共享来源或版本不可访问；历史派生正文已隐藏。',visibility:'permission-denied'})

async function currentSources(tx,card,input,refs,service) {
  const rows=await service.list(tx,card,input)
  if(refs.some(v=>!rows.some(r=>r.recordId===v.recordId&&r.version===v.version)))throw new TaskInputError(409,'SHARED_DENIED','共享来源已撤回或内容版本变化。')
}

export async function validateGroupResults(tx,card,refs,services) {
  if(!refs?.length)return
  const state=await tx.doc((await import('./collaboration.mjs')).Collaboration)
  for(const ref of refs) {
    const relation=state.items.find(r=>r.id===ref.relationId&&r.parentTaskId===card.taskId)
    if(!relation||relation.result?.revision!==ref.revision||(await projectGroupResult(tx,card,relation,relation.result,services)).visibility==='permission-denied')throw new TaskInputError(409,'SHARED_DENIED','结果来源在模型派发前变化；拒绝过期上下文。')
  }
}
