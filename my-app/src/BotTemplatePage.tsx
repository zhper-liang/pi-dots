import { useState } from 'react'
import BotAvatar, { ShapeIcon } from './BotAvatar'
import { avatarColors, avatarShapes, loadLook, saveLook, shapeLabels, type BotLook } from './botLook'
import BotConfiguration from './BotConfiguration'
import BotRules from './BotRules'
import BotRoutines from './BotRoutines'

type Bot = { status?: 'active' | 'inactive'; id: string; name: string; description: string; configRef: { botId: string; version: string } }
export type TemplateTask = { taskId: number; title: string; createdAt: string; statusLabel: string }
type Props = {
  bot: Bot; token: string; tasks: TemplateTask[]; creating: boolean
  onNewTask: () => void; onOpenTask: (taskId: number) => void
  onSaved: (bot: Bot) => void; onDeactivate: () => void
}

export default function BotTemplatePage({ bot, token, tasks, creating, onNewTask, onOpenTask, onSaved, onDeactivate }: Props) {
  const [look, setLook] = useState<BotLook>(() => loadLook(bot.id))
  const [editing, setEditing] = useState(false)
  const inactive = bot.status === 'inactive'
  const chief = bot.id === 'chief'
  function updateLook(next: BotLook) { setLook(next); saveLook(bot.id, next) }
  return <div className="bot-page">
    <header className="bot-detail-head">
      <BotAvatar name={bot.name} look={look} size={80} />
      <div>
        <h1>{chief ? '★ ' : ''}{bot.name}</h1>
        <p className="shell-muted">{look.role ?? (chief ? '主管 · 负责分派与验收' : 'Bot 模板')}{inactive ? ' · 已停用' : ''}</p>
      </div>
      <div className="bot-detail-actions">
        <button className="primary" type="button" disabled={inactive || creating} onClick={onNewTask}>{creating ? '正在创建…' : '新任务'}</button>
        <button type="button" aria-expanded={editing} aria-controls="bot-edit" onClick={() => setEditing(v => !v)}>{editing ? '完成编辑' : '编辑'}</button>
      </div>
    </header>
    <p className="bot-detail-desc">{bot.description}</p>
    {inactive && <p role="status" className="shell-note">这个 Bot 已停用：不能再新建任务。历史任务和真实结果都保留。</p>}

    <div id="bot-edit" hidden={!editing} className="bot-edit">
      <section className="bot-edit-section" aria-label="外观">
        <h2>外观</h2>
        <ul className="pd-rows">
          <li className="pd-row"><span className="pd-row-title">颜色</span>
            <fieldset className="bot-picker" disabled={inactive}><legend className="sr-only">颜色</legend>
              {avatarColors.map((c, i) => <label key={c} className="swatch" style={{ background: c }}><input type="radio" name={`look-color-${bot.id}`} checked={look.color === c} onChange={() => updateLook({ ...look, color: c })} aria-label={`颜色 ${i + 1}`} /></label>)}
            </fieldset></li>
          <li className="pd-row"><span className="pd-row-title">形状</span>
            <fieldset className="bot-picker" disabled={inactive}><legend className="sr-only">形状</legend>
              {avatarShapes.map(s => <label key={s} className="shape-option" title={shapeLabels[s]}><input type="radio" name={`look-shape-${bot.id}`} checked={look.shape === s} onChange={() => updateLook({ ...look, shape: s })} aria-label={shapeLabels[s]} /><ShapeIcon shape={s} color={look.shape === s ? look.color : '#a1a1aa'} size={28} /></label>)}
            </fieldset></li>
          <li className="pd-row"><label className="pd-row-title" htmlFor={`look-role-${bot.id}`}>角色</label>
            <input id={`look-role-${bot.id}`} className="pd-input" maxLength={40} placeholder="例如：日程管家" value={look.role ?? ''} disabled={inactive} onChange={e => updateLook({ ...look, role: e.target.value || undefined })} /></li>
        </ul>
      </section>
      <BotRules key={`rules:${bot.id}:${token}`} token={token} botId={bot.id} readOnly={inactive} />
      <BotConfiguration key={`config:${bot.id}:${token}`} botId={bot.id} token={token} readOnly={inactive} onSaved={onSaved} />
      {!chief && !inactive && <section className="bot-edit-section bot-danger" aria-label="停用 Bot">
        <p className="bot-edit-hint">停用后不能再用它新建任务，历史和已发生的结果保留。</p>
        <button type="button" onClick={() => {
          if (window.confirm(`停用 ${bot.name}？之后不能再用它新建任务，在途操作会尽力停止。历史与真实结果保留，已发生的效果不会回滚，目前不能重新启用。`)) onDeactivate()
        }}>停用此 Bot</button>
      </section>}
    </div>

    <BotRoutines key={`routines:${bot.id}:${token}`} token={token} botId={bot.id} readOnly={inactive} onOpenTask={onOpenTask} />

    <section aria-labelledby={`bot-tasks-${bot.id}`} className="today-card">
      <h2 id={`bot-tasks-${bot.id}`}>用这个模板开始的任务</h2>
      {tasks.length === 0 ? <p className="shell-muted">还没有任务。点「新任务」开始。</p>
        : <ul className="today-list">{tasks.map(t => <li key={t.taskId}><button type="button" className="today-link" onClick={() => onOpenTask(t.taskId)}><span>{t.title}</span><span className="shell-muted small">{t.statusLabel}</span></button></li>)}</ul>}
    </section>
  </div>
}
