import { useRef, useState } from 'react'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'

type Calendar = { calendarId: string; summary: string }
export type FeishuStatus = { configured: boolean; connectionId: string | null; authorizationVersion: number; binding: (Calendar & { resource: string }) | null }
type Bot = { id: string; name: string; resources: string[] }

/** Shared connection editor. It never queries event bodies or creates a calendar automatically. */
export default function FeishuConnection({ token, status, active = true, readOnly = false, onChanged }: { token: string; status: FeishuStatus | null; active?: boolean; readOnly?: boolean; onChanged: () => void }) {
  const [calendars, setCalendars] = useState<Calendar[]>([]), [selected, setSelected] = useState('')
  const [bots, setBots] = useState<Bot[] | null>(null), [error, setError] = useState(''), [readError, setReadError] = useState(''), [busy, setBusy] = useState(false)
  const running = useRef(false)
  async function api<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { signal, method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message ?? '连接操作失败。')
    return result
  }
  useWorkspaceRefresh({
    scopeKey: JSON.stringify([token, status?.connectionId, status?.authorizationVersion]), active: active && !busy,
    load: async ({ signal, isCurrent }) => {
      const result = await api<{ bots: { id: string; name: string }[] }>('/api/bots', undefined, signal)
      const current = await Promise.all(result.bots.map(async bot => { const view = await api<{ assigned: { resources: string[] } }>(`/api/bots/${encodeURIComponent(bot.id)}/configuration`, undefined, signal); return { ...bot, resources: view.assigned.resources } }))
      if (isCurrent()) { setBots(current); setReadError('') }
    },
    onInvalidate: reason => { if (reason === 'scope') { setBots(null); setCalendars([]); setSelected('') } },
    onError: () => { setBots(null); setReadError('受影响机器人状态暂未同步，将自动重试。') },
  })
  async function run(work: () => Promise<void>) {
    if (running.current || readOnly || !active) return
    running.current = true; setBusy(true); setError('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : '连接操作结果未确认，正在自动核对。') }
    finally { running.current = false; setBusy(false) }
  }
  const affected = (bots ?? []).filter(bot => bot.resources.some(id => id === status?.binding?.resource || id.startsWith('workspace:feishu:'))).map(bot => bot.name)
  return <section className="feishu-connection" aria-label="飞书连接管理">
    <p className="bot-edit-hint">连接由所有机器人共享。每个机器人使用哪些日历，在上面的使用范围里选择。</p>
    {!status && <p role="status">连接状态暂未同步，将自动重试。</p>}
    {status && !status.configured && <p role="status">请先在本机配置飞书应用凭据，配置后会自动同步。凭据保存在服务端。</p>}
    {status?.configured && <>
      <button type="button" disabled={busy || readOnly} onClick={() => void run(async () => { const result = await api<{ data: { items: Calendar[]; complete: boolean } }>('/api/feishu/calendars'); if (!result.data.complete) throw new Error('日历列表未读取完整，请稍后再试。'); setCalendars(result.data.items) })}>选择日历</button>
      {calendars.length > 0 && <div className="feishu-bind-form"><label htmlFor="capability-feishu-calendar">应用可见日历</label><select id="capability-feishu-calendar" value={selected} disabled={busy || readOnly} onChange={event => setSelected(event.target.value)}><option value="">请选择日历</option>{calendars.map(item => <option key={item.calendarId} value={item.calendarId}>{item.summary}</option>)}</select><button type="button" disabled={!selected || busy || readOnly} onClick={() => void run(async () => { await api('/api/feishu/manage', { action: 'bind', calendarId: selected, confirm: true }); setCalendars([]); setSelected(''); onChanged() })}>绑定所选日历</button></div>}
      {status.binding && <div><p>当前日历：{status.binding.summary}</p><p className="bot-edit-hint">断开后受影响的机器人：{bots === null ? '正在核对…' : affected.length ? affected.join('、') : '当前没有机器人使用此日历'}。</p><button type="button" disabled={busy || readOnly || bots === null} onClick={() => void run(async () => { if (!window.confirm(`断开飞书日历「${status.binding!.summary}」？${affected.length ? `将影响 ${affected.join('、')}。` : '使用此连接的机器人将不能再访问该日历。'}`)) return; await api('/api/feishu/manage', { action: 'disconnect', confirm: true }); onChanged() })}>断开共享连接</button></div>}
    </>}
    <p className="bot-edit-hint">查看和编辑日程请到「事项 → 日历」。</p>
    {busy && <p role="status">正在处理连接…</p>}{readError && <p role="alert" className="bot-edit-error">{readError}</p>}{error && <p role="alert" className="bot-edit-error">{error}</p>}
  </section>
}
