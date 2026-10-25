import { assertBotActive } from './bot-directory.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError } from './task-config.mjs'
import { assertNotCancelled } from './cancellation.mjs'

export const BLOCKER_TOOL = 'report_blocker'
export const TaskBlockers = defineDoc({ kind: 'pidot.task-blockers', version: 1, scope: 'task',
  initial: () => ({ activeId: null, items: [] }) })
export const blockerTool = Object.freeze({ name: BLOCKER_TOOL, effect: 'task-state',
  description: '缺少继续原任务必需的信息时，向处理人提出具体问题；子任务服务端强制先交绑定主管（assignee=supervisor）并持久化等待。仅当前处理人从对应事项回答后恢复；不能用普通消息/插入冒充回答。不要猜测必要日期或时区，不要用此工具请求权限/批准。此调用后本轮剩余工具不执行，收到回答后重新规划。',
  parameters: { type: 'object', additionalProperties: false, required: ['question', 'requiredInformation', 'assignee'], properties: {
    question: { type: 'string', minLength: 1, maxLength: 1000 },
    requiredInformation: { type: 'string', minLength: 1, maxLength: 1000 },
    assignee: { type: 'string', enum: ['user', 'supervisor'] },
  } },
})
export function validBlockerArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) &&
    Object.keys(args).length === 3 && ['user', 'supervisor'].includes(args.assignee) &&
    ['question', 'requiredInformation'].every((key) => typeof args[key] === 'string' && args[key].trim() && args[key].length <= 1000)
}
export async function reportBlocker(tx, card, args, entryId, turnId, callId) {
  const state = await tx.doc(TaskBlockers, card.taskId)
  if (state.activeId !== null) return { ok: false, error: { code: 'TASK_BLOCKED', message: '请先处理原待办问题。' } }
  const {Collaboration}=await import('./collaboration.mjs')
  const relation = (await tx.doc(Collaboration)).items.find(r=>r.childTaskId===card.taskId && r.childInputId===entryId)
  if (args.assignee === 'supervisor' && !relation) return {ok:false,error:{code:'BLOCKER_HANDLER_DENIED',message:'此Task没有绑定主管。'}}
  const assignee=relation ? 'supervisor':'user'
  const item = { taskId: card.taskId, conversationId: card.conversationId, inReplyTo: entryId, turnId, callId,
    question: args.question, requiredInformation: args.requiredInformation, assignee, status: 'pending', version:1, ...(relation ? {rootWorkId:relation.rootWorkId,parentTaskId:relation.parentTaskId,supervisorBotId:relation.supervisorBotId}:{}), history:[{action:'reported',assignee,createdAt:new Date().toISOString()}],
    createdAt: new Date().toISOString(), answer: null }
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.blocker-reported', data: item })
  const blocker = { ...item, id: audit.id }
  state.items.push(blocker); state.activeId = blocker.id
  await notifyBlocker(tx, relation, blocker)
  return { ok: true, data: { blockerId: blocker.id, taskId: card.taskId, status: assignee==='user'?'waiting-for-user':'waiting-for-supervisor',
    assignee, version:1, notice: '具体问题已保存在对应Task待办中，等待该事项当前处理人回答。' } }
}

// Same watch mechanism as ChatInput: durable checkpoint, no polling/model calls.
export async function waitForBlocker(runtime, id, ctx) {
  const watch = await runtime.watchDoc(TaskBlockers, runtime.taskId, ctx)
  const {watchRootStop}=await import('./collaboration.mjs')
  const rootStop=await watchRootStop(runtime,ctx)
  let abort
  try {
    await Promise.race([rootStop.promise,new Promise((resolve, reject) => {
      abort = () => reject(runtime.signal.reason ?? new Error('Invocation stopped'))
      runtime.signal.addEventListener('abort', abort, { once: true })
      if (runtime.signal.aborted) { abort(); return }
      const check = (value) => { if (value?.items.some((item) => item.id === id && item.status === 'resolved')) resolve() }
      check(watch.value); watch.start(async (value) => { check(value) })
      void watch.closed.then(() => reject(new Error('Blocker watch closed')))
    })])
  } finally { runtime.signal.removeEventListener('abort', abort); await watch.stop(); await rootStop.stop() }
}
export function blockerApi({ harness, context, TaskCard, ChatInput, get, bots, collaboration }) {
  return {
    async resolveBlocker(id, blockerId, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!['answer','version','rootWorkId','inReplyTo'].includes(k)) ||
        typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 4000) {
        throw new TaskInputError(400, 'INVALID_BLOCKER_ANSWER', '回答仅接受 answer：1–4000 字符的非空文本。')
      }
      await harness.commit(async (tx) => {
        await resolveInformation(tx, {TaskCard,ChatInput,bots,collaboration}, id, blockerId, input, null)

      }, context)
      harness.resume()
      return get(id)
    },
  }
}

