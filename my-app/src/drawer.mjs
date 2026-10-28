// Drawer keyboard rules shared by the mobile sidebar and the session details panel (T05).
// Pure so they can be tested without a DOM; useDrawer.ts applies them to elements.

/** Elements a keyboard user can Tab to; visibility is checked separately. */
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/**
 * Where Tab should move inside a modal drawer. `index` is the focused item's position among the
 * drawer's `count` focusables (-1 when focus is outside). Returns the index to focus, 'root' when
 * nothing inside can take focus, or null to let the browser move focus normally.
 */
export function trapTarget(count, index, shift) {
  if (count === 0) return 'root'
  if (index === -1) return shift ? count - 1 : 0
  if (shift && index === 0) return count - 1
  if (!shift && index === count - 1) return 0
  return null
}

/** Open drawers, newest last. Only the top one answers Escape and traps Tab. */
export function drawerStack() {
  const ids = []
  return {
    open(id) { const at = ids.indexOf(id); if (at !== -1) ids.splice(at, 1); ids.push(id) },
    close(id) { const at = ids.indexOf(id); if (at !== -1) ids.splice(at, 1) },
    isTop(id) { return ids.length > 0 && ids[ids.length - 1] === id },
  }
}

/** Escape closes a drawer unless an inner widget (a menu, an IME composition) already used it. */
export function closesOnKey(event) {
  return event.key === 'Escape' && !event.defaultPrevented && !event.isComposing
}
