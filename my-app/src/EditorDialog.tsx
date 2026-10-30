import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './Icons'
import { FOCUSABLE, trapTarget } from './drawer.mjs'
import { useDrawer } from './useDrawer'
import './editor-controls.css'

export type EditorDialogProps = {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  description?: ReactNode
  footer?: ReactNode
  /** Only an actively in-flight request. Clear this on unknown so recovery actions remain usable. */
  pending?: boolean
  /** Locks the draft and submission, but not dismissal or type="button" recovery actions in footer. */
  disabled?: boolean
  error?: string
  initialFocus?: string
  returnFocus?: RefObject<HTMLElement | null>
}

let scrollLocks = 0
let restoreScroll: (() => void) | undefined
const backgroundLocks = new Map<HTMLElement, { count: number; inert: boolean }>()

function lockPage(layer: HTMLElement) {
  if (scrollLocks++ === 0) {
    const body = document.body, html = document.documentElement
    const overflow = body.style.overflow, padding = body.style.paddingRight, htmlOverflow = html.style.overflow
    const gutter = Math.max(0, window.innerWidth - html.clientWidth)
    if (gutter) body.style.paddingRight = `${parseFloat(getComputedStyle(body).paddingRight) + gutter}px`
    body.style.overflow = 'hidden'
    html.style.overflow = 'hidden'
    restoreScroll = () => { body.style.overflow = overflow; body.style.paddingRight = padding; html.style.overflow = htmlOverflow }
  }
  const siblings = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== layer)
  for (const node of siblings) {
    const lock = backgroundLocks.get(node) ?? { count: 0, inert: node.inert }
    lock.count++
    backgroundLocks.set(node, lock)
    node.inert = true
  }
  return () => {
    for (const node of siblings) {
      const lock = backgroundLocks.get(node)
      if (lock && --lock.count === 0) { node.inert = lock.inert; backgroundLocks.delete(node) }
    }
    if (--scrollLocks === 0) { restoreScroll?.(); restoreScroll = undefined }
  }
}

const available = (node: HTMLElement) => node.getClientRects().length > 0 && !node.matches(':disabled') && !node.closest('[inert], [hidden], [aria-hidden="true"]')
const controls = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(available)

/** A deliberately small shell: callers own the form, requestId, error and recovery lifecycle. */
export default function EditorDialog({ open, title, onClose, children, description, footer, pending = false, disabled = false, error, initialFocus, returnFocus }: EditorDialogProps) {
  const id = useId(), dialog = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null), backdropPressed = useRef(false)
  const dismiss = () => { if (!pending) onClose() }

  // Capture before making the page inert. Restore inert/scroll in layout cleanup BEFORE useDrawer returns focus.
  useLayoutEffect(() => {
    if (!open || !layer.current) return
    opener.current = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    return lockPage(layer.current)
  }, [open, returnFocus])

  useDrawer(dialog, { open, modal: true, onClose: dismiss, initialFocus, returnFocus: opener })

  useEffect(() => {
    const root = dialog.current
    if (!open || !root) return
    const keepFocus = () => {
      if (root.closest('[inert]')) return
      const active = document.activeElement
      if (active instanceof HTMLElement && root.contains(active) && (active === root || available(active))) return
      const preferred = initialFocus ? [...root.querySelectorAll<HTMLElement>(initialFocus)].find(available) : undefined
      ;(preferred ?? controls(root)[0] ?? root).focus({ preventScroll: true })
    }
    keepFocus()
    // Detail → edit/error/pending can remove or disable the focused control without closing the shell.
    const observer = new MutationObserver(keepFocus)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert'] })
    return () => observer.disconnect()
  }, [open, initialFocus])

  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || event.defaultPrevented || !dialog.current?.contains(event.target as Node)) return
    // Native :disabled includes inherited fieldset disability, unlike the shared hook's generic selector.
    event.stopPropagation()
    const root = dialog.current, items = controls(root)
    const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey)
    if (target === null) return
    event.preventDefault()
    ;(target === 'root' ? root : items[target]).focus({ preventScroll: true })
  }

  if (!open || typeof document === 'undefined') return null
  return createPortal(<div className="editor-dialog-backdrop" ref={layer}
    onPointerDown={event => { backdropPressed.current = event.target === event.currentTarget }}
    onClick={event => { if (backdropPressed.current && event.target === event.currentTarget) dismiss(); backdropPressed.current = false }}>
    <div className="editor-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true"
      aria-labelledby={`${id}-title`} aria-describedby={[description ? `${id}-description` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined}
      aria-busy={pending || undefined} onKeyDown={trap}
      onSubmitCapture={event => { if (pending || disabled) { event.preventDefault(); event.stopPropagation() } }}>
      <header className="editor-dialog-header">
        <h2 id={`${id}-title`}>{title}</h2>
        <button type="button" className="editor-control-button editor-dialog-close" disabled={pending} aria-label="关闭弹窗" onClick={dismiss}><CloseIcon /></button>
      </header>
      {description && <div className="editor-dialog-description" id={`${id}-description`}>{description}</div>}
      <fieldset className="editor-dialog-content" disabled={pending || disabled}>{children}</fieldset>
      {error && <p className="editor-control-error" id={`${id}-error`} role="alert">{error}</p>}
      {pending && <p className="editor-dialog-status" role="status">正在处理，请稍候…</p>}
      {footer && <fieldset className="editor-dialog-footer" disabled={pending}>{footer}</fieldset>}
    </div>
  </div>, document.body)
}
