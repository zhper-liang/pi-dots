import { useEffect, useRef, useState } from 'react'
import CapabilityPicker from './CapabilityPicker'
import { visibleCapabilities, type CapabilityItem } from './bot-capabilities.mjs'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'

type BotCapability = CapabilityItem & { revision: string; enabledForBot: boolean; partiallyEnabled: boolean }
type Capabilities = { botId: string; revision: string; items: BotCapability[] }
type Mutation = { requestId: string; expectedRevision: string; capabilityId: string; enabled: boolean; expectedCatalogRevision: string }
type Props = { token: string; botId: string; readOnly: boolean; active: boolean }

async function request<T>(path: string, token: string, input?: Mutation, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: input === undefined ? 'GET' : 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.error?.message ?? '能力操作失败。'), {
    definitive: response.status >= 400 && response.status < 500,
    conflict: response.status === 409,
  })
  return body.data
}

export default function BotCapabilities(props: Props) {
  return <BotCapabilitiesPanel key={`${props.botId}:${props.token}`} {...props} />
}

function BotCapabilitiesPanel({ token, botId, readOnly, active }: Props) {
  const [view, setView] = useState<Capabilities | null>(null)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState<string | null>(null)
  const retry = useRef<Mutation | null>(null)
  const saving = useRef(false)
  const live = useRef(true)
  const readVersion = useRef(0)
  const path = `/api/bots/${encodeURIComponent(botId)}/capabilities`

  async function load(signal?: AbortSignal, isCurrent = () => true, reconcile = false) {
    const version = ++readVersion.current
    const data = await request<Capabilities>(path, token, undefined, signal)
    if (!live.current || signal?.aborted || version !== readVersion.current || !isCurrent() || saving.current && !reconcile) return false
    setView(data)
    setReadError('')
    return true
  }

  function failedRead() {
    if (live.current) setReadError('能力列表没读到，点「重新读取」。')
  }

  useWorkspaceRefresh({
    scopeKey: JSON.stringify([token, botId]), active: active && busy === null && uncertain === null,
    load: ({ signal, isCurrent }) => load(signal, isCurrent).then(() => {}),
    onError: failedRead,
  })
  useEffect(() => {
    const lifetime = live, version = readVersion
    lifetime.current = true
    return () => { lifetime.current = false; version.current++ }
  }, [])

  async function save(mutation: Mutation) {
    if (readOnly || !active || saving.current) return
    saving.current = true
    readVersion.current++
    retry.current = mutation
    setBusy(mutation.capabilityId)
    setError('')
    try {
      await request(path, token, mutation)
      if (!live.current) return
      if (!await load(undefined, () => true, true)) throw new Error('没确认保存成功，点「重试」。')
      if (!live.current) return
      retry.current = null
      setUncertain(null)
    } catch (caught) {
      if (!live.current) return
      const failure = caught as Error & { definitive?: boolean; conflict?: boolean }
      if (failure.definitive) {
        retry.current = null
        setUncertain(null)
        if (failure.conflict) {
          const fresh = await load(undefined, () => true, true).catch(() => { failedRead(); return false })
          if (live.current && fresh) setError('已在别处改过，已重新读取。')
        } else setError(failure.message)
      } else {
        setUncertain(mutation.capabilityId)
        setError('没确认保存成功，点「重试」。')
      }
    } finally {
      saving.current = false
      if (live.current) setBusy(null)
    }
  }

  function toggle(capabilityId: string, enabled: boolean) {
    if (!view || retry.current) return
    const item = view.items.find(item => item.id === capabilityId)!
    void save({ requestId: crypto.randomUUID(), expectedRevision: view.revision, capabilityId, enabled, expectedCatalogRevision: item.revision })
  }

  const items = visibleCapabilities(view?.items ?? [], botId)
  return <section className="bot-edit-section" aria-label="能力">
    <h2>能力</h2>
    {readOnly && <p className="bot-edit-hint">这个机器人已停用，只能查看。</p>}
    {!view && !readError && <p role="status" className="bot-edit-hint">正在读取…</p>}
    {view && <CapabilityPicker items={items} enabled={items.filter(item => item.enabledForBot).map(item => item.id)} partial={items.filter(item => item.partiallyEnabled).map(item => item.id)} disabled={readOnly || !active || !!readError} pendingId={busy ?? uncertain} onToggle={toggle} />}
    {readError && <p role="alert" className="bot-edit-error">{readError}</p>}
    {error && <p role="alert" className="bot-edit-error">{error}</p>}
    <div className="capability-retry">
      {uncertain && <button type="button" disabled={readOnly || !active || busy !== null} onClick={() => { if (retry.current) void save(retry.current) }}>重试</button>}
      {!uncertain && (error || readError) && <button type="button" disabled={!active || busy !== null} onClick={() => { setError(''); void load().catch(failedRead) }}>重新读取</button>}
    </div>
  </section>
}
