import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import ScheduleWorkspace from './ScheduleWorkspace'
import BotRoutines from './BotRoutines'
import CalendarBoard from './CalendarBoard'
import SettingsPage from './SettingsPage'
import { AutomationBanner } from './AutomationControls'
import { MenuIcon } from './Icons'
import { useDrawer, useMediaQuery } from './useDrawer'
import { workspaceViews, itemTabs, nextItemTab, resolveItemTab, isLegacyTodoHash } from './workspace-navigation.mjs'
import type { ItemTab, WorkspaceView } from './workspace-navigation.mjs'

type Props = {
  bots: { id: string; name: string; status?: string; active?: boolean }[]; onOpenTask: (taskId: number, botId: string) => void
  token: string; view: WorkspaceView; itemTab: ItemTab; onItemTab: (tab: ItemTab) => void; onView: (view: WorkspaceView) => void
  sidebar: (shell: { collapsed: boolean; onToggleCollapsed: () => void; onClose: () => void }) => ReactNode
  title: string; home: ReactNode; inboxSummary?: ReactNode; footer?: ReactNode; children: ReactNode
}

/**
 * App shell: left column, optional mobile top bar, and the main column. Every panel stays mounted
 * (hidden attribute) so switching views never erases a draft or an unconfirmed request.
 */
export default function UnifiedWorkspace({ bots, onOpenTask, token, view, itemTab, onItemTab, onView, sidebar, title, home, inboxSummary, footer, children }: Props) {
  const restoreLegacyTodo = useEffectEvent(() => {
    const legacy = isLegacyTodoHash(window.location.hash)
    if (legacy) { onItemTab('calendar'); onView('items') }
  })
  useEffect(() => {
    restoreLegacyTodo()
    window.addEventListener('hashchange', restoreLegacyTodo)
    return () => window.removeEventListener('hashchange', restoreLegacyTodo)
  }, [])
  const visibleItemTab = resolveItemTab(itemTab)
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const onChanged = () => setRefreshKey(value => value + 1)
  const routineChoices = bots.map(bot => ({ id: bot.id, name: bot.name, status: bot.status === 'inactive' ? 'inactive' as const : 'active' as const }))
  const tabRefs = useRef<Partial<Record<ItemTab, HTMLButtonElement | null>>>({})
  const sidebarRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  // Below 720px (shell.css) the sidebar is a drawer over the page; widening the window closes it.
  const phone = useMediaQuery('(max-width: 719px)')
  const [wasPhone, setWasPhone] = useState(phone)
  if (wasPhone !== phone) { setWasPhone(phone); if (!phone) setDrawerOpen(false) }
  const drawer = phone && drawerOpen
  useDrawer(sidebarRef, { open: drawer, modal: true, onClose: () => setDrawerOpen(false), initialFocus: '[aria-current="page"]', returnFocus: menuRef })
  function onTabKey(event: ReactKeyboardEvent) {
    const next = nextItemTab(visibleItemTab, event.key)
    if (next === visibleItemTab) return
    event.preventDefault(); onItemTab(next); tabRefs.current[next]?.focus()
  }
  const page = workspaceViews.find((item) => item.id === view)!
  const showHeader = ['items', 'inbox', 'settings'].includes(view)

  // On a phone the closed drawer is inert (off-screen, out of the Tab order) and the open one makes the page inert.
  return <div className={`shell ${collapsed ? 'shell-collapsed' : ''} ${drawer ? 'shell-drawer-open' : ''}`}>
    {drawer && <div className="shell-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
    <aside ref={sidebarRef} id="shell-sidebar" className="shell-sidebar" aria-label="主导航" role={phone ? 'dialog' : undefined} aria-modal={phone ? true : undefined} inert={phone && !drawer}>
      {sidebar({ collapsed, onToggleCollapsed: () => setCollapsed((value) => !value), onClose: () => setDrawerOpen(false) })}
    </aside>
    <div className="shell-main" inert={drawer}>
      <header className="pd-topbar">
        <button ref={menuRef} type="button" className="shell-icon-button" aria-label="打开导航" aria-expanded={drawer} aria-controls="shell-sidebar" onClick={() => setDrawerOpen(true)}><MenuIcon /></button>
        <span className="pd-topbar-title">{title}</span>
      </header>
      <AutomationBanner token={token} onOpenSettings={() => onView('settings')} />
      {showHeader && <header className="shell-page-header"><h1>{page.label}</h1><p>{page.description}</p></header>}
      <div id="workspace-active-panel" aria-live="polite">
        <section id="workspace-panel-home" hidden={view !== 'home'} className="shell-chat-page">{home}</section>
        <section id="workspace-panel-items" hidden={view !== 'items'} className="pd-items">
          <div className="pd-subtabs" role="tablist" aria-label="事项">
            {itemTabs.map((tab) => <button key={tab.id} ref={(el) => { tabRefs.current[tab.id] = el }} type="button" role="tab" id={`items-tab-${tab.id}`} aria-selected={visibleItemTab === tab.id} aria-controls={`items-panel-${tab.id}`} tabIndex={visibleItemTab === tab.id ? 0 : -1} onKeyDown={onTabKey} onClick={() => onItemTab(tab.id)}>{tab.label}</button>)}
          </div>
          <div id="items-panel-calendar" role="tabpanel" aria-labelledby="items-tab-calendar" hidden={visibleItemTab !== 'calendar'} className="workspace-page"><CalendarBoard token={token} refreshKey={refreshKey} onChanged={onChanged} initialMode="day" active={view === 'items' && visibleItemTab === 'calendar'} /></div>
          <div id="items-panel-routines" role="tabpanel" aria-labelledby="items-tab-routines" hidden={visibleItemTab !== 'routines'} className="workspace-page">
            <BotRoutines bots={routineChoices} refreshKey={refreshKey} onChanged={onChanged} token={token} onOpenTask={onOpenTask} />
            <details className="tech-info"><summary>高级：全部计划</summary><ScheduleWorkspace token={token} view="schedules" /></details>
          </div>
          <div id="items-panel-runs" role="tabpanel" aria-labelledby="items-tab-runs" hidden={visibleItemTab !== 'runs'} className="workspace-page"><ScheduleWorkspace token={token} view="runs" /></div>
        </section>
        <section id="workspace-panel-inbox" hidden={view !== 'inbox'} className="workspace-page">
          {inboxSummary}
        </section>
        <section id="workspace-panel-settings" hidden={view !== 'settings'} className="workspace-page"><SettingsPage token={token} footer={footer} /></section>
        <section id="workspace-panel-chats" hidden={view !== 'chats'} className="shell-chat-page">{children}</section>
      </div>
    </div>
  </div>
}
