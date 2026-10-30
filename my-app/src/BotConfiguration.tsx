import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import Switch from './Switch'

type Bot = { id: string; name: string; description: string; configRef: { botId: string; version: string }; defaults: { model: { id: string } | null; tools: string[]; toolResources: string[] } }
type View = { bot: Bot; versions: (Bot & { source: string; savedAt: string })[]; assigned: { tools: string[]; resources: string[] }; resources: string[]; resourceLabels?: Record<string, { title: string; note: string }>; models: { id: string; provider: string }[]; audit: { id: number; type: string; source: string; code?: string; createdAt: string; initiatingUser?: string; executingChief?: string; taskId?: number; operationId?: string; next?: unknown; previous?: unknown }[] }
type Change = { model: string; resources: string[] }

const toggle = (items: string[], name: string) => items.includes(name) ? items.filter((n) => n !== name) : [...items, name]
async function request<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) { const error = new Error(result.error?.message ?? '配置操作失败。') as Error & { code?: string }; error.code = result.error?.code; throw error }
  return result
}
// Readable names for source resources; the raw id stays in the row tooltip.
function describeResource(id: string, labels?: Record<string, { title: string; note: string }>) {
  // Server-provided titles for multi-source providers (e.g. each Google calendar or task list).
  if (labels && Object.hasOwn(labels, id)) return labels[id]
  if (id === 'mock:personal') return { title: '模拟日程', note: '测试用的个人日程，不是真实日历' }
  if (id === 'workspace:local') return { title: '本地待办与日程', note: '本机保存的事项' }
  if (id.startsWith('workspace:feishu:')) return { title: '飞书日历（事项）', note: '通过待办与事项工具读写飞书日程' }
  if (id.startsWith('feishu:')) return { title: '飞书日历', note: '通过日历工具读写飞书日程' }
  return { title: id, note: '' }
}

/** Model and source settings only. Personality is edited exclusively in Bot memory. */
export default function BotConfiguration({ botId, token, onSaved, readOnly = false }: { botId: string; token: string; readOnly?: boolean; onSaved: (bot: Bot) => void }) {
  const [view, setView] = useState<View | null>(null)
  const [model, setModel] = useState('')
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
    if (!keepDraft) { setModel(next.bot.defaults.model?.id ?? '') }
  }
  useEffect(() => {
    let live = true
    request<View>(`/api/bots/${botId}/configuration`, token).then((next) => {
      if (live) { setView(next); setModel(next.bot.defaults.model?.id ?? '') }
    }).catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [botId, token])
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
      setError(code === 'CONFIG_VERSION_CONFLICT' ? '配置已在别处更新：先读取最新版本再改。' : e instanceof Error ? e.message : '保存失败。')
    } finally { if (mounted.current) setBusy(false) }
  }
  function saveModel(event: FormEvent) {
    event.preventDefault()
    if (!view) return
    void submit({ model, resources: view.assigned.resources }, '模型已保存。新任务使用新模型；已开始的会话保持原模型。', false)
  }
  function switchResource(id: string) {
    if (!view) return
    // Source changes preserve the saved model and any unsaved model draft.
    void submit({ model: view.bot.defaults.model?.id ?? '', resources: toggle(view.assigned.resources, id) }, '来源已更新。', dirty)
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
      <p className="bot-edit-hint">人格与职责统一在「记忆 → 人格」编辑，保存后实时生效。</p>
      <span className="sr-only" data-testid="bot-config-version">{view.bot.configRef.version}</span>
      <form className="bot-edit-form" onSubmit={saveModel}>
        <div className="pd-row pd-row-select">
          <label className="pd-row-text" htmlFor={`bot-model-${botId}`}>
            <span className="pd-row-title">模型</span>
            <span className="pd-row-desc">新任务使用；已开始的会话不变</span>
          </label>
          {view.bot.defaults.model && view.models.length > 0
            ? <select id={`bot-model-${botId}`} value={model} disabled={readOnly || busy} onChange={(e) => setModel(e.target.value)}>
              {view.models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
            : <span id={`bot-model-${botId}`} className="pd-row-desc">测试模式（未配置模型）</span>}
        </div>
        {!readOnly && (dirty || error) && <div className="bot-edit-actions">
          {dirty && <button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</button>}
          <button type="button" className="pd-button" disabled={busy} onClick={discard}>{dirty ? '放弃更改' : '重新读取'}</button>
        </div>}
      </form>
    </section>
    <section className="bot-edit-section" aria-label="来源">
      <h2>来源</h2>
      <p className="bot-edit-hint">开了才能读写这个来源。切换立即生效，用于所有会话的下一次操作。</p>
      {view.resources.length === 0 ? <p className="bot-edit-hint">还没有可用的来源。</p>
        : <ul className="pd-rows">{view.resources.map((id) => {
          const { title, note } = describeResource(id, view.resourceLabels)
          return <li key={id} className="pd-row" title={id}>
            <div className="pd-row-text"><span className="pd-row-title">{title}</span>{note && <span className="pd-row-desc">{note}</span>}</div>
            <Switch label={title} checked={view.assigned.resources.includes(id)} disabled={readOnly || busy} onChange={() => switchResource(id)} />
          </li>
        })}</ul>}
      {readOnly && <p role="status" className="bot-edit-hint">Bot 已停用：只能查看。</p>}
      {error && <p role="alert" className="bot-edit-error">{error}</p>}
      {notice && <p role="status" className="bot-edit-hint">{notice}</p>}
    </section>
    <details className="bot-edit-diagnostics">
      <summary>配置历史与审计（{view.versions.length} 个版本 · {view.audit.length} 条记录）</summary>
      <ol className="bot-edit-history">{view.versions.map((v) => <li key={v.configRef.version}>
        <strong>{v.configRef.version}</strong> · {v.source} · {new Date(v.savedAt).toLocaleString('zh-CN')} · 模型 {v.defaults.model?.id ?? '测试模式'} · 资源 {v.defaults.toolResources.join('、') || '无'}
        <p>当时的职责（历史记录）：{v.description}</p>
      </li>)}</ol>
      <ol className="bot-edit-history">{view.audit.map((e) => <li key={e.id}>#{e.id} · {e.type} · {e.source}{e.code ? ` · ${e.code}` : ''} · {new Date(e.createdAt).toLocaleString('zh-CN')}
        <pre>{JSON.stringify({ previous: e.previous, next: e.next, initiatingUser: e.initiatingUser, executingChief: e.executingChief, taskId: e.taskId, operationId: e.operationId }, null, 2)}</pre>
      </li>)}</ol>
    </details>
  </>
}
