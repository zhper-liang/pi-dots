import { useEffect, useRef, useState } from 'react'
import CapabilityList, { type CapabilityItem } from './CapabilityList'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'

type Group = {
  id: string; label: string; description: string; mode: 'allow' | 'ask'
  enabled: boolean; partiallyEnabled: boolean; available: boolean
  tools: { name: string; write: boolean; status: string }[]
}
type Configuration = { toolGroups: Group[] }
type Capabilities = { botId: string; revision: string; items: CapabilityItem[] }
type Mutation = { itemId: string; path: string; input: Record<string, string | boolean> }

async function request<T>(path: string, token: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: input === undefined ? 'GET' : 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? '工具操作失败。'), {
    definitive: response.status >= 400 && response.status < 500 && response.status !== 408,
    conflict: response.status === 409,
  })
  if (!body) throw new Error('服务未返回有效结果，请重试核对。')
  return body.data ?? body
}

// Remount on identity changes, so late reads/writes cannot update a different Bot or token scope.
type Props = { token: string; botId: string; readOnly?: boolean; active?: boolean; refreshKey?: number }
export default function BotRules(props: Props) {
  return <BotTools key={`${props.botId}:${props.token}`} {...props} />
}

function BotTools({ token, botId, readOnly = false, active = true, refreshKey }: Props) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState<string | null>(null)
  const retry = useRef<Mutation | null>(null)
  const saving = useRef(false)
  const live = useRef(true), readVersion = useRef(0)
  const base = `/api/bots/${encodeURIComponent(botId)}`

  async function load(signal?: AbortSignal, isCurrent = () => true, reconcile = false) {
    const version = ++readVersion.current
    const [config, catalog] = await Promise.allSettled([
      request<Configuration>(`${base}/configuration`, token, undefined, signal),
      request<Capabilities>(`${base}/capabilities`, token, undefined, signal),
    ])
    if (!live.current || signal?.aborted || version !== readVersion.current || !isCurrent() || saving.current && !reconcile) return false
    if (config.status === 'fulfilled') setConfiguration(config.value)
    else setError(config.reason instanceof Error ? config.reason.message : '无法读取工具配置。')
    if (catalog.status === 'fulfilled' && catalog.value.botId === botId && Array.isArray(catalog.value.items) && typeof catalog.value.revision === 'string') {
      setCapabilities(catalog.value)
      setCatalogError('')
    } else {
      setCapabilities(null)
      setCatalogError('无法核对能力目录，启停暂不可用；不会用写入确认代替停用。')
    }
    return config.status === 'fulfilled' && catalog.status === 'fulfilled' && catalog.value.botId === botId && Array.isArray(catalog.value.items) && typeof catalog.value.revision === 'string'
  }

  useWorkspaceRefresh({
    scopeKey: JSON.stringify([token, botId]), active: active && busy === null && uncertain === null, refreshKey,
    load: ({ signal, isCurrent }) => load(signal, isCurrent).then(() => {}),
    onError: () => {
      if (!live.current) return
      setCapabilities(null)
      setCatalogError('工具目录暂时无法读取，将在可见时自动重试；启停暂不可用。')
    },
  })
  useEffect(() => {
    const lifetime = live, version = readVersion
    lifetime.current = true
    return () => { lifetime.current = false; version.current++ }
  }, [])

  async function save(mutation: Mutation) {
    if (readOnly || saving.current) return
    saving.current = true
    readVersion.current++
    retry.current = mutation
    setBusy(mutation.itemId)
    setError('')
    try {
      await request(mutation.path, token, mutation.input)
      if (!live.current) return
      if (!await load(undefined, () => true, true)) throw new Error('保存结果待核对，请重试回读。')
      if (!live.current) return
      retry.current = null
      setUncertain(null)
    } catch (failure) {
      if (!live.current) return
      const definitive = failure instanceof Error && 'definitive' in failure && failure.definitive
      if (definitive) {
        retry.current = null
        setUncertain(null)
        if ('conflict' in failure && failure.conflict) await load(undefined, () => true, true)
      } else setUncertain(mutation.itemId)
      if (live.current) setError(failure instanceof Error ? failure.message : '保存失败。')
    } finally {
      saving.current = false
      if (live.current) setBusy(null)
    }
  }

  function toggle(item: CapabilityItem) {
    if (!capabilities || retry.current || item.controlNote) return
    void save({ itemId: item.id, path: `${base}/capabilities`, input: {
      requestId: crypto.randomUUID(), expectedRevision: capabilities.revision,
      capabilityId: item.id, enabled: !item.enabledForBot, expectedCatalogRevision: item.revision,
    } })
  }

  function changeMode(item: CapabilityItem, mode: 'allow' | 'ask') {
    if (retry.current || !item.confirmable || item.mode === mode || !item.id.startsWith('tool:')) return
    void save({ itemId: item.id, path: `${base}/tool-groups/${encodeURIComponent(item.id.slice(5))}`,
      input: { requestId: crypto.randomUUID(), mode } })
  }

  const groups = configuration?.toolGroups ?? []
  const items: CapabilityItem[] = (capabilities?.items ?? groups.map(group => ({
    id: `tool:${group.id}`, kind: 'tool' as const, name: group.label, description: group.description,
    status: 'configured' as const, revision: '', enabledForBot: group.enabled,
    partiallyEnabled: group.partiallyEnabled, available: group.available,
  }))).map(item => {
    const group = groups.find(group => item.id === `tool:${group.id}`)
    const systemControl = item.id === 'tool:automation' || item.id === 'tool:bots'
    return { ...item, mode: group?.mode, confirmable: !!group?.tools.some(tool => tool.write && tool.status === 'available') && !systemControl,
      controlNote: systemControl ? '系统安全与 Chief 管理由公共权限链管理，不在这里启停。' : undefined }
  })

  return <section className="bot-edit-section" aria-label="工具">
    <h2>工具</h2>
    <p className="bot-edit-hint">启用或停用决定工具能否使用，读取工具也可停用；写入确认独立设置为每次先问或直接执行（包括删除）。启停不改变来源授权，也不修改已有确认规则。</p>
    {!configuration && !capabilities && !error && <p role="status" className="bot-edit-hint">正在读取…</p>}
    {(configuration || capabilities) && <CapabilityList items={items} readOnly={readOnly || !capabilities} pendingId={busy ?? uncertain} onToggle={toggle} onModeChange={changeMode} />}
    {catalogError && <p role="status" className="bot-edit-hint">{catalogError}</p>}
    {error && <p role="alert" className="bot-edit-error">{error}</p>}
    <div className="capability-retry">
      {uncertain && <><p className="bot-edit-hint">结果未确认，重试沿用原 requestId；核对前不可发起其他修改。</p><button type="button" disabled={readOnly || busy !== null} onClick={() => { if (retry.current) void save(retry.current) }}>重试原操作</button></>}
      {!uncertain && (error || catalogError) && <button type="button" disabled={busy !== null} onClick={() => { setError(''); void load() }}>重新读取</button>}
    </div>
  </section>
}
