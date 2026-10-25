import { useEffect, useRef, useState, type FormEvent } from 'react'
type Bot = { id: string; name: string; status?: string }
type Pending = { requestId: string; title: string; adminBotId: string; memberBotIds: string[] }
const key = 'pidot.pending-group-creation'
function saved(): Pending | null { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') } catch { return null } }
export default function GroupCreation({ bots, token, onCreated }: { bots: Bot[]; token: string; onCreated: (id: number) => void }) {
  const [pending] = useState(saved)
  const [title, setTitle] = useState(pending?.title ?? '')
  const [adminBotId, setAdmin] = useState(pending?.adminBotId ?? '')
  const [members, setMembers] = useState<string[]>(pending?.memberBotIds ?? [])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<Pending | null>(pending), submitting = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function create(event: FormEvent) {
    event.preventDefault(); if (submitting.current) return
    const data = { title: title.trim(), adminBotId, memberBotIds: [...members].sort() }
    if (!request.current || JSON.stringify(data) !== JSON.stringify({ title: request.current.title, adminBotId: request.current.adminBotId, memberBotIds: request.current.memberBotIds })) request.current = { requestId: crypto.randomUUID(), ...data }
    try { sessionStorage.setItem(key, JSON.stringify(request.current)) } catch { /* in-memory retry */ }
    submitting.current = true; setBusy(true); setError('')
    try {
      const response = await fetch('/api/groups', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request.current) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error?.message ?? '创建失败')
      try { sessionStorage.removeItem(key) } catch { /* storage unavailable */ }
      request.current = null; if (alive.current) { setTitle(''); onCreated(result.task.taskId) }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '结果未确认，请使用同一参数重试。') }
    finally { submitting.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="group-creation" aria-label="创建群聊"><h2>群聊 · 已有 Bot 协作入口</h2><p className="muted small">管理员负责普通消息；成员与管理员创建后固定。群内可选择单个 @ 目标，执行须已有协作与验收许可。</p>
    <form onSubmit={create}><fieldset disabled={busy}><label htmlFor="group-title">群名称</label><input id="group-title" required maxLength={100} value={title} onChange={e => setTitle(e.target.value)} />
      <fieldset><legend>选择至少两个活跃成员</legend>{bots.filter(b => b.status !== 'inactive').map(b => <label className="group-member" key={b.id}><input type="checkbox" checked={members.includes(b.id)} onChange={e => setMembers(current => e.target.checked ? [...current, b.id] : current.filter(id => id !== b.id))} />{b.name}</label>)}</fieldset>
      <label htmlFor="group-admin">群管理员（可以不是 Chief）</label><select id="group-admin" required value={adminBotId} onChange={e => setAdmin(e.target.value)}><option value="">请选择管理员</option>{bots.filter(b => members.includes(b.id) && b.status !== 'inactive').map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      {error && <p role="alert">{error}</p>}<button className="primary" disabled={busy || members.length < 2 || !members.includes(adminBotId)}>{busy ? '正在创建群聊…' : '创建群聊'}</button></fieldset></form></section>
}