const clone=x=>JSON.parse(JSON.stringify(x))
const reject=(code,message)=>{throw new TaskInputError(409,code,message)}
// notify(user,event): page-local durable delivery; same logical item/version is upserted.
// No external push, arbitrary recipient, new execution state or in-memory delivery promise.
export function userNotifier(tx) {
 return async function notify(user,event) {
  const {Collaboration}=await import('./collaboration.mjs')
  const relation=(await tx.doc(Collaboration)).items.find(r=>r.id===event.relationId)
  if(!relation || relation.initiatingUser!==user || event.item.taskId!==relation.childTaskId || event.item.rootWorkId!==relation.rootWorkId) reject('BLOCKER_NOTIFICATION_DENIED','通知接收人与原工作不匹配。')
  relation.blockers??=[]
  const index=relation.blockers.findIndex(b=>b.id===event.item.id)
  const snapshot=clone(event.item)
  if(index<0) relation.blockers.push(snapshot); else relation.blockers[index]=snapshot
 }
}
export async function notifyBlocker(tx,relation,item) {
 if(relation) await userNotifier(tx)(relation.initiatingUser,{relationId:relation.id,item})
}
export async function guardBlocker(tx, deps, id) {
 const record=await tx.task(id)
 if(!record || record.kind!=='pidot.chat') throw new TaskInputError(404,'TASK_NOT_FOUND','任务不存在。')
 await assertNotCancelled(tx,id,record)
 const card=await tx.doc(deps.TaskCard,id)
 await assertBotActive(tx,card.bot.id)
 await deps.collaboration.guard(tx,id,{issueDecision:true})
 return {record,card}
}
export async function resolveInformation(tx,deps,id,blockerId,input,actor) {
 const {record,card}=await guardBlocker(tx,deps,id)
 const state=await tx.doc(TaskBlockers,id),item=state.items.find(i=>i.id===blockerId)
 if(!item) reject('BLOCKER_NOT_FOUND','此Task没有该事项。')
 const {Collaboration}=await import('./collaboration.mjs')
 const relation=(await tx.doc(Collaboration)).items.find(r=>r.childTaskId===id&&r.childInputId===item.inReplyTo)
 if(actor) {
  if(!relation || relation.parentTaskId!==actor.taskId || relation.supervisorBotId!==actor.bot.id) reject('BLOCKER_HANDLER_DENIED','不是原工作的绑定主管。')
  await guardBlocker(tx,deps,actor.taskId)
 }
 const source=actor?'supervisor':'authenticated-user'
 // Exact replay only; cannot use an old version to overwrite or cross the transfer boundary.
 if(item.status==='resolved') {
  if(item.answer.content===input.answer && item.answer.source===source && (!relation || input.version===item.answer.expectedVersion && input.rootWorkId===item.rootWorkId && input.inReplyTo===item.inReplyTo)) return
  reject('BLOCKER_ALREADY_RESOLVED','事项已回答，不能冲突覆盖。')
 }
 if(actor && (await tx.doc(deps.ChatInput,actor.taskId)).entryId!==relation.parentInputId) reject('BLOCKER_HANDLER_DENIED','不是原活动工作。')
 if(item.assignee!==(actor?'supervisor':'user')) reject('BLOCKER_HANDLER_DENIED','只有当前处理人可以回答。')
 if(relation && (input.version!==item.version || input.rootWorkId!==item.rootWorkId || input.inReplyTo!==item.inReplyTo)) reject('BLOCKER_VERSION_CONFLICT','工作、输入或事项版本不匹配。')
 if(state.activeId!==blockerId || record.state.checkpoint?.phase!=='awaitBlocker' || record.state.checkpoint.blockerId!==blockerId || record.state.checkpoint.entryId!==item.inReplyTo || item.taskId!==id || item.conversationId!==card.conversationId || (await tx.doc(deps.ChatInput,id)).entryId!==item.inReplyTo || !['pending','running'].includes(record.state.status)) reject('BLOCKER_UNAVAILABLE','原等待检查点不匹配。')
 const answer={blockerId,taskId:id,inReplyTo:item.inReplyTo,question:item.question,content:input.answer,source,expectedVersion:item.version,createdAt:new Date().toISOString(),...(actor?{actorTaskId:actor.taskId}: {})}
 const audit=await tx.appendEntry(card.conversationId,{kind:'pidot.blocker-resolved',data:answer})
 item.status='resolved';item.version=(item.version??1)+1;item.answer={...answer,id:audit.id};state.activeId=null
 item.history??=[];item.history.push({action:'resolved',assignee:item.assignee,source,createdAt:answer.createdAt})
 await notifyBlocker(tx,relation,item)
}
export async function executeBlockerAction(tx,deps,actor,call) {
 const a=call.arguments
 if(call.name==='blocker_resolve') {
  await resolveInformation(tx,deps,a.taskId,a.blockerId,a,actor)
  return {ok:true,data:{taskId:a.taskId,blockerId:a.blockerId,status:'resolved'}}
 }
 await guardBlocker(tx,deps,a.taskId);await guardBlocker(tx,deps,actor.taskId)
 const {Collaboration}=await import('./collaboration.mjs')
 const relation=(await tx.doc(Collaboration)).items.find(r=>r.childTaskId===a.taskId&&r.parentTaskId===actor.taskId&&r.supervisorBotId===actor.bot.id&&r.rootWorkId===a.rootWorkId&&r.childInputId===a.inReplyTo)
 if(!relation) reject('BLOCKER_HANDLER_DENIED','不是原工作的绑定主管。')
 const state=await tx.doc(TaskBlockers,a.taskId),item=state.items.find(i=>i.id===a.blockerId)
 if(!item) reject('BLOCKER_NOT_FOUND','事项不存在。')
 if(item.assignee==='user'&&item.transfer?.reason===a.reason&&item.transfer.expectedVersion===a.version) return {ok:true,data:{status:'waiting-for-user',replayed:true}}
 if((await tx.doc(deps.ChatInput,actor.taskId)).entryId!==relation.parentInputId) reject('BLOCKER_HANDLER_DENIED','不是原活动工作。')
 if(item.status!=='pending'||item.assignee!=='supervisor') reject('BLOCKER_HANDLER_DENIED','事项已转交或回答。')
 if(item.version!==a.version) reject('BLOCKER_VERSION_CONFLICT','事项版本过期。')
 const record=await tx.task(a.taskId)
 if(state.activeId!==item.id||record.state.checkpoint?.phase!=='awaitBlocker'||record.state.checkpoint.blockerId!==item.id||record.state.checkpoint.entryId!==item.inReplyTo||(await tx.doc(deps.ChatInput,a.taskId)).entryId!==item.inReplyTo) reject('BLOCKER_UNAVAILABLE','等待检查点不匹配。')
 item.transfer={reason:a.reason,expectedVersion:item.version,actorTaskId:actor.taskId,createdAt:new Date().toISOString()};item.assignee='user';item.version++
 item.history.push({action:'escalated',assignee:'user',...clone(item.transfer)})
 await tx.appendEntry((await tx.doc(deps.TaskCard,a.taskId)).conversationId,{kind:'pidot.blocker-escalated',data:{blockerId:item.id,...clone(item.transfer)}})
 await notifyBlocker(tx,relation,item)
 return {ok:true,data:{taskId:a.taskId,blockerId:item.id,version:item.version,status:'waiting-for-user'}}
}
