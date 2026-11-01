import { useSyncExternalStore } from 'react'

// Bot avatars are client-side only (no backend field yet): stored in localStorage keyed by bot id.
// Every bot is the same TV robot; a look is its body color plus an optional eye accessory.
export const avatarColors = ['#6b7cff', '#e8833a', '#2f9e6e', '#c2477d', '#8a63d2', '#2a8fbd', '#d4a017', '#5f6b7a', '#e05252', '#1f9d9a'] as const
export const PIPI_COLOR = '#22252e'
/** The look picker also offers pipi's black; defaults for other bots hash over avatarColors only. */
export const lookColors = [PIPI_COLOR, ...avatarColors] as const
export const accessories = ['none', 'pq', 'round'] as const
export type Accessory = typeof accessories[number]
export type BotLook = { color: string; accessory: Accessory; role?: string }
export const accessoryLabels: Record<Accessory, string> = { none: '无配饰', pq: 'pq 眼镜', round: '圆框眼镜' }

const key = (botId: string) => `pidot.bot-look.${botId}`
function hash(text: string) { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h }
export function defaultLook(botId: string): BotLook {
  if (botId === 'chief') return { color: PIPI_COLOR, accessory: 'pq' }
  const h = hash(botId)
  return { color: avatarColors[h % avatarColors.length], accessory: accessories[(h >>> 4) % accessories.length] }
}
export function loadLook(botId: string): BotLook { return lookFrom(botId, storedLook(botId)) }
/** A look from its stored text (null when nothing is saved). */
function lookFrom(botId: string, raw: string | null): BotLook {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value && typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color)) {
      const role = typeof value.role === 'string' ? value.role : undefined
      if (accessories.includes(value.accessory)) return { color: value.color, accessory: value.accessory, role }
      // A look saved before the TV robot had a shape instead of an accessory. Keep its color, except
      // pipi's: its old default blue becomes the new black.
      const fallback = defaultLook(botId)
      return { color: botId === 'chief' ? fallback.color : value.color, accessory: fallback.accessory, role }
    }
  } catch { /* malformed: fall back to the default */ }
  return defaultLook(botId)
}
/** Fired after a look is saved so every robot on screen redraws (useLook). */
export const LOOK_EVENT = 'pidot-look'
export function saveLook(botId: string, look: BotLook) {
  try { localStorage.setItem(key(botId), JSON.stringify(look)) } catch { /* storage unavailable: look is cosmetic */ }
  window.dispatchEvent(new Event(LOOK_EVENT))
}
function storedLook(botId: string) {
  try { return localStorage.getItem(key(botId)) } catch { return null }
}
function subscribe(onChange: () => void) {
  window.addEventListener(LOOK_EVENT, onChange); window.addEventListener('storage', onChange)
  return () => { window.removeEventListener(LOOK_EVENT, onChange); window.removeEventListener('storage', onChange) }
}
/** A bot's saved look that updates as soon as it is changed here or in another tab. */
export function useLook(botId: string): BotLook {
  return lookFrom(botId, useSyncExternalStore(subscribe, () => storedLook(botId)))
}
