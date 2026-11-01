import { useRef, useState } from 'react'
import FeishuConnection, { type FeishuStatus } from './FeishuConnection'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'
import { scheduleSourceRows, sourceAssignment, type SourceConfiguration, type SourceRow } from './schedule-sources.mjs'

export type SourceContext = { token: string; botId: string; active: boolean; readOnly: boolean; onChanged?: () => void }

export default function ScheduleSources({ token, botId, active, readOnly, onChanged, enabled }: SourceContext & { enabled: boolean }) {
  const [view, setView] = useState<SourceConfiguration | null>(null)
  const [status, setStatus] = useState<FeishuStatus | null>(null)
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [manage, setManage] = useState(false)
  const saving = useRef(false)
  const path = `/api/bots/${encodeURIComponent(botId)}/configuration`
  async function api<T>(url: string, input?: object, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, { signal, method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error?.message ?? '来源状态读取失败。')
    return body
  }
  const { refresh } = useWorkspaceRefresh({
    scopeKey: JSON.stringify([token, botId]), active: active && !busy,
    load: async ({ signal, isCurrent }) => {
      const [configuration, connection] = await Promise.allSettled([api<SourceConfiguration>(path, undefined, signal), api<{ data: FeishuStatus }>('/api/feishu/status', undefined, signal)])
      if (!isCurrent() || saving.current) return
      if (configuration.status === 'fulfilled') setView(configuration.value)
      if (connection.status === 'fulfilled') setStatus(connection.value.data)
      setReadError(configuration.status === 'rejected' ? '来源范围暂未同步，将自动重试。' : connection.status === 'rejected' ? '飞书连接状态暂不可达，本地来源仍可使用，将自动重试。' : '')
    },
    onInvalidate: reason => { if (reason === 'scope') { setView(null); setStatus(null); setManage(false); setNotice(''); setError(''); setReadError('') } },
    onError: () => setReadError('来源状态暂未同步，将自动重试。'),
  })
  async function toggle(row: SourceRow) {
    if (!view || !enabled || readOnly || !active || saving.current) return
    saving.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await api(path, sourceAssignment(view, row, !row.enabled, crypto.randomUUID()))
      setNotice('来源范围已保存，当前会话下一步使用新范围。'); onChanged?.()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '保存结果未确认，正在自动核对。') }
    finally { saving.current = false; setBusy(false); void refresh(true) }
  }
  const rows = view ? scheduleSourceRows(view) : []
  const connectionNote = status?.binding ? status.binding.summary : status ? status.configured ? '尚未绑定日历' : '凭据未配置' : '连接状态待确认'
  const connectionControl = <button type="button" className="text-button" disabled={readOnly || !active || busy} onClick={() => setManage(value => !value)} aria-expanded={manage}>{manage ? '收起连接' : status?.binding ? '管理连接' : '连接飞书日历'}</button>
  return <section className="schedule-sources" aria-label="日程与待办来源">
    <h3>使用范围</h3>
    <p className="bot-edit-hint">{enabled ? '勾选这个机器人可使用的来源。新连接的来源默认加入。' : '已选范围会保留，开启「日程与待办」后生效。'}</p>
    {!view && !error && !readError && <p role="status" className="bot-edit-hint">正在读取来源…</p>}
    <ul className="pd-rows">{rows.map(row => <li className="pd-row capability-source-row" key={row.id}>
      <label className="capability-source-choice">
        <input type="checkbox" aria-label={`使用${row.title}`} checked={row.enabled} disabled={!enabled || !active || readOnly || busy} onChange={() => void toggle(row)} />
        <span className="pd-row-text"><span className="pd-row-title">{row.title}</span>{(row.id === 'feishu' || row.note) && <span className="pd-row-desc">{row.id === 'feishu' ? connectionNote : row.note}</span>}</span>
      </label>
      {row.id === 'feishu' && connectionControl}
    </li>)}{!rows.some(row => row.id === 'feishu') && <li className="pd-row capability-source-row">
      <div className="pd-row-text"><span className="pd-row-title">飞书日历</span><span className="pd-row-desc">{connectionNote}</span></div>{connectionControl}
    </li>}</ul>
    {manage && <FeishuConnection token={token} status={status} active={active} readOnly={readOnly} onChanged={() => { onChanged?.(); void refresh(true) }} />}
    {notice && <p role="status" className="bot-edit-hint">{notice}</p>}
    {readError && <p role="alert" className="bot-edit-error">{readError}</p>}
    {error && <p role="alert" className="bot-edit-error">{error}</p>}
    {(readError || error) && <button type="button" className="text-button" disabled={!active || busy} onClick={() => void refresh(true)}>重新读取</button>}
  </section>
}
