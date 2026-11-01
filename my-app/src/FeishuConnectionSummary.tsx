import { useState } from 'react'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'
import type { FeishuStatus } from './FeishuConnection'

export default function FeishuConnectionSummary({ token, active }: { token: string; active: boolean }) {
  const [summary, setSummary] = useState('读取中…')
  useWorkspaceRefresh({
    scopeKey: token, active,
    load: async ({ signal, isCurrent }) => {
      const response = await fetch('/api/feishu/status', { signal, headers: { Authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error('连接状态读取失败。')
      if (!isCurrent()) return
      const status = body.data as FeishuStatus
      setSummary(status.binding ? `已连接 ${status.binding.summary}` : status.configured ? '尚未绑定日历' : '凭据未配置')
    },
    onInvalidate: reason => { if (reason === 'scope') setSummary('读取中…') },
    onError: () => setSummary('状态暂不可达，将自动重试'),
  })
  return <span className="settings-state" role="status">{summary}</span>
}
