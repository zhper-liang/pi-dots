import { useState } from 'react'
import BotAvatar from './BotAvatar'
import { loadLook } from './botLook'
import { directoryBots } from './bot-directory.mjs'
import { PlusIcon, SearchIcon } from './Icons'

type Bot = { id: string; name: string; description: string; status?: 'active' | 'inactive' }
export default function BotDirectory({ bots, loading, onOpen, onCreate }: { bots: Bot[]; loading: boolean; onOpen: (id: string) => void; onCreate: () => void }) {
  const [query, setQuery] = useState('')
  const shown = directoryBots(bots, query)
  return <section className="bot-page bot-directory" aria-labelledby="bot-directory-title">
    <header className="bot-directory-head"><div><h1 id="bot-directory-title">机器人</h1><p className="shell-muted">选择一个 Bot 对话，或管理它的规则、能力与任务。</p></div><button type="button" className="primary" onClick={onCreate}><PlusIcon size={16} />新建 Bot</button></header>
    <label className="pd-search bot-directory-search"><SearchIcon /><span className="sr-only">搜索机器人</span><input type="search" placeholder="搜索名称或职责…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {loading && bots.length === 0 ? <p role="status">正在读取机器人…</p> : shown.length === 0 ? <p role="status" className="shell-muted">{query.trim() ? '没有匹配的机器人。' : '还没有机器人。点击「新建 Bot」开始。'}</p> : <ul className="bot-directory-grid">{shown.map(bot => <li key={bot.id}><button type="button" className="bot-directory-card" onClick={() => onOpen(bot.id)}>
      <BotAvatar name={bot.name} look={loadLook(bot.id)} size={48} /><span className="bot-directory-card-body"><strong>{bot.name}</strong><span className="bot-directory-state">{bot.status === 'inactive' ? '已停用 · 历史可查看' : bot.id === 'chief' ? '主管 · 派活与验收' : '可对话'}</span><span className="bot-directory-description">{bot.description}</span><span className="bot-directory-open">打开详情 →</span></span>
    </button></li>)}</ul>}
  </section>
}
