import TaskApprovalControls, {type ApprovalTask} from './TaskApprovalControls'
import TaskBlockerControls, {type BlockedTask} from './TaskBlockerControls'
export type GroupIssue = ApprovalTask & BlockedTask & {restricted?:boolean;groupId:string;rootWorkId:string;sourceMessageId:number}
export default function GroupIssueControls({items,token,onRefresh,onError}:{items?:GroupIssue[];token:string;onRefresh:()=>void;onError:(error:unknown)=>void}) {
  const visible=items?.filter(t=>t.restricted||t.approvals?.items.length||t.blockers?.items.length)
  if(!visible?.length)return null
  return <section aria-label="群内待处理" className="group-issues"><h3>群内待处理</h3>{visible.map(item => <article key={item.taskId}>
    <p><a href={`#bot=${encodeURIComponent(item.bot.id)}&task=${item.taskId}`}>打开原任务 · {item.bot.id}</a></p>
    {item.restricted && <p role="status">暂时看不了这条记录，请核对连接权限。</p>}
    <TaskBlockerControls task={{ ...item, groupChild: true }} token={token} onUpdated={onRefresh} onError={onError} />
    <TaskApprovalControls task={{ ...item, groupChild: true }} token={token} onUpdated={onRefresh} onError={onError} />
  </article>)}</section>
}
