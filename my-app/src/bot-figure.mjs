// The TV robot every bot is drawn as. Pure color and state logic, kept apart from the SVG so it
// can be tested directly. Body colors are user data (the look picker), not theme tokens.

export function mix(hex, target, amount) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(target.slice(1), 16)
  const channel = shift => Math.round(((a >> shift) & 255) * (1 - amount) + ((b >> shift) & 255) * amount)
  return '#' + [16, 8, 0].map(shift => channel(shift).toString(16).padStart(2, '0')).join('')
}

export function luma(hex) {
  const n = parseInt(hex.slice(1), 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

const DARK_LUMA = 0.2
const SCREEN_BASE = '#11141c'

/** Shades derived from one body color. A near-black body (pipi) takes the app accent for its
 *  knobs and antenna tips (accent: null means "use the theme accent"), and a navy screen. */
export function figureColors(color) {
  const dark = luma(color) < DARK_LUMA
  return {
    dark,
    light: mix(color, '#ffffff', dark ? 0.14 : 0.22),
    deep: mix(color, '#000000', dark ? 0.3 : 0.16),
    rod: dark ? '#5b6170' : mix(color, '#000000', 0.35),
    screen: dark ? mix('#4f7bff', SCREEN_BASE, 0.75) : mix(color, SCREEN_BASE, 0.7),
    accent: dark ? null : mix(color, '#ffffff', 0.55),
  }
}

/** Kaomoji tint: a near-black body would vanish in dark mode, so it borrows the accent. */
export function tintOf(color) {
  return luma(color) < DARK_LUMA ? 'var(--c-accent)' : color
}

const FIGURE = new Set(['idle', 'greet', 'thinking', 'working', 'waiting', 'done', 'error', 'resting'])
/** The figure's motion for a run state. Hitting the call limit looks like an error. */
export function figureMood(mood) {
  if (mood === 'limited') return 'error'
  return FIGURE.has(mood) ? mood : 'idle'
}

const SIDEBAR = new Set(['thinking', 'working', 'waiting', 'error', 'limited', 'resting'])
/** Sidebar robots move only when the session is worth a glance (busy, waiting for you, stuck) or
 *  sleep when it is off. Everything else stands still so a long list stays calm. */
export function sidebarFigure(mood) {
  return SIDEBAR.has(mood) ? figureMood(mood) : undefined
}
