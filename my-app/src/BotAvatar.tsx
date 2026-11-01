import { useId, type CSSProperties } from 'react'
import { useLook, type Accessory, type BotLook } from './botLook'
import { figureColors, type FigureMood } from './bot-figure.mjs'
import './bot-figure.css'

// Glasses sit on the screen in white, centered on the eyes (35/55, 57); the eyes move behind them.
function Glasses({ kind }: { kind: Accessory }) {
  if (kind === 'none') return null
  return <g className="tv-glasses" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="35" cy="57" r="9" /><circle cx="55" cy="57" r="9" /><path d="M44 55.5 Q45 54.5 46 55.5" />
    {kind === 'pq' ? <><path d="M26 57 V71" /><path d="M64 57 V71" /></> : <><path d="M26 57 L22 54" /><path d="M64 57 L68 54" /></>}
  </g>
}

/** Every bot is the same TV robot in its own color: rabbit-ear rods, a screen face, two knobs.
 *  Without a mood it stands still; a mood plays that state's motion (stopped by reduced motion). */
export default function BotAvatar({ look, size = 28, mood }: { look: BotLook; size?: number; mood?: FigureMood }) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const c = figureColors(look.color), compact = size <= 44
  const rod = compact ? 3.4 : 2.4, ball = compact ? 4.4 : 3.6
  const style = { '--tv-accent': c.accent ?? 'var(--c-accent)', '--tv-delay': `-${[...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 9}s` } as CSSProperties
  return <span className="bot-avatar" style={{ width: size, height: size }} aria-hidden="true">
    <svg className={`tv${c.dark ? ' is-dark' : ''}${look.accessory !== 'none' ? ' has-glasses' : ''}`} data-mood={mood} style={style} width={size} height={size} viewBox={compact ? '5 5 90 90' : '0 0 100 100'} focusable="false">
      <defs>
        <linearGradient id={`${id}-shell`} x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stopColor={c.light} /><stop offset="1" stopColor={c.deep} /></linearGradient>
        <clipPath id={`${id}-screen`}><rect x="21" y="39" width="48" height="40" rx="12" /></clipPath>
      </defs>
      <g className="tv-rig">
        {(['is-l', 'is-r'] as const).map(side => <g key={side} className={`tv-ant ${side}`}>
          <path d="M50 30 V9" stroke={c.rod} strokeWidth={rod} strokeLinecap="round" />
          <circle className="tv-accent tv-halo" cx="50" cy="8" r={ball + 3} /><circle className="tv-accent" cx="50" cy="8" r={ball} />
        </g>)}
        <circle cx="50" cy="33" r="7" fill={c.rod} />
        <circle cx="32" cy="89" r="4.5" fill={c.rod} /><circle cx="68" cy="89" r="4.5" fill={c.rod} />
        <rect className="tv-shell" x="14" y="32" width="72" height="56" rx="18" fill={`url(#${id}-shell)`} />
        <rect x="22" y="35.5" width="16" height="2.6" rx="1.3" fill="#fff" opacity=".2" />
        <rect x="21" y="39" width="48" height="40" rx="12" fill={c.screen} stroke="#000" strokeOpacity=".18" strokeWidth="2" />
        <g clipPath={`url(#${id}-screen)`}>
          <ellipse cx="30" cy="44" rx="9" ry="2.6" fill="#fff" opacity=".1" transform="rotate(-24 30 44)" />
          <rect className="tv-scan" x="27" y="42" width="36" height="2" fill="#fff" />
          <g className="tv-face">
            {mood === 'done' ? <g fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><path d="M29.5 60 Q35 51 40.5 60" /><path d="M49.5 60 Q55 51 60.5 60" /></g>
              : mood === 'resting' ? <g fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><path d="M29.5 56 Q35 62 40.5 56" /><path d="M49.5 56 Q55 62 60.5 56" /></g>
              : <g className="tv-eyes"><ellipse cx="35" cy="57" rx="4.6" ry="7.5" fill="#fff" /><ellipse cx="55" cy="57" rx="4.6" ry="7.5" fill="#fff" /></g>}
            <circle className="tv-mouth" cx="45" cy="70" r="2.8" fill="#fff" />
            {mood === 'error' && <path className="tv-tear" d="M57 65 q-2.2 3.3 0 5 q2.2 -1.7 0 -5z" fill="#bfe3ff" />}
          </g>
        </g>
        <Glasses kind={look.accessory} />
        <circle className="tv-accent" cx="77.5" cy="50" r="3.6" /><circle className="tv-accent" cx="77.5" cy="62" r="3.6" />
        {mood === 'resting' && <><text className="tv-accent tv-z" x="74" y="26" fontSize="11" fontWeight="700">z</text><text className="tv-accent tv-z" x="81" y="18" fontSize="8" fontWeight="700">z</text></>}
      </g>
    </svg>
  </span>
}

/** The bot's saved look, read here so callers render it by id (chat bubbles do not hold looks). */
export function BotFace({ id, size = 32, mood }: { id: string; size?: number; mood?: FigureMood }) {
  return <BotAvatar look={useLook(id)} size={size} mood={mood} />
}

/** A group chat's avatar: up to three members' robots stacked into one square. */
export function BotCrew({ ids, size = 40 }: { ids: string[]; size?: number }) {
  const shown = ids.slice(0, 3), small = Math.round(size * 0.56)
  return <span className={`bot-crew is-${shown.length}`} style={{ width: size, height: size }} aria-hidden="true">
    {shown.map(id => <BotFace key={id} id={id} size={small} />)}
  </span>
}
