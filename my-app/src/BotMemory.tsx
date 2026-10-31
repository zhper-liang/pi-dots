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
  return <div className="memory-view" aria-label="机器人记忆" aria-busy={resource.loading && !resource.data}>
    <div className="memory-actions"><p className="memory-intro">人格由你写，记忆从对话里整理，改完马上生效。</p><button type="button" disabled={resource.loading} onClick={() => { void resource.refresh() }}>{resource.loading ? '正在读取…' : '刷新'}</button></div>
    {resource.error && <p role="alert" className="memory-error">{resource.error}</p>}
    {!resource.data && !resource.error && <p role="status" className="memory-hint">正在读取记忆…</p>}
    {readOnly && <p role="status" className="memory-hint">这个机器人已停用，只能查看。</p>}
    {resource.data && <>
      <MemoryDocumentSection title="人格" description="这个机器人的性格、说话方式和职责，只有你能改。" document={resource.data.personality} history={resource.data.history?.personality} truncated={resource.data.historyNextBeforeVersion?.personality != null} readOnly={readOnly} onEdit={edit} onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      <MemoryDocumentSection title="记忆" description="只属于这个机器人，可以改或删；日程以日历为准。" document={resource.data.memory} history={resource.data.history?.memory} truncated={resource.data.historyNextBeforeVersion?.memory != null} readOnly={readOnly} onEdit={edit} onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      <MemoryDocumentSection title="共享偏好" description="所有机器人共用，在这里只能看，到「设置 → 偏好」里改。" document={resource.data.preferences} readOnly onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      {onOpenPreferences && <button type="button" onClick={onOpenPreferences}>去设置改偏好</button>}
    </>}
  </div>
}
