import { useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import BotAvatar, { ShapeIcon } from './BotAvatar'
import { avatarColors, avatarShapes, loadLook, saveLook, shapeLabels, type BotLook } from './botLook'
import BotConfiguration from './BotConfiguration'
import BotRules from './BotRules'
import BotRoutines from './BotRoutines'
import { BotSkills } from './SkillControls'
import StdioCredentials from './StdioCredentials'
import { botTabs, type BotTab } from './bot-directory.mjs'
import { nextTab } from './workspace-navigation.mjs'

type Bot = { status?: 'active' | 'inactive'; id: string; name: string; description: string; configRef: { botId: string; version: string } }
export type TemplateTask = { taskId: number; title: string; createdAt: string; statusLabel: string }
type Props = {
  bot: Bot; token: string; tasks: TemplateTask[]; creating: boolean; tab: BotTab; mainTaskId: number | null; chat: ReactNode
  onTab: (tab: BotTab) => void; onDirectory: () => void
  onNewTask: () => void; onOpenTask: (taskId: number) => void
  onSaved: (bot: Bot) => void; onDeactivate: () => void
}

export default function BotTemplatePage({ bot, token, tasks, creating, tab, mainTaskId, chat, onTab, onDirectory, onNewTask, onOpenTask, onSaved, onDeactivate }: Props) {
  const [look, setLook] = useState<BotLook>(() => loadLook(bot.id))
  const tabRefs = useRef<Partial<Record<BotTab, HTMLButtonElement | null>>>({})
  const inactive = bot.status === 'inactive'
  const chief = bot.id === 'chief'
  function updateLook(next: BotLook) { setLook(next); saveLook(bot.id, next) }
  function onTabKey(event: KeyboardEvent) {
    const next = nextTab(botTabs.map(item => item.id), tab, event.key)
    if (next === tab) return
    event.preventDefault(); onTab(next); tabRefs.current[next]?.focus()
  }
  const panelProps = (id: BotTab) => ({ id: `bot-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `bot-tab-${id}`, hidden: tab !== id, tabIndex: 0, className: `bot-tab-panel${id === 'chat' ? ' bot-tab-chat' : ''}` })
  return <div className="bot-page bot-detail-page">
    <nav className="bot-detail-nav" aria-label="机器人导航"><button type="button" className="text-button" onClick={onDirectory}>← 机器人目录</button><button type="button" className="text-button" onClick={onNewTask} disabled={inactive || creating}>{creating ? '正在创建…' : '新建独立任务'}</button></nav>
    <header className="bot-detail-head"><BotAvatar name={bot.name} look={look} size={56} /><div><h1>{bot.name}</h1><p className="shell-muted">{look.role ?? (chief ? '主管 · 负责分派与验收' : '机器人')}{inactive ? ' · 已停用' : ''}</p></div></header>
    <p className="bot-detail-desc">{bot.description}</p>
    {inactive && <p role="status" className="shell-note">这个 Bot 已停用：不能再发消息或新建任务。历史任务和真实结果都保留。</p>}
    <div className="bot-detail-tabs" role="tablist" aria-label="Bot 详情">{botTabs.map(item => <button key={item.id} ref={el => { tabRefs.current[item.id] = el }} type="button" role="tab" id={`bot-tab-${item.id}`} aria-controls={`bot-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => onTab(item.id)} onKeyDown={onTabKey}>{item.label}{item.id === 'tasks' ? ` (${tasks.length})` : ''}</button>)}</div>
    <div {...panelProps('chat')}>{mainTaskId === null ? <p role="status">主会话尚未就绪，请刷新后核对。</p> : chat}</div>
    <div {...panelProps('rules')}><BotRules key={`rules:${bot.id}:${token}`} token={token} botId={bot.id} readOnly={inactive} /></div>
    <div {...panelProps('skills')}><BotSkills token={token} mainTaskId={mainTaskId} active={tab === 'skills'} /></div>
    <div {...panelProps('mcp')}><h2>MCP</h2><p className="shell-muted">仅管理这个 Bot 的本机 stdio 凭证。凭证不是模型 key，请勿粘贴进对话。</p><StdioCredentials key={`mcp:${bot.id}:${token}`} token={token} fixedBotId={bot.id} readOnly={inactive} expanded /></div>
    <div {...panelProps('memory')}><section className="bot-memory-placeholder"><h2>记忆</h2><p>人格、用户偏好和记忆文档将在 T11 提供。本页暂不读取或改写历史记忆。</p></section></div>
    <div {...panelProps('settings')}>
      <section className="bot-edit-section" aria-label="外观">
        <h2>外观</h2>
        <ul className="pd-rows">
          <li className="pd-row"><span className="pd-row-title">颜色</span>
            <fieldset className="bot-picker" disabled={inactive}><legend className="sr-only">颜色</legend>
              {avatarColors.map((c, i) => <label key={c} className="swatch" style={{ background: c }}><input type="radio" name={`look-color-${bot.id}`} checked={look.color === c} onChange={() => updateLook({ ...look, color: c })} aria-label={`颜色 ${i + 1}`} /></label>)}
            </fieldset></li>
          <li className="pd-row"><span className="pd-row-title">形状</span>
            <fieldset className="bot-picker" disabled={inactive}><legend className="sr-only">形状</legend>
              {avatarShapes.map(s => <label key={s} className="shape-option" title={shapeLabels[s]}><input type="radio" name={`look-shape-${bot.id}`} checked={look.shape === s} onChange={() => updateLook({ ...look, shape: s })} aria-label={shapeLabels[s]} /><ShapeIcon shape={s} color={look.shape === s ? look.color : 'var(--c-muted)'} size={28} /></label>)}
            </fieldset></li>
          <li className="pd-row"><label className="pd-row-title" htmlFor={`look-role-${bot.id}`}>角色</label>
            <input id={`look-role-${bot.id}`} className="pd-input" maxLength={40} placeholder="例如：日程管家" value={look.role ?? ''} disabled={inactive} onChange={e => updateLook({ ...look, role: e.target.value || undefined })} /></li>
        </ul>
      </section>
      <BotConfiguration key={`config:${bot.id}:${token}`} botId={bot.id} token={token} readOnly={inactive} onSaved={onSaved} />
      {!chief && !inactive && <section className="bot-edit-section bot-danger" aria-label="停用 Bot"><h2>停用 Bot</h2><p>停用后不能再用它新建任务，历史和已发生的结果保留。</p><button type="button" onClick={() => {
        if (window.confirm(`停用 ${bot.name}？之后不能再用它新建任务，在途操作会尽力停止。历史与真实结果保留，已发生的效果不会回滚，目前不能重新启用。`)) onDeactivate()
      }}>停用此 Bot</button></section>}
    </div>
    <div {...panelProps('tasks')}>
      <section aria-labelledby="bot-tasks-title" className="today-card"><h2 id="bot-tasks-title">独立任务</h2><p className="shell-muted small">按 Bot 身份归组，含已归档任务；打开后仍是原 Task，可用浏览器后退回到这里。</p>
        {tasks.length === 0 ? <p className="shell-muted">还没有独立任务。</p> : <ul className="today-list">{tasks.map(task => <li key={task.taskId}><button type="button" className="today-link" onClick={() => onOpenTask(task.taskId)}><span>{task.title}</span><span className="shell-muted small">{task.statusLabel} · {new Date(task.createdAt).toLocaleString('zh-CN')}</span></button></li>)}</ul>}
      </section>
      <BotRoutines key={`routines:${bot.id}:${token}`} token={token} botId={bot.id} readOnly={inactive} onOpenTask={onOpenTask} />
    </div>
  </div>
}
