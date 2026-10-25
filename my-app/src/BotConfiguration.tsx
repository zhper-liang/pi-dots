import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

type Bot = { id: string; name: string; description: string; configRef: { botId: string; version: string }; defaults: { model: { id: string } | null; tools: string[]; toolResources: string[] } }
type View = { bot: Bot; versions: (Bot & { source: string; savedAt: string })[]; installed: string[]; assigned: { tools: string[]; resources: string[] }; revoked: string[]; resources: string[]; models: { id: string; provider: string }[]; audit: { id: number; type: string; source: string; code?: string; createdAt: string; initiatingUser?: string; executingChief?: string; taskId?: number; operationId?: string; next?: unknown; previous?: unknown }[] }
async function request<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message ?? '配置操作失败。')
  return result
}
const toggle = (items: string[], name: string) => items.includes(name) ? items.filter((n) => n !== name) : [...items, name]
export default function BotConfiguration({ botId, token, onSaved, readOnly = false }: { botId: string; token: string; readOnly?: boolean; onSaved: (bot: Bot) => void }) {
  const [view, setView] = useState<View | null>(null)
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('')
  const [tools, setTools] = useState<string[]>([])
  const [resources, setResources] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // Each mounted Bot owns its draft and CAS version; late responses never edit another Bot.
  const load = async () => request<View>(`/api/bots/${botId}/configuration`, token)
  const adopt = (next: View) => { setView(next); setDescription(next.bot.description); setModel(next.bot.defaults.model?.id ?? ''); setTools(next.assigned.tools); setResources(next.assigned.resources) }
  useEffect(() => {
    let live = true
    request<View>(`/api/bots/${botId}/configuration`, token).then((next) => { if (live) adopt(next) }).catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [botId, token])
  async function save(event: FormEvent) {
    event.preventDefault(); if (!view || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request(`/api/bots/${botId}/configuration`, token, { expectedVersion: view.bot.configRef.version, requestId: crypto.randomUUID(), description, tools, resources,
        ...(view.bot.defaults.model ? { parameters: { model: { id: model } } } : {}) })
      const next = await load(); adopt(next); onSaved(next.bot); setNotice('已保存。工具和资源从所有会话的下一次调用起生效；模型与职责供新任务使用，旧会话可另行迁移。')
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败。') } finally { setBusy(false) }
  }
  return <details className="bot-configuration"><summary>工具与资源、模型和职责</summary>
    <p className="shell-note" role="note">勾选的工具与资源从所有会话的下一次调用起生效。</p>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!view ? <p>正在读取配置…</p> : <>
      <p className="muted small">当前 Bot：{view.bot.name}<span className="sr-only" data-testid="bot-config-version">{view.bot.configRef.version}</span>。勾选后保存即可使用。</p>
      {readOnly && <p role="status">Bot 已停用：配置与管理记录只读，历史仍可查看。</p>}<fieldset disabled={readOnly}><form onSubmit={(e) => void save(e)}>
        <label htmlFor="bot-config-description">Bot 角色与职责</label><textarea id="bot-config-description" maxLength={2000} required value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
        <label htmlFor="bot-config-model">已配置模型</label><select id="bot-config-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy || !view.bot.defaults.model || view.models.length === 0}>
          {!view.bot.defaults.model && <option value="">确定性测试模式（无真实模型）</option>}{view.models.map((m) => <option key={m.id} value={m.id}>{m.provider} / {m.id}</option>)}
        </select>
        <p className="muted small">不新增供应商、连接器或凭证。新会话使用保存后的配置；当前会话仍显示原固定版本。</p>
        <fieldset className="bot-permissions" disabled={busy}><legend>工具</legend>{view.installed.map((name) => <label key={name}><input type="checkbox" aria-label={`分配工具 ${name}`} checked={tools.includes(name)} onChange={() => setTools(toggle(tools, name))} /><code>{name}</code>{view.revoked.includes(name) && <span className="muted small"> · 已撤销，暂不可用</span>}</label>)}</fieldset>
        <fieldset className="bot-permissions" disabled={busy}><legend>资源</legend>{view.resources.map((name) => <label key={name}><input type="checkbox" aria-label={`分配资源 ${name}`} checked={resources.includes(name)} onChange={() => setResources(toggle(resources, name))} /><code>{name}</code></label>)}</fieldset>
        <button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存 Bot 新配置'}</button> <button type="button" disabled={busy} onClick={() => { void load().then((next) => { adopt(next); setError(''); setNotice('已重新加载最新版本；请检查后再编辑。') }).catch((e: Error) => setError(e.message)) }}>重新加载最新配置</button>
      </form></fieldset>
      <details><summary>不可变配置历史（{view.versions.length}）</summary>{view.versions.map((v) => <div key={v.configRef.version}><strong>{v.configRef.version}</strong><p>{v.description}</p><p className="muted small">来源：{v.source} · {new Date(v.savedAt).toLocaleString('zh-CN')} · 模型 {v.defaults.model?.id ?? '测试模式'} · 工具 {v.defaults.tools.join('、') || '无'} · 资源 {v.defaults.toolResources.join('、') || '无'}</p></div>)}</details>
      <details><summary>配置与授权审计（{view.audit.length}）</summary><ol>{view.audit.map((e) => <li key={e.id}>#{e.id} · {e.type} · {e.source}{e.code ? ` · ${e.code}` : ''} · {new Date(e.createdAt).toLocaleString('zh-CN')}<pre>{JSON.stringify({ previous: e.previous, next: e.next, initiatingUser: e.initiatingUser, executingChief: e.executingChief, taskId: e.taskId, operationId: e.operationId }, null, 2)}</pre></li>)}</ol></details>
    </>}
  </details>
}
