export type WaitingSnapshot = { kind: 'blocker' | 'approval' | 'limits' | 'action-outcome'; inputId: number; status: 'pending' | 'response-saved' | 'insertion-pending' | 'cancelled'; reason: string | null;
  item: { id: number } | null; usage: { modelCalls: number; toolCalls: number; totalTokens: number; unknownTokenCalls: number };
  limits: { modelCalls: number; toolCalls: number; totalTokens?: number } }
const labels = { 'action-outcome': '操作结果待核实', blocker: '信息问题', approval: '模拟日历审批', limits: '调用限额' }
export default function WaitingRecoveryNotice({ recovered, current, cancelled }: { recovered?: WaitingSnapshot | null; current?: WaitingSnapshot | null; cancelled: boolean }) {
  if (!recovered) return null
  return <section className="task-blockers" aria-label="等待事项恢复" data-testid="waiting-recovery">
    <h3>已恢复原等待事项 · {labels[recovered.kind]}{recovered.item ? ` #${recovered.item.id}` : ''}</h3>
    <p>关联原输入 #{recovered.inputId}。{recovered.status === 'insertion-pending' ? '重启前已选择插入，原审批卡保持锁定，请提交新要求；不会执行原操作。' : recovered.status === 'response-saved' ? '重启前回应已保存，使用原回应继续，不重复提问或消费批准。' : '重启不默认批准、不解除阻塞、不增加额度；请从对应事项处理。'}</p>
    <p className="muted small">恢复时：模型 {recovered.usage.modelCalls} / {recovered.limits.modelCalls} · 工具 {recovered.usage.toolCalls} / {recovered.limits.toolCalls} · 已知 Token {recovered.usage.totalTokens} / {recovered.limits.totalTokens ?? '未设阈值'} · 未知 {recovered.usage.unknownTokenCalls}。{recovered.reason && ` 原因：${recovered.reason}。`}</p>
    <p>{cancelled ? 'Task 已取消，旧回答或批准不能恢复执行。' : current?.status === 'insertion-pending' ? '已选择插入，等待提交新要求；同意、拒绝、插入均不可再选。' : current?.status === 'pending' ? current.kind === 'action-outcome' ? '原操作结果仍待核实；工具仅按明确保障窗口复用原幂等标识安全恢复，条件不成立则只读查询或等待用户处理，已有历史、配置与计数保留。' : '当前仍等待用户处理；已有历史、配置与计数保留。' : current?.status === 'response-saved' ? '对应回应已保存，继续前仍检查当前权限、限额与任务状态。' : '此等待事项已处理；原回应与执行结果见对应卡片。'}</p>
  </section>
}
