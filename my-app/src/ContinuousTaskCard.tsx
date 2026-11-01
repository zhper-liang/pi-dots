import './continuous-task.css'

// Presentation-only draft. The integration layer maps the authenticated server projection to
// these fields and handles request identity, version checks and stale responses.
export type ContinuousTaskAction = {
  id: string
  label: string
}

export type ContinuousTaskCardView = {
  rootTaskId: number
  title: string
  goal: string
  status: string
  statusReason?: string | null
  currentStep?: string | null
  executor?: string | null
  completionCriteria?: string[]
  verifiedResults?: { id: string; summary: string }[]
  pendingReverification?: { id: string; summary: string }[]
  pendingItems?: { id: string; summary: string }[]
  usage?: { label: string; value: string }[]
  actions?: ContinuousTaskAction[]
  href?: string
}

type Props = {
  task: ContinuousTaskCardView
  busy?: boolean
  onAction: (taskId: number, action: string) => void
}

export default function ContinuousTaskCard({ task, busy = false, onAction }: Props) {
  return <section className="continuous-task-card" aria-label={`持续目标：${task.title}`}>
    <div className="continuous-task-heading">
      <h3>{task.title}</h3>
      <span className="continuous-task-status">{task.status}</span>
    </div>
    <p className="continuous-task-goal">{task.goal}</p>
    {task.statusReason && <p className="continuous-task-reason">{task.statusReason}</p>}
    {(task.currentStep || task.executor) && <dl className="continuous-task-facts">
      {task.currentStep && <><dt>当前阶段</dt><dd>{task.currentStep}</dd></>}
      {task.executor && <><dt>执行者</dt><dd>{task.executor}</dd></>}
    </dl>}
    {!!task.completionCriteria?.length && <div><h4>完成标准</h4><ul>{task.completionCriteria.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></div>}
    {!!task.verifiedResults?.length && <div><h4>已验收成果</h4><ul>{task.verifiedResults.map(item => <li key={item.id}>{item.summary}</li>)}</ul></div>}
    {!!task.pendingReverification?.length && <div><h4>待重新核验</h4><ul>{task.pendingReverification.map(item => <li key={item.id}>{item.summary}</li>)}</ul></div>}
    {!!task.pendingItems?.length && <div><h4>待处理</h4><ul>{task.pendingItems.map(item => <li key={item.id}>{item.summary}</li>)}</ul></div>}
    {!!task.usage?.length && <div><h4>累计用量</h4><dl className="continuous-task-facts">{task.usage.map(item => <div className="continuous-task-usage" key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></div>}
    {(task.href || !!task.actions?.length) && <div className="continuous-task-actions">
      {task.href && <a href={task.href}>打开目标</a>}
      {task.actions?.map(action => <button key={action.id} type="button" disabled={busy} onClick={() => onAction(task.rootTaskId, action.id)}>{action.label}</button>)}
    </div>}
  </section>
}
