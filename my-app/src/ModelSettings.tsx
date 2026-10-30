import { useEffect, useId, useRef, useState } from 'react'
import EditorDialog from './EditorDialog'
import { MODEL_SETTINGS_NOTICE, modelSettingsAttempt, modelSettingsSummary, publicModelSettings, type PublicModelSettings } from './model-settings-ui.mjs'
import './model-settings.css'

export default function ModelSettings({ token }: { token: string }) {
  const [settings, setSettings] = useState<PublicModelSettings | null>(null)
  const [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState(''), [apiKey, setApiKey] = useState('')
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
    setBaseUrl(settings.baseUrl); setModel(settings.model); setApiKey(''); setError(''); setNotice('')
    setUncertain(false); attempt.current = null; setOpen(true)
  }

  async function save(event?: React.FormEvent) {
    event?.preventDefault()
    if (saving.current || !settings || settings.source === 'env') return
    saving.current = true; setBusy(true); setError(''); setNotice('')
    const generation = active.current
    try {
      // Retry the same draft with the original id; credentials exist only in this editor's memory.
      const payload = modelSettingsAttempt({ baseUrl, model, apiKey }, attempt.current, () => crypto.randomUUID())
      attempt.current = payload
      const response = await fetch('/api/settings/model', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (active.current !== generation) return
      if (!response.ok) {
        // Never render arbitrary backend text: providers may echo request credentials.
        const unknown = response.status >= 500
        setUncertain(unknown)
        setError(unknown ? '保存结果未确认，草稿已保留。可重试原请求确认结果；关闭不会撤销已发出的保存。' : response.status === 409 ? '设置未保存：配置可能由环境变量提供或处于测试模式。草稿已保留，可关闭后重新读取。' : '模型设置未保存，草稿已保留。请检查地址、模型名和凭证后重试。')
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
        setError('保存结果未确认，草稿已保留。可重试原请求确认结果；关闭不会撤销已发出的保存。')
      }
    } finally {
      if (active.current === generation) { saving.current = false; setBusy(false) }
    }
  }

  if (!settings) return <div className="model-settings">{error ? <p role="alert">{error} <button type="button" onClick={reloadSettings}>重新读取</button></p> : <p role="status">正在读取模型设置…</p>}</div>
  const summary = modelSettingsSummary(settings), locked = summary.readOnly
  return <section className="model-settings" aria-label="模型连接">
    <div className="model-settings-card">
      <div className="model-settings-heading"><h3>{summary.model}</h3><span className="model-settings-status">{summary.status}</span></div>
      <dl className="model-settings-summary">
        <div><dt>地址摘要</dt><dd>{summary.address}</dd></div>
        <div><dt>API key</dt><dd>{summary.key}</dd></div>
        <div><dt>配置来源</dt><dd>{locked ? '环境变量 · 只读' : settings.source === 'file' ? '本机保存' : '尚未配置'}</dd></div>
      </dl>
      <button type="button" ref={editButton} onClick={edit}>{locked ? '查看配置' : '编辑连接'}</button>
    </div>
    <p className="shell-muted small">{MODEL_SETTINGS_NOTICE}</p>
    {notice && <p role="status">{notice}</p>}
    <EditorDialog open={open} title={locked ? '查看模型连接' : '编辑模型连接'} onClose={close} pending={busy} disabled={locked || uncertain} error={error}
      initialFocus={locked ? undefined : 'input[name="model-base-url"]'} returnFocus={editButton}
      description={locked ? '当前由环境变量提供，整块只读；请在服务端修改环境配置。' : '编辑当前唯一模型连接；仅保存后生效，取消不写入。'}
      footer={<><button type="button" className="editor-control-button" onClick={close}>{locked ? '关闭' : uncertain ? '关闭并重新读取' : '取消'}</button>{!locked && (uncertain ? <button type="button" className="editor-control-button is-primary" onClick={() => void save()}>重试原请求</button> : <button type="submit" className="editor-control-button is-primary" form={formId}>{busy ? '正在保存…' : '保存连接'}</button>)}</>}>
      <form id={formId} className="model-settings-form" onSubmit={event => void save(event)}>
        <label className="model-settings-row"><span>Base URL</span><input name="model-base-url" type="url" value={baseUrl} required maxLength={2048} autoComplete="off" spellCheck={false} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label className="model-settings-row"><span>模型名</span><input value={model} required maxLength={200} autoComplete="off" spellCheck={false} onChange={event => setModel(event.target.value)} /></label>
        <label className="model-settings-row"><span>API key <small className="shell-muted">{summary.key}</small></span><input type="password" value={apiKey} required={!settings.hasKey} autoComplete="new-password" spellCheck={false} onChange={event => setApiKey(event.target.value)} placeholder={settings.hasKey ? '留空保留已保存的凭证' : '输入 API key'} aria-describedby={`${formId}-key-help`} /></label>
        <p id={`${formId}-key-help`} className="shell-muted small">已保存的 key 永不回显；仅保存在服务端独立凭证文件。输入仅用于本次保存，成功或取消后清空。</p>
      </form>
    </EditorDialog>
  </section>
}
