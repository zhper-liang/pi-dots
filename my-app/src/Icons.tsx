import type { ReactNode } from 'react'

// 16px line icons, drawn in currentColor. Decorative: the button or row carries the text label.
type Props = { size?: number }
const frame = (size: number, children: ReactNode) => <svg className="pd-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>

export const MenuIcon = ({ size = 16 }: Props) => frame(size, <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />)
export const PlusIcon = ({ size = 16 }: Props) => frame(size, <path d="M8 3v10M3 8h10" />)
export const SearchIcon = ({ size = 16 }: Props) => frame(size, <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>)
// `filled` marks the pinned state by shape, not only by color.
export const PinIcon = ({ size = 16, filled = false }: Props & { filled?: boolean }) => frame(size, <><path d="M6 2.5h4M7 2.5v4L4.5 9.5h7L9 6.5v-4" fill={filled ? 'currentColor' : 'none'} /><path d="M8 9.5V14" /></>)
export const GearIcon = ({ size = 16 }: Props) => frame(size, <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" /></>)
export const ItemsIcon = ({ size = 16 }: Props) => frame(size, <><rect x="2.5" y="3" width="11" height="10.5" rx="1.5" /><path d="M2.5 6.5h11M5.5 1.8v2.4M10.5 1.8v2.4" /></>)
export const BellIcon = ({ size = 16 }: Props) => frame(size, <><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z" /><path d="M6.6 14h2.8" /></>)
export const ChatIcon = ({ size = 16 }: Props) => frame(size, <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />)
export const GroupIcon = ({ size = 16 }: Props) => frame(size, <><circle cx="6" cy="6" r="2.2" /><path d="M2 13c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8" /><path d="M10.5 3.9a2.2 2.2 0 0 1 0 4.2M11.6 9.4c1.4.5 2.4 1.8 2.4 3.6" /></>)
export const SidebarIcon = ({ size = 16 }: Props) => frame(size, <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11" /></>)
export const CloseIcon = ({ size = 16 }: Props) => frame(size, <path d="M4 4l8 8M12 4l-8 8" />)
