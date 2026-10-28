import { useEffect, useRef, useState } from 'react'
type Ref = { type: string; id: string; sourceId: string }
type Run = { id: string; scheduledFor: string; startedAt?: string; finishedAt?: string; state: string; attempts: number; reason?: string; retryAt?: string; deliveryId?: string; operationId?: string; error?: { code: string; message: string } }
type Reminder = { id: string; version: number; targetVersion: number; targetRef?: Ref; sourceId?: string; state: string; enabled?: boolean; redacted?: boolean; reason?: string; schedule?: { id: string; nextDueAt: string; status: string; revision: number }; runs?: Run[] }
type Notice = { taskId?: number; botId?: string; notice?: string; id: string; status: string; title?: string; recordedAt?: string; readAt?: string; deliveryId?: string; occurrenceId?: string; redacted?: boolean }
type Inbox = { reminders: Reminder[]; items: Notice[]; next?: number; notice: string }
export default function ReminderWorkspace({ token, onOpenTask }: { token: string; onOpenTask?: (taskId: number, botId: string) => void }) {
  const [sourceId, setSourceId] = useState('local'), [type, setType] = useState('Todo'), [targetId, setTargetId] = useState(''), [targetVersion, setTargetVersion] = useState(''), [remoteId, setRemoteId] = useState(''), [mode, setMode] = useState('relative'), [value, setValue] = useState('-300'), [confirmed, setConfirmed] = useState(false)
  const [data, setData] = useState<Inbox | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [receipt, setReceipt] = useState(''), [pending, setPending] = useState(false)
  const request = useRef<{ key: string; input: object } | null>(null), running = useRef(false)
  async function api<T>(path: string, input: object): Promise<T> {
    const r = await fetch(`/api/workspace/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).catch(() => { throw Error('连接中断，结果未确认。请保留原参数重查原请求，不要新建重复提醒。') })
    const b = await r.json(); if (!r.ok) throw Object.assign(Error(`${b.error?.code}: ${b.error?.message}`), { status: r.status }); return b.data
  }
  async function action(fn: () => Promise<void>) {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : '操作失败') } finally { running.current = false; setBusy(false) }
  }
  const reload = async () => { setData(await api<Inbox>('reminder-list', {})) }
  useEffect(() => {
    let active = true
    const poll = async () => {
      if (running.current) return
      try {
        const r = await fetch('/api/workspace/reminder-list', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })
        const b = await r.json()
        if (!active) return
        if (!r.ok) { setData(null); setReceipt(''); setError(b.error?.message ?? '提醒读取失败，请刷新。'); return }
        setData(b.data)
        if (b.data.reminders.some((r: Reminder) => r.redacted)) setReceipt('')
      } catch { if (active) { setData(null); setReceipt(''); setError('提醒读取失败，请刷新。') } }
    }
    void poll()
    const timer = window.setInterval(poll, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [token])
  async function execute(input: object) {
    const key = JSON.stringify(input)
    if (request.current && request.current.key !== key) throw Error('有结果未确认的请求；先保留原参数重查，或刷新收件箱核对。')
    request.current ??= { key, input: { ...input, requestId: crypto.randomUUID() } }; setPending(true)
    let result: { id: string; state: string }
    try { result = await api('reminder-manage', request.current.input) } catch (e) { if (e && typeof e === 'object' && 'status' in e && Number(e.status) < 500) { request.current = null; setPending(false) } throw e }
    request.current = null; setPending(false); setReceipt(`${result.id} / ${result.state}`); await reload()
  }
  return <section className="local-workspace" aria-label="提醒与例行任务结果">
    <h3>提醒与例行任务结果</h3>
    <p className="shell-muted">仅应用内记录；recorded / read 不代表微信、QQ、系统推送或用户实际收到。</p>
    <button disabled={busy} onClick={() => void action(reload)}>刷新提醒和通知</button>
    {error && <p role="alert">{error}</p>}
    {data === null ? <p role="status">正在读取提醒…</p> : <>
      {data.items.length === 0 && <p>暂无通知记录</p>}
      {data.items.map(n => <article key={n.id} className="inbox-card">
        <h4>{n.redacted ? '目标正文授权失效，内容隐藏' : n.title ?? '事项提醒'}</h4>
        <p><time dateTime={n.recordedAt}>{n.recordedAt ? new Date(n.recordedAt).toLocaleString('zh-CN') : '记录时间未提供'}</time> · {n.status === 'read' ? '已读 · read' : n.status === 'recorded' ? '已记录（未读）· recorded' : n.status === 'unread' ? '已记录（未读）· unread' : n.status}</p>
        <p>{n.redacted ? '当前权限不允许查看旧正文与原任务。' : n.taskId ? '例行任务执行结果，请到原任务核对；记录不代表执行成功。' : '关联事项到达提醒时间，请核对当前安排。'}</p>
        {!n.redacted && n.taskId && <a href={`#task=${n.taskId}`} onClick={e => { if (onOpenTask) { e.preventDefault(); onOpenTask(n.taskId!, n.botId ?? 'chief') } }}>打开原任务</a>}
        {n.status !== 'read' && <button disabled={busy} onClick={() => void action(async () => { await api('notification-read', { id: n.id }); await reload() })}>标记已读</button>}
        <details className="inbox-detail"><summary>诊断</summary><pre>{JSON.stringify({ id: n.id, deliveryId: n.deliveryId, occurrenceId: n.occurrenceId, taskId: n.taskId, status: n.status, recordedAt: n.recordedAt, readAt: n.readAt, notice: n.notice }, null, 2)}</pre></details>
      </article>)}
      {data.next !== undefined && <button disabled={busy} onClick={() => void action(async () => { const next = await api<Inbox>('reminder-list', { cursor: data.next }); setData({ ...next, items: [...data.items, ...next.items] }) })}>加载更多通知</button>}
    </>}
    <details className="shell-more"><summary>管理关联提醒与执行记录</summary>
      <p>提醒绑定精确目标和版本；普通提醒不调用模型。审批、阻塞与跳过的动作在“需要你处理”中，保留原 Task 身份。</p>
    <form onSubmit={e => { e.preventDefault(); void action(async () => { if (!confirmed) throw Error('请确认时间与授权范围'); await execute({ command: 'create', targetRef: { type, id: targetId, sourceId }, targetVersion: Number(targetVersion), channel: 'inbox', confirmed: true, ...(mode === 'at' ? { at: value } : { offset: Number(value) }) }) }) }}>
      <label>提醒来源ID<input value={sourceId} onChange={e => { setSourceId(e.target.value); setConfirmed(false) }} required /></label>
      <label>提醒目标类型<select value={type} onChange={e => { setType(e.target.value); setConfirmed(false) }}><option>Todo</option><option>Event</option></select></label>
      {sourceId !== 'local' && <label>外部 eventId（先精确读取）<input value={remoteId} onChange={e => setRemoteId(e.target.value)} /></label>}
      <label>目标ID<input value={targetId} onChange={e => { setTargetId(e.target.value); setConfirmed(false) }} required /></label>
      <label>目标当前版本<input type="number" min="1" value={targetVersion} onChange={e => { setTargetVersion(e.target.value); setConfirmed(false) }} required /></label>
      <button type="button" disabled={busy} onClick={() => void action(async () => {
        const result = await api<{ items: { id: string; version: number; title: string }[] }>(sourceId === 'local' ? 'get' : 'external-get', sourceId === 'local' ? { sourceId, type, id: targetId } : { sourceId, eventId: remoteId })
        const t = result.items[0]; if (!t) throw Error('目标未找到'); setTargetId(t.id); setTargetVersion(String(t.version)); setReceipt(`当前目标：${t.id} / v${t.version}`); setConfirmed(false)
      })}>读取目标与当前版本</button>
      <label>提醒方式<select value={mode} onChange={e => { setMode(e.target.value); setValue(e.target.value === 'at' ? '' : '-300'); setConfirmed(false) }}><option value="relative">相对目标开始/截止时间（秒，负数提前）</option><option value="at">一次性时刻（含时区）</option></select></label>
      <label>{mode === 'at' ? '提醒时刻（例如 2026-10-20T09:00:00+08:00）' : '相对秒数'}<input aria-label="提醒时间或偏移" type={mode === 'relative' ? 'number' : 'text'} value={value} onChange={e => { setValue(e.target.value); setConfirmed(false) }} required /></label>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认精确目标/版本、提醒时间和收件箱渠道；目标改期会重算，无截止待办不可创建。</label>
      <button disabled={busy || !confirmed}>保存关联提醒</button>
    </form>
    {pending && <p role="status">请求结果尚未确认；保留原参数再次提交会查询同一持久回执，不能当成已成功。</p>}
    {receipt && <p className="workspace-receipt">{receipt}</p>}
      {data && <>
      <h3>提醒与执行记录</h3>{data.reminders.length === 0 && <p>暂无提醒</p>}
      {data.reminders.map(r => <article key={r.id}><p>{r.redacted ? '授权失效，详情隐藏' : `${r.targetRef?.type} ${r.targetRef?.id} · v${r.version} / 目标v${r.targetVersion}`} · {r.state} {r.reason}</p>
        {!r.redacted && <><p>计划 {r.schedule?.id} · {r.schedule?.nextDueAt} · {r.schedule?.status}</p>
          {r.enabled && <button disabled={busy || pending} onClick={() => { if (window.confirm('停用此精确提醒？阻止未来执行，不撤销已生成通知。')) void action(() => execute({ command: 'disable', id: r.id, sourceId: r.sourceId, expectedVersion: r.version, confirmed: true })) }}>停用提醒</button>}
          {r.runs?.map(o => <p key={o.id}>执行 {o.id} · {o.scheduledFor} · {o.state} · 尝试{o.attempts} · {o.reason} {o.error?.code} {o.error?.message} · 开始{o.startedAt ?? '—'} / 结束{o.finishedAt ?? '—'} · 重试{o.retryAt ?? '—'} · Delivery {o.deliveryId ?? '—'} · Operation {o.operationId ?? '—'}</p>)}
        </>}</article>)}
      </>}
    </details>
  </section>
}
