export type WaitingSnapshot = { kind: 'blocker' | 'approval' | 'limits' | 'action-outcome'; inputId: number; status: 'pending' | 'response-saved' | 'insertion-pending' | 'cancelled'; reason: string | null;
  item: { id: number } | null; usage: { modelCalls: number; toolCalls: number; totalTokens: number; unknownTokenCalls: number };
  limits: { modelCalls: number; toolCalls: number; totalTokens?: number } }
const labels = { 'action-outcome': '操作结果待核实', blocker: '信息问题', approval: '操作确认', limits: '调用限额' }
export default function WaitingRecoveryNotice({ recovered, current, cancelled }: { recovered?: WaitingSnapshot | null; current?: WaitingSnapshot | null; cancelled: boolean }) {
  if (!recovered) return null
  return <section className="task-blockers" aria-label="等待事项恢复" data-testid="waiting-recovery">
    <h3>已恢复等待事项 · {labels[recovered.kind]}</h3>
    <p>{cancelled ? '会话已取消，记录已保留。' : current ? '请处理对应的确认、问题或调用上限。' : '等待事项已处理。'}</p>
  </section>
}
