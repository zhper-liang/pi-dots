import { createHash } from 'node:crypto'
import { assertBotActive } from './bot-directory.mjs'
import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError } from './task-config.mjs'
import { assertNotCancelled } from './cancellation.mjs'
import { validQuestions, questionsFor, validateAnswers, canSkipQuestions } from '../shared/question-form.mjs'

export const BLOCKER_TOOL = 'report_blocker'
export const TaskBlockers = defineDoc({ kind: 'pidot.task-blockers', version: 1, scope: 'task',
  initial: () => ({ activeId: null, items: [] }) })
export const blockerTool = Object.freeze({ name: BLOCKER_TOOL, effect: 'task-state',
  description: '缺信息时提问并挂起原请求，不挡新消息。questions可给1–3题表单；非必需题required=false需defaultAnswer。子任务交主管；不用来请求授权。',
  parameters: { type: 'object', additionalProperties: false, required: ['question', 'requiredInformation', 'assignee'], properties: {
    question: { type: 'string', minLength: 1, maxLength: 1000 },
    requiredInformation: { type: 'string', minLength: 1, maxLength: 1000 },
    assignee: { type: 'string', enum: ['user', 'supervisor'] },
    questions: { type: 'array', maxItems: 3, items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, type: { enum: ['text', 'single', 'multiple'] }, required: { type: 'boolean' }, defaultAnswer: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } } } } } } },
  } },
})
export function validBlockerArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) &&
    Object.keys(args).every(key => ['question', 'requiredInformation', 'assignee', 'questions'].includes(key)) && (args.questions === undefined || validQuestions(args.questions)) && ['user', 'supervisor'].includes(args.assignee) &&
    ['question', 'requiredInformation'].every((key) => typeof args[key] === 'string' && args[key].trim() && args[key].length <= 1000)
}
export async function reportBlocker(tx, card, args, entryId, turnId, callId) {
  const state = await tx.doc(TaskBlockers, card.taskId)
  if (state.items.some(item => item.status === 'pending' && item.inReplyTo === entryId)) return { ok: false, error: { code: 'TASK_BLOCKED', message: '请先处理原待办问题。' } }
  const {Collaboration}=await import('./collaboration.mjs')
  const relation = (await tx.doc(Collaboration)).items.find(r=>r.childTaskId===card.taskId && r.childInputId===entryId)
  if (args.assignee === 'supervisor' && !relation) return {ok:false,error:{code:'BLOCKER_HANDLER_DENIED',message:'此Task没有绑定主管。'}}
  const assignee=relation ? 'supervisor':'user'
  const item = { taskId: card.taskId, conversationId: card.conversationId, inReplyTo: entryId, turnId, callId,
    ...(args.questions ? { questions: clone(args.questions) } : {}), question: args.question, requiredInformation: args.requiredInformation, assignee, status: 'pending', version:1, ...(relation ? {rootWorkId:relation.rootWorkId,parentTaskId:relation.parentTaskId,supervisorBotId:relation.supervisorBotId}:{}), history:[{action:'reported',assignee,createdAt:new Date().toISOString()}],
    createdAt: new Date().toISOString(), answer: null }
  const audit = await tx.appendEntry(card.conversationId, { kind: 'pidot.blocker-reported', data: item })
  const blocker = { ...item, id: audit.id }
  state.items.push(blocker); state.activeId = blocker.id
  await notifyBlocker(tx, relation, blocker)
  return { ok: true, data: { blockerId: blocker.id, taskId: card.taskId, status: assignee==='user'?'waiting-for-user':'waiting-for-supervisor',
    assignee, version:1, notice: '具体问题已保存在对应Task待办中，等待该事项当前处理人回答。' } }
}

