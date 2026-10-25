import { useCallback, useEffect, useState } from 'react'
type Status = { enabled: boolean; revision: number; pastDays: number; futureDays: number; refreshSeconds: number; timezone: string; runState: string; attempts: number; lastSuccessAt?: string; retryAt?: string; error?: { code: string; message: string }; windows: { window: { start: string; end: string }; generation: number; stale: boolean; lastSuccessAt?: string }[]; notice: string }
export default function ExternalSync({ token, sourceId, epoch, readScope }: { token: string; sourceId: string; epoch: number; readScope: string }) {
  const [state, setState] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [config, setConfig] = useState({ pastDays: 7, futureDays: 31, refreshSeconds: 300, timezone: 'Asia/Shanghai' })
  const api = useCallback(async (action: string, body: object) => {
    const r = await fetch(`/api/workspace/external-sync-${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ sourceId, ...body }) })
    const j = await r.json(); if (!r.ok) throw Error(`${j.error?.code}: ${j.error?.message}`); return j.data as Status
  }, [token, sourceId])
  useEffect(() => {
    let active = true
    const load = async () => {
      if (readScope !== 'full') { if (active) setState(null); return }
      try { const s = await api('status', {}); if (active) { setState(s); setError('') } } catch (e) { if (active) { setState(null); setError(String(e)) } }
    }
    void load(); const timer = setInterval(() => void load(), 5000)
    return () => { active = false; clearInterval(timer) }
  }, [api, epoch, readScope])
  const run = async (action: string, body: object) => { setBusy(true); setError(''); try { setState(await api(action, body)) } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  return <section aria-label="外部同步缓存" style={{ minWidth: 0, overflowWrap: 'anywhere' }}><h3>外部变化同步（只读窗口重扫）</h3>
    <p>来源 {sourceId}。后台同步不调用模型，不发送通知；停机不执行。</p>
    {error && <p role="alert">{error}</p>}
    {readScope !== 'full' ? <p>忙闲权限不读取正文缓存，请使用实时忙闲查询。</p> : <>
      <p>配置 {state?.enabled ? '启用' : '禁用'} · 运行 {state?.runState ?? '未读取'} · attempts {state?.attempts ?? 0} · lastSuccess {state?.lastSuccessAt ?? '无'} · retryAt {state?.retryAt ?? '无'}</p>
      {state?.error && <p role="alert">{state.error.code}：{state.error.message}</p>}
      <ul>{state?.windows.map((w, i) => <li key={i}>coverage {w.window.start} — {w.window.end} · generation {w.generation} · {w.stale ? 'stale（离线只读/尚未完整刷新）' : 'fresh'} · lastSuccess {w.lastSuccessAt}</li>)}</ul>
      {(['pastDays', 'futureDays', 'refreshSeconds'] as const).map(k => <label key={k} style={{ display: 'block' }}>{k}<input aria-label={`同步${k}`} type="number" min={k === 'refreshSeconds' ? 60 : 1} max={k === 'refreshSeconds' ? 86400 : 31} value={config[k]} onChange={e => setConfig({ ...config, [k]: Number(e.target.value) })} style={{ maxWidth: '100%' }} /></label>)}
      <label style={{ display: 'block' }}>同步时区<input aria-label="同步时区" value={config.timezone} onChange={e => setConfig({ ...config, timezone: e.target.value })} style={{ maxWidth: '100%' }} /></label>
      <button disabled={busy || !state} onClick={() => { if (globalThis.confirm(`确认只读同步：过去${config.pastDays}天/未来${config.futureDays}天，每${config.refreshSeconds}秒，${config.timezone}？会替换当前配置。`)) void run('configure', { ...config, enabled: true, expectedRevision: state!.revision, confirmed: true }) }}>保存并启用同步</button>
      <button disabled={busy || !state?.enabled} onClick={() => { if (globalThis.confirm('禁用未来抓取？历史缓存和变化记录保留。')) void run('configure', { enabled: false, expectedRevision: state!.revision, confirmed: true }) }}>禁用同步</button>
      <button disabled={busy || !state?.enabled || state?.runState === 'running'} onClick={() => { if (globalThis.confirm('立即执行当前配置的只读窗口重扫？不发送外部写入或通知。')) void run('refresh', { confirmed: true }) }}>手动刷新同步缓存</button>
      <p>{state?.notice}</p>
    </>}
  </section>
}
