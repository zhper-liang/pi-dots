import { useState } from 'react'
import WorkspaceIdentity from './WorkspaceIdentity'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'

type Source = { id: string; authority: 'local' | 'external'; authorized: boolean; readScope?: string; epoch?: number; grantEpoch?: number; calendarId?: string }
type Status = { enabled: boolean; schemaVersion: number | null; sources: Source[]; notice: string }
export default function WorkspaceStatus({ token, active = true }: { token: string; active?: boolean }) {
  const [data, setData] = useState<Status | null>(null), [external, setExternal] = useState<Source[]>([])
  const [error, setError] = useState(''), [externalError, setExternalError] = useState(''), [busy, setBusy] = useState(false), [updatedAt, setUpdatedAt] = useState('')
  const { refresh } = useWorkspaceRefresh({
    scopeKey: token, active,
    load: async ({ signal, isCurrent }) => {
      setBusy(true)
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const read = async (path: string, post = false) => {
        const response = await fetch(path, { signal, headers, ...(post ? { method: 'POST', body: '{}' } : {}) })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error?.message ?? '状态读取失败。')
        return body.data
      }
      try {
        const [local, remote] = await Promise.allSettled([read('/api/workspace/status'), read('/api/workspace/external-sources', true)])
        if (!isCurrent()) return
        if (local.status === 'fulfilled') { setData(local.value); setError('') } else setError('本地存储状态暂未同步，将自动重试。')
        if (remote.status === 'fulfilled') { setExternal(remote.value.sources); setExternalError('') } else setExternalError('外部来源暂不可达，将自动重试。')
        if (local.status === 'fulfilled' && remote.status === 'fulfilled') setUpdatedAt(new Date().toLocaleTimeString('zh-CN'))
      } finally { if (isCurrent()) setBusy(false) }
    },
    onInvalidate: reason => { if (reason === 'scope') { setData(null); setExternal([]); setUpdatedAt(''); setError(''); setExternalError(''); setBusy(false) } },
    onError: () => { setBusy(false); setError('状态读取超时，将自动重试。') },
  })
  return <section className="feishu-panel"><h2>来源与存储诊断</h2>
    {(error || externalError) && <button type="button" disabled={busy || !active} onClick={() => void refresh(true)}>重新读取</button>}
    {busy && !data && <p role="status">正在核验来源与用户权限…</p>}
    {updatedAt && <p className="bot-edit-hint">更新于 {updatedAt}</p>}
    {error && <p role="alert">{error}</p>}{externalError && <p role="status">{externalError}</p>}
    {data && <><p>业务存储：{data.enabled ? `版本 ${data.schemaVersion}` : '已禁用'}</p><p>{data.notice}</p></>}
    {[...(data?.sources ?? []), ...external].map(source => <div key={source.id}><WorkspaceIdentity sourceId={source.id} authority={source.authority} scope={source.authorized ? source.readScope ?? 'full' : 'none'} epoch={source.epoch ?? source.grantEpoch} />{source.calendarId && <p>已绑定飞书应用账号/容器：{source.calendarId}</p>}</div>)}
  </section>
}
