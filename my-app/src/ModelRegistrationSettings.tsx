import { parseContextWindow, formatContextWindow } from '../shared/model-context.mjs'
import { useEffect, useId, useRef, useState } from 'react'
import { publicRegistrations, modelSettingsSummary, type ModelRegistration } from './model-settings-ui.mjs'
import EditorDialog from './EditorDialog'

type Draft = { id?: string; providerId: string; baseUrl: string; model: string; apiKey: string; contextWindow: string }
const blank = (): Draft => ({ providerId: '', baseUrl: '', model: '', apiKey: '', contextWindow: '' })

export default function ModelRegistrationSettings({ token }: { token: string }) {
  const [entries, setEntries] = useState<ModelRegistration[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [reload, setReload] = useState(0)
  const saving = useRef(false), active = useRef(0), attempt = useRef<{ signature: string; payload: object } | null>(null)
  const addButton = useRef<HTMLButtonElement>(null), formId = useId()
  useEffect(() => {
    const abort = new AbortController(), generation = ++active.current
    fetch('/api/settings/models', { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error(); return publicRegistrations((await response.json()).data) })
      .then(data => { if (active.current === generation) setEntries(data) })
      .catch(() => { if (!abort.signal.aborted && active.current === generation) setError('模型列表读取失败，请重新读取。') })
    return () => { active.current = generation + 1; abort.abort() }
  }, [token, reload])
  function edit(entry?: ModelRegistration) {
    setDraft(entry ? { id: entry.id, providerId: entry.providerId, baseUrl: entry.baseUrl, model: entry.model, apiKey: '', contextWindow: formatContextWindow(entry.contextWindow) } : blank())
    attempt.current = null; setError(''); setNotice(''); setUncertain(false)
  }
  function close() {
    if (saving.current) return
    setDraft(null); attempt.current = null; setError(''); setUncertain(false); setReload(value => value + 1)
  }
  async function save(event?: React.FormEvent) {
    event?.preventDefault()
    if (!draft || saving.current) return
    let contextWindow
    try { contextWindow = parseContextWindow(draft.contextWindow) } catch { setError('上下文容量须为 8192–4000000 tokens，可填写 256K 或 1M。'); return }
    const data = { ...(draft.id ? { id: draft.id } : {}), contextWindow, providerId: draft.providerId.trim(), baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}) }
    const signature = JSON.stringify(data)
    if (attempt.current?.signature !== signature) attempt.current = { signature, payload: { ...data, requestId: crypto.randomUUID() } }
    const generation = active.current
    saving.current = true; setBusy(true); setError('')
    try {
      const response = await fetch('/api/settings/models', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(attempt.current.payload) })
      if (active.current !== generation) return
      if (!response.ok) {
        setUncertain(response.status >= 500)
        setError(response.status >= 500 ? '没确认保存成功，请重试核对。' : response.status === 409 ? '未保存：同名模型已登记、请求有冲突或当前为测试模式。请检查后重试。' : '未保存，请检查供应商 ID、URL、模型名和 Key。')
        return
      }
      publicRegistrations([(await response.json()).data])
      if (active.current !== generation) return
      setDraft(null); attempt.current = null; setUncertain(false); setNotice('已保存，可在创建机器人时选择。'); setReload(value => value + 1)
      window.dispatchEvent(new Event('pidot:model-settings-updated'))
    } catch { if (active.current === generation) { setUncertain(true); setError('没确认保存成功，请重试核对。') } }
    finally { saving.current = false; if (active.current === generation) setBusy(false) }
  }
  const current = entries?.find(entry => entry.id === draft?.id)
  const change = (key: keyof Draft, value: string) => setDraft(previous => previous && { ...previous, [key]: value })
  return <section className="model-settings" aria-label="已登记模型">
    <div className="model-settings-heading"><h3>已登记模型</h3><button className="editor-control-button" type="button" ref={addButton} onClick={() => edit()}>添加模型</button></div>
    <p className="shell-muted small">登记多个供应商或模型后，创建机器人时可以选择。API 需兼容 OpenAI。</p>
    {entries === null && !error && <p role="status">正在读取模型列表…</p>}
    {entries?.filter(entry => entry.id !== 'default').map(entry => <div key={entry.id} className="model-settings-card">
      <div className="model-settings-heading"><h3>{entry.model}</h3><span className="model-settings-status">已配置 · 未验证连接</span></div>
      <dl className="model-settings-summary"><div><dt>供应商 ID</dt><dd>{entry.providerId}</dd></div><div><dt>URL</dt><dd>{modelSettingsSummary(entry).address}</dd></div><div><dt>上下文</dt><dd>{formatContextWindow(entry.contextWindow)}</dd></div><div><dt>API key</dt><dd>{entry.hasKey ? '已配置' : '未配置'}</dd></div></dl>
      <button type="button" onClick={() => edit(entry)}>编辑模型</button>
    </div>)}
    {entries && entries.every(entry => entry.id === 'default') && <p className="shell-muted small">还没有额外登记的模型。</p>}
    {notice && <p role="status">{notice}</p>}
    {!draft && error && <p role="alert">{error} <button type="button" onClick={() => { setError(''); setReload(value => value + 1) }}>重新读取</button></p>}
    <EditorDialog open={!!draft} title={draft?.id ? '编辑模型' : '添加模型'} onClose={close} pending={busy} disabled={uncertain} error={error}
      returnFocus={addButton} initialFocus='input[name="provider-id"]' description="填写供应商 ID、接口地址、Key 和模型名。保存后可供机器人选择。"
      footer={<><button className="editor-control-button" type="button" onClick={close}>{uncertain ? '关闭并重新读取' : '取消'}</button><button className="editor-control-button is-primary" type={uncertain ? 'button' : 'submit'} form={formId} onClick={uncertain ? () => void save() : undefined}>{busy ? '正在保存…' : uncertain ? '重试' : '保存模型'}</button></>}>
      {draft && <form id={formId} className="model-settings-form" onSubmit={event => void save(event)}>
        <label className="model-settings-row"><span>供应商 ID</span><input name="provider-id" required pattern={'[A-Za-z0-9][A-Za-z0-9_.\\-]{0,79}'} maxLength={80} value={draft.providerId} onChange={event => change('providerId', event.target.value)} placeholder="例如：deepseek" autoComplete="off" /></label>
        <label className="model-settings-row"><span>URL</span><input type="url" required maxLength={2048} value={draft.baseUrl} onChange={event => change('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" autoComplete="off" /></label>
        <label className="model-settings-row"><span>API key</span><input type="password" required={!current?.hasKey} value={draft.apiKey} onChange={event => change('apiKey', event.target.value)} placeholder={current?.hasKey ? '留空保留此配置的 Key' : '输入 API key'} autoComplete="new-password" /></label>
        <label className="model-settings-row"><span>模型名</span><input required maxLength={200} value={draft.model} onChange={event => change('model', event.target.value)} placeholder="填写接口使用的模型名" autoComplete="off" /></label>
        <label className="model-settings-row"><span>上下文容量</span><input list={`${formId}-context-options`} value={draft.contextWindow} onChange={event => change('contextWindow', event.target.value)} placeholder="256K" autoComplete="off" aria-describedby={`${formId}-context-help`} /></label>
        <datalist id={`${formId}-context-options`}>{['32K', '64K', '128K', '256K', '512K', '1M', '2M'].map(size => <option key={size} value={size} />)}</datalist>
        <p id={`${formId}-context-help`} className="shell-muted small">留空默认 256K（256000 tokens）；支持 K / M 或完整数字。按模型实际容量填写，用于自动压缩。</p>
        <p className="shell-muted small">Key 仅保存在本机，保存后不再显示。修改模型名后，使用旧模型的机器人需重新选择。</p>
      </form>}
    </EditorDialog>
  </section>
}
