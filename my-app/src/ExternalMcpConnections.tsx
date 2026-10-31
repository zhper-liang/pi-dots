import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import EditorDialog from './EditorDialog'
import McpCredentialForm from './McpCredentialForm'
import { createExternalMcpClient, McpRequestError, MCP_ENV_KEYS, mcpConfigInput, mcpStatusLabel,
  type ExternalMcpClient, type McpConfigForm, type McpConnection, type McpMutation, type McpOperation, type McpReceipt } from './external-mcp-client.mjs'
import './mcp-connection.css'

type Props = { token: string; client?: ExternalMcpClient; onSummary?: (text: string) => void }
type Pending = { operation: McpOperation; input: McpMutation; connectionId: string; retryable?: boolean }
const blankForm = (): McpConfigForm => ({ name: '', description: '', transport: 'streamable-http', url: '', allowLoopback: false,
  credentialRequired: false, executable: '', args: '', envKeys: [], secretEnvKeys: '' })

export default function ExternalMcpConnections(props: Props) {
  return <ConnectionPanel key={props.token} {...props} />
}
function ConnectionPanel({ token, client: provided, onSummary }: Props) {
  const client = useMemo(() => provided ?? createExternalMcpClient({ token }), [provided, token])
  const id = useId()
  const [items, setItems] = useState<McpConnection[] | null>(null), [listError, setListError] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null), [credentialPending, setCredentialPending] = useState<string | null>(null)
  const [editor, setEditor] = useState(false), [editing, setEditing] = useState<McpConnection | null>(null), [connectionId, setConnectionId] = useState('')
  const [form, setForm] = useState(blankForm)
  const active = useRef<AbortController | null>(null), working = useRef(false), live = useRef(false), readVersion = useRef(0)
  const locked = busy || pending !== null || credentialPending !== null
  async function load(signal?: AbortSignal) {
    const version = ++readVersion.current
    try {
      const fresh = await client.connections(signal)
      if (live.current && !signal?.aborted && version === readVersion.current) { setItems(fresh); setListError(''); onSummary?.(fresh.length ? `${fresh.length} 个` : '未添加') }
    } catch { if (live.current && !signal?.aborted && version === readVersion.current) setListError('连接列表没读到，点「重新读取连接」再试。') }
  }
  useEffect(() => {
    live.current = true
    const controller = new AbortController(), holder = active
    void load(controller.signal)
    return () => { live.current = false; controller.abort(); holder.current?.abort() }
    // Token changes remount the panel; client injection is stable for each identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])
  function edit(item?: McpConnection) {
    if (locked) return
    setEditing(item ?? null); setConnectionId(item?.connectionId ?? `mcp-${crypto.randomUUID().slice(0, 18)}`)
    setForm({ ...blankForm(), ...(item ? { name: item.name, description: item.description, transport: item.transport,
      credentialRequired: item.credentialRequired, secretEnvKeys: (item.secretEnvKeys ?? []).join(', ') } : {}) })
    setError(''); setNotice(''); setEditor(true)
  }
  async function complete(result: McpReceipt, original: Pending, signal: AbortSignal) {
    if (result.connectionId !== original.connectionId || !result.revision) throw new McpRequestError('MCP_INVALID_RECEIPT', { unknown: true })
    setPending(null)
    if (original.operation === 'configure') setEditor(false)
    setNotice(`${original.operation === 'remove' ? '连接已移除' : original.operation === 'disable' ? '连接已停用' : original.operation === 'configure' ? '配置已保存' : '连接检查完成'}：${mcpStatusLabel(result.status)}。`)
    await load(signal)
  }
  async function mutate(operation: McpOperation, input: McpMutation, retryOriginal = false) {
    if (working.current || credentialPending || pending && !retryOriginal || retryOriginal && (!pending?.retryable || pending.input.requestId !== input.requestId)) return
    const controller = new AbortController(), original = { operation, input, connectionId: input.config?.connectionId ?? input.connectionId! }
    working.current = true; active.current = controller; setBusy(true); setError(''); setNotice('')
    try {
      const result = await client.mutate(operation, input, controller.signal)
      if (!controller.signal.aborted && live.current) await complete(result, original, controller.signal)
    } catch (failure) {
      if (!controller.signal.aborted && live.current) {
        if (!(failure instanceof McpRequestError) || failure.unknown) { setPending(original); setError('上次操作没确认结果，先点「核对上次操作」。') }
        else { setPending({ ...original, retryable: true }); setError(failure.message); await load(controller.signal) }
      }
    } finally { working.current = false; if (live.current && !controller.signal.aborted) { active.current = null; setBusy(false) } }
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (locked) return
    const parsed = mcpConfigInput(form, connectionId)
    if (parsed.error) { setError(parsed.error); return }
    void mutate('configure', { requestId: crypto.randomUUID(), ...(editing ? { expectedRevision: editing.revision } : {}), config: parsed.config })
  }
  function change(item: McpConnection, operation: Exclude<McpOperation, 'configure'>) {
    if (locked) return
    if (operation === 'remove' && !window.confirm(`移除「${item.name}」？用到它的机器人以后都调不了它。`)) return
    void mutate(operation, { requestId: crypto.randomUUID(), connectionId: item.connectionId, expectedRevision: item.revision,
      ...(operation === 'remove' ? { confirmGlobal: true as const } : {}) })
  }
  async function verify() {
    if (!pending || working.current) return
    const original = pending, controller = new AbortController()
    const ledgerOperation = original.operation === 'reconnect' ? 'check' : original.operation
    working.current = true; active.current = controller; setBusy(true); setError('')
    try {
      const status = await client.requestStatus(original.input.requestId, controller.signal)
      if (!live.current || controller.signal.aborted) return
      if (status?.state === 'succeeded' && status.operation === ledgerOperation && status.result) await complete(status.result, original, controller.signal)
      else if (status?.state === 'failed' && status.operation === ledgerOperation) { setPending({ ...original, retryable: true }); setError('上次操作失败了，可以「重试」或改配置后再保存。'); await load(controller.signal) }
      else setError('上次操作还没有结果，稍后再点「核对上次操作」。')
    } catch (failure) {
      if (live.current && !controller.signal.aborted) {
        if (failure instanceof McpRequestError && failure.status === 404) { setPending({ ...original, retryable: true }); setError('没找到上次操作的记录，可以「重试」。') }
        else setError('现在核对不了，稍后再试。')
      }
    }
    finally { working.current = false; if (live.current && !controller.signal.aborted) { active.current = null; setBusy(false) } }
  }
  const recovery = pending && <div className="external-mcp-pending" role="status"><details className="tech-info"><summary>技术信息</summary><p>原请求：<code>{pending.input.requestId}</code>。原操作与配置保持不变。</p></details>
    {pending.retryable ? <div className="external-mcp-actions"><button type="button" disabled={busy} onClick={() => void mutate(pending.operation, pending.input, true)}>重试</button><button type="button" disabled={busy} onClick={() => { setPending(null); setError('已取消重试，可以重新读取后再改。') }}>取消重试</button></div>
      : <button type="button" disabled={busy} onClick={() => void verify()}>核对上次操作</button>}
  </div>
  return <div className="external-mcp-connections">
    <p className="shell-muted small">连好以后，到机器人的「能力 → MCP」里打开。</p>
    <div className="external-mcp-actions"><button type="button" disabled={locked} onClick={() => edit()}>添加 MCP 连接</button><button type="button" disabled={busy} onClick={() => void load()}>重新读取连接</button></div>
    {items === null && !listError && <p role="status">正在读取 MCP 连接…</p>}
    {items?.length === 0 && <p className="shell-muted small">还没有 MCP 连接。</p>}
    {!!items?.length && <ul className="external-mcp-list" aria-label="外部 MCP 连接">
      {items.map(item => <li key={item.connectionId} className="external-mcp-row">
        <div><strong>{item.name}</strong><p className="shell-muted small">{item.description || '暂无说明'}</p>
          <p className="small">{item.transport === 'stdio' ? '已安装本机程序' : 'Streamable HTTP'} · <span role="status">{pending?.connectionId === item.connectionId ? pending.retryable ? '上次操作未完成' : '操作结果待核查' : mcpStatusLabel(item.status)}</span>{typeof item.toolCount === 'number' ? ` · ${item.toolCount} 个已发现工具` : ''}</p>
          {item.lastCheck?.checkedAt && <p className="shell-muted small">最近检查：{new Date(item.lastCheck.checkedAt).toLocaleString()}{item.lastCheck.error?.code ? `（${item.lastCheck.error.code}）` : ''}</p>}
        </div>
        <div className="external-mcp-actions">
          {item.credentialSource !== 'google' && <button type="button" disabled={locked} onClick={() => edit(item)}>修改配置</button>}
          <button type="button" disabled={locked || !item.enabled} onClick={() => change(item, 'check')}>检查连接</button>
          <button type="button" disabled={locked || !item.enabled} onClick={() => change(item, 'reconnect')}>重新连接</button>
          <button type="button" disabled={locked || !item.enabled} onClick={() => change(item, 'disable')}>停用</button>
          <button type="button" disabled={locked} onClick={() => change(item, 'remove')}>移除</button>
        </div>
        {item.credentialSource !== 'google' && (item.transport === 'streamable-http' || !!item.secretEnvKeys?.length) && <details className="external-mcp-credential"><summary>{item.hasCredential ? '替换连接凭据' : '安全输入凭据'}</summary>
          <McpCredentialForm connectionId={item.connectionId} expectedRevision={item.revision} transport={item.transport} secretEnvKeys={item.secretEnvKeys} hasCredential={item.hasCredential}
            disabled={busy || pending !== null || credentialPending !== null && credentialPending !== item.connectionId}
            onSave={(input, signal) => client.saveCredential(input, signal)} onVerify={(requestId, signal) => client.requestStatus(requestId, signal)}
            onSaved={() => { void load() }} onPendingChange={waiting => setCredentialPending(waiting ? item.connectionId : null)} />
        </details>}
      </li>)}
    </ul>}
    {listError && <p role="alert">{listError}</p>}{error && !editor && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!editor && recovery}
    <EditorDialog open={editor} title={editing ? '修改 MCP 连接' : '添加 MCP 连接'} pending={busy} disabled={pending !== null} error={error}
      footer={recovery}
      onClose={() => setEditor(false)} initialFocus={`#mcp-name-${id}`} description="连接本机已经装好的程序，或一个 HTTP 地址。">
      <form className="external-mcp-form" onSubmit={save}>
        {editing && <p className="shell-muted small">修改时请重新填写连接地址或启动信息。保存后须重新检查连接。</p>}
        <label htmlFor={`mcp-name-${id}`}>连接名称</label><input id={`mcp-name-${id}`} required maxLength={200} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} />
        <label htmlFor={`mcp-description-${id}`}>说明</label><textarea id={`mcp-description-${id}`} rows={2} maxLength={4000} value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} />
        <label htmlFor={`mcp-transport-${id}`}>连接方式</label><select id={`mcp-transport-${id}`} value={form.transport} onChange={event => setForm(current => ({ ...current, transport: event.target.value as McpConfigForm['transport'] }))}><option value="streamable-http">远程 Streamable HTTP</option><option value="stdio">已安装本机程序（stdio）</option></select>
        {form.transport === 'streamable-http' ? <><label htmlFor={`mcp-url-${id}`}>MCP 地址</label><input id={`mcp-url-${id}`} type="url" required maxLength={4096} placeholder="https://example.com/mcp" value={form.url} onChange={event => setForm(current => ({ ...current, url: event.target.value }))} />
          <label className="external-mcp-check"><input type="checkbox" checked={form.allowLoopback} onChange={event => setForm(current => ({ ...current, allowLoopback: event.target.checked }))} />允许本机 loopback 测试服务</label></> : <>
          <label htmlFor={`mcp-executable-${id}`}>已安装程序的绝对路径</label><input id={`mcp-executable-${id}`} required maxLength={2048} value={form.executable} placeholder="/absolute/path/to/mcp-server" onChange={event => setForm(current => ({ ...current, executable: event.target.value }))} />
          <label htmlFor={`mcp-args-${id}`}>启动参数（每行一个）</label><textarea id={`mcp-args-${id}`} rows={3} value={form.args} onChange={event => setForm(current => ({ ...current, args: event.target.value }))} /><p className="shell-muted small">只启动已装好的程序，密钥填在下面的凭据变量里。</p>
          <label htmlFor={`mcp-secret-keys-${id}`}>秘密环境变量名（逗号分隔）</label><input id={`mcp-secret-keys-${id}`} value={form.secretEnvKeys} placeholder="SERVICE_API_KEY" onChange={event => setForm(current => ({ ...current, secretEnvKeys: event.target.value }))} />
          <details><summary>可继承的非秘密环境变量</summary><div className="external-mcp-env">{MCP_ENV_KEYS.map(key => <label key={key}><input type="checkbox" checked={form.envKeys.includes(key)} onChange={event => setForm(current => ({ ...current, envKeys: event.target.checked ? [...current.envKeys, key] : current.envKeys.filter(value => value !== key) }))} />{key}</label>)}</div></details>
        </>}
        <label className="external-mcp-check"><input type="checkbox" checked={form.credentialRequired} onChange={event => setForm(current => ({ ...current, credentialRequired: event.target.checked }))} />此连接需要凭据（保存配置后安全输入）</label>
        <div className="external-mcp-actions"><button type="button" disabled={busy} onClick={() => setEditor(false)}>取消</button><button type="submit" className="primary" disabled={locked}>保存连接配置</button></div>
      </form>
    </EditorDialog>
  </div>
}
