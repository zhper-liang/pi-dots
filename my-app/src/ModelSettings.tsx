import { useEffect, useRef, useState } from 'react'
import { MODEL_SETTINGS_NOTICE, modelSettingsPayload, publicModelSettings, type PublicModelSettings } from './model-settings-ui.mjs'
import './model-settings.css'

export default function ModelSettings({ token }: { token: string }) {
  const [settings, setSettings] = useState<PublicModelSettings | null>(null)
  const [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState(''), [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const active = useRef(0), saving = useRef(false)

  useEffect(() => {
    const generation = ++active.current
    const controller = new AbortController()
    fetch('/api/settings/model', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('unavailable')
        return publicModelSettings((await response.json()).data)
      }).then(view => {
        if (active.current !== generation) return
        setSettings(view); setBaseUrl(view.baseUrl); setModel(view.model)
      }).catch(() => { if (active.current === generation && !controller.signal.aborted) setError('模型设置读取失败，请重试。') })
    return () => { active.current = generation + 1; controller.abort() }
  }, [token])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (saving.current || !settings || settings.source === 'env') return
    saving.current = true; setBusy(true); setError(''); setNotice('')
    const generation = active.current
    const payload = modelSettingsPayload({ baseUrl, model, apiKey }, crypto.randomUUID())
    // Clear immediately, even on failed/unknown saves. Never put a returned key in state.
    setApiKey('')
    try {
      const response = await fetch('/api/settings/model', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!response.ok) {
        // Do not render arbitrary backend errors: providers may echo request credentials.
        if (active.current === generation) setError(response.status === 409 ? '设置未保存：配置可能由环境变量提供或处于测试模式，请重新加载确认。' : '模型设置未确认保存，请检查地址、模型名和凭证后重试。')
        return
      }
      const view = publicModelSettings((await response.json()).data)
      if (active.current !== generation) return
      setSettings(view); setBaseUrl(view.baseUrl); setModel(view.model); setNotice(`已保存。${MODEL_SETTINGS_NOTICE}`); window.dispatchEvent(new Event('pidot:model-settings-updated'))
    } catch {
      if (active.current === generation) setError('模型设置未确认保存，请重新加载检查；凭证输入已清空。')
    } finally {
      saving.current = false
      if (active.current === generation) setBusy(false)
    }
  }

  if (!settings) return <div className="model-settings">{error ? <p role="alert">{error} <button type="button" onClick={() => window.location.reload()}>重新加载</button></p> : <p role="status">正在读取模型设置…</p>}</div>
  const locked = settings.source === 'env'
  return <form className="model-settings" onSubmit={event => void save(event)}>
    {locked && <p className="shell-muted small">当前由环境变量提供，整块只读；请在服务端修改环境配置。</p>}
    <fieldset disabled={locked || busy}>
      <label className="model-settings-row"><span>Base URL</span><input type="url" value={baseUrl} required maxLength={2048} autoComplete="off" spellCheck={false} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
      <label className="model-settings-row"><span>模型名</span><input value={model} required maxLength={200} autoComplete="off" spellCheck={false} onChange={event => setModel(event.target.value)} /></label>
      <label className="model-settings-row"><span>API key <small className="shell-muted">{settings.hasKey ? '已保存' : '未设置'}</small></span><input type="password" value={apiKey} required={!settings.hasKey} autoComplete="new-password" spellCheck={false} onChange={event => setApiKey(event.target.value)} placeholder={settings.hasKey ? '留空保留已保存的凭证' : '输入 API key'} aria-describedby="model-key-help" /></label>
      <p id="model-key-help" className="shell-muted small">已保存的 key 永不回显；仅保存在服务端独立凭证文件，提交后清空输入。</p>
      <button className="primary" type="submit">{busy ? '正在保存…' : '保存模型设置'}</button>
    </fieldset>
    <p className="shell-muted small">{MODEL_SETTINGS_NOTICE}</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </form>
}
