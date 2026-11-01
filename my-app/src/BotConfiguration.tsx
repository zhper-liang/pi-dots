import { formatContextWindow } from '../shared/model-context.mjs'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

type Bot = { id: string; name: string; description: string; configRef: { botId: string; version: string }; defaults: { model: { id: string } | null; tools: string[]; toolResources: string[] } }
type View = { bot: Bot; versions: (Bot & { source: string; savedAt: string })[]; assigned: { tools: string[]; resources: string[] }; resources: string[]; toolGroups: { id: string; enabled: boolean }[]; resourceLabels?: Record<string, { title: string; note: string }>; models: { id: string; contextWindow?: number; provider: string; name?: string }[]; audit: { id: number; type: string; source: string; code?: string; createdAt: string; initiatingUser?: string; executingChief?: string; taskId?: number; operationId?: string; next?: unknown; previous?: unknown }[] }
type Change = { model: string; resources: string[] }

async function request<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) { const error = new Error(result.error?.message ?? '配置操作失败。') as Error & { code?: string }; error.code = result.error?.code; throw error }
  return result
}
/** Model and source settings only. Personality is edited exclusively in Bot memory. */
export default function BotConfiguration({ botId, token, onSaved, readOnly = false, active = true }: { botId: string; token: string; readOnly?: boolean; active?: boolean; onSaved: (bot: Bot) => void }) {
  const [view, setView] = useState<View | null>(null)
  const [model, setModel] = useState('')
  const modelDraft = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // Mounted per Bot (keyed by botId); a late response after unmount must not touch state.
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = () => request<View>(`/api/bots/${botId}/configuration`, token)
  // A fresh view replaces the draft only when the user has not edited it.
  const adopt = (next: View, keepDraft = false) => {
    setView(next)
    if (!keepDraft) { setModel(next.bot.defaults.model?.id ?? ''); modelDraft.current = null }
  }
  useEffect(() => {
    if (!active) return
    let live = true
    request<View>(`/api/bots/${botId}/configuration`, token).then((next) => {
      if (live) { setView(next); if (modelDraft.current === null) setModel(next.bot.defaults.model?.id ?? '') }
    }).catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [botId, token, active])
  const dirty = !!view && (!!view.bot.defaults.model && model !== view.bot.defaults.model.id)
  async function submit(change: Change, done: string, keepDraft: boolean) {
    if (!view || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request(`/api/bots/${botId}/configuration`, token, { expectedVersion: view.bot.configRef.version, requestId: crypto.randomUUID(),
        description: view.bot.description, tools: view.assigned.tools, resources: change.resources,
        ...(view.bot.defaults.model ? { parameters: { model: { id: change.model } } } : {}) })
      const next = await load()
      if (!mounted.current) return
      adopt(next, keepDraft); onSaved(next.bot); setNotice(done)
    } catch (e) {
      if (!mounted.current) return
      const code = (e as { code?: string }).code
      setError(code === 'CONFIG_VERSION_CONFLICT' ? '设置已在别处改过，点「重新读取」再改。' : e instanceof Error ? e.message : '保存失败。')
    } finally { if (mounted.current) setBusy(false) }
  }
  function saveModel(event: FormEvent) {
    event.preventDefault()
    if (!view) return
    void submit({ model, resources: view.assigned.resources }, '模型已保存。之后的对话用这个模型。', false)
  }
  function discard() {
    setError(''); setNotice('')
    void load().then((next) => { if (mounted.current) adopt(next) }).catch((e: Error) => { if (mounted.current) setError(e.message) })
  }
  if (!view) return <section className="bot-edit-section" aria-label="模型"><h2>模型</h2>
    <p className={error ? 'bot-edit-error' : 'bot-edit-hint'} role={error ? 'alert' : undefined}>{error || '正在读取…'}</p></section>
  return <>
    <section className="bot-edit-section" aria-label="模型">
      <h2>模型</h2>
      <span className="sr-only" data-testid="bot-config-version">{view.bot.configRef.version}</span>
      <form className="bot-edit-form" onSubmit={saveModel}>
        <div className="pd-row pd-row-select">
          <label className="pd-row-text" htmlFor={`bot-model-${botId}`}>
            <span className="pd-row-title">模型</span>
            <span className="pd-row-desc">之后的对话用这个模型</span>
          </label>
          {view.bot.defaults.model && view.models.length > 0
            ? <select id={`bot-model-${botId}`} value={model} disabled={readOnly || busy} onChange={(e) => { setModel(e.target.value); modelDraft.current = e.target.value === view.bot.defaults.model?.id ? null : e.target.value }}>
              {view.models.map((m) => <option key={m.id} value={m.id}>{`${m.name ?? m.id}${m.name && m.provider ? ` · ${m.provider}` : ''} · ${formatContextWindow(m.contextWindow)}`}</option>)}
            </select>
            : <span id={`bot-model-${botId}`} className="pd-row-desc">测试模式（未配置模型）</span>}
        </div>
        {!readOnly && (dirty || error) && <div className="bot-edit-actions">
          {dirty && <button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</button>}
          <button type="button" className="pd-button" disabled={busy} onClick={discard}>{dirty ? '放弃更改' : '重新读取'}</button>
        </div>}
      </form>
    </section>
    <p className="bot-edit-hint">日历与任务列表的使用范围在<a href={`#bot=${encodeURIComponent(botId)}&tab=capabilities`}>能力 → 工具集</a>管理。</p>
    {readOnly && <p role="status" className="bot-edit-hint">这个机器人已停用，只能查看。</p>}
    {error && <p role="alert" className="bot-edit-error">{error}</p>}
    {notice && <p role="status" className="bot-edit-hint">{notice}</p>}
    <details className="tech-info">
      <summary>修改记录</summary>
      <ol className="bot-edit-history">{view.versions.map((v) => <li key={v.configRef.version}>
        {new Date(v.savedAt).toLocaleString('zh-CN')} · 模型 {v.defaults.model?.id ?? '测试回复'}
        <p>当时的职责（历史记录）：{v.description}</p>
      </li>)}</ol>
    </details>
  </>
}
