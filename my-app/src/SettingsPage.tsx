import type { ReactNode } from 'react'
import StdioCredentials from './StdioCredentials'
import WorkspaceStatus from './WorkspaceStatus'
import ExternalWorkspace from './ExternalWorkspace'
import { AutomationSettings } from './AutomationControls'
import { AssistSettings, MutedDetectors } from './Findings'

export default function SettingsPage({ token, footer }: { token: string; footer?: ReactNode }) {
  return <div className="settings">
    <section className="today-card" aria-labelledby="settings-sources">
      <h2 id="settings-sources">来源与状态</h2>
      <WorkspaceStatus token={token} />
      <details className="shell-more"><summary>飞书日历来源</summary><p className="shell-muted small">只读同步不会授予写权限。</p><ExternalWorkspace token={token} /></details>
    </section>
    <section className="today-card" aria-labelledby="settings-mcp">
      <h2 id="settings-mcp">本机工具连接</h2>
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
      <h2 id="settings-model">模型与测试模式</h2>
      <p>每个 Bot 模板有自己的模型设置。没有配置真实模型时，任务使用测试模式，回复不是模型生成的。</p>
      <p className="shell-muted small">在侧栏「Bot 模板」里打开某个 Bot，点「编辑」即可更改模型。修改只影响之后新建的任务，已有任务不受影响。</p>
    </section>
    {footer && <section className="today-card settings-account" aria-label="连接">{footer}</section>}
  </div>
}
