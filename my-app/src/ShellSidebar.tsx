import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import BotAvatar from './BotAvatar'
import { loadLook } from './botLook'
import { PIN_KEY, parsePins, togglePin, sessionSections, relativeTime, matchesQuery, type SessionItem } from './session-list.mjs'
import type { WorkspaceView } from './workspace-navigation.mjs'
import { BellIcon, CloseIcon, GearIcon, GroupIcon, ItemsIcon, PinIcon, PlusIcon, SearchIcon, SidebarIcon } from './Icons'

export type SidebarSession = SessionItem & { owner: string; botId: string; group: boolean; note: string }
export type SidebarBot = { id: string; name: string; inactive: boolean; mainTaskId: number | null }
type Props = {
  collapsed: boolean; onToggleCollapsed: () => void; onClose: () => void
  view: WorkspaceView; newSession: boolean; inboxCount: number
  sessions: SidebarSession[]; bots: SidebarBot[]; selectedId: number | null; botPage: string | null
  onHome: () => void; onNewSession: () => void; onOpenSession: (id: number, owner: string) => void
  onOpenBot: (bot: SidebarBot) => void; onBotSettings: (id: string) => void; onNewBot: () => void; onNewGroup: () => void
  onView: (view: WorkspaceView) => void
}

function readPins() { try { return parsePins(localStorage.getItem(PIN_KEY)) } catch { return [] } }

