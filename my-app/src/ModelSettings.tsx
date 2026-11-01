import { parseContextWindow, formatContextWindow } from '../shared/model-context.mjs'
import { useEffect, useId, useRef, useState } from 'react'
import ModelRegistrationSettings from './ModelRegistrationSettings'
import EditorDialog from './EditorDialog'
import { MODEL_SETTINGS_NOTICE, modelSettingsAttempt, modelSettingsSummary, publicModelSettings, type PublicModelSettings } from './model-settings-ui.mjs'
import './model-settings.css'

export default function ModelSettings({ token }: { token: string }) {
  const [settings, setSettings] = useState<PublicModelSettings | null>(null)
  const [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState(''), [apiKey, setApiKey] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0)
  const active = useRef(0), saving = useRef(false), attempt = useRef<ReturnType<typeof modelSettingsAttempt> | null>(null)
  const editButton = useRef<HTMLButtonElement>(null), formId = useId()

  useEffect(() => {
    const generation = ++active.current
    const controller = new AbortController()
    fetch('/api/settings/model', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('unavailable')
        return publicModelSettings((await response.json()).data)
      }).then(view => {
        if (active.current === generation) setSettings(view)
      }).catch(() => { if (active.current === generation && !controller.signal.aborted) setError('模型设置读取失败，请重试。') })
    return () => { active.current = generation + 1; controller.abort() }
  }, [token, reload])

  // SettingsPage already mounts with key={token}; retries reset only on user action.
  function reloadSettings() {
    setSettings(null); setError(''); setNotice(''); setReload(value => value + 1)
  }

  function close() {
    if (saving.current) return
    setOpen(false); setApiKey(''); setBaseUrl(''); setModel(''); setError(''); attempt.current = null
    // A closed unknown save is not a rollback. Re-read its public receipt, never resend it.
    if (uncertain || error) reloadSettings()
    setUncertain(false)
  }

  function edit() {
    if (!settings) return
    setContextWindow(formatContextWindow(settings.contextWindow)); setBaseUrl(settings.baseUrl); setModel(settings.model); setApiKey(''); setError(''); setNotice('')
    setUncertain(false); attempt.current = null; setOpen(true)
  }

  async function save(event?: React.FormEvent) {
    event?.preventDefault()
    if (saving.current || !settings || settings.source === 'env') return
    try { parseContextWindow(contextWindow) } catch { setError('上下文容量须为 8192–4000000 tokens，可填写 256K 或 1M。'); return }
    saving.current = true; setBusy(true); setError(''); setNotice('')
    const generation = active.current
    try {
      // Retry the same draft with the original id; credentials exist only in this editor's memory.
      const payload = modelSettingsAttempt({ baseUrl, model, apiKey, contextWindow: parseContextWindow(contextWindow) }, attempt.current, () => crypto.randomUUID())
      attempt.current = payload
      const response = await fetch('/api/settings/model', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (active.current !== generation) return
      if (!response.ok) {
        // Never render arbitrary backend text: providers may echo request credentials.
        const unknown = response.status >= 500
        setUncertain(unknown)
        setError(unknown ? '没确认保存成功，草稿还在，点「重试」核对。' : response.status === 409 ? '设置未保存：配置可能由环境变量提供或处于测试模式。草稿已保留，可关闭后重新读取。' : '模型设置未保存，草稿已保留。请检查地址、模型名和凭证后重试。')
        return
      }
      const view = publicModelSettings((await response.json()).data)
      if (active.current !== generation) return
      setSettings(view); setBaseUrl(''); setModel(''); setApiKey(''); attempt.current = null
      setOpen(false); setUncertain(false); setNotice(`已保存。${MODEL_SETTINGS_NOTICE}`)
      window.dispatchEvent(new Event('pidot:model-settings-updated'))
    } catch {
      if (active.current === generation) {
        setUncertain(true)
        setError('没确认保存成功，草稿还在，点「重试」核对。')
      }
    } finally {
      if (active.current === generation) { saving.current = false; setBusy(false) }
    }
  }

  if (!settings) return <div className="model-settings">{error ? <p role="alert">{error} <button type="button" onClick={reloadSettings}>重新读取</button></p> : <p role="status">正在读取模型设置…</p>}</div>
  const summary = modelSettingsSummary(settings), locked = summary.readOnly
  return <section className="model-settings" aria-label="模型连接">
    <ModelRegistrationSettings key={token} token={token} />
    <h3>默认连接</h3>
    <div className="model-settings-card">
      <div className="model-settings-heading"><h3>{summary.model}</h3><span className="model-settings-status">{summary.status}</span></div>
      <dl className="model-settings-summary">
        <div><dt>地址摘要</dt><dd>{summary.address}</dd></div>
        <div><dt>上下文</dt><dd>{formatContextWindow(settings.contextWindow)}</dd></div><div><dt>API key</dt><dd>{summary.key}</dd></div>
        <div><dt>保存位置</dt><dd>{locked ? '环境变量 · 只读' : settings.source === 'file' ? '本机保存' : '尚未配置'}</dd></div>
      </dl>
      <button type="button" ref={editButton} onClick={edit}>{locked ? '查看配置' : '编辑连接'}</button>
    </div>
    <p className="shell-muted small">{MODEL_SETTINGS_NOTICE}</p>
    {notice && <p role="status">{notice}</p>}
    <EditorDialog open={open} title={locked ? '查看模型连接' : '编辑模型连接'} onClose={close} pending={busy} disabled={locked || uncertain} error={error}
      initialFocus={locked ? undefined : 'input[name="model-base-url"]'} returnFocus={editButton}
      description={locked ? '当前由环境变量提供，整块只读；请在服务端修改环境配置。' : '编辑默认模型连接；仅保存后生效，取消不写入。'}
      footer={<><button type="button" className="editor-control-button" onClick={close}>{locked ? '关闭' : uncertain ? '关闭并重新读取' : '取消'}</button>{!locked && (uncertain ? <button type="button" className="editor-control-button is-primary" onClick={() => void save()}>重试</button> : <button type="submit" className="editor-control-button is-primary" form={formId}>{busy ? '正在保存…' : '保存连接'}</button>)}</>}>
      <form id={formId} className="model-settings-form" onSubmit={event => void save(event)}>
        <label className="model-settings-row"><span>Base URL</span><input name="model-base-url" type="url" value={baseUrl} required maxLength={2048} autoComplete="off" spellCheck={false} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label className="model-settings-row"><span>模型名</span><input value={model} required maxLength={200} autoComplete="off" spellCheck={false} onChange={event => setModel(event.target.value)} /></label>
        <label className="model-settings-row"><span>API key <small className="shell-muted">{summary.key}</small></span><input type="password" value={apiKey} required={!settings.hasKey} autoComplete="new-password" spellCheck={false} onChange={event => setApiKey(event.target.value)} placeholder={settings.hasKey ? '留空保留已保存的凭证' : '输入 API key'} aria-describedby={`${formId}-key-help`} /></label>
        <label className="model-settings-row"><span>上下文容量</span><input value={contextWindow} onChange={event => setContextWindow(event.target.value)} placeholder="256K" list={`${formId}-context-options`} /></label>
        <datalist id={`${formId}-context-options`}>{['32K', '64K', '128K', '256K', '512K', '1M', '2M'].map(size => <option key={size} value={size} />)}</datalist>
        <p className="shell-muted small">留空默认 256K（256000 tokens）；支持 K / M 或完整数字，用于自动压缩。</p>
        <p id={`${formId}-key-help`} className="shell-muted small">保存后不再显示 key，只存在本机。</p>
      </form>
    </EditorDialog>
  </section>
}
