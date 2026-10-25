import { useCallback, useEffect, useRef, useState } from 'react'

type Client = { clientId: string; botId: string; scope: { sources: string[]; actions: string[]; readScope: string }; expiresAt: number; revoked: boolean; expired: boolean }
type Credential = { token: string; clientId: string; expiresAt: number }
type Bot = { id: string; name: string; status?: string }
const actionLabels: Record<string, string> = { read: '读取', create: '新建', update: '修改', delete: '删除' }

export default function StdioCredentials({ token }: { token: string }) {
  const [clients, setClients] = useState<Client[] | null>(null), [bots, setBots] = useState<Bot[]>([])
  const [botId, setBot] = useState(''), [sourceId, setSource] = useState(''), [sources, setSources] = useState<string[]>([])
  const [readScope, setScope] = useState('full'), [actions, setActions] = useState(['read'])
  const [credential, setCredential] = useState<Credential | null>(null), [busy, setBusy] = useState(false), [loadingSources, setLoadingSources] = useState(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const inFlight = useRef(false)
  const api = useCallback(async (path: string, body?: object) => {
    const response = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message ?? '凭证操作失败。')
    return result
  }, [token])
  useEffect(() => {
    let live = true
    Promise.all([api('workspace/client-list', {}), api('bots')]).then(([list, directory]) => {
      if (!live) return
      setClients(list.data.items)
      const active = (directory.bots as Bot[]).filter(b => b.status !== 'inactive')
      setBots(active); setBot(active[0]?.id ?? '')
    }).catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [api])
  useEffect(() => {
    let live = true
    if (!botId) return
    api(`bots/${encodeURIComponent(botId)}/configuration`).then(view => {
      if (!live) return
      const ids = (view.assigned.resources as string[]).filter(r => r.startsWith('workspace:')).map(r => r.slice(10))
      setSources(ids); setSource(ids[0] ?? '')
    }).catch((e: Error) => { if (live) setError(e.message) }).finally(() => { if (live) setLoadingSources(false) })
    return () => { live = false }
  }, [api, botId])
  async function refresh() {
    const [list, directory] = await Promise.all([api('workspace/client-list', {}), api('bots')])
    const active = (directory.bots as Bot[]).filter(b => b.status !== 'inactive')
    const selected = active.some(b => b.id === botId) ? botId : active[0]?.id ?? ''
    setClients(list.data.items); setBots(active); setBot(selected)
    if (selected) {
      const view = await api(`bots/${encodeURIComponent(selected)}/configuration`)
      const ids = (view.assigned.resources as string[]).filter(r => r.startsWith('workspace:')).map(r => r.slice(10))
      setSources(ids); setSource(current => ids.includes(current) ? current : ids[0] ?? ''); setLoadingSources(false)
    }
  }
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try { await work(); await refresh() }
    catch (e) { setError(e instanceof TypeError ? '结果未确认，请刷新凭证列表核对后再操作。' : e instanceof Error ? e.message : '请求失败，请刷新凭证列表核对。') }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function issue() {
    // A new click is an explicit new credential, never an automatic retry.
    setCredential(null)
    const result = await api('workspace/client-issue', { botId, sourceId, readScope, actions, ttlSeconds: 600, confirmed: true })
    setCredential(result.data)
  }
  async function revoke(clientId: string) {
    await api('workspace/client-revoke', { clientId, confirmed: true })
    if (credential?.clientId === clientId) setCredential(null)
    setNotice('凭证已撤销。')
  }
  return <details className="stdio-clients" onToggle={e => { if (e.currentTarget.open) void run(async () => {}) }}><summary>本机 stdio MCP 凭证</summary>
    <p className="shell-muted small">有效期 10 分钟。范围受 Bot 当前工具和资源限制；取消勾选后立即限制后续调用。</p>
    <fieldset disabled={busy}><legend>发放凭证</legend>
      <label>Bot <select value={botId} onChange={e => { setBot(e.target.value); setSources([]); setSource(''); setLoadingSources(true) }}><option value="" disabled>选择 Bot</option>{bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label>来源 <select value={sourceId} onChange={e => setSource(e.target.value)} disabled={loadingSources || sources.length === 0}><option value="" disabled>{loadingSources ? '正在读取…' : '选择来源'}</option>{sources.map(s => <option key={s} value={s}>{s === 'local' ? '本地工作区' : s}</option>)}</select></label>
      {!loadingSources && botId && sources.length === 0 && <p className="shell-muted small">请先在 Bot 页勾选工作区工具和资源。</p>}
      <label>读取范围 <select value={readScope} onChange={e => { setScope(e.target.value); if (e.target.value === 'busy') setActions(['read']) }}><option value="full">完整内容</option><option value="busy">仅忙闲</option></select></label>
      <div className="action-row">{Object.entries(actionLabels).map(([action, label]) => <label key={action}><input type="checkbox" checked={actions.includes(action)} disabled={readScope === 'busy' && action !== 'read'} onChange={() => setActions(current => current.includes(action) ? current.filter(a => a !== action) : [...current, action])} />{label}</label>)}</div>
      <button type="button" disabled={!botId || !sourceId || loadingSources || actions.length === 0} onClick={() => void run(issue)}>发放 10 分钟凭证</button>
    </fieldset>
    {credential && <section aria-label="新发放的凭证"><p>仅本次显示，{new Date(credential.expiresAt).toLocaleString('zh-CN')} 到期。只供本机桥使用，请勿粘贴进聊天。</p><label>stdio 凭证<input type="password" readOnly autoComplete="off" value={credential.token} /></label><div className="action-row"><button type="button" onClick={() => { void navigator.clipboard.writeText(credential.token).then(() => setNotice('凭证已复制。')).catch(() => setError('复制失败，请手动复制凭证。')) }}>复制凭证</button><button type="button" onClick={() => setCredential(null)}>隐藏凭证</button></div></section>}
    <h3>已发放凭证</h3><button type="button" disabled={busy} onClick={() => void run(async () => {})}>刷新凭证列表</button>
    {clients === null ? <p className="shell-muted small">正在读取凭证列表…</p> : clients.length === 0 ? <p className="shell-muted small">尚未发放凭证。</p> : <ul className="stdio-client-list">{clients.map(c => <li key={c.clientId}><strong>{bots.find(b => b.id === c.botId)?.name ?? c.botId}</strong> · {c.revoked ? '已撤销' : c.expired ? '已过期' : '有效'}<p className="small">{c.scope.sources.join('、')} · {c.scope.actions.map(a => actionLabels[a] ?? a).join('、')} · {c.scope.readScope === 'full' ? '完整内容' : '仅忙闲'} · 到期 {new Date(c.expiresAt).toLocaleString('zh-CN')}</p><code>{c.clientId}</code>{!c.revoked && <div><button type="button" disabled={busy} onClick={() => void run(() => revoke(c.clientId))}>撤销凭证</button></div>}</li>)}</ul>}
    {error && <p role="alert" className="shell-note">{error}</p>}{notice && <p role="status">{notice}</p>}
  </details>
}
