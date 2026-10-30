import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { suggestionKeyAction } from './commands.mjs'
import './composer-suggestions.css'

export type ComposerSuggestion = { id: string; label: string; hint: string; disabled: string | null }
export type ComposerSuggestionsProps<T extends ComposerSuggestion> = {
  enabled: boolean
  sessionKey: string
  label: string
  items: readonly T[]
  inputRef: RefObject<HTMLTextAreaElement | null>
  onPick: (item: T) => void
  renderLeading?: (item: T) => ReactNode
  renderLabel?: (item: T) => ReactNode
  renderDetail?: (item: T) => ReactNode
  emptyLabel?: string
}

// Both wrappers use this one focus/ARIA/keyboard implementation. Inactive wrappers never
// touch the textarea's ARIA attributes; slash and caret-local @ triggers are disjoint.
export default function ComposerSuggestions<T extends ComposerSuggestion>({ enabled, sessionKey, label, items, inputRef, onPick,
  renderLeading, renderLabel, renderDetail, emptyLabel = '没有匹配项' }: ComposerSuggestionsProps<T>) {
  const menuId = `composer-suggestions-${useId()}`
  const listRef = useRef<HTMLUListElement>(null)
  const composing = useRef(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ sessionKey: '', id: '' })
  const selected = cursor.sessionKey === sessionKey ? items.findIndex(item => item.id === cursor.id) : 0
  const index = selected < 0 ? 0 : selected
  const shown = enabled && focused && dismissed !== sessionKey

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const onFocus = () => setFocused(true)
    const onBlur = () => { setFocused(false); composing.current = false }
    const onCompositionStart = () => { composing.current = true }
    const onCompositionEnd = () => { composing.current = false }
    setFocused(document.activeElement === input)
    input.addEventListener('focus', onFocus)
    input.addEventListener('blur', onBlur)
    input.addEventListener('compositionstart', onCompositionStart)
    input.addEventListener('compositionend', onCompositionEnd)
    return () => {
      input.removeEventListener('focus', onFocus)
      input.removeEventListener('blur', onBlur)
      input.removeEventListener('compositionstart', onCompositionStart)
      input.removeEventListener('compositionend', onCompositionEnd)
    }
  }, [inputRef])

  useEffect(() => {
    // Leaving the trigger resets Escape, so deleting/retyping the same @ can reopen it.
    if (!enabled) setDismissed(null)
  }, [enabled])

  useEffect(() => {
    const input = inputRef.current
    if (!input || !shown) return
    input.setAttribute('aria-expanded', 'true')
    input.setAttribute('aria-controls', menuId)
    if (items[index]) input.setAttribute('aria-activedescendant', `${menuId}-option-${index}`)
    else input.removeAttribute('aria-activedescendant')
    const onKey = (event: KeyboardEvent) => {
      if (composing.current) return
      const action = suggestionKeyAction(event, index, items.length)
      if (!action) return
      event.preventDefault()
      // Do not let Enter bubble to a parent composer submit handler after a pick.
      event.stopPropagation()
      if (action.type === 'dismiss') setDismissed(sessionKey)
      else if (action.type === 'move') setCursor({ sessionKey, id: items[action.index].id })
      else if (!items[action.index].disabled) onPick(items[action.index])
    }
    input.addEventListener('keydown', onKey)
    return () => {
      input.removeEventListener('keydown', onKey)
      if (input.getAttribute('aria-controls') === menuId) {
        input.setAttribute('aria-expanded', 'false')
        input.removeAttribute('aria-controls')
        input.removeAttribute('aria-activedescendant')
      }
    }
  }, [shown, menuId, index, items, inputRef, onPick, sessionKey])

  useEffect(() => {
    if (shown && items[index]) listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' })
  }, [shown, index, items])

  if (!shown) return null
  return <ul ref={listRef} id={menuId} role="listbox" aria-label={label} className="composer-suggestions">
    {items.length === 0 && <li role="presentation" className="composer-suggestions-empty"><span role="status">{emptyLabel}</span></li>}
    {items.map((item, i) => <li key={item.id} id={`${menuId}-option-${i}`} role="option" aria-selected={i === index} aria-disabled={Boolean(item.disabled)}
      className={`composer-suggestion${i === index ? ' is-active' : ''}${item.disabled ? ' is-disabled' : ''}`}
      onMouseDown={event => event.preventDefault()} onMouseEnter={() => setCursor({ sessionKey, id: item.id })}
      onClick={() => { if (!composing.current && !item.disabled) onPick(item) }}>
      {renderLeading && <span className="composer-suggestion-leading">{renderLeading(item)}</span>}
      <span className="composer-suggestion-body">
        <span className="composer-suggestion-label">{renderLabel ? renderLabel(item) : item.label}</span>
        {item.hint && <span className="composer-suggestion-hint">{item.hint}</span>}
        {item.disabled ? <span className="composer-suggestion-detail">{item.disabled}</span> : renderDetail && <span className="composer-suggestion-detail">{renderDetail(item)}</span>}
      </span>
    </li>)}
  </ul>
}