/** Left column: brand and new session, 会话 / 机器人, search, grouped sessions, then 事项 · 通知 · 设置. */
export default function ShellSidebar(props: Props) {
  const { collapsed, onClose, view, newSession, inboxCount, sessions, bots, selectedId, botPage } = props
  const [tab, setTab] = useState<'sessions' | 'bots'>('sessions')
  const [query, setQuery] = useState('')
  const [pins, setPins] = useState(readPins)
  // Relative times tick once a minute; reading the clock during render would be impure.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer) }, [])
  // Each action also closes the mobile drawer.
  const act = (fn: () => void) => () => { fn(); onClose() }
  function pin(id: number) {
    const next = togglePin(pins, id)
    setPins(next)
    try { localStorage.setItem(PIN_KEY, JSON.stringify(next)) } catch { /* pins stay for this tab only */ }
  }
  const sections = sessionSections(sessions, { pins, query, now })
  const shownBots = bots.filter((bot) => matchesQuery({ title: bot.name, botName: bot.name }, query))
  const chief = bots.find((bot) => bot.id === 'chief')
  const nav = (id: WorkspaceView, label: string, icon: ReactNode, count = 0) =>
    <button type="button" className="pd-nav-row" aria-current={view === id ? 'page' : undefined} aria-label={count ? `${label}，${count} 项待处理` : label} title={label} onClick={act(() => props.onView(id))}>
      {icon}<span className="shell-label">{label}</span>{count > 0 && <span className="pd-count" aria-hidden="true">{count}</span>}
    </button>

  return <>
    <div className="pd-side-top">
      <button type="button" className="pd-brand" aria-label="pidot：回到 Chief" onClick={act(props.onHome)}><span className="shell-brand-mark" aria-hidden="true">p</span><span className="shell-label">pidot</span></button>
      <button type="button" className="shell-icon-button shell-collapse" aria-label={collapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!collapsed} aria-controls="shell-sidebar" onClick={props.onToggleCollapsed}><SidebarIcon /></button>
      <button type="button" className="shell-icon-button shell-close" aria-label="关闭导航" onClick={onClose}><CloseIcon /></button>
    </div>
    <button type="button" className="pd-nav-row pd-new" aria-current={newSession ? 'page' : undefined} title="新建会话" onClick={act(props.onNewSession)}><PlusIcon /><span className="shell-label">新建会话</span></button>

    <div className="pd-side-body">
      <div className="pd-tabs" role="tablist" aria-label="侧栏内容">
        {(['sessions', 'bots'] as const).map((id) => <button key={id} type="button" role="tab" id={`side-tab-${id}`} aria-selected={tab === id} aria-controls={`side-panel-${id}`} onClick={() => setTab(id)}>{id === 'sessions' ? '会话' : '机器人'}</button>)}
      </div>
      <label className="pd-search"><SearchIcon /><span className="sr-only">搜索会话和 Bot</span>
        <input type="search" placeholder={tab === 'sessions' ? '搜索会话…' : '搜索 Bot…'} value={query} onChange={(e) => setQuery(e.target.value)} /></label>

      <div id="side-panel-sessions" role="tabpanel" aria-labelledby="side-tab-sessions" hidden={tab !== 'sessions'} className="pd-side-list">
        {chief && !query.trim() && <div className="pd-row-wrap"><button type="button" className="pd-session" aria-current={view === 'home' ? 'page' : undefined} onClick={act(props.onHome)}>
          <BotAvatar name={chief.name} look={loadLook('chief')} size={20} />
          <span className="pd-session-text"><span className="pd-session-title">{chief.name}</span><span className="pd-session-meta">主会话 · 派活和验收</span></span>
        </button></div>}
        {sections.length === 0 && <p className="pd-side-empty">{query.trim() ? '没有匹配的会话' : '还没有其他会话'}</p>}
        {sections.map((section) => <section key={section.id} className="pd-side-section" aria-label={section.label}>
          <h2 className={section.id === 'pinned' || section.id === 'confirm' ? 'pd-side-heading is-strong' : 'pd-side-heading'}>{section.id === 'pinned' && <PinIcon size={12} />}{section.label}</h2>
          <ul>{section.items.map((item) => <li key={item.id} className="pd-row-wrap">
            <button type="button" className="pd-session" aria-current={view === 'chats' && selectedId === item.id ? 'page' : undefined} onClick={act(() => props.onOpenSession(item.id, item.owner))}>
              {item.group ? <span className="pd-group-mark" aria-hidden="true"><GroupIcon size={14} /></span> : <BotAvatar name={item.botName} look={loadLook(item.botId)} size={20} />}
              <span className="pd-session-text"><span className="pd-session-title">{item.title}</span><span className="pd-session-meta">{item.group ? '群聊' : item.botName}{item.note ? ` · ${item.note}` : ''}</span></span>
              <span className="pd-session-time">{relativeTime(item.at, now)}</span>
            </button>
            <button type="button" className={`pd-pin${pins.includes(item.id) ? ' is-pinned' : ''}`} aria-pressed={pins.includes(item.id)} aria-label={`${pins.includes(item.id) ? '取消置顶' : '置顶'}：${item.title}`} title={pins.includes(item.id) ? '取消置顶' : '置顶'} onClick={() => pin(item.id)}><PinIcon size={13} filled={pins.includes(item.id)} /></button>
          </li>)}</ul>
        </section>)}
      </div>

      <div id="side-panel-bots" role="tabpanel" aria-labelledby="side-tab-bots" hidden={tab !== 'bots'} className="pd-side-list">
        <ul>{shownBots.map((bot) => <li key={bot.id} className="pd-row-wrap">
          <button type="button" className="pd-session" aria-current={(bot.id === 'chief' ? view === 'home' : view === 'chats' && bot.mainTaskId !== null && selectedId === bot.mainTaskId) ? 'page' : undefined} onClick={act(() => props.onOpenBot(bot))}>
            <BotAvatar name={bot.name} look={loadLook(bot.id)} size={20} />
            <span className="pd-session-text"><span className="pd-session-title">{bot.name}</span><span className="pd-session-meta">{bot.inactive ? '已停用 · 只读' : bot.mainTaskId !== null ? '主会话' : '打开设置'}</span></span>
          </button>
          <button type="button" className={`pd-pin pd-bot-settings${botPage === bot.id ? ' is-pinned' : ''}`} aria-current={botPage === bot.id ? 'page' : undefined} aria-label={`${bot.name} 的设置`} title="Bot 设置" onClick={act(() => props.onBotSettings(bot.id))}><GearIcon size={13} /></button>
        </li>)}</ul>
        {shownBots.length === 0 && <p className="pd-side-empty">没有匹配的 Bot</p>}
        <button type="button" className="pd-nav-row pd-quiet" onClick={act(props.onNewBot)}><PlusIcon /><span>新建 Bot</span></button>
        <button type="button" className="pd-nav-row pd-quiet" aria-current={botPage === 'groups' ? 'page' : undefined} onClick={act(props.onNewGroup)}><GroupIcon /><span>新建群聊</span></button>
      </div>
    </div>

    <nav className="pd-side-foot" aria-label="工作区">
      {nav('items', '事项', <ItemsIcon />)}
      {nav('inbox', '通知', <BellIcon />, inboxCount)}
      {nav('settings', '设置', <GearIcon />)}
    </nav>
  </>
}
