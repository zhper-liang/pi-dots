import { useState } from 'react'
import BotAvatar from './BotAvatar'
import { loadLook } from './botLook'
import { directoryBots } from './bot-directory.mjs'
import { GearIcon, PlusIcon, SearchIcon } from './Icons'

type Bot = { id: string; name: string; description: string; status?: 'active' | 'inactive' }
export default function BotDirectory({ bots, loading, onOpen, onSettings, onCreate }: { bots: Bot[]; loading: boolean; onOpen: (id: string) => void; onSettings: (id: string) => void; onCreate: () => void }) {
  const [query, setQuery] = useState('')
  const shown = directoryBots(bots, query)
  return <section className="bot-page bot-directory" aria-labelledby="bot-directory-title">
    <header className="bot-directory-head"><div><h1 id="bot-directory-title">机器人</h1><p className="shell-muted">点机器人开始对话，点齿轮改设置。</p></div><button type="button" className="primary" onClick={onCreate}><PlusIcon size={16} />新建机器人</button></header>
    <label className="pd-search bot-directory-search"><SearchIcon /><span className="sr-only">搜索机器人</span><input type="search" placeholder="搜索名称或职责…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {loading && bots.length === 0 ? <p role="status">正在读取机器人…</p> : shown.length === 0 ? <p role="status" className="shell-muted">{query.trim() ? '没有匹配的机器人。' : '还没有机器人，点「新建机器人」开始。'}</p> : <ul className="bot-directory-grid">{shown.map(bot => <li key={bot.id}><div className="bot-directory-card">
      <button type="button" className="bot-directory-chat" onClick={() => onOpen(bot.id)}>
        <BotAvatar name={bot.name} look={loadLook(bot.id)} size={48} /><span className="bot-directory-card-body"><strong>{bot.name}</strong>{(bot.status === 'inactive' || bot.id === 'chief') && <span className="bot-directory-state">{bot.status === 'inactive' ? '已停用' : '主管 · 派活与验收'}</span>}<span className="bot-directory-description">{bot.description}</span></span>
      </button>
      <button type="button" className="bot-directory-settings" aria-label={`${bot.name} 的设置`} title="机器人设置" onClick={() => onSettings(bot.id)}><GearIcon size={18} /></button>
    </div></li>)}</ul>}
  </section>
}
