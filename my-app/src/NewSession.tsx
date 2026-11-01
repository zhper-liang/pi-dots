import { useState } from 'react'
import type { FormEvent } from 'react'
import { BotFace } from './BotAvatar'
import { GroupIcon } from './Icons'

type Bot = { id: string; name: string; status?: string }

/** Empty new session: pick who does it, write the first message. Sending creates the session and sends it. */
export default function NewSession({ bots, busy, onStart, onGroup }: { bots: Bot[]; busy: boolean; onStart: (botId: string, text: string) => void; onGroup: () => void }) {
  const active = bots.filter((bot) => bot.status !== 'inactive')
  const [botId, setBotId] = useState('chief')
  const [text, setText] = useState('')
  const chosen = active.find((bot) => bot.id === botId) ?? active[0]
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!chosen || busy || !text.trim()) return
    onStart(chosen.id, text)
  }
  return <section className="pd-new-session" aria-labelledby="new-session-title">
    <BotFace id={chosen?.id ?? 'chief'} size={96} mood="greet" />
    <h1 id="new-session-title">有什么要做的？</h1>
    <p className="shell-muted">选一个机器人，写下第一句话。要几个一起做，就开群聊。</p>
    <form className="pd-new-form" onSubmit={submit}>
      <fieldset className="pd-chips"><legend className="sr-only">交给谁</legend>
        {active.map((bot) => <label key={bot.id} className={`pd-chip${chosen?.id === bot.id ? ' is-picked' : ''}`}>
          <input type="radio" name="new-session-bot" checked={chosen?.id === bot.id} onChange={() => setBotId(bot.id)} />
          <BotFace id={bot.id} size={22} />{bot.name}
        </label>)}
        <button type="button" className="pd-chip" onClick={onGroup}><GroupIcon size={14} />群聊</button>
      </fieldset>
      <div className="pd-composer-box">
        <label htmlFor="new-session-message" className="sr-only">第一条消息</label>
        <textarea id="new-session-message" rows={3} maxLength={4000} value={text} placeholder={chosen ? `给 ${chosen.name} 发消息…` : '没有可用的机器人'} disabled={busy || !chosen} onChange={(e) => setText(e.target.value)} />
        <div className="pd-composer-bar">
          <span className="pd-composer-hint">{text.length} / 4000</span>
          <button className="primary" disabled={busy || !chosen || !text.trim()}>{busy ? '正在开始…' : '开始'}</button>
        </div>
      </div>
    </form>
  </section>
}
