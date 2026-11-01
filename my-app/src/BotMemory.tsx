import { useCallback, useMemo, useState } from 'react'
import { MemoryDocumentSection } from './MemoryDocuments'
import { useMemoryResource } from './useMemoryResource'
import { createMemoryApi } from './memory-api.mjs'
import { memoryDate, memoryLearningReason } from './memory-helpers.mjs'
import type { MemoryApi, MemoryEdit, MemoryLearning, MemorySourceHandler } from './memory-types'

export type BotMemoryProps = {
  botId: string; token: string; active?: boolean; readOnly?: boolean; api?: MemoryApi
  onOpenPreferences?: () => void; onOpenSource?: MemorySourceHandler
}

export default function BotMemory({ botId, token, active = true, readOnly = false, api: adapter, onOpenPreferences, onOpenSource }: BotMemoryProps) {
  // Remount drafts on identity changes, never on a poll or ordinary tab switch.
  return <BotMemoryContent key={`${botId}:${token}`} botId={botId} token={token} active={active} readOnly={readOnly} api={adapter} onOpenPreferences={onOpenPreferences} onOpenSource={onOpenSource} />
}

function BotMemoryContent({ botId, token, active = true, readOnly, api: adapter, onOpenPreferences, onOpenSource }: BotMemoryProps) {
  const api = useMemo(() => adapter ?? createMemoryApi(token), [adapter, token])
  const read = useCallback((signal?: AbortSignal) => api.getBot(botId, signal), [api, botId])
  const resource = useMemoryResource(read, active)
  async function edit(input: MemoryEdit) {
    const result = await api.editBot(botId, input)
    resource.update(old => ({ ...old, [input.kind]: result.document }))
    return result
  }
  return <div className="memory-view" aria-label="机器人记忆" aria-busy={resource.loading && !resource.data}>
    <div className="memory-actions"><p className="memory-intro">人格由你写，记忆从对话里整理，改完马上生效。</p><button type="button" disabled={resource.loading} onClick={() => { void resource.refresh() }}>{resource.loading ? '正在读取…' : '刷新'}</button></div>
    {resource.error && <p role="alert" className="memory-error">{resource.error}</p>}
    {!resource.data && !resource.error && <p role="status" className="memory-hint">正在读取记忆…</p>}
    {readOnly && <p role="status" className="memory-hint">这个机器人已停用，只能查看。</p>}
    {resource.data && <>
      {resource.data.learning && <MemoryLearningSection learning={resource.data.learning} readOnly={readOnly} supported={!!api.reviewBot} onOpenSource={onOpenSource} onAction={async action => {
        if (!api.reviewBot) return
        const learning = await api.reviewBot(botId, action)
        resource.update(old => ({ ...old, learning }))
      }} />}
      <MemoryDocumentSection title="人格" description="这个机器人的性格、说话方式和职责，只有你能改。" document={resource.data.personality} history={resource.data.history?.personality} truncated={resource.data.historyNextBeforeVersion?.personality != null} readOnly={readOnly} onEdit={edit} onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      <MemoryDocumentSection title="记忆" description="只属于这个机器人，可以改或删；日程以日历为准。" document={resource.data.memory} history={resource.data.history?.memory} truncated={resource.data.historyNextBeforeVersion?.memory != null} readOnly={readOnly} onEdit={edit} onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      <MemoryDocumentSection title="共享偏好" description="所有机器人共用，在这里只能看，到「设置 → 偏好」里改。" document={resource.data.preferences} readOnly onRefresh={resource.refresh} onOpenSource={onOpenSource} />
      {onOpenPreferences && <button type="button" onClick={onOpenPreferences}>去设置改偏好</button>}
    </>}
  </div>
}


function MemoryLearningSection({ learning, readOnly, supported, onAction, onOpenSource }: {
  learning: MemoryLearning; readOnly?: boolean; supported: boolean
  onAction: (action: 'review' | 'pause' | 'resume') => Promise<void>; onOpenSource?: MemorySourceHandler
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  async function act(action: 'review' | 'pause' | 'resume') {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onAction(action)
      setNotice(action === 'review' ? '已安排整理，有结果后在这里显示。' : action === 'pause' ? '后台整理已暂停，手动编辑仍可使用。' : '后台整理已恢复。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请刷新后重试。') }
    finally { setBusy(false) }
  }
  const jobs = (learning.jobs ?? []).slice(0, 5)
  return <section className="memory-section memory-learning" aria-label="后台整理">
    <div className="memory-section-head"><h2>后台整理</h2><span className="memory-meta">{!learning.enabled ? '功能已关闭' : learning.paused ? '已暂停' : '已开启'}</span></div>
    <p className="memory-hint">从本机器人的对话和已验证成果中整理长期事实与方法。没有新内容时不会重复保存。</p>
    <p className="memory-meta">最近整理：{learning.lastReviewAt ? memoryDate(learning.lastReviewAt) : '尚未整理'} · 待处理 {learning.pending} 项</p>
    <p className="memory-meta">今日后台用量：{learning.calls} / {learning.limits.calls} 次，{learning.tokens.toLocaleString('zh-CN')} / {learning.limits.tokens.toLocaleString('zh-CN')} tokens（按 UTC 日重置）</p>
    {!learning.enabled && <p className="memory-hint">后台功能已关闭，已有记忆和学到的 Skill 保留；仍可直接编辑记忆。</p>}
    {learning.enabled && learning.paused && <p className="memory-hint">暂停期间保留待处理材料，恢复后继续整理。</p>}
    {supported && <div className="memory-actions">
      <button type="button" disabled={readOnly || busy || !learning.enabled || learning.paused} onClick={() => { void act('review') }}>{busy ? '正在处理…' : '立即整理'}</button>
      <button type="button" disabled={readOnly || busy || !learning.enabled} onClick={() => { void act(learning.paused ? 'resume' : 'pause') }}>{learning.paused ? '恢复后台整理' : '暂停后台整理'}</button>
    </div>}
    {notice && <p role="status" className="memory-notice">{notice}</p>}
    {error && <p role="alert" className="memory-error">{error}</p>}
    {jobs.length > 0 && <details><summary>最近整理记录</summary><ul className="memory-history">{jobs.map(job => <li key={job.jobId}>
      <p>{memoryLearningReason(job)} <span className="memory-meta">{memoryDate(job.updatedAt)}</span></p>
      {(job.changes ?? []).slice(0, 3).map((change, index) => <p className="memory-content" key={index}>{change.kind === 'skill' ? '方法：' : change.kind === 'preferences' ? '偏好：' : '记忆：'}{change.content}</p>)}
      {onOpenSource && <div className="memory-actions">{(job.sourceEntries ?? []).slice(0, 4).map(source => <button type="button" key={`${source.taskId}:${source.entryId}`} onClick={() => onOpenSource(source)}>查看来源 {source.taskId} · {source.entryId}</button>)}</div>}
    </li>)}</ul></details>}
  </section>
}
