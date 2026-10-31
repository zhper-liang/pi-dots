export type WaitingSnapshot = { kind: 'blocker' | 'approval' | 'limits' | 'action-outcome'; inputId: number; status: 'pending' | 'response-saved' | 'insertion-pending' | 'cancelled'; reason: string | null;
  item: { id: number } | null; usage: { modelCalls: number; toolCalls: number; totalTokens: number; unknownTokenCalls: number };
  limits: { modelCalls: number; toolCalls: number; totalTokens?: number } }
const labels = { 'action-outcome': '操作结果待核实', blocker: '信息问题', approval: '操作确认', limits: '调用限额' }
export default function WaitingRecoveryNotice({ recovered, current, cancelled }: { recovered?: WaitingSnapshot | null; current?: WaitingSnapshot | null; cancelled: boolean }) {
  if (!recovered) return null
  return <section className="task-blockers" aria-label="等待事项恢复" data-testid="waiting-recovery">
    <h3>已恢复等待事项 · {labels[recovered.kind]}</h3>
    <p>{cancelled ? '会话已取消，记录已保留。' : current ? '请处理对应的确认、问题或调用上限。' : '等待事项已处理。'}</p>
    <details className="tech-info"><summary>技术信息</summary>
      <p>原输入 #{recovered.inputId} · {recovered.status} · {recovered.reason}</p>
      <p>模型 {recovered.usage.modelCalls} / {recovered.limits.modelCalls} · 工具 {recovered.usage.toolCalls} / {recovered.limits.toolCalls} · Token {recovered.usage.totalTokens} / {recovered.limits.totalTokens ?? '未设阈值'} · 未知 {recovered.usage.unknownTokenCalls}</p>
    </details>
  </section>
}
