import type { ReactNode } from 'react'
import StdioCredentials from './StdioCredentials'
import ExternalMcpConnections from './ExternalMcpConnections'
import ModelSettings from './ModelSettings'
import UserPreferences from './UserPreferences'
import WorkspaceStatus from './WorkspaceStatus'
import ExternalWorkspace from './ExternalWorkspace'
import GoogleConnection from './GoogleConnection'
import { AutomationSettings } from './AutomationControls'
import { AssistSettings, MutedDetectors } from './Findings'

export default function SettingsPage({ token, footer }: { token: string; footer?: ReactNode }) {
  return <div className="settings">
    <section className="today-card" aria-labelledby="settings-sources">
      <h2 id="settings-sources">来源与状态</h2>
      <WorkspaceStatus token={token} />
      <details className="shell-more"><summary>飞书日历来源</summary><p className="shell-muted small">只读同步不会授予写权限。</p><ExternalWorkspace token={token} /></details>
    </section>
    <section className="today-card" aria-labelledby="settings-google">
      <h2 id="settings-google">连接 Google</h2>
      <GoogleConnection key={token} token={token} />
    </section>
    <section className="today-card" aria-labelledby="settings-mcp">
      <h2 id="settings-mcp">MCP 工具连接</h2>
      <ExternalMcpConnections key={`external:${token}`} token={token} />
      <StdioCredentials key={token} token={token} />
    </section>
    <section className="today-card" aria-labelledby="settings-automation">
      <h2 id="settings-automation">自动化</h2>
      <AutomationSettings token={token} />
    </section>
    <section className="today-card" aria-labelledby="settings-findings">
      <h2 id="settings-findings">主动提醒</h2>
      <MutedDetectors token={token} />
      <AssistSettings token={token} />
    </section>
    <section className="today-card" aria-labelledby="settings-model">
      <h2 id="settings-model">模型</h2>
      <ModelSettings key={token} token={token} />
    </section>
    <section className="today-card" aria-label="共享偏好">
      <UserPreferences token={token} />
    </section>
    {footer && <section className="today-card settings-account" aria-label="连接">{footer}</section>}
  </div>
}
