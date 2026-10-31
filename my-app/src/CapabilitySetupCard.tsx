import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SystemCard from './SystemCard'
import Switch from './Switch'
import McpCredentialForm from './McpCredentialForm'
import { createExternalMcpClient, type ExternalMcpClient, type McpConnection } from './external-mcp-client.mjs'
import { CAPABILITY_SETUP_STATES, CAPABILITY_SETUP_ACTIONS, sameCapabilitySetup, createCapabilitySetupClient, type CapabilitySetupReceipt, type CapabilitySetupClient } from './capability-setup.mjs'
import './capability-setup.css'

export type { CapabilitySetupReceipt, CapabilitySetupClient } from './capability-setup.mjs'

type Props = { token: string; receipt: CapabilitySetupReceipt; targetName?: string; botNames?: Record<string, string>; readOnly?: boolean; refreshKey?: number
  client?: CapabilitySetupClient; mcpClient?: ExternalMcpClient; onChanged?: () => void; onOpenBot?: (botId: string) => void; onOpenApproval?: (approvalId: string) => void }
export default function CapabilitySetupCard(props: Props) {
  return <SetupCard key={`${props.token}:${props.receipt.taskId}:${props.receipt.setupId}`} {...props} />
}
function SetupCard({ token, receipt, targetName, botNames = {}, readOnly = false, refreshKey, client: provided, mcpClient: providedMcp, onChanged, onOpenBot, onOpenApproval }: Props) {
  const client = useMemo(() => provided ?? createCapabilitySetupClient({ token }), [provided, token])
  const mcp = useMemo(() => providedMcp ?? createExternalMcpClient({ token }), [providedMcp, token])
  const [current, setCurrent] = useState(receipt), [verified, setVerified] = useState(false)
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [credential, setCredential] = useState<McpConnection | null>(null), [credentialOpen, setCredentialOpen] = useState(false), [credentialPending, setCredentialPending] = useState(false)
  const inFlight = useRef(false), live = useRef(true), active = useRef<AbortController | null>(null), latest = useRef(receipt), readFlight = useRef<Promise<CapabilitySetupReceipt | null> | null>(null), readVersion = useRef(0), queuedRead = useRef(false)
  const unknown = uncertain || current.state === 'unknown'
  const incoming = JSON.stringify(receipt)
  const apply = useCallback((next: CapabilitySetupReceipt) => {
    if (!sameCapabilitySetup(next, latest.current)) throw new Error('配置结果没有对应上，点「核查原配置」。')
    latest.current = next; setCurrent(next); setVerified(true); setUncertain(false)
    return next
  }, [])
  const readLatest = useCallback(async (signal: AbortSignal) => {
    let result: CapabilitySetupReceipt | null = null
    do {
      queuedRead.current = false
      const version = readVersion.current
      try {
        const next = await client.get(latest.current, signal)
        if (live.current && !signal.aborted && version === readVersion.current) result = apply(next)
      } catch (failure) {
        if (version === readVersion.current || !queuedRead.current) throw failure
      }
    } while (queuedRead.current && live.current && !signal.aborted)
    return result
  }, [client, apply])
  const query = useCallback((fresh = false) => {
    if (fresh) { readVersion.current++; queuedRead.current = true }
    if (inFlight.current) return readFlight.current ?? Promise.resolve(null)
    const controller = new AbortController()
    inFlight.current = true; active.current = controller; setBusy(true); setError('')
    const pending = (async () => {
      try { return await readLatest(controller.signal) }
      catch { if (live.current && !controller.signal.aborted) { setVerified(false); setError('现在核对不了，稍后再点「核查原配置」。') } }
      finally { inFlight.current = false; readFlight.current = null; if (live.current && !controller.signal.aborted) { active.current = null; setBusy(false) } }
      return null
    })()
    readFlight.current = pending
    return pending
  }, [readLatest])
  useEffect(() => {
    const lifetime = live, holder = active
    lifetime.current = true
    return () => { lifetime.current = false; holder.current?.abort() }
  }, [])
  useEffect(() => { void query(true) }, [query, incoming, refreshKey])
  async function resume(original = latest.current) {
    if (readOnly || inFlight.current || original.state === 'unknown' || !original.canResume || ['ready', 'disabled', 'unbound', 'removed'].includes(original.state)) return
    const controller = new AbortController()
    inFlight.current = true; active.current = controller; setBusy(true); setError(''); setNotice('')
    try {
      const next = await client.resume(original, controller.signal)
      if (!live.current || controller.signal.aborted) return
      latest.current = next; setVerified(false)
      await readLatest(controller.signal)
      if (!live.current || controller.signal.aborted) return
      onChanged?.()
    } catch { if (live.current && !controller.signal.aborted) { setUncertain(true); setVerified(false); setError('没确认配置成功，点「核查原配置」。') } }
    finally { inFlight.current = false; if (live.current && !controller.signal.aborted) { active.current = null; setBusy(false); if (queuedRead.current) void query() } }
  }
  async function openCredentials() {
    if (readOnly || inFlight.current || busy || unknown || !verified || !current.credentialEntry) return
    if (credentialPending && credential) { setCredentialOpen(true); return }
    const controller = new AbortController()
    inFlight.current = true; active.current = controller; setBusy(true); setError('')
    try {
      const connection = (await mcp.connections(controller.signal)).find(item => item.connectionId === current.credentialEntry!.connectionId)
      if (!connection) throw new Error('missing connection')
      if (live.current && !controller.signal.aborted) { setCredential(connection); setCredentialOpen(true) }
    } catch { if (live.current && !controller.signal.aborted) setError('无法读取原连接的安全凭据字段，请核查连接后再试。') }
    finally { inFlight.current = false; if (live.current && !controller.signal.aborted) { active.current = null; setBusy(false); if (queuedRead.current) void query() } }
  }
  async function credentialSaved() {
    setCredentialOpen(false); setCredentialPending(false); setNotice('凭据已安全保存，正在核查原配置操作。'); onChanged?.()
    const next = await query(true)
    if (next?.canResume && next.state !== 'unknown') await resume(next)
    else if (live.current) setNotice(!next ? '凭据已安全保存，最新配置状态仍待核查。' : next.state === 'ready' && next.enabledForBot && next.verification.status === 'ready' ? '凭据已保存，原配置已通过回读校验。' : '凭据已保存，请回原会话继续。')
  }
  const ready = verified && current.state === 'ready' && current.enabledForBot && current.verification.status === 'ready'
  const state = !verified ? '尚未核查最新配置状态' : current.state === 'ready' && !ready ? '绑定或校验尚未确认，配置未完成' : CAPABILITY_SETUP_STATES[current.state]
  const canResume = verified && !unknown && current.canResume && !['ready', 'disabled', 'unbound', 'removed'].includes(current.state)
  const others = current.affectedBotIds.filter(botId => botId !== current.targetBotId)
  return <SystemCard id={`capability-setup-${current.setupId}`} card={{ kind: 'capability-setup', state: verified ? current.state : 'pending' }} title={`${current.kind === 'mcp' ? 'MCP' : 'Skill'} · ${current.name || current.capabilityId || '能力配置'}`}
    state={state} className="capability-setup-card" error={error || (verified ? current.error?.message : undefined)}
    meta={`${CAPABILITY_SETUP_ACTIONS[current.action]} · 目标机器人：${targetName ?? botNames[current.targetBotId] ?? current.targetBotId}`}
    actions={<><button type="button" disabled={busy} onClick={() => void query(true)}>核查原配置</button>
      {canResume && <button type="button" disabled={busy || readOnly || credentialPending} onClick={() => void resume()}>继续原配置</button>}
      {verified && !unknown && current.state === 'needs_auth' && current.credentialEntry && <button type="button" disabled={busy || readOnly} onClick={() => void openCredentials()}>安全输入凭据</button>}
      {verified && !unknown && current.state === 'needs_confirmation' && current.approvalId && onOpenApproval && <button type="button" disabled={busy || readOnly || credentialPending} onClick={() => onOpenApproval(current.approvalId!)}>查看对应确认</button>}
      {onOpenBot && <button type="button" onClick={() => onOpenBot(current.targetBotId)}>查看机器人能力</button>}
    </>}>
    {current.description && <p>{current.description}</p>}
    <div className="capability-setup-binding">{verified ? <><Switch label={`目标机器人的${current.name}启用状态`} checked={current.enabledForBot} disabled onChange={() => {}} onText="已启用" offText="未启用" /><span>可以在机器人的「能力」里改，也可以在对话里说。</span></> : <span>正在核查启用状态…</span>}</div>
    {verified && <p className="capability-setup-verification">校验：{current.verification.summary || '暂无校验说明'}{current.verification.checkedAt ? ` · ${new Date(current.verification.checkedAt).toLocaleString()}` : ' · 尚无校验时间'}</p>}
    {verified && !!current.missing.length && <ul className="capability-setup-missing" aria-label="缺少条件">{current.missing.map((item, index) => <li key={`${item.kind}:${item.id}:${index}`}>{item.message || `${item.kind}：${item.id}`}</li>)}</ul>}
    {!!others.length && <p className="capability-setup-impact">此全局操作还涉及其他机器人：{others.map(botId => botNames[botId] ?? botId).join('、')}。范围见对应确认卡。</p>}
    {unknown && <p role="status">没确认结果，点「核查原配置」。</p>}
    {notice && <p role="status">{notice}</p>}
    {credential && <section className="capability-setup-credential" hidden={!credentialOpen} aria-label="原连接的安全凭据输入"><button type="button" onClick={() => setCredentialOpen(false)}>收起凭据输入</button>
      <McpCredentialForm connectionId={credential.connectionId} expectedRevision={credential.revision} transport={credential.transport} secretEnvKeys={credential.secretEnvKeys} hasCredential={credential.hasCredential}
        disabled={busy || readOnly || unknown} onSave={(input, signal) => mcp.saveCredential(input, signal)} onVerify={(requestId, signal) => mcp.requestStatus(requestId, signal)} onSaved={() => { void credentialSaved() }} onPendingChange={setCredentialPending} />
    </section>}
    <details className="tech-info capability-setup-details"><summary>技术信息</summary><dl><dt>setup</dt><dd>{current.setupId}</dd><dt>request</dt><dd>{current.requestId}</dd><dt>operation</dt><dd>{current.operationId}</dd><dt>Task / 输入</dt><dd>{current.taskId} / {current.inputId}</dd>{current.capabilityId && <><dt>能力</dt><dd>{current.capabilityId}</dd></>}</dl></details>
  </SystemCard>
}
