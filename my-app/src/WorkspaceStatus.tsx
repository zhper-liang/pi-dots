import { useRef, useState } from 'react'
import WorkspaceIdentity from './WorkspaceIdentity'

type Source = { id: string; authority: 'local' | 'external'; authorized: boolean; readScope?: string; epoch?: number; grantEpoch?: number; calendarId?: string }
type Status = { enabled: boolean; schemaVersion: number | null; sources: Source[]; notice: string }
export default function WorkspaceStatus({ token }: { token: string }) {
  const [data, setData] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const sequence = useRef(0)
  async function refresh() {
    const request = ++sequence.current
    setBusy(true); setError(''); setData(null)
    try {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const responses = await Promise.all([fetch('/api/workspace/status', { headers }), fetch('/api/workspace/external-sources', { method: 'POST', headers, body: '{}' })])
      const bodies = await Promise.all(responses.map(response => response.json()))
      if (request !== sequence.current) return
      if (responses.some(response => !response.ok)) throw new Error('业务来源状态读取失败。')
      setData({ ...bodies[0].data, sources: [...bodies[0].data.sources, ...bodies[1].data.sources] })
    } catch { if (request === sequence.current) setError('业务存储状态读取失败，请检查连接后重试。') }
    finally { if (request === sequence.current) setBusy(false) }
  }
  return <section className="feishu-panel"><h2>来源与存储诊断</h2><button disabled={busy} onClick={() => void refresh()}>{busy ? '正在读取…' : '读取存储状态'}</button>{busy && <p role="status">正在核验来源与用户权限…</p>}{error && <p role="alert">{error}</p>}{!data && !busy && !error && <p className="workspace-empty">读取服务端当前状态，不自动连接、授权或展开日程正文。</p>}{data && <><p>业务存储：{data.enabled ? `版本 ${data.schemaVersion}` : '已禁用'}</p><p>{data.notice}</p>{data.sources.map(source => <div key={source.id}><WorkspaceIdentity sourceId={source.id} authority={source.authority} scope={source.authorized ? source.readScope ?? 'full' : 'none'} epoch={source.epoch ?? source.grantEpoch} />{source.calendarId && <p>已绑定飞书应用账号/容器：{source.calendarId}</p>}</div>)}</>}</section>
}
