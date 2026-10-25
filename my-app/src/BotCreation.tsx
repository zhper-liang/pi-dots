import { useEffect, useRef, useState, type FormEvent } from 'react'
import BotAvatar, { ShapeIcon } from './BotAvatar'
import { avatarColors, avatarShapes, saveLook, shapeLabels, type AvatarShape } from './botLook'

type CreatedBot = { id: string; name: string; description: string; configRef: { botId: string; version: string } }
const pendingKey = 'pidot.pending-bot-creation'
type Pending = { requestId: string; name: string; description: string; profile: string }
function savedPending(): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null')
    return value && ['requestId', 'name', 'description', 'profile'].every((key) => typeof value[key] === 'string') ? value : null
  } catch { return null }
}
// Templates only prefill the form.
const templates: { name: string; role: string; description: string; color: string; shape: AvatarShape }[] = [
  { name: '每日助理', role: '日常事务', description: '每天早上汇总今天的日程、到期待办和需要我处理的事，并提醒冲突。', color: avatarColors[0], shape: 'circle' },
  { name: '日程整理', role: '日程管理', description: '查看我的日历，找出冲突和空档，给出调整建议。', color: avatarColors[5], shape: 'squircle' },
  { name: '费用整理', role: '财务助理', description: '整理我提供的消费记录，按类别汇总并标出异常。', color: avatarColors[2], shape: 'hexagon' },
  { name: 'Bug 复现', role: '测试助理', description: '根据我描述的问题，整理复现步骤、预期与实际结果。', color: avatarColors[8], shape: 'diamond' },
]
export type BotCreationProps = { token: string; onCreated: (bot: CreatedBot, mainTaskId: number | null) => void; onCancel?: () => void }

// PLAN §8.6: only the name is needed. Duties come from the server's name template when left empty;
// everything else sits under "高级".
export default function BotCreation({ token, onCreated, onCancel }: BotCreationProps) {
  const [pending] = useState(savedPending)
  const [name, setName] = useState(pending?.name ?? '')
  const [role, setRole] = useState('')
  const [description, setDescription] = useState(pending?.description ?? '')
  const [profile, setProfile] = useState(pending?.profile ?? 'general')
  const [color, setColor] = useState<string>(avatarColors[0])
  const [shape, setShape] = useState<AvatarShape>('circle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<Pending | null>(pending)
  const controller = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  useEffect(() => () => controller.current?.abort(), [])
  function applyTemplate(t: typeof templates[number]) { setName(t.name); setRole(t.role); setDescription(t.description); setColor(t.color); setShape(t.shape) }
  async function create(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    const data = { name: name.trim(), description: description.trim(), profile }
    if (!request.current || JSON.stringify(data) !== JSON.stringify({ name: request.current.name, description: request.current.description, profile: request.current.profile })) {
      request.current = { ...data, requestId: crypto.randomUUID() }
    }
    try { sessionStorage.setItem(pendingKey, JSON.stringify(request.current)) } catch { /* in-memory retry remains safe */ }
    submitting.current = true; setBusy(true); setError('')
    const abort = new AbortController(); controller.current = abort
    const { description: duties, ...rest } = request.current
    try {
      const response = await fetch('/api/bots', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(duties ? request.current : rest), signal: abort.signal })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '创建失败。')
      if (abort.signal.aborted) return
      try { sessionStorage.removeItem(pendingKey) } catch { /* optional */ }
      saveLook(body.bot.id, { color, shape, role: role.trim() || body.inferred?.role || undefined })
      request.current = null; setName(''); setDescription(''); setRole(''); onCreated(body.bot, typeof body.mainTaskId === 'number' ? body.mainTaskId : null)
    } catch (error) {
      if (!abort.signal.aborted) setError(error instanceof Error && error.name !== 'TypeError' ? error.message : '创建结果未确认；可重试相同内容（不会重复创建），或刷新列表核对。')
    } finally { if (!abort.signal.aborted) { submitting.current = false; setBusy(false) } }
  }
  return <div className="bot-page">
    <header className="bot-page-head"><h1>新建 Bot</h1><p className="shell-muted">起个名字就能建。它负责什么会按名字自动写好，建完直接进入和它的对话。</p></header>
    <form onSubmit={e => void create(e)} className="bot-form">
      <div className="bot-preview"><BotAvatar name={name || 'B'} look={{ color, shape }} size={96} /><div><strong>{name || '未命名 Bot'}</strong><p className="shell-muted">{role || '角色按名字自动生成'}</p></div></div>
      <label htmlFor="bot-name">名字</label><input id="bot-name" required maxLength={60} value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="例如：日程助理" />
      <p className="shell-muted small">默认带本地工作区工具。删除先问你，其余直接做；建好后可在 Bot 页调整工具、资源和规则。</p>
      <details className="bot-advanced"><summary>高级</summary>
        <label htmlFor="bot-description">负责什么</label><textarea id="bot-description" rows={4} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} disabled={busy} placeholder="不填就按名字自动生成" />
        <label htmlFor="bot-role">角色</label><input id="bot-role" maxLength={40} value={role} onChange={e => setRole(e.target.value)} disabled={busy} placeholder="不填就按名字自动生成" />
        <fieldset className="bot-picker" disabled={busy}><legend>颜色</legend>
          {avatarColors.map(c => <label key={c} className="swatch" style={{ background: c }}><input type="radio" name="bot-color" checked={color === c} onChange={() => setColor(c)} aria-label={`颜色 ${avatarColors.indexOf(c) + 1}`} /></label>)}
        </fieldset>
        <fieldset className="bot-picker" disabled={busy}><legend>形状</legend>
          {avatarShapes.map(s => <label key={s} className="shape-option" title={shapeLabels[s]}><input type="radio" name="bot-shape" checked={shape === s} onChange={() => setShape(s)} aria-label={shapeLabels[s]} /><ShapeIcon shape={s} color={shape === s ? color : '#a1a1aa'} size={28} /></label>)}
        </fieldset>
        <label htmlFor="bot-profile">基础能力</label><select id="bot-profile" value={profile} onChange={e => setProfile(e.target.value)} disabled={busy}><option value="general">通用对话与问题登记</option><option value="mock-calendar">模拟日历</option></select>
      </details>
      {error && <p role="alert" className="shell-alert-card">{error}</p>}
      <div className="bot-actions">{onCancel && <button type="button" onClick={onCancel} disabled={busy}>取消</button>}<button className="primary" disabled={busy || !name.trim()}>{busy ? '正在创建…' : '创建 Bot'}</button></div>
    </form>
    <section aria-labelledby="bot-templates" className="bot-templates"><h2 id="bot-templates">从模板开始</h2><p className="shell-muted small">点一下填好名字和职责，建好后可在 Bot 页调整工具和规则。</p>
      <div className="bot-template-grid">{templates.map(t => <button type="button" key={t.name} className="bot-template" disabled={busy} onClick={() => applyTemplate(t)}><BotAvatar name={t.name} look={t} size={36} /><span><strong>{t.name}</strong><small>{t.description}</small></span></button>)}</div>
    </section>
  </div>
}
