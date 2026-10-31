import { useEffect, useRef, useState, type FormEvent } from 'react'
import CapabilityPicker from './CapabilityPicker'
import { BOT_TEMPLATES, DEFAULT_CAPABILITIES, visibleCapabilities, type BotTemplate, type CapabilityItem } from './bot-capabilities.mjs'

type CreatedBot = { id: string; name: string; description: string; configRef: { botId: string; version: string } }
const pendingKey = 'pidot.pending-bot-creation'
type Pending = { requestId: string; name: string; description: string; profile: string; capabilities?: string[] }
function savedPending(): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null')
    return value && ['requestId', 'name', 'description', 'profile'].every(key => typeof value[key] === 'string') ? value : null
  } catch { return null }
}
export type BotCreationProps = { token: string; onCreated: (bot: CreatedBot, mainTaskId: number | null) => void; onCancel?: () => void }

export default function BotCreation({ token, onCreated, onCancel }: BotCreationProps) {
  const [pending] = useState(savedPending)
  const [name, setName] = useState(pending?.name ?? '')
  const [description, setDescription] = useState(pending?.description ?? '')
  const profile = pending?.profile ?? 'general'
  const [items, setItems] = useState<CapabilityItem[] | null>(null)
  const [enabled, setEnabled] = useState<string[]>(pending?.capabilities ?? DEFAULT_CAPABILITIES)
  const [catalogError, setCatalogError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<Pending | null>(pending)
  const controller = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const loading = items === null && !catalogError

  useEffect(() => {
    const abort = new AbortController()
    setItems(null)
    setCatalogError(false)
    fetch('/api/capabilities', { signal: abort.signal, headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const body = await response.json()
        if (!response.ok) throw new Error('能力列表没读到。')
        return visibleCapabilities(body.data.items as CapabilityItem[], null)
      })
      .then(catalog => {
        if (abort.signal.aborted) return
        setItems(catalog)
        setEnabled(pending?.capabilities ?? DEFAULT_CAPABILITIES.filter(id => catalog.some(item => item.id === id)))
      })
      .catch(() => { if (!abort.signal.aborted) setCatalogError(true) })
    return () => abort.abort()
  }, [token, pending])
  useEffect(() => () => controller.current?.abort(), [])

  function applyTemplate(template: BotTemplate) {
    setName(template.name)
    setDescription(template.description)
    setEnabled(template.capabilities.filter(id => items?.some(item => item.id === id)))
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    if (submitting.current || loading) return
    const data = { name: name.trim(), description: description.trim(), profile, ...(items === null ? {} : { capabilities: enabled }) }
    const previous = request.current
    if (!previous || data.name !== previous.name || data.description !== previous.description || data.profile !== previous.profile || JSON.stringify(data.capabilities) !== JSON.stringify(previous.capabilities)) {
      request.current = { ...data, requestId: crypto.randomUUID() }
    }
    try { sessionStorage.setItem(pendingKey, JSON.stringify(request.current)) } catch { /* in-memory retry remains safe */ }
    submitting.current = true
    setBusy(true)
    setError('')
    const abort = new AbortController()
    controller.current = abort
    const { description: duties, ...rest } = request.current!
    try {
      const response = await fetch('/api/bots', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(duties ? request.current : rest), signal: abort.signal,
      })
      const body = await response.json()
      if (!response.ok) throw new Error(response.status >= 500 ? '没确认创建成功。再点一次「创建」会核对上次的结果。' : body.error?.message ?? '创建失败。')
      if (abort.signal.aborted) return
      try { sessionStorage.removeItem(pendingKey) } catch { /* optional */ }
      request.current = null
      setName('')
      setDescription('')
      onCreated(body.bot, body.mainTaskId)
    } catch (caught) {
      if (!abort.signal.aborted) setError(caught instanceof Error && caught.name !== 'TypeError' ? caught.message : '没确认创建成功。再点一次「创建」会核对上次的结果。')
    } finally {
      if (!abort.signal.aborted) { submitting.current = false; setBusy(false) }
    }
  }

  const enabledNames = items === null ? ['日程与待办', '历史与回读'] : items.filter(item => enabled.includes(item.id)).map(item => item.name)
  return <div className="bot-page">
    <header className="bot-page-head"><h1>新建机器人</h1><p className="shell-muted">起个名字就能建，建完直接对话。</p></header>
    <form onSubmit={event => void create(event)} className="bot-form">
      <div className="bot-template-options" role="group" aria-label="机器人模板">
        {BOT_TEMPLATES.map(template => <button type="button" key={template.name} className="bot-template-option" disabled={busy || loading} onClick={() => applyTemplate(template)}>{template.name}</button>)}
      </div>
      <label htmlFor="bot-name">名字</label>
      <input id="bot-name" required maxLength={60} value={name} onChange={event => setName(event.target.value)} disabled={busy} placeholder="例如：日程助理" />
      <label htmlFor="bot-description">负责什么</label>
      <textarea id="bot-description" rows={4} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} disabled={busy} placeholder="这个机器人帮你做什么？" />
      <details className="bot-advanced">
        <summary>{enabledNames.length ? `高级 · 已开：${enabledNames.join('、')}` : '高级 · 没开能力'}</summary>
        {catalogError ? <p className="bot-edit-hint">能力列表没读到，会按默认能力创建。</p> : items === null ? <p role="status" className="bot-edit-hint">正在读取…</p> : <CapabilityPicker items={items} enabled={enabled} disabled={busy} onToggle={(id, next) => setEnabled(current => next ? [...current, id] : current.filter(item => item !== id))} />}
      </details>
      {error && <p role="alert" className="shell-alert-card">{error}</p>}
      <div className="bot-actions">
        {onCancel && <button type="button" onClick={onCancel} disabled={busy}>取消</button>}
        <button className="primary" disabled={busy || loading || !name.trim()}>{busy ? '正在创建…' : '创建'}</button>
      </div>
    </form>
  </div>
}
