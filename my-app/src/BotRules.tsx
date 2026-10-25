import { useCallback, useEffect, useState } from 'react'

type Effect = 'allow' | 'ask' | 'deny'
type Rule = { id: string; botId: string; match: { tool?: string; action?: string; sourceId?: string; type?: string }; effect: Effect; origin: string }
const effects = { allow: '直接做', ask: '先问我', deny: '禁止' }
const tools: Record<string, string> = { 'workspace.prepare_change': '改工作区事项', calendar_feishu_create_event: '新建飞书日程', calendar_feishu_update_event: '修改飞书日程', calendar_feishu_delete_event: '删除飞书日程', calendar_reschedule_event: '模拟改期', bot_manage: '管理 Bot' }
const actions: Record<string, string> = { create: '新建', update: '修改', delete: '删除', configure: '配置', deactivate: '停用' }
const describe = (m: Rule['match']) => [tools[m.tool ?? ''] ?? m.tool ?? '全部写入', m.action && (actions[m.action] ?? m.action), m.sourceId && `来源 ${m.sourceId}`, m.type && ({ Todo: '待办', Event: '日程' }[m.type] ?? m.type)].filter(Boolean).join(' · ')

export default function BotRules({ token, botId, readOnly }: { token: string; botId: string; readOnly?: boolean }) {
  const [rules, setRules] = useState<Rule[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [tool, setTool] = useState('workspace.prepare_change'), [action, setAction] = useState(''), [effect, setEffect] = useState<Effect>('ask')
  const call = useCallback(async (path: string, body?: unknown) => {
    const response = await fetch(path, body === undefined ? { headers: { Authorization: `Bearer ${token}` } } : { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error?.message ?? '操作失败。')
    return result.data
  }, [token])
  const load = useCallback(async () => {
    const result = await call('/api/rules') as Rule[]
    setRules(result.filter(r => r.botId === botId && r.origin !== 'preset')); setError('')
  }, [call, botId])
  useEffect(() => {
    let live = true
    call('/api/rules').then((result: Rule[]) => { if (live) setRules(result.filter(r => r.botId === botId && r.origin !== 'preset')) }).catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [call, botId])
  async function run(path: string, body: unknown) {
    if (busy) return
    setBusy(true)
    try { await call(path, body); await load() } catch (e) { setError(e instanceof Error ? e.message : '操作失败。') } finally { setBusy(false) }
  }
  if (rules === null) return <p className="shell-muted">{error || '正在读取规则…'}</p>
  const actionChoices = tool === 'workspace.prepare_change' ? ['create', 'update', 'delete'] : tool === 'bot_manage' ? ['create', 'configure', 'deactivate'] : []
  return <fieldset className="bot-rules" disabled={readOnly || busy}><legend>规则</legend>
    <p className="shell-muted small">默认删除和停用 Bot 先问你，其余直接做。暂停自动化时，写入会先问你。</p>
    {rules.length === 0 ? <p className="shell-muted small">还没有自定义规则。在确认卡上点“以后直接做”，也会记在这里。</p>
      : <ul>{rules.map(r => <li key={r.id}>{describe(r.match)} · {effects[r.effect]} <button type="button" onClick={() => void run('/api/rules/remove', { id: r.id })}>删除规则</button></li>)}</ul>}
    <div className="action-row">
      <label>工具 <select value={tool} onChange={e => { setTool(e.target.value); setAction('') }}>{Object.entries(tools).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {actionChoices.length > 0 && <label>动作 <select value={action} onChange={e => setAction(e.target.value)}><option value="">全部动作</option>{actionChoices.map(a => <option key={a} value={a}>{actions[a]}</option>)}</select></label>}
      <label>设为 <select value={effect} onChange={e => setEffect(e.target.value as Effect)}>{Object.entries(effects).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <button type="button" onClick={() => void run('/api/rules', { botId, match: { tool, ...(action ? { action } : {}) }, effect })}>添加规则</button>
    </div>
    <p className="shell-muted small">规则越具体越优先；同样具体时，禁止优先于先问我，再优先于直接做。</p>
    {error && <p role="alert" className="shell-note">{error}</p>}
  </fieldset>
}
