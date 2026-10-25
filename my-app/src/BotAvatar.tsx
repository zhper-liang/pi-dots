import { type AvatarShape, type BotLook } from './botLook'

const paths: Record<AvatarShape, string> = {
  circle: 'M50 4a46 46 0 1 1 0 92a46 46 0 1 1 0-92z',
  square: 'M6 6h88v88H6z',
  squircle: 'M30 4h40c18 0 26 8 26 26v40c0 18-8 26-26 26H30C12 96 4 88 4 70V30C4 12 12 4 30 4z',
  hexagon: 'M50 3l41 23.5v47L50 97L9 73.5v-47z',
  diamond: 'M50 2l48 48l-48 48L2 50z',
  triangle: 'M50 6l46 84H4z',
  star: 'M50 3l13.5 29.5L96 36l-24 22l6.5 32L50 74L21.5 90L28 58L4 36l32.5-3.5z',
  cloud: 'M28 84a22 22 0 0 1-4-43.6A26 26 0 0 1 74 34a20 20 0 0 1 2 40v10z',
}

export function ShapeIcon({ shape, color, size = 20 }: { shape: AvatarShape; color: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d={paths[shape]} fill={color} /></svg>
}

export default function BotAvatar({ name, look, size = 28 }: { name: string; look: BotLook; size?: number }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  return <span className="bot-avatar" style={{ width: size, height: size }} aria-hidden="true">
    <svg width={size} height={size} viewBox="0 0 100 100" focusable="false"><path d={paths[look.shape]} fill={look.color} />
      <text x="50" y={look.shape === 'triangle' ? 70 : 54} textAnchor="middle" dominantBaseline="middle" fontSize={look.shape === 'triangle' ? 34 : 44} fontWeight="700" fill="#fff">{initial}</text></svg>
  </span>
}
