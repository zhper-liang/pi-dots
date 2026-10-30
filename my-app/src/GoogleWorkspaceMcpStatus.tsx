import { useEffect, useRef, useState } from 'react'
import { publicWorkspaceMcpStatus, workspaceMcpView, workspaceMcpErrorText, type WorkspaceMcpStatus } from './google-workspace-mcp-ui.mjs'
import './google-workspace-mcp.css'

class StatusRequestError extends Error {}
const LABELS: Record<string, string> = { gmail: 'Gmail', drive: 'Drive', docs: 'Docs', sheets: 'Sheets' }

// R3-05 slot in the Google card: is workspace-mcp running, and is the Google-sourced MCP connection usable.
// Reads GET /api/google/workspace-mcp; "检查连接" reuses POST /api/external-mcp/check. No token ever reaches the page.
export default function GoogleWorkspaceMcpStatus({ token, google }: { token: string; google: { connected: boolean; services: string[] } }) {
  const [status, setStatus] = useState<WorkspaceMcpStatus | null>(null), [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const live = useRef(true)
  async function request(path: string, body?: unknown) {
    let response: Response
    try { response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
    catch { throw new StatusRequestError('网络中断，结果未确认；请稍后刷新状态。') }
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new StatusRequestError(workspaceMcpErrorText(response.status, data))
    return data?.data
  }
  async function refresh() {
    try { const next = publicWorkspaceMcpStatus(await request('/api/google/workspace-mcp')); if (live.current) { setStatus(next); setLoadError('') } }
    catch (failure) { if (live.current) setLoadError(failure instanceof Error ? failure.message : '读取失败。') }
  }
  const servicesKey = google.services.join(',')
  useEffect(() => {
    live.current = true
    void refresh()
    return () => { live.current = false }
    // Re-read when the account changes (connect/disconnect); token changes remount the settings page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, google.connected, servicesKey])
  async function check() {
    const connection = status?.connection
    if (busy || !connection) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await request('/api/external-mcp/check', { requestId: crypto.randomUUID(), connectionId: connection.connectionId, expectedRevision: connection.revision })
      if (live.current) setNotice(result?.status === 'ready' ? `检查通过：发现 ${Number(result.toolCount) || 0} 个工具。` : '检查完成，连接仍不可用。')
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : '检查没有成功。') }
    finally { if (live.current) setBusy(false); await refresh() }
  }

  if (!status) return <div className="workspace-mcp-status" aria-label="workspace-mcp 状态">
    {loadError ? <p role="alert">{loadError} <button type="button" className="pd-button" onClick={() => void refresh()}>重新读取</button></p> : <p role="status">正在读取 workspace-mcp 状态…</p>}
  </div>
  const view = workspaceMcpView(status, google)
  return <div className="workspace-mcp-status" aria-label="workspace-mcp 状态">
    <div className="workspace-mcp-head"><h4>Gmail、Drive、Docs、Sheets（workspace-mcp）</h4>
      {!!view.services.length && <span className="shell-muted small">{view.services.map(item => LABELS[item]).join(' · ')}</span>}</div>
    <dl className="workspace-mcp-lines">
      <div><dt>workspace-mcp</dt><dd><span className={`workspace-mcp-tag is-${view.runtime.tone}`}>{view.runtime.text}</span>{view.runtime.hint && <span className="shell-muted small">{view.runtime.hint}</span>}</dd></div>
      <div><dt>连接</dt><dd><span className={`workspace-mcp-tag is-${view.connection.tone}`}>{view.connection.text}</span>{view.connection.hint && <span className="shell-muted small">{view.connection.hint}</span>}</dd></div>
    </dl>
    <div className="google-connection-actions">
      {status.connection && <button type="button" className="pd-button" disabled={busy || !view.canCheck} onClick={() => void check()}>{busy ? '正在检查…' : view.checkLabel}</button>}
      <button type="button" className="pd-button" disabled={busy} onClick={() => { setNotice(''); setError(''); void refresh() }}>刷新状态</button>
    </div>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}{loadError && <p role="alert">{loadError}</p>}
  </div>
}
