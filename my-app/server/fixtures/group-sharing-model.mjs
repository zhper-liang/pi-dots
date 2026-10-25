// Deterministic model fixture only; real-provider acceptance is recorded separately.
export const groupSharingConfig={baseUrl:'https://fixture.invalid/v1',model:'group-sharing-recovery',apiKey:'fixture'}
const text=content=>({mode:'model',reply:{content},execution:{usage:{totalTokens:5}}})
let serial=0
const turn=(name,args)=>{const call={type:'toolCall',id:`sharing-${++serial}`,name,arguments:args};return {...text(''),toolCalls:[call],assistant:{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:groupSharingConfig.model,stopReason:'toolUse',timestamp:Date.now()}}}
export async function sharingModel(_m,o) {
 const results=o.context.messages.filter(m=>m.role==='toolResult').flatMap(m=>m.content??[]).filter(c=>c.type==='text').flatMap(c=>{try{return [JSON.parse(c.text)]}catch{return []}})
 const assigned=results.filter(r=>r.ok&&r.data?.childTaskId&&r.data?.childInputId).map(r=>r.data)
 if(o.parametersBotId==='calendar')return results.some(r=>r.ok&&r.data?.recordId)?text('A模拟事实完成'):turn('shared_publish',{operationId:'publish-a',recordId:'window',expectedVersion:0,kind:'fact',content:{subject:'会议',predicate:'模拟时间',value:'09:30'}})
 if(o.parametersBotId==='chief')return text('B建议09:30；仅使用定向模拟事实')
 if(!assigned.length)return turn('task_assign',{operationId:'a',botId:'calendar',goal:'发布模拟事实',completionCriteria:['发布fact']})
 const refs=results.flatMap(r=>r.data?.records??[])
 if(!refs.length)return turn('shared_read',{})
 for(const r of assigned)if(!results.some(x=>x.data?.decision==='accept'&&x.data?.childTaskId===r.childTaskId))return turn('task_review',{operationId:`accept-${r.childTaskId}`,childTaskId:r.childTaskId,rootWorkId:r.rootWorkId,revision:1,expectedState:'submitted',decision:'accept',reason:'核对模拟事实来源'})
 if(assigned.length===1)return turn('task_assign',{operationId:'b',botId:'chief',goal:'依据共享事实给建议，不委派',completionCriteria:['引用事实'],sharedRecords:refs.map(r=>({recordId:r.recordId,version:r.version,accessVersion:r.accessVersion}))})
 return text('主管完成A→B定向共享；原工作两名直接子Bot已验收')
}
export async function configureSharing(store) {
 const shared=['shared_publish','shared_read','shared_link'],tools=[...shared,'collaborators_list','task_assign','task_review']
 for(const id of ['todo','calendar','chief']){const {bot}=await store.getBotConfiguration(id);const allowed=id==='todo'?tools:shared;if(JSON.stringify(bot.defaults.tools)!==JSON.stringify(allowed))await store.updateBotConfiguration(id,{requestId:'sharing-recovery-'+id,expectedVersion:bot.configRef.version,description:bot.description,tools:allowed,resources:[]})}
}
