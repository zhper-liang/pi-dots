type Result = { visibility?: string; groupId?: string; sourceMessageId?: number; deliveryKey?: string; sources?: {recordId:string;version:number;accessVersion?:number}[]; content: string; status: string; submittedAt: string; accepted: boolean; revision?: number; basis?: { inputId: number; previousRevision: number | null; reworkDecisionEntryId: number | null } }
type Decision = { entryId: number; revision: number; decision: string; reason: string; supervisorBotId: string; supervisorTaskId: number; createdAt: string }
export type Relation = { groupId?: string; sourceMessageId?: number; forkAnchor?: number; id: string; parentTaskId: number; parentInputId: number; supervisorBotId: string; executorBotId: string; childTaskId: number; rootWorkId: string; goal: string; completionCriteria: string[]; createdAt: string; consumedEntryId: number | null; result: Result | null; reviewRequired?: boolean; businessStatus?: string; reworkCount?: number; acceptedRevision?: number; revisions?: Result[]; decisions?: Decision[] }
export default function CollaborationPanel({ taskId, items }: { taskId: number; items?: Relation[] }) {
  if (!items?.length) return null
  return <section aria-label="机器人协作" className="task-state"><h3>机器人协作</h3>{items.map(item => <article key={item.id}>
    <p><a href={`#bot=${encodeURIComponent(item.groupId ? 'groups' : item.supervisorBotId)}&task=${item.parentTaskId}${item.sourceMessageId ? `&message=${item.sourceMessageId}` : ''}`}>主管 {item.supervisorBotId}</a> → <a href={`#bot=${encodeURIComponent(item.executorBotId)}&task=${item.childTaskId}`}>执行者 {item.executorBotId}</a>{taskId === item.childTaskId ? ' · 返回主管会话' : ''}</p>
    <p>目标：{item.goal}</p><ul>{item.completionCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
    <p role="status">{item.businessStatus === 'accepted' ? '已验收' : item.businessStatus === 'cancelled' ? '已取消' : item.businessStatus === 'failed' ? '执行失败' : item.businessStatus === 'rework-requested' ? '返工中' : item.result ? '结果已提交，等主管验收' : '等子任务结果'}</p>
    {(item.revisions?.length ? item.revisions : item.result ? [item.result] : []).map((result, i) => <details key={result.revision ?? i} open><summary>结果 · {result.submittedAt}</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.content}</p><details className="tech-info"><summary>技术信息</summary><pre>{JSON.stringify({ revision: result.revision, deliveryKey: result.deliveryKey, visibility: result.visibility, sources: result.sources, basis: result.basis }, null, 2)}</pre></details></details>)}
    <details className="tech-info"><summary>技术信息</summary>
      <p>原输入 #{item.parentInputId} · 工作 {item.rootWorkId} · 主管任务 #{item.parentTaskId} · 子任务 #{item.childTaskId} · fork {item.forkAnchor} · 收取记录 #{item.consumedEntryId} · 打回 {item.reworkCount ?? 0} 次</p>
      {item.decisions?.map(d => <p key={d.entryId}>责任记录 #{d.entryId} · {d.createdAt} · {d.supervisorBotId} / Task #{d.supervisorTaskId} · 修订 #{d.revision}：{d.decision === 'accept' ? '已接受' : '打回返工'} · {d.reason}</p>)}
    </details>
  </article>)}</section>
}