// Same watch mechanism as ChatInput: durable checkpoint, no polling/model calls.
export async function waitForBlocker(runtime, id, ctx, ChatQueue) {
  const watch = await runtime.watchDoc(TaskBlockers, runtime.taskId, ctx)
  const {watchRootStop}=await import('./collaboration.mjs')
  const rootStop=await watchRootStop(runtime,ctx)
  const queueWatch = ChatQueue ? await runtime.watchDoc(ChatQueue, runtime.taskId, ctx) : null
  let abort
  try {
    await Promise.race([rootStop.promise,new Promise((resolve, reject) => {
      abort = () => reject(runtime.signal.reason ?? new Error('Invocation stopped'))
      runtime.signal.addEventListener('abort', abort, { once: true })
      if (runtime.signal.aborted) { abort(); return }
      const check = (value) => { if (value?.items.some((item) => item.id === id && item.status !== 'pending')) resolve() }
      check(watch.value); watch.start(async (value) => { check(value) })
      if (queueWatch) { const queued = value => { if (value?.entryIds.length) resolve() }; queued(queueWatch.value); queueWatch.start(async value => queued(value)) }
      void watch.closed.then(() => reject(new Error('Blocker watch closed')))
    })])
  } finally { runtime.signal.removeEventListener('abort', abort); await watch.stop(); await queueWatch?.stop(); await rootStop.stop() }
}
export function blockerApi({ harness, context, TaskCard, ChatInput, ChatQueue, admitNextInput, get, bots, collaboration, afterQuestionAction }) {
  return {
    async resolveBlocker(id, blockerId, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['answer', 'answers', 'action', 'requestId', 'version', 'rootWorkId', 'inReplyTo'].includes(k)) ||
        (input.action !== undefined && !['resolve', 'skip', 'cancel', 'adjust'].includes(input.action)) ||
        (input.requestId !== undefined && (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200))) {
        throw new TaskInputError(400, 'INVALID_BLOCKER_ANSWER', '请提交对应问题的回答或处理动作。')
      }
      await harness.commit(async (tx) => {
        await guardBlocker(tx, { TaskCard, ChatInput, bots, collaboration }, id)
        const state = await tx.doc(TaskBlockers, id)
        const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
        const signature = createHash('sha256').update(JSON.stringify(normalize({ blockerId, input }))).digest('hex')
        const key = `request:${input.requestId}`
        const prior = input.requestId && state.requests?.[key]
        if (prior) {
          if (prior !== signature) reject('BLOCKER_REQUEST_CONFLICT', '同一请求标识不能更改问题或回答内容。')
          return
        }
        await resolveInformation(tx, {TaskCard,ChatInput,ChatQueue,admitNextInput,bots,collaboration}, id, blockerId, input, null)
        if (input.requestId) { state.requests ??= {}; state.requests[key] = signature }

      }, context)
      await afterQuestionAction?.(id, input)
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
 const collaborationState=await tx.doc(Collaboration)
 const relation=collaborationState.items.find(r=>r.childTaskId===id&&r.childInputId===item.inReplyTo)
 if(actor) {
  if(!relation || relation.parentTaskId!==actor.taskId || relation.supervisorBotId!==actor.bot.id) reject('BLOCKER_HANDLER_DENIED','不是原工作的绑定主管。')
  await guardBlocker(tx,deps,actor.taskId)
 }
 const source=actor?'supervisor':'authenticated-user'
 const action=input.action ?? 'resolve'
 if (actor && action !== 'resolve' || relation && ['cancel', 'adjust'].includes(action)) reject('BLOCKER_HANDLER_DENIED','受管子任务仅接受原处理人的回答。')
 if (input.version !== undefined && item.status === 'pending' && input.version !== item.version || input.inReplyTo !== undefined && input.inReplyTo !== item.inReplyTo) reject('BLOCKER_VERSION_CONFLICT','问题版本或原请求不匹配。')
 let content=input.answer, answers
 if (action === 'resolve' && input.answers !== undefined) {
  const checked=validateAnswers(questionsFor(item),input.answers)
  if (!checked.ok) throw new TaskInputError(400,'INVALID_BLOCKER_ANSWER',checked.error)
  content=checked.answer; answers=checked.answers
 }
 if (action === 'skip') {
  if (!canSkipQuestions(questionsFor(item))) reject('BLOCKER_REQUIRED','此问题缺少继续所必需的信息，不能跳过。')
  content=questionsFor(item).map(q=>`${q.question}：${q.defaultAnswer}`).join('\n')
 }
 if (action !== 'cancel' && (typeof content !== 'string' || !content.trim() || content.length > 4000)) throw new TaskInputError(400,'INVALID_BLOCKER_ANSWER','回答须为1–4000字符。')
 if (action === 'cancel') content='用户取消了这次请求。'
 if(item.status !== 'pending') {
  if(item.answer?.content===content && item.answer?.source===source && (item.answer.action ?? 'resolve')===action && (input.version === undefined || input.version === item.answer.expectedVersion) && (!relation || input.version===item.answer.expectedVersion && input.rootWorkId===item.rootWorkId && input.inReplyTo===item.inReplyTo)) return
  reject('BLOCKER_ALREADY_RESOLVED','事项已处理，不能冲突覆盖。')
 }
 if(actor && (await tx.doc(deps.ChatInput,actor.taskId)).entryId!==relation.parentInputId) reject('BLOCKER_HANDLER_DENIED','不是原活动工作。')
 if(item.assignee!==(actor?'supervisor':'user')) reject('BLOCKER_HANDLER_DENIED','只有当前处理人可以回答。')
 if(relation && (input.version!==item.version || input.rootWorkId!==item.rootWorkId || input.inReplyTo!==item.inReplyTo)) reject('BLOCKER_VERSION_CONFLICT','工作、输入或事项版本不匹配。')
 const waiting=state.activeId===blockerId && record.state.checkpoint?.phase==='awaitBlocker' && record.state.checkpoint.blockerId===blockerId && record.state.checkpoint.entryId===item.inReplyTo && (await tx.doc(deps.ChatInput,id)).entryId===item.inReplyTo
 if((!item.parked && !waiting) || item.taskId!==id || item.conversationId!==card.conversationId || !['pending','running'].includes(record.state.status)) reject('BLOCKER_UNAVAILABLE','原问题已不再可处理。')
 const answer={blockerId,taskId:id,inReplyTo:item.inReplyTo,question:item.question,content,source,action,...(answers?{answers}:{}),expectedVersion:item.version,createdAt:new Date().toISOString(),...(actor?{actorTaskId:actor.taskId}: {})}
 const audit=await tx.appendEntry(card.conversationId,{kind:'pidot.blocker-resolved',data:answer})
 if (action === 'cancel') {
  collaborationState.stops ??= []
  for (const row of collaborationState.items.filter(row => row.parentTaskId === id && row.parentInputId === item.inReplyTo)) {
   if (!collaborationState.stops.some(stop => stop.rootWorkId === row.rootWorkId)) collaborationState.stops.push({ version: 1, rootWorkId: row.rootWorkId, parentTaskId: id, parentInputId: item.inReplyTo, source, requestedAt: answer.createdAt, entryId: audit.id })
  }
 }
 item.status=action==='cancel'?'cancelled':action==='adjust'?'superseded':action==='skip'?'skipped':'resolved';item.version=(item.version??1)+1;item.answer={...answer,id:audit.id};if(state.activeId===blockerId)state.activeId=null
 item.history??=[];item.history.push({action:'resolved',assignee:item.assignee,source,createdAt:answer.createdAt})
 await notifyBlocker(tx,relation,item)
 if (item.parked) await (await import('./question-runtime.mjs')).enqueueQuestionInput(tx,card,item,deps)
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
