import { useEffect, useRef, useState } from 'react'
import { taskPath } from './taskPath'

type Ref = { botId: string; version: string }
type Migration = { id: number; previous: Ref; next: Ref; source: string; createdAt: string }
type OwnedTask = { taskId: number; bot: { id: string }; configRef: Ref; migrationHistory?: Migration[] }
type Preview = { taskId: number; conversationId: number; previous: Ref; next: Ref; previewToken: string; changes: { field: string; previous: unknown; next: unknown }[]; retainedOverrides: string[]; activeSkills: { id: string; version: string; sha256: string }[]; capacity: { contextWindow: number; estimatedTokens: number; nextInputReserveTokens: number } | null; usage: { modelCalls: number; toolCalls: number; totalTokens: number; unknownTokenCalls: number } }
const fieldLabels: Record<string, string> = { 'bot.description': '职责', 'parameters.mode': '回复方式', 'parameters.model': '模型', 'parameters.thinkingLevel': '思考深度', 'parameters.requestTimeoutMs': '单次等待上限', 'parameters.maxOutputTokens': '单次回复长度上限', 'parameters.callLimits': '调用上限', 'parameters.contextWindows': '模型容量' }
const fieldLabel = (field: string) => fieldLabels[field] ?? '其他设置'
// A setting value in words: model by name, lists joined, objects as short key: value pairs.
function settingValue(value: unknown): string {
  if (value === null || value === undefined) return '未设置'
  if (value === 'model') return '真实模型'
  if (value === 'test') return '测试回复'
  if (value === 'low') return '低'
  if (value === 'high') return '高'
  if (Array.isArray(value)) return value.length ? value.join('、') : '无'
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string') return record.id
    return Object.entries(record).map(([key, item]) => `${key} ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`).join('，')
  }
  return String(value)
}
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
        onUpdated(body.task); setNotice('已更新，之后的消息用新模型和提示词。')
      } else { operation.current = null; setPreview(body.preview); setConfirmed(false) }
    } catch (e) {
      if (!signal.aborted) setError(e instanceof TypeError ? '没确认更新成功，再点一次核对。' : e instanceof Error ? e.message : '操作失败。')
    } finally { inFlight.current = false; if (!signal.aborted) setBusy(false) }
  }
  return <details className="bot-configuration task-migration"><summary>更新本会话的模型与提示词</summary>
    <p className="muted small">空闲时可以更新，已有历史和调用次数保留。</p>
    <button type="button" disabled={busy} onClick={() => void perform(false)}>{busy ? '正在比较…' : '看看会改什么'}</button>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {preview && <section aria-label="会改什么">
      <p>聊天记录、任务要求和已用调用次数都保留{preview.retainedOverrides.length ? '，你单独改过的设置也保留' : ''}。</p>
      {(() => { const rows = preview.changes.filter((c) => !['parameters.tools', 'parameters.toolResources'].includes(c.field)); return rows.length ? <div className="table-scroll"><table><caption>会改的设置</caption><thead><tr><th>设置</th><th>现在</th><th>改成</th></tr></thead><tbody>{rows.map((c) => <tr key={c.field}><th>{fieldLabel(c.field)}</th><td>{settingValue(c.previous)}</td><td>{settingValue(c.next)}</td></tr>)}</tbody></table></div> : <p>只更新了内部配置，用起来没有区别。</p> })()}
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />把这个会话改成上面的设置。</label>
      <button className="primary" type="button" disabled={busy || !confirmed} onClick={() => void perform(true)}>更新这个会话</button>
    </section>}
    {!!task.migrationHistory?.length && <p className="muted small">上次更新：{new Date(task.migrationHistory.at(-1)!.createdAt).toLocaleString('zh-CN')}</p>}
  </details>
}
