import { useEffect, useState, type CSSProperties } from 'react'
import { useLook } from './botLook'
import { tintOf } from './bot-figure.mjs'
import { moodFrames, type Mood } from './bot-mood.mjs'
import { useMediaQuery } from './useDrawer'
import type { StatusTone } from './taskStatus'

const DONE_MS = 2000

/** The bot's kaomoji for a run state, tinted with its avatar color. Every frame sits in one grid
 *  cell, so swapping frames never shifts the layout; with reduced motion it stays on the first frame. */
export function MoodFace({ botId, mood }: { botId: string; mood: Mood }) {
  const frames = moodFrames(mood)
  const still = useMediaQuery('(prefers-reduced-motion: reduce)')
  const color = useLook(botId).color
  const [step, setStep] = useState({ mood, index: 0 })
  const index = step.mood === mood ? step.index % frames.length : 0
  useEffect(() => {
    if (still || frames.length < 2) return
    const timer = setTimeout(() => setStep({ mood, index: (index + 1) % frames.length }), frames[index][1])
    return () => clearTimeout(timer)
  }, [still, frames, index, mood])
  return <span className={`mood-face mood-${mood}`} style={{ '--bot': tintOf(color) } as CSSProperties} aria-hidden="true">
    {frames.map(([face], i) => <span key={i} className={i === index ? 'is-on' : undefined}>{face}</span>)}
  </span>
}

/** The chat header pill: face plus status words. A reply that just finished smiles for two seconds. */
export function ChatStatus({ taskId, botId, label, tone, mood }: { taskId: number; botId: string; label: string; tone: StatusTone; mood: Mood }) {
  const color = useLook(botId).color
  const [seen, setSeen] = useState({ taskId, mood })
  const [done, setDone] = useState(false)
  if (seen.taskId !== taskId || seen.mood !== mood) {
    setSeen({ taskId, mood })
    setDone(seen.taskId === taskId && (seen.mood === 'thinking' || seen.mood === 'working') && mood === 'idle')
  }
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(false), DONE_MS)
    return () => clearTimeout(timer)
  }, [done])
  const happy = done && mood === 'idle'
  return <span className={`status-badge chat-status tone-${tone}`} style={{ '--bot': tintOf(color) } as CSSProperties} role="status">
    <MoodFace botId={botId} mood={happy ? 'done' : mood} /><span className="chat-status-label">{happy ? '回复好了' : label}</span>
  </span>
}
