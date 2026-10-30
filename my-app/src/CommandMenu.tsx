import { useEffect, useMemo, useState, type RefObject } from 'react'
import { buildCommands, isCommandDraft, matchCommands, type Command, type SkillOption } from './commands.mjs'
import ComposerSuggestions from './ComposerSuggestions'
import { loadAutomation } from './automation'
import { taskPath } from './taskPath'

// The existing slash command contract is unchanged. Optional enabled/refreshKey let the
// integrator lock the composer or refresh its Skill catalog after registration/revocation.
type MenuTask = { taskId: number; bot: { id: string }; group?: unknown; groupId?: string; groupChild?: boolean }
export type CommandMenuProps = {
  task: MenuTask
  token: string
  draft: string
  inputRef: RefObject<HTMLTextAreaElement | null>
  onPick: (command: Command) => void
  enabled?: boolean
  refreshKey?: string | number
}
export default function CommandMenu({ task, token, draft, inputRef, onPick, enabled = true, refreshKey = 0 }: CommandMenuProps) {
  const open = enabled && isCommandDraft(draft)
  const group = Boolean(task.group)
  const skillPath = taskPath(task, '/skills')
  const scope = JSON.stringify([token, skillPath, group, refreshKey])
  const [catalog, setCatalog] = useState<{ scope: string; skills: SkillOption[]; paused: boolean }>({ scope: '', skills: [], paused: false })
  const current = catalog.scope === scope ? catalog : { skills: [], paused: false }

  useEffect(() => {
    if (!open) return
    let live = true
    const controller = new AbortController()
    // Never keep another Task/token's Skills visible while a new catalog is in flight.
    setCatalog({ scope, skills: [], paused: false })
    if (!group) fetch(skillPath, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.ok ? response.json() : { skills: [] })
      .then(value => { if (live) setCatalog(previous => ({ ...previous, scope, skills: Array.isArray(value.skills) ? value.skills : [] })) })
      .catch(() => { /* menu still lists actions; unavailable Skills never persist */ })
    loadAutomation(token).then(value => { if (live) setCatalog(previous => ({ ...previous, scope, paused: value.paused })) })
      .catch(() => { /* pause stays listed; the server decides */ })
    return () => { live = false; controller.abort() }
  }, [open, group, skillPath, token, scope])

  const items = useMemo(() => open ? matchCommands(buildCommands({ skills: current.skills, group, paused: current.paused }), draft) : [],
    [open, current.skills, current.paused, group, draft])
  return <ComposerSuggestions enabled={open} sessionKey={JSON.stringify([scope, draft])} label="命令与 Skill" items={items} inputRef={inputRef} onPick={onPick}
    renderLabel={command => command.kind === 'skill' ? `Skill · ${command.label}` : command.label} emptyLabel="没有匹配的命令或 Skill" />
}
