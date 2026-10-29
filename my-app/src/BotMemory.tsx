import { useCallback, useMemo } from 'react'
import { MemoryDocumentSection } from './MemoryDocuments'
import { useMemoryResource } from './useMemoryResource'
import { createMemoryApi } from './memory-api.mjs'
import type { MemoryApi, MemoryEdit, MemorySourceHandler } from './memory-types'

export type BotMemoryProps = {
  botId: string; token: string; active?: boolean; readOnly?: boolean; api?: MemoryApi
  onOpenPreferences?: () => void; onOpenSource?: MemorySourceHandler
}

export default function BotMemory({ botId, token, active = true, readOnly = false, api: adapter, onOpenPreferences, onOpenSource }: BotMemoryProps) {
  // Remount drafts on identity changes, never on a poll or ordinary tab switch.
  return <BotMemoryContent key={`${botId}:${token}`} botId={botId} token={token} active={active} readOnly={readOnly} api={adapter} onOpenPreferences={onOpenPreferences} onOpenSource={onOpenSource} />
}

function BotMemoryContent({ botId, token, active = true, readOnly, api: adapter, onOpenPreferences, onOpenSource }: BotMemoryProps) {
  const api = useMemo(() => adapter ?? createMemoryApi(token), [adapter, token])
  const read = useCallback((signal?: AbortSignal) => api.getBot(botId, signal), [api, botId])
  const resource = useMemoryResource(read, active)
  async function edit(input: MemoryEdit) {
    const result = await api.editBot(botId, input)
    resource.update(old => ({ ...old, [input.kind]: result.document }))
    return result
  }
  return <div className="memory-view" aria-label="Bot 记忆" aria-busy={resource.loading && !resource.data}>
    <div className="memory-actions"><p className="memory-intro">人格由你设定，记忆从对话整理。保存后，下一次模型调用实时读取。</p><button type="button" disabled={resource.loading} onClick={() => { void resource.refresh() }}>{resource.loading ? '正在读取…' : '刷新'}</button></div>
    {resource.error && <p role="alert" className="memory-error">{resource.error}</p>}
    {!resource.data && !resource.error && <p role="status" className="memory-hint">正在读取三份文档…</p>}
    {readOnly && <p role="status" className="memory-hint">Bot 已停用，只能查看文档与历史。</p>}
    {resource.data && <>
      <MemoryDocumentSection title="人格" description="这个 Bot 的性格、表达方式与职责。仅由你编辑，已取代旧职责描述。" document={resource.data.personality} history={resource.data.history?.personality} truncated={resource.data.historyNextBeforeVersion?.personality != null} readOnly={readOnly} onEdit={edit} onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      <MemoryDocumentSection title="Bot 记忆" description="只属于这个 Bot。可纠正或删除；即将发生的日程始终以实时日历为准。" document={resource.data.memory} history={resource.data.history?.memory} truncated={resource.data.historyNextBeforeVersion?.memory != null} readOnly={readOnly} onEdit={edit} onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      <MemoryDocumentSection title="共享偏好" description="所有 Bot 共用，在这里仅供查看。请到「设置 → 共享偏好」编辑。" document={resource.data.preferences} readOnly onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      {onOpenPreferences ? <button type="button" onClick={onOpenPreferences}>去设置编辑共享偏好</button> : <p className="memory-hint">要修改共享偏好，请打开侧栏底部的「设置」。</p>}
    </>}
  </div>
}
