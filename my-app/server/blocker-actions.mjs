export const BLOCKER_ACTIONS = ['blocker_resolve', 'blocker_escalate']
export const blockerActions = BLOCKER_ACTIONS.map(name => ({ name, description: name === 'blocker_resolve'
  ? '仅绑定的当前任务主管回答子任务的具体信息事项。使用宿主通知中的精确taskId/blockerId/version/rootWorkId/inReplyTo；信息回答不批准任何动作或权限。重复同一回答幂等。'
  : '主管无法提供必要信息时显式转交认证用户，提供reason并保留历史；转交后主管不可再回答。不请求权限或危险动作批准。',
parameters: { type:'object', additionalProperties:false, required:['taskId','blockerId','version','rootWorkId','inReplyTo',name === 'blocker_resolve' ? 'answer':'reason'], properties:{
 taskId:{type:'integer',minimum:1},blockerId:{type:'integer',minimum:1},version:{type:'integer',minimum:1},rootWorkId:{type:'string',minLength:1,maxLength:180},inReplyTo:{type:'integer',minimum:1},
 [name === 'blocker_resolve' ? 'answer':'reason']:{type:'string',minLength:1,maxLength:4000}
} } }))
export function validBlockerAction(call) {
 const a=call.arguments, text=call.name === 'blocker_resolve' ? 'answer':'reason'
 return !call.argumentsError && a && typeof a==='object' && !Array.isArray(a) && Object.keys(a).length===6 && ['taskId','blockerId','version','inReplyTo'].every(k=>Number.isSafeInteger(a[k])&&a[k]>0) && typeof a.rootWorkId==='string'&&a.rootWorkId.length>0&&a.rootWorkId.length<=180&&typeof a[text]==='string'&&a[text].trim().length>0&&a[text].length<=4000
}
