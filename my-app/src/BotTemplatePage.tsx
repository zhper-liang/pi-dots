import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import BotAvatar from './BotAvatar'
import { accessories, accessoryLabels, lookColors, loadLook, saveLook, type BotLook } from './botLook'
import BotConfiguration from './BotConfiguration'
import BotMemory from './BotMemory'
import { resolveMemorySourceHash } from './memory-helpers.mjs'
import type { MemoryApi, MemorySource, MemorySourceHandler } from './memory-types'
import BotCapabilities from './BotCapabilities'
import FeishuCalendarPanel from './FeishuCalendarPanel'
import { botTabs, type BotTab } from './bot-directory.mjs'
import { nextTab } from './workspace-navigation.mjs'

type Bot = { status?: 'active' | 'inactive'; id: string; name: string; description: string; configRef: { botId: string; version: string } }
type Props = {
  bot: Bot; token: string; tab: Exclude<BotTab, 'chat'>; mainTaskId: number | null
  onTab: (tab: BotTab) => void; onChat: () => void
  onSaved: (bot: Bot) => void; onDeactivate: () => void
  active?: boolean; refreshKey?: number
  memoryApi?: MemoryApi; onOpenPreferences?: () => void; onOpenMemorySource?: MemorySourceHandler
}

export default function BotTemplatePage({ bot, token, tab, mainTaskId, onTab, onChat, onSaved, onDeactivate, active = true, memoryApi, onOpenPreferences, onOpenMemorySource }: Props) {
  const [look, setLook] = useState<BotLook>(() => loadLook(bot.id))
  const [sourceNotice, setSourceNotice] = useState('')
  const sourceRequest = useRef<AbortController | null>(null)
  useEffect(() => () => { sourceRequest.current?.abort() }, [bot.id, token])
  const tabRefs = useRef<Partial<Record<BotTab, HTMLButtonElement | null>>>({})
  const inactive = bot.status === 'inactive'
  const chief = bot.id === 'chief'
  function updateLook(next: BotLook) { setLook(next); saveLook(bot.id, next) }
  async function openMemorySource(source: MemorySource) {
    if (sourceRequest.current) return
    const controller = new AbortController()
    sourceRequest.current = controller
    setSourceNotice('正在打开原对话…')
    try {
      const hash = await resolveMemorySourceHash(token, source, controller.signal)
      if (controller.signal.aborted) return
      window.location.hash = hash
      setSourceNotice('')
    } catch {
      if (!controller.signal.aborted) setSourceNotice('打不开原对话，可能已删除。')
    } finally {
      if (sourceRequest.current === controller) sourceRequest.current = null
    }
  }

  function onTabKey(event: KeyboardEvent) {
    const next = nextTab(botTabs.map(item => item.id), tab, event.key)
    if (next === tab) return
    event.preventDefault(); onTab(next); tabRefs.current[next]?.focus()
  }
  const panelProps = (id: Exclude<BotTab, 'chat'>) => ({ id: `bot-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `bot-tab-${id}`, hidden: tab !== id, tabIndex: 0, className: 'bot-tab-panel' })
  return <div className="bot-page bot-detail-page">
    <nav className="bot-detail-nav" aria-label="机器人导航"><button type="button" className="text-button" onClick={onChat}>← 回到对话</button></nav>
    <header className="bot-detail-head"><BotAvatar look={look} size={56} mood="idle" /><div><h1>{bot.name}</h1><p className="shell-muted">{look.role ?? (chief ? '主管 · 负责分派与验收' : '机器人')}{inactive ? ' · 已停用' : ''}</p></div></header>
    {inactive && <p role="status" className="shell-note">这个机器人已停用，只能查看。</p>}
    <div className="bot-detail-tabs" role="tablist" aria-label="机器人设置">{botTabs.map(item => <button key={item.id} ref={el => { tabRefs.current[item.id] = el }} type="button" role="tab" id={`bot-tab-${item.id}`} aria-controls={`bot-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => onTab(item.id)} onKeyDown={onTabKey}>{item.label}</button>)}</div>
    <div {...panelProps('capabilities')}><BotCapabilities key={`capabilities:${bot.id}:${token}`} token={token} botId={bot.id} readOnly={inactive} active={active && tab === 'capabilities'} /></div>
    <div {...panelProps('memory')}><BotMemory botId={bot.id} token={token} active={tab === 'memory'} readOnly={inactive} api={memoryApi} onOpenPreferences={onOpenPreferences} onOpenSource={onOpenMemorySource ?? (source => { void openMemorySource(source) })} />{sourceNotice && <p role="status" className="memory-hint">{sourceNotice}</p>}</div>
    <div {...panelProps('settings')}>
      <section className="bot-edit-section" aria-label="外观">
        <h2>外观</h2>
        <ul className="pd-rows">
          <li className="pd-row"><span className="pd-row-title">颜色</span>
            <fieldset className="bot-picker" disabled={inactive}><legend className="sr-only">颜色</legend>
              {lookColors.map((c, i) => <label key={c} className="swatch" style={{ background: c }}><input type="radio" name={`look-color-${bot.id}`} checked={look.color === c} onChange={() => updateLook({ ...look, color: c })} aria-label={i === 0 ? '黑色' : `颜色 ${i}`} /></label>)}
            </fieldset></li>
          <li className="pd-row"><span className="pd-row-title">配饰</span>
            <fieldset className="bot-picker" disabled={inactive}><legend className="sr-only">配饰</legend>
              {accessories.map(a => <label key={a} className="shape-option accessory-option" title={accessoryLabels[a]}><input type="radio" name={`look-accessory-${bot.id}`} checked={look.accessory === a} onChange={() => updateLook({ ...look, accessory: a })} aria-label={accessoryLabels[a]} /><BotAvatar look={{ ...look, accessory: a }} size={36} /></label>)}
            </fieldset></li>
          <li className="pd-row"><label className="pd-row-title" htmlFor={`look-role-${bot.id}`}>显示标签</label>
            <input id={`look-role-${bot.id}`} className="pd-input" maxLength={40} placeholder="仅用于展示，例如：日程管家" value={look.role ?? ''} disabled={inactive} onChange={e => updateLook({ ...look, role: e.target.value || undefined })} /></li>
        </ul>
      </section>
      <BotConfiguration key={`config:${bot.id}:${token}`} botId={bot.id} token={token} readOnly={inactive} active={active && tab === 'settings'} onSaved={onSaved} />
      {!chief && !inactive && <section className="bot-edit-section bot-danger" aria-label="停用机器人"><h2>停用机器人</h2><p>停用后不能再和它对话，记录都保留。</p><button type="button" onClick={() => {
        if (window.confirm(`停用 ${bot.name}？停用后不能再和它对话，正在做的事会尽量停下，记录都保留，暂时不能重新启用。`)) onDeactivate()
      }}>停用机器人</button></section>}
      <details className="tech-info"><summary>飞书日历</summary><FeishuCalendarPanel token={token} taskId={mainTaskId} /></details>
    </div>
  </div>
}
