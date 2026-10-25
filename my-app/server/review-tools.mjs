export const REVIEW_TOOL = 'task_review'
export const reviewTool = { name: REVIEW_TOOL, description: '仅原工作绑定主管验收或打回已提交子结果。使用结果中的childTaskId/rootWorkId/revision，expectedState固定submitted；operationId稳定重试；decision=accept或request-rework，reason必须给出验收依据或具体可执行修改要求。打回在同Task/原输入继续，沿用累计预算和精确用户审批；不能自验收或替代审批。仅全部必需子结果accepted后才可报告工作完成。', parameters: { type:'object', additionalProperties:false, required:['operationId','childTaskId','rootWorkId','revision','expectedState','decision','reason'], properties: {
 operationId:{type:'string',minLength:1,maxLength:80}, childTaskId:{type:'integer',minimum:1}, rootWorkId:{type:'string',minLength:1,maxLength:180}, revision:{type:'integer',minimum:1}, expectedState:{const:'submitted',type:'string'},decision:{type:'string',enum:['accept','request-rework']},reason:{type:'string',minLength:1,maxLength:4000}
} } }
export function validReviewArgs(call) {
 const a=call.arguments
 return !call.argumentsError&&a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===7&&Object.keys(a).every(k=>reviewTool.parameters.required.includes(k))&&typeof a.operationId==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(a.operationId)&&Number.isSafeInteger(a.childTaskId)&&a.childTaskId>0&&Number.isSafeInteger(a.revision)&&a.revision>0&&typeof a.rootWorkId==='string'&&a.rootWorkId.length>0&&a.rootWorkId.length<=180&&a.expectedState==='submitted'&&['accept','request-rework'].includes(a.decision)&&typeof a.reason==='string'&&a.reason.trim().length>0&&a.reason.length<=4000
}
