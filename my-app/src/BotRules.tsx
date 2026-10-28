import { useCallback, useEffect, useRef, useState } from 'react'
import Switch from './Switch'

type ToolStatus = 'available' | 'revoked' | 'unassigned' | 'main-only' | 'chief-only'
type Group = { id: string; label: string; description: string; mode: 'allow' | 'ask'; available: boolean; switchable: boolean
  tools: { name: string; label: string; write: boolean; status: ToolStatus }[] }

// GET /configuration answers with the view itself; the switch route wraps it in { data }. Callers here need neither shape.
async function request(path: string, token: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error?.message ?? '操作失败。')
  return result
}

/**
 * 工具与权限：每个 Bot 默认拥有全部工具组。只有含写入的组有开关：开 = 组内写入直接做（含删除），
 * 关 = 每次先问你。只读组始终可用，单独列一行；来源在下方「来源」里分配。
 */
export default function BotRules({ token, botId, readOnly }: { token: string; botId: string; readOnly?: boolean }) {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  // Late responses from a previously opened Bot must never change this Bot's switches.
  const scope = useRef(botId)
  const load = useCallback(async () => {
    const current = botId
    scope.current = botId
    const view = await request(`/api/bots/${botId}/configuration`, token) as { toolGroups: Group[] }
    if (scope.current !== current) return
    setGroups(view.toolGroups)
  }, [botId, token])
  useEffect(() => {
    let live = true
    load().catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [load])
  async function toggle(group: Group) {
    if (busy) return
    setBusy(group.id); setError('')
    try {
      await request(`/api/bots/${botId}/tool-groups/${group.id}`, token, { requestId: crypto.randomUUID(), mode: group.mode === 'allow' ? 'ask' : 'allow' })
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败。') } finally { setBusy(null) }
  }
  if (!groups) return <section className="bot-edit-section" aria-label="工具与权限"><h2>工具与权限</h2>
    <p className={error ? 'bot-edit-error' : 'bot-edit-hint'} role={error ? 'alert' : undefined}>{error || '正在读取…'}</p></section>
  const switchable = groups.filter((group) => group.switchable)
  const fixed = groups.filter((group) => !group.switchable && group.tools.some((tool) => tool.status === 'available' || tool.status === 'main-only'))
  return <section className="bot-edit-section" aria-label="工具与权限">
    <h2>工具与权限</h2>
    <p className="bot-edit-hint">开：直接做，包括删除。关：每次先问你。改动从所有会话的下一次操作起生效。</p>
    <ul className="pd-rows">
      {switchable.map((group) => {
        const writes = group.tools.filter((tool) => tool.write && tool.status === 'available').map((tool) => tool.label)
        return <li key={group.id} className="pd-row">
          <div className="pd-row-text">
            <span className="pd-row-title">{group.label}</span>
            <span className="pd-row-desc">{writes.join('、')}</span>
          </div>
          <Switch label={group.label} checked={group.mode === 'allow'} disabled={readOnly || busy !== null} onText="直接做" offText="先问我" onChange={() => void toggle(group)} />
        </li>
      })}
    </ul>
    {fixed.length > 0 && <p className="bot-edit-hint">始终可用，不需要确认：{fixed.map((group) => group.label).join('、')}。</p>}
    {error && <p role="alert" className="bot-edit-error">{error}</p>}
  </section>
}
