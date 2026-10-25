import { useEffect, useMemo, useState, type RefObject } from 'react'
import { buildCommands, matchCommands, type Command, type SkillOption } from './commands.mjs'
import { loadAutomation } from './automation'
import { taskPath } from './taskPath'

// Composer "/" menu: opens while the draft is "/" plus one word. The textarea keeps focus;
// ↑/↓ move, Enter or Tab picks, Esc closes. Skills come from GET …/skills for this Task.
type MenuTask = { taskId: number; bot: { id: string }; group?: unknown; groupId?: string; groupChild?: boolean }
export default function CommandMenu({ task, token, draft, inputRef, onPick }: { task: MenuTask; token: string; draft: string; inputRef: RefObject<HTMLTextAreaElement | null>; onPick: (command: Command) => void }) {
  const open = /^\/\S*$/.test(draft)
  const [skills, setSkills] = useState<SkillOption[]>([])
  const [paused, setPaused] = useState(false)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ draft: '', index: 0 })
  const group = Boolean(task.group)
  useEffect(() => {
    if (!open) return
    let live = true
    if (!group) fetch(taskPath(task, '/skills'), { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : { skills: [] }).then(v => { if (live) setSkills(v.skills ?? []) }).catch(() => { /* menu still lists actions */ })
    loadAutomation(token).then(v => { if (live) setPaused(v.paused) }).catch(() => { /* pause stays listed; the server decides */ })
    return () => { live = false }
  }, [open, group, task, token])
  const items = useMemo(() => open && closedFor !== draft ? matchCommands(buildCommands({ skills, group, paused }), draft) : [], [open, closedFor, draft, skills, group, paused])
  const index = cursor.draft === draft ? Math.min(cursor.index, Math.max(items.length - 1, 0)) : 0
  const shown = items.length > 0
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.setAttribute('aria-expanded', String(shown))
    if (shown) { input.setAttribute('aria-controls', 'command-menu'); input.setAttribute('aria-activedescendant', `command-${index}`) }
    else { input.removeAttribute('aria-controls'); input.removeAttribute('aria-activedescendant') }
    if (!shown) return
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setCursor({ draft, index: (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length }) }
      else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); if (!items[index].disabled) onPick(items[index]) }
      else if (event.key === 'Escape') { event.preventDefault(); setClosedFor(draft) }
    }
    input.addEventListener('keydown', onKey)
    return () => input.removeEventListener('keydown', onKey)
  }, [shown, index, items, draft, inputRef, onPick])
  if (!shown) return null
  return <ul id="command-menu" role="listbox" aria-label="命令" className="command-menu">
    {items.map((c, i) => <li key={c.id} id={`command-${i}`} role="option" aria-selected={i === index} aria-disabled={Boolean(c.disabled)}
      className={`command-item${i === index ? ' active' : ''}${c.disabled ? ' disabled' : ''}`}
      onMouseDown={e => e.preventDefault()} onMouseEnter={() => setCursor({ draft, index: i })} onClick={() => { if (!c.disabled) onPick(c) }}>
      <span className="command-label">{c.kind === 'skill' ? `Skill · ${c.label}` : c.label}</span>
      <span className="command-hint">{c.disabled ?? c.hint}</span>
    </li>)}
  </ul>
}
