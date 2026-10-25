import TaskApprovalControls, {type ApprovalTask} from './TaskApprovalControls'
import TaskBlockerControls, {type BlockedTask} from './TaskBlockerControls'
export type GroupIssue = ApprovalTask & BlockedTask & {restricted?:boolean;groupId:string;rootWorkId:string;sourceMessageId:number}
export default function GroupIssueControls({items,token,onRefresh,onError}:{items?:GroupIssue[];token:string;onRefresh:()=>void;onError:(error:unknown)=>void}) {
  const visible=items?.filter(t=>t.restricted||t.approvals?.items.length||t.blockers?.items.length)
  if(!visible?.length)return null
  return <section aria-label="群内原事项" className="group-issues"><h3>群内原事项 · 问题与精确审批</h3><p className="muted small">由绑定主管处理信息问题；必须由用户决定时显式转交。动作仅由认证用户在原审批卡批准。结果提交不等于验收通过。</p>{visible.map(item=><article key={item.taskId}><p><a href={`#bot=${encodeURIComponent(item.bot.id)}&task=${item.taskId}`}>原子任务 #{item.taskId} · {item.bot.id}</a> · 原群消息 #{item.sourceMessageId} · 工作 {item.rootWorkId}</p>{item.restricted&&<p role="status">来源权限不足；原事项正文与操作已隐藏，请核对来源授权。</p>}<TaskBlockerControls task={{...item,groupChild:true}} token={token} onUpdated={onRefresh} onError={onError}/><TaskApprovalControls task={{...item,groupChild:true}} token={token} onUpdated={onRefresh} onError={onError}/></article>)}</section>
}
