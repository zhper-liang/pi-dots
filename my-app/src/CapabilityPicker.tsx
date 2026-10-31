import { useState } from 'react'
import Switch from './Switch'
import { CAPABILITY_TABS, capabilityStatusLabel, filterCapabilities, type CapabilityItem, type CapabilityKind } from './bot-capabilities.mjs'
import './capabilities.css'

type Props = {
  items: CapabilityItem[]
  enabled: string[]
  partial?: string[]
  disabled?: boolean
  pendingId?: string | null
  onToggle: (id: string, next: boolean) => void
}

export default function CapabilityPicker({ items, enabled, partial = [], disabled = false, pendingId = null, onToggle }: Props) {
  const [tab, setTab] = useState<CapabilityKind>('tool')
  const [query, setQuery] = useState('')
  const filtered = filterCapabilities(items, tab, query)
  const empty = query.trim() ? '没有匹配的能力。' : tab === 'skill'
    ? '还没有 Skill，可以让 Chief 帮你导入。' : tab === 'mcp'
      ? '还没有 MCP 连接，到「设置 → 连接」添加，或让 Chief 帮你接上。' : '还没有工具集。'

  return <div className="capability-picker">
    <div className="pd-subtabs capability-tabs" role="tablist" aria-label="能力分类">
      {CAPABILITY_TABS.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
        {item.label} {items.filter(capability => capability.kind === item.id && enabled.includes(capability.id)).length}
      </button>)}
    </div>
    <input className="capability-search" type="search" aria-label="搜索能力" placeholder="搜索名称或说明" value={query} onChange={event => setQuery(event.target.value)} />
    {!filtered.length ? <p className="bot-edit-hint" role="status">{empty}</p> : <ul className="pd-rows capability-list" aria-label="能力列表">
      {filtered.map(item => {
        const checked = enabled.includes(item.id)
        const status = capabilityStatusLabel(item.status)
        return <li key={item.id} className="pd-row capability-row" aria-busy={pendingId === item.id}>
          <div className="pd-row-text">
            <span className="pd-row-title">{item.name}</span>
            {item.description && <span className="pd-row-desc capability-description">{item.description}</span>}
            {(status || partial.includes(item.id)) && <span className="pd-row-desc capability-status">
              {partial.includes(item.id) && <span>部分开启</span>}{status && <span>{status}</span>}
            </span>}
          </div>
          <Switch label={`启用${item.name}`} checked={checked} disabled={disabled || pendingId !== null || !checked && item.status === 'disabled'} onChange={() => onToggle(item.id, !checked)} />
        </li>
      })}
    </ul>}
  </div>
}
