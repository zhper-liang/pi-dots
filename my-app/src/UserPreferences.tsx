import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MemoryDocumentSection } from './MemoryDocuments'
import { useMemoryResource } from './useMemoryResource'
import { createMemoryApi } from './memory-api.mjs'
import { resolveMemorySourceHash } from './memory-helpers.mjs'
import type { MemoryApi, MemoryEdit, MemorySource, MemorySourceHandler } from './memory-types'

export type UserPreferencesProps = { token: string; active?: boolean; api?: MemoryApi; onOpenSource?: MemorySourceHandler }

/** Mount only in Settings: the Bot view deliberately exposes no shared-preference mutations. */
export default function UserPreferences(props: UserPreferencesProps) {
  return <UserPreferencesContent key={props.token} {...props} />
}
function UserPreferencesContent({ token, active = true, api: adapter, onOpenSource }: UserPreferencesProps) {
  const api = useMemo(() => adapter ?? createMemoryApi(token), [adapter, token])
  const read = useCallback((signal?: AbortSignal) => api.getPreferences(signal), [api])
  const resource = useMemoryResource(read, active)
  const [sourceNotice, setSourceNotice] = useState('')
  const sourceRequest = useRef<AbortController | null>(null)
  useEffect(() => () => { sourceRequest.current?.abort() }, [])
  async function openSource(source: MemorySource) {
    if (sourceRequest.current) return
    const controller = new AbortController()
    sourceRequest.current = controller
    setSourceNotice('正在打开来源对话…')
    try {
      const hash = await resolveMemorySourceHash(token, source, controller.signal)
      if (controller.signal.aborted) return
      window.location.hash = hash
      setSourceNotice('')
    } catch {
      if (!controller.signal.aborted) setSourceNotice('无法打开这条来源，原消息可能已不可见。请刷新后核对。')
    } finally {
      if (sourceRequest.current === controller) sourceRequest.current = null
    }
  }
  async function edit(input: MemoryEdit) {
    const result = await api.editPreferences(input)
    resource.update(old => ({ ...old, ...result.document }))
    return result
  }
  return <div className="memory-view" aria-label="共享偏好设置" aria-busy={resource.loading && !resource.data}>
    <div className="memory-actions"><p className="memory-intro">所有 Bot 共用。纠正后，所有会话的下一次模型调用会读取最新偏好。</p><button type="button" disabled={resource.loading} onClick={() => { void resource.refresh() }}>{resource.loading ? '正在读取…' : '刷新'}</button></div>
    {sourceNotice && <p role="status" className="memory-hint">{sourceNotice}</p>}
    {resource.error && <p role="alert" className="memory-error">{resource.error}</p>}
    {!resource.data && !resource.error && <p role="status" className="memory-hint">正在读取共享偏好…</p>}
    {resource.data && <MemoryDocumentSection title="共享偏好" description="可纠正或删除已有偏好。新增偏好请在对话中说明，保留可核实的来源。" document={resource.data} history={resource.data.history} truncated={resource.data.historyNextBeforeVersion != null} onEdit={edit} onRefresh={resource.refresh} onOpenSource={onOpenSource ?? (source => { void openSource(source) })} />}
  </div>
}
