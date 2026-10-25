export const SHARED_TOOLS = ['shared_publish', 'shared_read', 'shared_link']
const str = maxLength => ({ type:'string', minLength:1, maxLength })
const id = str(180)
const version = { type:'integer', minimum:0 }
export const sharedTools = [
 {name:'shared_publish',description:'在当前根工作发布事实或笔记。来源由宿主填写；默认仅作者/主管可读。recordId在作者任务内稳定，expectedVersion=0创建，更新使用读取版本；operationId重试不变。fact的content只接受subject/predicate/value字符串；note的content是字符串。content JSON最多3500 UTF-8字节。不含任何任务控制或授权。',parameters:{type:'object',additionalProperties:false,required:['operationId','recordId','expectedVersion','kind','content'],properties:{operationId:str(80),recordId:id,expectedVersion:version,kind:{enum:['fact','note']},content:{oneOf:[str(4000),{type:'object',additionalProperties:false,required:['subject','predicate','value'],properties:{subject:str(500),predicate:str(500),value:str(2000)}}]}}}},
 {name:'shared_read',description:'只读当前工作明确可见共享记录，含宿主来源和精确版本；空参数列出最多20条。recordId必须是回执中的完整ID，禁止猜测其他任务。',parameters:{type:'object',additionalProperties:false,properties:{recordId:id}}},
 {name:'shared_link',description:'仅本根工作主管可明确关联/撤回给一个已委派兄弟Task的共享记录。只控制可见性，不授予资源或工具。expectedVersion为记录版本，expectedAccessVersion为访问版本；更新后重新读取。',parameters:{type:'object',additionalProperties:false,required:['operationId','recordId','expectedVersion','expectedAccessVersion','targetTaskId','allow'],properties:{operationId:str(80),recordId:id,expectedVersion:version,expectedAccessVersion:version,targetTaskId:{type:'integer',minimum:1},allow:{type:'boolean'}}}},
]
export function validSharedArgs(call) {
 const a=call.arguments, text=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n
 if(call.argumentsError||!a||typeof a!=='object'||Array.isArray(a))return false
 const keys=Object.keys(a), schema=sharedTools.find(t=>t.name===call.name)?.parameters
 if(!schema||keys.some(k=>!Object.hasOwn(schema.properties,k))||(schema.required??[]).some(k=>!Object.hasOwn(a,k)))return false
 if(call.name==='shared_read')return a.recordId===undefined||text(a.recordId,180)
 if(!text(a.operationId,80)||!/^[-\w.:]+$/.test(a.operationId)||!text(a.recordId,180)||!Number.isSafeInteger(a.expectedVersion)||a.expectedVersion<0)return false
 if(call.name==='shared_link')return Number.isSafeInteger(a.expectedAccessVersion)&&a.expectedAccessVersion>=0&&Number.isSafeInteger(a.targetTaskId)&&a.targetTaskId>0&&typeof a.allow==='boolean'
 if(Buffer.byteLength(JSON.stringify(a.content)??'','utf8')>3500)return false
 if(a.kind==='note')return text(a.content,4000)
 return a.kind==='fact'&&a.content&&typeof a.content==='object'&&!Array.isArray(a.content)&&Object.keys(a.content).length===3&&Object.keys(a.content).every(k=>['subject','predicate','value'].includes(k))&&text(a.content.subject,500)&&text(a.content.predicate,500)&&text(a.content.value,2000)
}
