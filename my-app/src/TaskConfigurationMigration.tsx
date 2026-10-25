import { useEffect, useRef, useState } from 'react'
import { taskPath } from './taskPath'

type Ref = { botId: string; version: string }
type Migration = { id: number; previous: Ref; next: Ref; source: string; createdAt: string }
type OwnedTask = { taskId: number; bot: { id: string }; configRef: Ref; migrationHistory?: Migration[] }
type Preview = { taskId: number; conversationId: number; previous: Ref; next: Ref; previewToken: string; changes: { field: string; previous: unknown; next: unknown }[]; retainedOverrides: string[]; activeSkills: { id: string; version: string; sha256: string }[]; capacity: { contextWindow: number; estimatedTokens: number; nextInputReserveTokens: number } | null; usage: { modelCalls: number; toolCalls: number; totalTokens: number; unknownTokenCalls: number } }
export default function TaskConfigurationMigration<T extends OwnedTask>({ task, token, onUpdated }: { task: T; token: string; onUpdated: (task: T) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const controller = useRef<AbortController | null>(null)
  const operation = useRef<object | null>(null)
  const inFlight = useRef(false)
  useEffect(() => () => controller.current?.abort(), [])
  async function perform(apply: boolean) {
    if (inFlight.current || apply && (!preview || !confirmed)) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    controller.current = new AbortController()
    const signal = controller.current.signal
    try {
      if (apply && preview) operation.current ??= { requestId: crypto.randomUUID(), expectedVersion: preview.previous.version, targetVersion: preview.next.version, previewToken: preview.previewToken, confirm: true }
      const response = await fetch(taskPath(task, '/configuration-migration'), { method: apply ? 'POST' : 'GET', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(apply ? { body: JSON.stringify(operation.current) } : {}) })
      const body = await response.json()
      if (signal.aborted) return
      if (!response.ok) {
        // Keep the exact operation for retry only on ambiguous transport/5xx failures.
        if (response.status < 500) { operation.current = null; setPreview(null); setConfirmed(false) }
        throw new Error(body.error?.message ?? '迁移操作失败。')
      }
      if (apply) {
        setPreview(null); setConfirmed(false); operation.current = null
        onUpdated(body.task); setNotice('迁移已保存。原 Task、会话、历史、任务要求、固定 Skill 与累计用量均保留；未自动发送消息。')
      } else { operation.current = null; setPreview(body.preview); setConfirmed(false) }
    } catch (e) {
      if (!signal.aborted) setError(e instanceof TypeError ? '结果未确认。可用同一请求重试确认，或刷新核对迁移记录；不要另发新请求。' : e instanceof Error ? e.message : '操作失败。')
    } finally { inFlight.current = false; if (!signal.aborted) setBusy(false) }
  }
  return <details className="bot-configuration task-migration"><summary>更新本会话的模型与提示词</summary>
    <p className="muted small">当前模型与提示词版本：<code data-testid="task-migration-version">{task.configRef.version}</code>。先比较最新 Bot 配置，再明确确认。仅空闲且无排队、审批、阻塞、限额或结果未知等待时可迁移；忙碌拒绝，不排队。普通消息不会迁移。工具、资源和规则已实时生效，无需迁移。</p>
    <button type="button" disabled={busy} onClick={() => void perform(false)}>{busy ? '正在核对…' : '查看迁移差异'}</button>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {preview && <section aria-label="迁移差异预览">
      <p><code>{preview.previous.version}</code> → <code>{preview.next.version}</code></p>
      <p>保留原 Task #{preview.taskId} / conversation #{preview.conversationId}、历史、任务要求、成功回执和累计用量：模型 {preview.usage.modelCalls} / 工具 {preview.usage.toolCalls} / 已知 Token {preview.usage.totalTokens} / 未知 {preview.usage.unknownTokenCalls}。</p>
      <p>保留用户参数覆盖：{preview.retainedOverrides.join('、') || '无'}。保留活动固定 Skill：{preview.activeSkills.map((s) => `${s.id}@${s.version}`).join('、') || '无'}。</p>
      {preview.capacity && <p>已配置模型容量 {preview.capacity.contextWindow} Token；保守估算上下文 {preview.capacity.estimatedTokens}，另预留下一次输入 {preview.capacity.nextInputReserveTokens}。不会为迁移静默压缩或删减规则。</p>}
      <div className="table-scroll"><table><caption>模型、提示词与运行配置变化</caption><thead><tr><th>字段</th><th>原配置</th><th>目标配置</th></tr></thead><tbody>{preview.changes.filter((c) => !['parameters.tools', 'parameters.toolResources'].includes(c.field)).map((c) => <tr key={c.field}><th>{c.field}</th><td><pre>{JSON.stringify(c.previous, null, 2)}</pre></td><td><pre>{JSON.stringify(c.next, null, 2)}</pre></td></tr>)}</tbody></table></div>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />我已查看差异，明确确认将本会话迁移到目标模型与提示词配置；不重置用量、不复活旧审批。</label>
      <button className="primary" type="button" disabled={busy || !confirmed} onClick={() => void perform(true)}>确认迁移本会话</button>
    </section>}
    <details><summary>本会话迁移记录（{task.migrationHistory?.length ?? 0}）</summary><ol>{task.migrationHistory?.map((m) => <li key={m.id}>#{m.id} · {m.previous.version} → {m.next.version} · {m.source} · {new Date(m.createdAt).toLocaleString('zh-CN')}</li>)}</ol></details>
  </details>
}
