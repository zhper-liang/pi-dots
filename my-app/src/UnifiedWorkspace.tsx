import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import LocalWorkspace from './LocalWorkspace'
import ScheduleWorkspace from './ScheduleWorkspace'
import ReminderWorkspace from './ReminderWorkspace'
import CalendarBoard from './CalendarBoard'
import SettingsPage from './SettingsPage'
import { AutomationBanner } from './AutomationControls'
import { workspaceViews } from './workspace-navigation.mjs'
import type { WorkspaceView } from './workspace-navigation.mjs'

const icons: Partial<Record<WorkspaceView, string>> = { today: '☀', calendar: '▦', todos: '☑', inbox: '✉', automation: '⏱' }
const links = workspaceViews.filter(item => item.id in icons)
const settings = workspaceViews.find(item => item.id === 'settings')!

type Props = {
  token: string; view: WorkspaceView; onView: (view: WorkspaceView) => void
  chief: ReactNode; sidebar: ReactNode; footer?: ReactNode
  today: ReactNode; inboxSummary?: ReactNode; inboxCount?: number; children: ReactNode
}

export default function UnifiedWorkspace({ token, view, onView, chief, sidebar, footer, today, inboxSummary, inboxCount = 0, children }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [automation, setAutomation] = useState<'schedules' | 'runs'>('schedules')
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])
  function go(next: WorkspaceView) { onView(next); setDrawerOpen(false) }
  const current = workspaceViews.find(item => item.id === view)!
  const showHeader = !['chats', 'today'].includes(view)

  return <div className={`shell ${collapsed ? 'shell-collapsed' : ''} ${drawerOpen ? 'shell-drawer-open' : ''}`}>
    <button type="button" className="shell-mobile-toggle" aria-label="打开导航" aria-expanded={drawerOpen} aria-controls="shell-sidebar" onClick={() => setDrawerOpen(true)}>☰</button>
    {drawerOpen && <div className="shell-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
    <aside id="shell-sidebar" className="shell-sidebar" aria-label="主导航">
      <div className="shell-sidebar-top">
        <button type="button" className="shell-brand" aria-label="Pidot 今天" onClick={() => go('today')}><span className="shell-brand-mark">p</span><span className="shell-label">pidot</span></button>
        <button type="button" className="shell-icon-button shell-collapse" aria-label={collapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!collapsed} aria-controls="shell-sidebar" onClick={() => setCollapsed(value => !value)}>{collapsed ? '»' : '«'}</button>
        <button type="button" className="shell-icon-button shell-close" aria-label="关闭导航" onClick={() => setDrawerOpen(false)}>×</button>
      </div>
      {/* Any button inside the chat-related areas opens the chat view and closes the mobile drawer. */}
      <div className="shell-chief" onClick={event => { if ((event.target as HTMLElement).closest('button')) go('chats') }}>{chief}</div>
      <nav className="shell-nav" aria-label="工作区">
        <ul>{links.map(item => <li key={item.id}><button type="button" id={`workspace-tab-${item.id}`} aria-current={view === item.id ? 'page' : undefined} aria-label={item.id === 'inbox' && inboxCount ? `${item.label}，${inboxCount} 项待确认` : item.label} title={item.label} onClick={() => go(item.id)}><span className="shell-nav-icon" aria-hidden="true">{icons[item.id]}</span><span className="shell-label">{item.label}</span>{item.id === 'inbox' && inboxCount > 0 && <span className="shell-count" aria-hidden="true">{inboxCount}</span>}</button></li>)}</ul>
      </nav>
      <div className="shell-conversations" onClick={event => { const target = event.target as HTMLElement; if (target.closest('button') && !target.closest('[data-stay]')) go('chats') }}>{sidebar}</div>
      <div className="shell-sidebar-footer">
        <button type="button" className="shell-settings" id="workspace-tab-settings" aria-current={view === 'settings' ? 'page' : undefined} aria-label={settings.label} onClick={() => go('settings')}><span aria-hidden="true">⚙</span><span className="shell-label">{settings.label}</span></button>
      </div>
    </aside>
    <div className="shell-main">
      <AutomationBanner token={token} onOpenSettings={() => go('settings')} />
      {showHeader && <header className="shell-page-header"><h1>{current.label}</h1><p>{current.description}</p></header>}
      {/* Panels stay mounted (hidden attr): switching views must not erase an unknown request or a draft. */}
      <div id="workspace-active-panel" aria-live="polite">
        {/* Home holds the Chief conversation (P-13), so it takes the chat page styles, not the workspace page ones. */}
        <section id="workspace-panel-today" hidden={view !== 'today'} className="shell-chat-page">{today}</section>
        <section id="workspace-panel-calendar" hidden={view !== 'calendar'} className="workspace-page"><CalendarBoard token={token} /></section>
        <section id="workspace-panel-todos" hidden={view !== 'todos'} className="workspace-page"><LocalWorkspace token={token} view="todos" /></section>
        <section id="workspace-panel-inbox" hidden={view !== 'inbox'} className="workspace-page">
          {inboxSummary}
          <h2 className="inbox-heading">通知与提醒</h2>
          <ReminderWorkspace token={token} />
          <details className="shell-more"><summary>关于通知状态</summary><p>“已记录/已读”只代表应用收件箱状态，不代表你已在其他渠道收到。</p></details>
        </section>
        <section id="workspace-panel-automation" hidden={view !== 'automation'} className="workspace-page">
          <div className="shell-filter" role="group" aria-label="自动化视图">
            <button type="button" aria-pressed={automation === 'schedules'} onClick={() => setAutomation('schedules')}>定时任务</button>
            <button type="button" aria-pressed={automation === 'runs'} onClick={() => setAutomation('runs')}>执行记录</button>
          </div>
          <ScheduleWorkspace token={token} view={automation} />
        </section>
        <section id="workspace-panel-settings" hidden={view !== 'settings'} className="workspace-page"><SettingsPage token={token} footer={footer} /></section>
        <section id="workspace-panel-chats" hidden={view !== 'chats'} className="shell-chat-page">{children}</section>
      </div>
    </div>
  </div>
}
