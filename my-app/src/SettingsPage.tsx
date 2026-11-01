import { useState, type ReactNode } from 'react'
import StdioCredentials from './StdioCredentials'
import ExternalMcpConnections from './ExternalMcpConnections'
import ModelSettings from './ModelSettings'
import UserPreferences from './UserPreferences'
import WorkspaceStatus from './WorkspaceStatus'
import ExternalWorkspace from './ExternalWorkspace'
import GoogleConnection from './GoogleConnection'
import { AutomationSettings } from './AutomationControls'
import { AssistSettings, MutedDetectors } from './Findings'
import './settings.css'

export default function SettingsPage({ token, footer }: { token: string; footer?: ReactNode }) {
  const [feishu, setFeishu] = useState('读取中…')
  const [google, setGoogle] = useState('读取中…')
  const [mcp, setMcp] = useState('读取中…')
  return <div className="settings">
    <section className="today-card" aria-labelledby="settings-connections">
      <h2 id="settings-connections">连接</h2>
      <details className="settings-connection"><summary>飞书日历<span className="settings-state">{feishu}</span></summary><ExternalWorkspace token={token} onSummary={setFeishu} /></details>
      <details className="settings-connection"><summary>Google<span className="settings-state">{google}</span></summary><GoogleConnection key={token} token={token} onSummary={setGoogle} /></details>
      <details className="settings-connection"><summary>MCP 连接<span className="settings-state">{mcp}</span></summary><ExternalMcpConnections key={`external:${token}`} token={token} onSummary={setMcp} /></details>
    </section>
    <section className="today-card" aria-labelledby="settings-model">
      <h2 id="settings-model">模型</h2>
      <ModelSettings key={token} token={token} />
    </section>
    <section className="today-card" aria-labelledby="settings-automation">
      <h2 id="settings-automation">自动化</h2>
      <AutomationSettings token={token} />
      <MutedDetectors token={token} />
      <AssistSettings token={token} />
    </section>
    <section className="today-card" aria-labelledby="settings-preferences">
      <h2 id="settings-preferences">偏好</h2>
      <UserPreferences token={token} />
    </section>
    <section className="today-card" aria-labelledby="settings-advanced">
      <h2 id="settings-advanced">高级</h2>
      <StdioCredentials key={token} token={token} />
      <details className="tech-info"><summary>存储诊断</summary><WorkspaceStatus token={token} /></details>
    </section>
    {footer && <section className="today-card settings-account" aria-label="连接">{footer}</section>}
  </div>
}
