import Switch from './Switch'
import './capability-list.css'

export type CapabilityItem = {
  id: string
  kind: 'tool' | 'mcp' | 'skill'
  name: string
  description: string
  status: 'ready' | 'configured' | 'needs_auth' | 'missing_dependency' | 'error' | 'disabled'
  revision: string
  enabledForBot: boolean
  partiallyEnabled?: boolean
  available?: boolean
  mode?: 'allow' | 'ask'
  confirmable?: boolean
  controlNote?: string
}

const statusLabels = {
  ready: '已就绪', configured: '已登记，待核对依赖', needs_auth: '需要凭据',
  missing_dependency: '缺少依赖', error: '连接或加载失败', disabled: '来源已停用',
}
const kindLabels = { tool: '工具', mcp: 'MCP', skill: 'Skill' }

export default function CapabilityList({ items, readOnly = false, pendingId, onToggle, onModeChange }: {
  items: CapabilityItem[]
  readOnly?: boolean
  pendingId?: string | null
  onToggle: (item: CapabilityItem) => void
  onModeChange?: (item: CapabilityItem, mode: 'allow' | 'ask') => void
}) {
  if (!items.length) return <p className="bot-edit-hint">暂无已登记的工具、MCP 或 Skill；可通过对话请求配置。</p>
  return <ul className="pd-rows capability-list" aria-label="工具列表">
    {items.map(item => <li key={item.id} className="pd-row capability-row" aria-busy={pendingId === item.id}>
      <div className="pd-row-text">
        <span className="pd-row-title">{item.name}</span>
        <span className="pd-row-desc">{item.description || '暂无描述'}</span>
        <span className="pd-row-desc">{kindLabels[item.kind]} · {item.partiallyEnabled ? '部分启用' : item.enabledForBot ? '已启用' : '未启用'} · {statusLabels[item.status]}</span>
        {item.enabledForBot && item.available === false && <span className="pd-row-desc">当前不可调用；启用不代表依赖或会话限制已满足。</span>}
        {item.controlNote && <span className="pd-row-desc">{item.controlNote}</span>}
      </div>
      <div className="capability-actions">
        <Switch label={`启用${item.name}`} checked={item.enabledForBot} disabled={readOnly || pendingId != null || !!item.controlNote || !item.enabledForBot && item.status === 'disabled'} onText="启用" offText="停用" onChange={() => onToggle(item)} />
        {item.confirmable && item.mode && onModeChange && <label className="capability-confirmation">
          <span>写入确认</span>
          <select aria-label={`${item.name}的写入确认`} value={item.mode} disabled={readOnly || pendingId != null} onChange={event => onModeChange(item, event.target.value as 'allow' | 'ask')}>
            <option value="ask">每次先问</option><option value="allow">直接执行</option>
          </select>
        </label>}
      </div>
    </li>)}
  </ul>
}
