// Bot avatars are client-side only (no backend field yet): stored in localStorage keyed by bot id.
export const avatarColors = ['#6b7cff', '#e8833a', '#2f9e6e', '#c2477d', '#8a63d2', '#2a8fbd', '#d4a017', '#5f6b7a', '#e05252', '#1f9d9a'] as const
export const avatarShapes = ['circle', 'square', 'squircle', 'hexagon', 'diamond', 'triangle', 'star', 'cloud'] as const
export type AvatarShape = typeof avatarShapes[number]
export type BotLook = { color: string; shape: AvatarShape; role?: string }
export const shapeLabels: Record<AvatarShape, string> = { circle: '圆形', square: '方形', squircle: '圆角方', hexagon: '六边形', diamond: '菱形', triangle: '三角', star: '星形', cloud: '云朵' }

const key = (botId: string) => `pidot.bot-look.${botId}`
function hash(text: string) { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h }
export function defaultLook(botId: string): BotLook {
  if (botId === 'chief') return { color: '#18181b', shape: 'star' }
  const h = hash(botId)
  return { color: avatarColors[h % avatarColors.length], shape: avatarShapes[(h >> 4) % avatarShapes.length] }
}
export function loadLook(botId: string): BotLook {
  try {
    const value = JSON.parse(localStorage.getItem(key(botId)) ?? 'null')
    if (value && typeof value.color === 'string' && avatarShapes.includes(value.shape)) return { color: value.color, shape: value.shape, role: typeof value.role === 'string' ? value.role : undefined }
  } catch { /* storage unavailable */ }
  return defaultLook(botId)
}
export function saveLook(botId: string, look: BotLook) {
  try { localStorage.setItem(key(botId), JSON.stringify(look)) } catch { /* storage unavailable: look is cosmetic */ }
}

