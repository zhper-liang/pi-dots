import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import { FOCUSABLE, closesOnKey, drawerStack, trapTarget } from './drawer.mjs'

/** Tracks a CSS media query, so React state matches the breakpoint the stylesheet uses. */
export function useMediaQuery(query: string) {
  const subscribe = useCallback((notify: () => void) => {
    const list = window.matchMedia(query)
    list.addEventListener('change', notify)
    return () => list.removeEventListener('change', notify)
  }, [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

const stack = drawerStack()
// A closed <details>, a hidden tab panel or an off-screen display:none parent leaves no box.
const shown = (el: Element) => el.getClientRects().length > 0
const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown)

type Options = {
  open: boolean
  /** Overlaying the page (narrow screens): focus moves in, Tab stays inside, focus returns on close. */
  modal: boolean
  onClose: () => void
  /** Selector for the element to focus on open; the first match that is visible wins. */
  initialFocus?: string
  /** Where focus goes on close. Needed when opening makes the trigger inert, which drops its focus. */
  returnFocus?: RefObject<HTMLElement | null>
}

/**
 * Escape closes the drawer. While modal it also takes focus on open, keeps Tab inside, and on close
 * hands focus back to whatever opened it. With two drawers open only the newest answers.
 */
export function useDrawer(root: RefObject<HTMLElement | null>, { open, modal, onClose, initialFocus, returnFocus }: Options) {
  const id = useId()
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })

  // Remember the opener and listen for Escape for as long as the drawer is open.
  useEffect(() => {
    if (!open) return
    const el = root.current
    const focused = document.activeElement
    const opener = returnFocus?.current ?? (focused instanceof HTMLElement && focused !== document.body ? focused : null)
    stack.open(id)
    const onKey = (event: KeyboardEvent) => {
      if (!stack.isTop(id) || !closesOnKey(event)) return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      stack.close(id)
      // Hand focus back only if it was inside the drawer or got dropped when the drawer hid.
      const active = document.activeElement
      const dropped = !active || active === document.body || Boolean(el?.contains(active))
      if (dropped && opener?.isConnected && shown(opener)) opener.focus({ preventScroll: true })
    }
  }, [open, id, root, returnFocus])

  // As an overlay: focus the drawer, then wrap Tab at its edges.
  useEffect(() => {
    const el = root.current
    if (!open || !modal || !el) return
    if (!el.contains(document.activeElement)) {
      const preferred = initialFocus ? [...el.querySelectorAll<HTMLElement>(initialFocus)].find(shown) : undefined
      ;(preferred ?? focusables(el)[0] ?? el).focus({ preventScroll: true })
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !stack.isTop(id)) return
      const items = focusables(el)
      const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey)
      if (target === null) return
      event.preventDefault()
      ;(target === 'root' ? el : items[target]).focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, modal, id, root, initialFocus])
}
