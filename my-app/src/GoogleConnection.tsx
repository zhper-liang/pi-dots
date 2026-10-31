import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import Switch from './Switch'
import GoogleWorkspaceMcpStatus from './GoogleWorkspaceMcpStatus'
import { GOOGLE_SERVICE_ROWS, SERVICE_STATE_TEXT, publicGoogleStatus, serviceRowState, googleStatusText, googleResultText, disconnectText, googleErrorText, type GoogleStatus } from './google-connection-ui.mjs'
import './google-connection.css'

type RowId = 'calendar' | 'tasks' | 'workspace'
class GoogleRequestError extends Error {}

// Secrets (client secret, pasted redirect URL) live only in uncontrolled inputs and the request
// body; forms are reset right after submit and nothing secret is kept in React state.
export default function GoogleConnection({ token, onSummary }: { token: string; onSummary?: (text: string) => void }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null), [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const [rows, setRows] = useState<RowId[] | null>(null)
  const live = useRef(true), wasActive = useRef(false), ids = useId()
  async function request(path: string, body?: unknown): Promise<GoogleStatus | Record<string, unknown>> {
    let response: Response
    try { response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
    catch { throw new GoogleRequestError('网络中断，结果未确认；请稍后刷新状态。') }
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      if (response.status === 503 && path === '/api/google/status' && live.current) onSummary?.('未启用')
      throw new GoogleRequestError(googleErrorText(response.status, data))
    }
    return data?.data
  }
  async function refresh() {
    try {
      const next = publicGoogleStatus(await request('/api/google/status'))
      if (!live.current) return
      setStatus(next); setLoadError('')
      if (wasActive.current && !next.attempt) { const text = googleResultText(next.lastResult); if (text) setNotice(text) }
      wasActive.current = !!next.attempt
    } catch (failure) { if (live.current) setLoadError(failure instanceof Error ? failure.message : '读取失败。') }
  }
  useEffect(() => {
    live.current = true
    void refresh()
    return () => { live.current = false }
    // Token changes remount the settings page (key={token}).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  useEffect(() => {
    if (status) onSummary?.(status.connected ? status.email ?? '已连接' : '未连接')
  }, [status, onSummary])
  const waiting = !!status?.attempt
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting])
  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : '操作没有成功。') }
    finally { if (live.current) setBusy(false) }
  }
  const chosen: RowId[] = rows ?? (status?.requested.length ? GOOGLE_SERVICE_ROWS.filter(row => row.services.some(s => status.requested.includes(s))).map(row => row.id) : GOOGLE_SERVICE_ROWS.map(row => row.id))
  function toggle(id: RowId) { setRows(chosen.includes(id) ? chosen.filter(item => item !== id) : [...chosen, id]) }
  function saveClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, fields = new FormData(form)
    const input = { requestId: crypto.randomUUID(), clientId: String(fields.get('google-client-id') ?? '').trim(), clientSecret: String(fields.get('google-client-secret') ?? '') }
    form.reset()
    void run(async () => { const next = publicGoogleStatus(await request('/api/google/client', input)); setStatus(next); setNotice('客户端配置已保存。') })
  }
  function connect() {
    void run(async () => {
      const next = publicGoogleStatus(await request('/api/google/connect', { services: chosen }))
      setStatus(next); wasActive.current = true
      if (next.attempt) window.open(next.attempt.authorizeUrl, '_blank', 'noopener,noreferrer')
    })
  }
  function paste(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, redirectUrl = String(new FormData(form).get('google-redirect-url') ?? '')
    form.reset()
    void run(async () => { const next = publicGoogleStatus(await request('/api/google/paste', { redirectUrl })); wasActive.current = false; setStatus(next); setNotice('已连接 Google。') })
  }
  function disconnect() {
    void run(async () => { const result = await request('/api/google/disconnect', {}); setNotice(disconnectText(result as { revoked?: boolean | null })); await refresh() })
  }

  if (!status) return <div className="google-connection">{loadError ? <p role="alert">{loadError} <button type="button" className="pd-button" onClick={() => void refresh()}>重新读取</button></p> : <p role="status">正在读取 Google 连接…</p>}</div>
  const client = status.client, connected = status.connected, needsAuth = status.status === 'needs_auth'
  return <div className="google-connection">
    <div className="google-connection-card">
      <div className="google-connection-head">
        <h3>Google 账号</h3>
        <span className={`google-connection-state is-${waiting ? 'waiting' : status.status}`}>{googleStatusText(status)}</span>
      </div>
      <ul className="pd-rows google-service-rows" aria-label="Google 服务">
        {GOOGLE_SERVICE_ROWS.map(row => {
          const state = serviceRowState(row, status), text = SERVICE_STATE_TEXT[state]
          return <li key={row.id} className="pd-row">
            <div className="pd-row-text"><span className="pd-row-title">{row.label}{text && <span className={`google-service-state is-${state}`}>{text}</span>}</span><span className="pd-row-desc">{row.note}</span></div>
            <Switch label={row.label} checked={chosen.includes(row.id)} disabled={busy || waiting} onChange={() => toggle(row.id)} />
          </li>
        })}
      </ul>
      <p className="shell-muted small">开关决定这次连接向 Google 申请哪些权限；实际以 Google 授予的为准。</p>
      {/* R3-05 slot: workspace-mcp running/connection status goes here. */}
      <GoogleWorkspaceMcpStatus token={token} google={{ connected, services: status.services }} />
      <div className="google-connection-actions">
        <button type="button" className="primary" disabled={busy || waiting || !client.configured || client.invalid || !chosen.length} onClick={connect}>{connected || needsAuth ? '重新连接' : '连接 Google'}</button>
        {(connected || needsAuth) && <button type="button" className="pd-button" disabled={busy} onClick={disconnect}>断开</button>}
      </div>
      {waiting && status.attempt && <p className="google-connection-waiting" role="status">已在新窗口打开 Google 授权页（5 分钟内有效）。没有打开？<a href={status.attempt.authorizeUrl} target="_blank" rel="noopener noreferrer">点这里打开</a>。</p>}
      <form className="google-paste" onSubmit={paste} autoComplete="off">
        <label htmlFor={`${ids}-paste`}>粘贴跳转地址</label>
        <p id={`${ids}-paste-help`} className="shell-muted small">授权后浏览器若打不开 127.0.0.1 开头的页面（例如 Pidot 在另一台机器上），把地址栏里的完整地址粘贴到这里。只用于这一次连接。</p>
        <div className="google-paste-row">
          <input id={`${ids}-paste`} name="google-redirect-url" type="text" inputMode="url" required maxLength={8192} spellCheck={false} autoComplete="off" disabled={busy || !waiting} aria-describedby={`${ids}-paste-help`} placeholder={waiting ? 'http://127.0.0.1:…/?state=…&code=…' : '先点“连接 Google”'} />
          <button type="submit" className="pd-button" disabled={busy || !waiting}>完成连接</button>
        </div>
      </form>
      {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}{loadError && <p role="alert">{loadError}</p>}
    </div>
    <details className="shell-more google-client" open={!client.configured || client.invalid ? true : undefined}>
      <summary>OAuth 客户端</summary>
      {client.source === 'env' ? <p className="shell-muted small">{client.invalid ? '环境变量中的 Google 客户端配置不完整或无效，请在服务端同时设置 GOOGLE_OAUTH_CLIENT_ID 和 GOOGLE_OAUTH_CLIENT_SECRET。' : '由环境变量提供 · 只读。请在服务端修改环境配置。'}</p>
        : <form className="google-client-form" onSubmit={saveClient} autoComplete="off">
          <p className="shell-muted small">{client.configured ? '已保存客户端，密钥永不回显。' : '尚未配置。'}在你自己的 Google Cloud 项目里建“桌面应用”类型的 OAuth 客户端，填入 ID 和密钥；只保存在服务端独立凭据文件。</p>
          <label className="google-client-row"><span>客户端 ID</span><input name="google-client-id" type="text" required maxLength={512} spellCheck={false} autoComplete="off" disabled={busy} /></label>
          <label className="google-client-row"><span>客户端密钥</span><input name="google-client-secret" type="password" required={!client.configured} maxLength={512} spellCheck={false} autoComplete="new-password" disabled={busy} placeholder={client.configured ? '留空保留已保存的密钥' : ''} /></label>
          <button type="submit" className="pd-button" disabled={busy}>{busy ? '正在保存…' : '保存客户端'}</button>
        </form>}
    </details>
  </div>
}
