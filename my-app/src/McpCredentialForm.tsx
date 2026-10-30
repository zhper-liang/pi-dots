import { useEffect, useId, useRef, useState } from 'react'
import { McpRequestError, type McpCredentialInput as CredentialInput, type McpReceipt, type McpRequestStatus } from './external-mcp-client.mjs'
import './mcp-connection.css'

export type McpCredentialInput = CredentialInput
export type McpCredentialReceipt = McpReceipt
type Props = { connectionId: string; expectedRevision: string; transport: 'streamable-http' | 'stdio';
  secretEnvKeys?: string[]; hasCredential: boolean; disabled?: boolean;
  onSave: (input: McpCredentialInput, signal: AbortSignal) => Promise<McpCredentialReceipt>;
  onVerify: (requestId: string, signal: AbortSignal) => Promise<McpRequestStatus | null>;
  onSaved?: (receipt: McpCredentialReceipt) => void; onPendingChange?: (pending: boolean) => void }
type Pending = { requestId: string; connectionId: string; expectedRevision: string }

// Only metadata survives an uncertain request. Password values stay in the form/request lifetime.
export default function McpCredentialForm(props: Props) {
  const scope = JSON.stringify([props.connectionId, props.transport, props.secretEnvKeys ?? []])
  return <CredentialFields key={scope} {...props} />
}
function CredentialFields({ connectionId, expectedRevision, transport, secretEnvKeys = [], hasCredential,
  disabled = false, onSave, onVerify, onSaved, onPendingChange }: Props) {
  const form = useRef<HTMLFormElement>(null), controller = useRef<AbortController | null>(null)
  const original = useRef<Pending | null>(null)
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState<Pending | null>(null), [retryable, setRetryable] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const helpId = useId()
  const validKeys = secretEnvKeys.length <= 16 && new Set(secretEnvKeys).size === secretEnvKeys.length && secretEnvKeys.every(key => /^[A-Z][A-Z0-9_]{0,63}$/.test(key))
  const unavailable = !validKeys || transport === 'stdio' && !secretEnvKeys.length
  useEffect(() => {
    const element = form.current, holder = controller
    return () => { holder.current?.abort(); element?.reset() }
  }, [])
  function complete(receipt: McpCredentialReceipt) {
    if (receipt.saved !== true || receipt.connectionId !== connectionId || !receipt.revision) throw new Error('invalid-receipt')
    original.current = null; setUncertain(null); setRetryable(false); onPendingChange?.(false)
    onSaved?.({ connectionId: receipt.connectionId, revision: receipt.revision, status: receipt.status, saved: true,
      ...(typeof receipt.replayed === 'boolean' ? { replayed: receipt.replayed } : {}) })
    setNotice('凭据已保存；请检查连接。此操作不会分配任何 Bot 工具。')
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || unavailable || controller.current || original.current && !retryable) return
    const active = new AbortController(), fields = new FormData(event.currentTarget)
    const credential = transport === 'streamable-http' ? { bearerToken: String(fields.get('bearer') ?? '') } :
      { env: Object.fromEntries(secretEnvKeys.map(key => [key, String(fields.get(key) ?? '')])) }
    event.currentTarget.reset()
    const metadata = original.current ?? { requestId: crypto.randomUUID(), connectionId, expectedRevision }
    original.current = metadata; controller.current = active; onPendingChange?.(true)
    setBusy(true); setRetryable(false); setError(''); setNotice('')
    try {
      const result = await onSave({ ...metadata, credential }, active.signal)
      if (!active.signal.aborted) complete(result)
    } catch (failure) {
      if (!active.signal.aborted) {
        if (failure instanceof McpRequestError && !failure.unknown) { original.current = null; setUncertain(null); setRetryable(false); onPendingChange?.(false); setError(failure.message) }
        else { setUncertain(metadata); setError('凭据保存结果未确认，输入已清空。请核查原请求，不会自动重新提交。') }
      }
    } finally { if (!active.signal.aborted) { controller.current = null; setBusy(false) } }
  }
  async function verify() {
    if (controller.current || !original.current || disabled) return
    const active = new AbortController(), metadata = original.current
    controller.current = active; setBusy(true); setError('')
    try {
      const status = await onVerify(metadata.requestId, active.signal)
      if (active.signal.aborted) return
      if (status?.requestId === metadata.requestId && status.state === 'succeeded' && status.operation === 'credential' && status.result?.saved === true) complete(status.result)
      else if (status?.state === 'failed' && status.operation === 'credential') { setRetryable(true); setError('原凭据请求已失败。请重新输入原凭据，用同一请求标识显式重试；旧输入不会保留。') }
      else setError('原请求尚未确认完成，请保留此请求并稍后核查。')
    } catch (failure) {
      if (!active.signal.aborted) {
        if (failure instanceof McpRequestError && failure.status === 404) { setRetryable(true); setError('尚未找到原请求。可重新输入原凭据，用同一请求标识显式重试。') }
        else setError('暂时无法核查原请求；输入保持清空，请稍后再核查。')
      }
    }
    finally { if (!active.signal.aborted) { controller.current = null; setBusy(false) } }
  }
  return <form ref={form} className="mcp-credential-form" onSubmit={event => void save(event)} autoComplete="off">
    <p id={helpId} className="shell-muted small">{hasCredential ? '已有凭据，永不回显。' : '尚未保存凭据。'}凭据仅保存到服务端独立文件；不要在聊天、连接地址或启动参数中填写秘密。</p>
    <fieldset disabled={disabled || busy || unavailable || uncertain !== null && !retryable}>
      {(transport === 'streamable-http' ? ['bearer'] : validKeys ? secretEnvKeys : []).map(key => <label className="mcp-credential-row" key={key}>
        <span>{key === 'bearer' ? 'Bearer 凭据' : key}</span><input name={key} type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} aria-describedby={helpId} />
      </label>)}
      <button className="primary" type="submit">{busy ? '正在安全保存…' : retryable ? '重新输入后重试原凭据请求' : '保存凭据'}</button>
    </fieldset>
    {unavailable && <p role="status">此配置未声明可输入的凭据字段，请先修改连接配置。</p>}
    {uncertain && <div role="status"><p>待核查请求：<code>{uncertain.requestId}</code></p><button type="button" disabled={disabled || busy} onClick={() => void verify()}>核查原凭据请求</button></div>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </form>
}
