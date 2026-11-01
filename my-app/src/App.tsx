import { subscribeCapabilityChanges } from './capabilities-changed.mjs'
import ModelPicker, { type ComposerModel } from './ModelPicker'
import UnifiedWorkspace from './UnifiedWorkspace'
import { GearIcon } from './Icons'
import { BotFace } from './BotAvatar'
import { ChatStatus, MoodFace } from './BotMood'
import { refineMood } from './bot-mood.mjs'
import { sidebarFigure } from './bot-figure.mjs'
import { toolLabel } from './timeline.mjs'
import { chatUnits, stepDetail, stepLabels, stepStatus, toolSummary, type ChatUnit, type StepStatus } from './tool-steps.mjs'
import Markdown from './Markdown'
import GroupIssueControls, {type GroupIssue} from './GroupIssueControls'
import GroupCreation from './GroupCreation'
import CollaborationOverview, {type Overview} from './CollaborationOverview'
import SharedInformationPanel, {type SharedRecord} from './SharedInformationPanel'
import CollaborationPanel, { type Relation } from './CollaborationPanel'
import GroupTaskBoard from './GroupTaskBoard'
import BotCreation from './BotCreation'
import BotTemplatePage from './BotTemplatePage'
import CapabilitySetupCard from './CapabilitySetupCard'
import { capabilitySetupEntries, capabilitySetupReceipt, capabilityManagerNotice, type CapabilitySetupReceipt } from './capability-setup.mjs'
import BotDirectory from './BotDirectory'
import { botDetailHash, readBotTab, type BotTab } from './bot-directory.mjs'
import './bot-directory.css'
import TaskTimeline from './TaskTimeline'
import { openApproval, openBlocker } from './system-cards.mjs'
import InboxPage from './InboxPage'
import { AutoAppliedCard } from './AutomationControls'
import { MirrorCard, type MirrorMessage } from './MainSession'
import ShellSidebar, { type SidebarBot, type SidebarSession } from './ShellSidebar'
import NewSession from './NewSession'
import { lastActivity, sessionPreview, type SessionActionResult, type SessionActionTarget } from './session-list.mjs'
import { createSessionActionHandlers, removeSessionState, replaceMainSession } from './session-lifecycle-client.mjs'
import { FindingCard } from './Findings'
import type { ItemTab, WorkspaceView } from './workspace-navigation.mjs'
import TaskConfigurationMigration from './TaskConfigurationMigration'
import { taskPath } from './taskPath'
import WaitingRecoveryNotice, { type WaitingSnapshot } from './WaitingRecoveryNotice'
import TaskApprovalControls, { type ApprovalState } from './TaskApprovalControls'
import TaskBlockerControls, { type BlockerState } from './TaskBlockerControls'
import TaskCancellationControls from './TaskCancellationControls'
import { SkillHistory, SkillNote, type SkillMessage, type SkillState } from './SkillControls'
import CommandMenu from './CommandMenu'
import MentionMenu from './MentionMenu'
import { mentionTargetIds, reconcileMentions, type MentionBinding, type MentionPick } from './mentions.mjs'
import { isCommandDraft, type Command } from './commands.mjs'
import { setAutomationPaused } from './automation'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import './App.css'
import './shell.css'
import { taskStatus } from './taskStatus'
import { useDrawer, useMediaQuery } from './useDrawer'

type ConfigRef = { botId: string; version: string }
type Bot = { status?: 'active' | 'inactive'; deactivatedAt?: string; id: string; name: string; description: string; configRef: ConfigRef }
type ChatMessage = SkillMessage & { externalMcp?: { connectionId: string; connectionName?: string; originalName?: string }; afterControlStop?: boolean; afterCancellation?: boolean; purpose?: string; intermediate?: boolean; targetInputId?: number; appliedAt?: string; botId?: string; botName?: string; childTaskId?: number; deliveryStatus?: 'steer-pending' | 'steer-applied' | 'queued' | 'processing' | 'blocked' | 'waiting' | 'completed' | 'failed' | 'received' | 'cancelled'; queuePosition?: number; id: number; role: 'user' | 'assistant' | 'error' | 'tool' | 'system'; systemKind?: string; requestId?: string; summary?: string; undone?: boolean; findingId?: string; detector?: string; lines?: string[]; findingState?: string; handledTaskId?: number | null; assist?: boolean; assistTaskId?: number | null; callId?: string; toolName?: string; turnId?: number; inReplyTo?: number; arguments?: Record<string, unknown>; result?: { ok: boolean; data?: { simulated?: boolean }; error?: { code: string; message: string } }; assistant?: { content: { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[] }; content: string; createdAt: string; mode?: string; errorCode?: string; execution?: { provider: string; api: string; model: string; thinkingLevel: string; thinking?: { type: string }; responseModel?: string; timeoutMs: number } }
type TaskState = { goal: string; completionCriteria: string[]; constraints: string[] }
// Who a chat row belongs to, so a run of rows from one speaker shows the avatar and name once.
function speakerOf(item: ChatMessage, fallbackBotId: string) {
  if (item.role === 'system') return null
  if (item.role === 'user') return 'user'
  return item.systemKind === 'group-reply' && item.botId ? item.botId : fallbackBotId
}
const unitSpeaker = (unit: ChatUnit<ChatMessage>, fallbackBotId: string) => speakerOf(unit.kind === 'tools' ? unit.first : unit.item, fallbackBotId)
function continuedRuns(units: ChatUnit<ChatMessage>[], fallbackBotId: string) {
  return units.map((unit, index) => {
    const speaker = unitSpeaker(unit, fallbackBotId), previous = units[index - 1]
    return speaker !== null && previous !== undefined && unitSpeaker(previous, fallbackBotId) === speaker
  })
}
const chatSkeleton = <div className="pd-skeleton-chat" aria-hidden="true">
  <div className="pd-skeleton-row is-user"><span className="pd-skeleton-bubble" /></div>
  <div className="pd-skeleton-row"><span className="pd-skeleton-avatar" /><span className="pd-skeleton-bubble" /></div>
  <div className="pd-skeleton-row is-short"><span className="pd-skeleton-avatar" /><span className="pd-skeleton-bubble" /></div>
</div>
type MessageControl = { activeInputId: number | null; waitingInputId: number | null; queuedInputIds: number[]; pendingSteers: { entryId: number; targetInputId: number }[]; appliedSteerIds: number[]; cancellationEntryId: number | null }
type Task = {
  capabilitySetups?: unknown[]
  lastMessage?: { role: 'user' | 'assistant'; content: string; systemKind?: string; botName?: string }
  scheduledWorkflow?: { scheduleId: string; revision: number; occurrenceId: string; promptVersion: string; writes?: boolean; test?: boolean };
  groupIssues?: GroupIssue[]; kind?: string; groupId?: string; group?: { adminBotId: string; members: { id: string; name: string; status: string }[] }; collaborationOverview?: Overview | null; sharedInformation?: SharedRecord[]; collaborations?: Relation[]; managementTools?: string[]; archived?: boolean;
  botLifecycle?: string
  migrationHistory?: { id: number; previous: ConfigRef; next: ConfigRef; source: string; createdAt: string }[]
  waiting?: WaitingSnapshot | null
  messageControl?: MessageControl
  recoveryHistory?: { waiting?: WaitingSnapshot | null; messageControl?: MessageControl; id: number; createdAt: string; disposition: string; checkpoint: { phase: string } | null; uncertainAttempt: { kind: string; attempt: number; toolName?: string } | null }[]
  approvals?: ApprovalState
  blockers?: BlockerState
  cancellation?: { entryId: number; source: string; requestedAt: string; activeInputId: number | null } | null
  contextPolicy?: { contextWindow: number; triggerTokens: number; outputTokens: number; reserveTokens: number } | null
  compaction?: { revision: number; latest: { entryId: number; summary: string; createdAt: string } | null }
  compactionHistory?: { id: number; revision: number; createdAt: string; sourceEntryIds: number[] }[]
  skillState?: SkillState
  toolSets?: { installed: string[]; assigned?: string[]; resources?: string[]; authorized: string[]; displayed: string[] }
  callUsage?: { modelCalls: number; toolCalls: number; totalTokens: number; unknownTokenCalls: number }
  effectiveCallLimits?: { modelCalls: number; toolCalls: number; totalTokens?: number }
  callLimitHistory?: { id: number; createdAt: string; previous: Record<string, number>; next: Record<string, number>; resumedInputId: number | null }[]
  taskState?: TaskState
  taskStateSources?: Record<string, { type: string; entryId?: number; source?: string }>
  taskStateHistory?: { id: number; createdAt: string; changes: Partial<TaskState> }[]
  pendingSteerIds?: number[]; steerLength?: number
  messages: ChatMessage[]; activeInputId: number | null; queuedInputIds?: number[]; queueLength?: number
  taskId: number; conversationId: number; title: string; createdAt: string; bot: Pick<Bot, 'id' | 'name' | 'description'>
  configRef: ConfigRef; parameters: Record<string, unknown>
  parameterSources: Record<string, { type: string; configRef: ConfigRef }>
  titleSource: string; runtime: { disposition?: string; status: string; outcome?: { status: string }; checkpoint: { phase: string; lastOutcome?: string; waitingReason?: string } | null }
}
const thinkingLevelOf = (parameters: Record<string, unknown>) => parameters.thinkingLevel === 'high' ? 'high' : 'low'
const managedChild = (task: Task) => task.collaborations?.some(r => r.childTaskId === task.taskId && r.reviewRequired) ?? false
const taskInactive = (task: Task) => task.botLifecycle === 'inactive'
const taskCancelled = (task: Task) => Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted'
// Only states you can act on or would not guess get a tag under your message; a normal reply needs none.
const deliveryLabels: Partial<Record<NonNullable<ChatMessage['deliveryStatus']>, string>> = { cancelled: '已取消', 'steer-pending': '待插入', 'steer-applied': '已插入', queued: '排队中' }
function deliveryLabel(item: ChatMessage, cancelled: boolean) {
  if (cancelled && item.deliveryStatus === 'steer-pending') return '没插入，会话已取消'
  if (cancelled && item.deliveryStatus === 'queued') return '没处理，会话已取消'
  const label = item.deliveryStatus && deliveryLabels[item.deliveryStatus]
  return label && item.deliveryStatus === 'queued' ? `${label} · 第 ${item.queuePosition} 条` : label
}
// What a few tools report instead of a plain 完成: the outcome still waits on you.
const stepOkLabels: Record<string, string> = { calendar_reschedule_event: '已提交，等确认', report_blocker: '已提问，等回答' }
const tokenKey = 'pidot.api-token'
function savedToken() { try { return sessionStorage.getItem(tokenKey) ?? '' } catch { return '' } }
// A directly executed external call's receipt carries no connection label; its auto-approved card does.
function externalOf(item: ChatMessage, approvals?: ApprovalState) {
  return item.externalMcp ?? (item.callId ? approvals?.items.find((approval) => approval.callId === item.callId)?.externalMcp : undefined)
}
function hashTask() { const id = new URLSearchParams(location.hash.slice(1)).get('task'); return id && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : null }
function hashBot() { return new URLSearchParams(location.hash.slice(1)).get('bot') }
function hashNewBot() { return new URLSearchParams(location.hash.slice(1)).has('new-bot') }
function hashDirectory() { return new URLSearchParams(location.hash.slice(1)).has('bots') }
function hashNewSession() { return new URLSearchParams(location.hash.slice(1)).has('new') }
const opensChat = () => hashTask() !== null || hashBot() !== null || hashNewBot() || hashNewSession() || hashDirectory()
// Archive is a persisted server flag (POST …/archive): it only hides, never cancels or deletes.
function confirmReason(task: Task): string | null {
  if (taskCancelled(task) || taskInactive(task)) return null
  if (task.waiting?.kind === 'action-outcome') return '结果待确认'
  if (task.approvals?.activeId) return '等你确认'
  if (task.blockers?.activeId) return '等你回答'
  if (task.waiting?.kind === 'limits' || task.runtime.checkpoint?.lastOutcome === 'limited') return '已到调用上限'
  return null
}
// One line under a sidebar row: why it waits, or what it is doing now.
function sessionNote(task: Task): string {
  if (taskInactive(task)) return '已停用'
  if (taskCancelled(task)) return '已取消'
  const reason = confirmReason(task)
  if (reason) return reason
  if (task.activeInputId !== null) return '正在回复'
  if ((task.messageControl?.queuedInputIds.length ?? 0) > 0) return '有排队消息'
  return ''
}
// The line under a sidebar row: why it waits or what it is doing, else the last thing said.
function rowPreview(task: Task): string {
  const note = sessionNote(task)
  // List items carry only their last message; the open session carries its whole history.
  const said = task.messages?.length ? task.messages : task.lastMessage ? [task.lastMessage] : []
  return note === '正在回复' ? '正在回复…' : note || sessionPreview(said, { group: task.kind === 'group' })
}
class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code }
}
async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.error?.message ?? '请求失败，请稍后重试。', response.status, data.error?.code)
  return data
}
function message(error: unknown) { return error instanceof Error ? error.message : '请求失败。' }
// The model a session was started with, by name only; its address and provider settings stay out of the page.
function modelName(task: Task) {
  const model = task.parameters.model as { id?: string } | null | undefined
  return task.parameters.mode !== 'model' ? '测试回复' : model?.id ?? '未知'
}

function ExecutionControls({ task, token, onUpdated, onError }: { task: Task; token: string; onUpdated: (task: Task) => void; onError: (error: unknown) => void }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const limits = task.effectiveCallLimits
  const usage = task.callUsage
  if (!limits || !usage) return null
  const limited = !taskCancelled(task) && task.runtime.checkpoint?.lastOutcome === 'limited'
  async function mutate(path: string, init: RequestInit) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    controller.current = new AbortController()
    const signal = controller.current.signal
    try {
      await api(path, token, { ...init, signal })
      const { task: updated } = await api<{ task: Task }>(taskPath(task), token, { signal })
      if (!signal.aborted) onUpdated(updated)
    } catch (error) {
      if (!signal.aborted) onError(error instanceof ApiError ? error : new Error('没确认保存成功，先刷新查看调用次数。'))
    } finally { busyRef.current = false; if (!signal.aborted) setBusy(false) }
  }
  function raise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const values: Record<string, number | null> = {}
    for (const key of ['modelCalls', 'toolCalls', 'totalTokens']) {
      if (data.has(key)) values[key] = Number(data.get(key))
    }
    if (data.get('removeTokenLimit') === 'on') values.totalTokens = null
    void mutate(taskPath(task, '/limits'), { method: 'PATCH', body: JSON.stringify(values) })
  }
  return <section className="execution-controls" aria-label="调用次数">
    <h3>调用次数</h3>
    <p>模型 {usage.modelCalls} / {limits.modelCalls} 次 · 工具 {usage.toolCalls} / {limits.toolCalls} 次 · 已知 Token {usage.totalTokens} / {limits.totalTokens ?? '未设阈值'} · 用量未知 {usage.unknownTokenCalls} 次</p>
    {limited && <p role="status" className="limit-notice">已到调用上限，进度已保存。</p>}
    <details open={limited}>
      <summary>提高调用上限</summary>
      <form className="limits-form" key={`${task.taskId}:${JSON.stringify(limits)}`} onSubmit={raise}>
        <label>模型调用上限<input name="modelCalls" aria-label="模型调用上限" type="number" min={limits.modelCalls} max={Number.MAX_SAFE_INTEGER} step="1" required defaultValue={limits.modelCalls} /></label>
        <label>工具调用上限<input name="toolCalls" aria-label="工具调用上限" type="number" min={limits.toolCalls} max={Number.MAX_SAFE_INTEGER} step="1" required defaultValue={limits.toolCalls} /></label>
        {limits.totalTokens !== undefined && <label>累计 Token 阈值<input name="totalTokens" type="number" min={limits.totalTokens} max={Number.MAX_SAFE_INTEGER} step="1" required defaultValue={limits.totalTokens} /></label>}
        {limits.totalTokens !== undefined && usage.unknownTokenCalls > 0 && <label className="token-override"><input type="checkbox" name="removeTokenLimit" />已理解未知用量风险，显式取消 Token 阈值（保留调用硬上限）</label>}
        <p className="muted small">只改上限，已用次数不清零。</p>
        <button className="primary" disabled={busy || taskCancelled(task) || task.activeInputId !== null || task.runtime.status === 'terminal'}>{busy ? '正在保存…' : limited ? '提高上限并继续' : '保存上限'}</button>
      </form>
    </details>
    {!!task.callLimitHistory?.length && <details><summary>上限调整记录（{task.callLimitHistory.length}）</summary><ul>{task.callLimitHistory.map((entry) => <li key={entry.id}>记录 #{entry.id} · {new Date(entry.createdAt).toLocaleString('zh-CN')} · {JSON.stringify(entry.previous)} → {JSON.stringify(entry.next)}{entry.resumedInputId !== null ? ` · 继续原输入 #${entry.resumedInputId}` : ''}</li>)}</ul></details>}
  </section>
}

function App() {
  const [token, setToken] = useState(savedToken)
  const [draftToken, setDraftToken] = useState('')
  const [bots, setBots] = useState<Bot[]>([])
  const [mainSessions, setMainSessions] = useState<Record<string, number>>({})
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(hashTask)
  const [loadedDetail, setDetail] = useState<Task | null>(null)
  const [botId, setBotId] = useState(() => hashBot() ?? 'chief')
  const [view, setView] = useState<WorkspaceView>(() => opensChat() ? 'chats' : 'home')
  const [itemTab, setItemTab] = useState<ItemTab>('calendar')
  const [newBot, setNewBot] = useState(hashNewBot)
  const [newSession, setNewSession] = useState(hashNewSession)
  const [directory, setDirectory] = useState(hashDirectory)
  const [botTab, setBotTab] = useState<BotTab>(() => readBotTab(location.hash))
  const [notice, setNotice] = useState('')
  const [inboxCount, setInboxCount] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(token))
  const [detailError, setDetailError] = useState('')
  const [creating, setCreating] = useState(false)
  const [stateSavingId, setStateSavingId] = useState<number | null>(null)
  const stateSavingRef = useRef(false)
  const [targets, setTargets] = useState<Record<number, string[]>>({})
  const [mentionBindings, setMentionBindings] = useState<Record<number, MentionBinding[]>>({})
  const [cursors, setCursors] = useState<Record<number, { start: number; end: number }>>({})
  const [composingId, setComposingId] = useState<number | null>(null)
  const composition = useRef<number | null>(null)
  const focusDraft = useRef<number | null>(null)
  const directedRequests = useRef<Record<number,{signature:string;requestId:string}>>({})
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [pickedModels, setPickedModels] = useState<Record<number, ComposerModel>>({})
  const [toolLabelsByBot, setToolLabelsByBot] = useState<Record<string, Record<string, string>>>({})
  const [sendingId, setSendingId] = useState<number | null>(null)
  const sendingRef = useRef(false)
  const [refresh, setRefresh] = useState(0)
  const historyEndRef = useRef<HTMLDivElement>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [pane, setPane] = useState<'chat' | 'timeline'>('chat')
  // "/" menu: the Skill picked for the next message of each Task, and the composer it reads keys from.
  const [pickedSkill, setPickedSkill] = useState<Record<number, { id: string; label: string }>>({})
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // Home is the Chief main session (T03); the day summary moved to 事项 → 今天.
  const home = view === 'home'
  const chiefMain = mainSessions.chief ?? null
  const botDetail = view === 'chats' && botTab === 'chat' && selectedId === null && !newSession && !newBot && !directory && botId !== 'groups'
  const activeId = home ? chiefMain : botDetail ? (mainSessions[botId] ?? null) : selectedId
  const detail = loadedDetail?.taskId === activeId ? loadedDetail : null
  const latestMessageId = detail?.messages.at(-1)?.id
  const composerTaskId = detail?.taskId
  useEffect(() => {
    composition.current = null
    const input = composerRef.current
    if (!input || composerTaskId === undefined) return
    const cursor = cursors[composerTaskId] ?? { start: input.value.length, end: input.value.length }
    input.setSelectionRange(cursor.start, cursor.end)
    if (focusDraft.current === composerTaskId) { focusDraft.current = null; input.focus() }
    // Restore only when the textarea changes Tasks, never while a user is selecting text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerTaskId])
  useEffect(() => {
    if (!new URLSearchParams(location.hash.slice(1)).get('message')) historyEndRef.current?.scrollIntoView({ block: 'end' })
  }, [activeId, latestMessageId, pane])
  // D-11: content that loads above the conversation (pause banner, today strip) must not push the
  // cards waiting above the composer out of view. Stay at the bottom unless the user scrolled up.
  const pinnedRef = useRef(true)
  useEffect(() => {
    const onScroll = () => { pinnedRef.current = innerHeight + scrollY >= document.documentElement.scrollHeight - 48 }
    const keep = () => {
      if (pinnedRef.current && !new URLSearchParams(location.hash.slice(1)).get('message')) historyEndRef.current?.scrollIntoView({ block: 'end' })
    }
    // A window resize (rotation, viewport change) clamps the scroll before the scroll event fires.
    const observer = new ResizeObserver(keep)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', keep)
    observer.observe(document.body)
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', keep); observer.disconnect() }
  }, [])
  // Below 1000px (shell.css) session details overlay the conversation as a drawer.
  const detailsRef = useRef<HTMLElement>(null)
  const detailsOverlay = useMediaQuery('(max-width: 1000px)')
  useDrawer(detailsRef, { open: detailsOpen && detail !== null && (home || view === 'chats'), modal: detailsOverlay, onClose: () => setDetailsOpen(false) })
  const messageAnchor = new URLSearchParams(location.hash.slice(1)).get('message')
  const hasMessageAnchor = Boolean(messageAnchor && detail?.messages.some(m => String(m.id) === messageAnchor))
  useEffect(() => {
    if (messageAnchor && /^[1-9]\d*$/.test(messageAnchor) && hasMessageAnchor) document.getElementById(`message-${messageAnchor}`)?.scrollIntoView({block:'center'})
  }, [messageAnchor, hasMessageAnchor])
  const creatingRef = useRef(false)
  const requestEpoch = useRef(0)

  function disconnect() {
    requestEpoch.current += 1
    try { sessionStorage.removeItem(tokenKey) } catch { /* storage may be disabled */ }
    setDrafts({}); setMentionBindings({}); setCursors({}); setTargets({}); setPickedSkill({}); directedRequests.current = {}; composition.current = null; setComposingId(null); setPickedModels({}); setToken(''); setDraftToken(''); setBots([]); setTasks([]); setDetail(null)
  }
  function report(error: unknown) {
    if (error instanceof ApiError && error.status === 401) disconnect()
    setError(message(error))
  }
  function connect(event: FormEvent) {
    event.preventDefault()
    const value = draftToken.trim()
    try { sessionStorage.setItem(tokenKey, value) } catch { /* in-memory access still works */ }
    setError(''); setLoading(true); setToken(value); setDraftToken('')
  }
  function resetComposition() { composition.current = null; setComposingId(null) }
  function selectBot(id: string, tab: BotTab = 'chat') {
    if (id === 'chief' && tab === 'chat') { goView('home'); return }
    resetComposition()
    if (id === botId && botDetail) { changeBotTab(tab); return }
    requestEpoch.current += 1
    window.history.pushState(null, '', botDetailHash(id, tab))
    setDirectory(false); setBotTab(tab); setNewBot(false); setNewSession(false); setView('chats'); setPane('chat'); setBotId(id); setSelectedId(null); setDetail(null); setDetailError(''); setError('')
  }
  function selectTask(id: number, owner = botId) {
    resetComposition()
    setDirectory(false)
    setView('chats'); setNewBot(false); setNewSession(false); setPane('chat')
    if (id === selectedId && owner === botId) return
    requestEpoch.current += 1
    window.history.pushState(null, '', `#bot=${encodeURIComponent(owner)}&task=${id}`)
    setBotId(owner); setDetail(null); setDetailError(''); setSelectedId(id)
  }
  // Going home clears the Task hash so a reload lands on the home page again.
  function goView(next: WorkspaceView, tab?: ItemTab) {
    resetComposition()
    if (next === 'home' && view !== 'home') {
      requestEpoch.current += 1
      if (location.hash) window.history.pushState(null, '', location.pathname + location.search)
      setDirectory(false); setSelectedId(null); setNewSession(false); setNewBot(false); setDetailError(''); setPane('chat')
    }
    if (tab) setItemTab(tab)
    setView(next)
  }
  // 新建会话: an empty page that picks a Bot; sending the first message creates the session.
  function openNewSession() {
    requestEpoch.current += 1
    window.history.pushState(null, '', '#new')
    setDirectory(false); setNewSession(true); setNewBot(false); setView('chats'); setPane('chat'); setSelectedId(null); setDetail(null); setDetailError('')
  }
  const ownerOf = (task: Task) => task.kind === 'group' ? 'groups' : task.bot.id
  function openNewBot() {
    requestEpoch.current += 1
    window.history.pushState(null, '', '#new-bot')
    setDirectory(false); setNewBot(true); setNewSession(false); setView('chats'); setSelectedId(null); setDetail(null)
  }
  function openDirectory() {
    requestEpoch.current += 1
    window.history.pushState(null, '', '#bots')
    setDirectory(true); setNewBot(false); setNewSession(false); setView('chats'); setSelectedId(null); setDetail(null); setDetailError('')
  }
  function changeBotTab(tab: BotTab) {
    setBotTab(tab)
    // Tabs belong to one detail page; Back from an opened Task returns to the same tab.
    window.history.replaceState(null, '', botDetailHash(botId, tab))
  }
  async function toggleArchive(task: Task) {
    try {
      const { task: updated } = await api<{ task: Task }>(taskPath(task, '/archive'), token, { method: 'POST', body: JSON.stringify({ archived: !task.archived }) })
      setDetail(current => current?.taskId === updated.taskId ? { ...current, archived: updated.archived } : current)
      setTasks(current => current.map(t => t.taskId === updated.taskId ? { ...t, archived: updated.archived } : t))
    } catch (e) { setNotice(e instanceof ApiError ? e.message : '归档结果未确认，请刷新后查看。') }
  }
  function reload() { setLoading(true); setDetailError(''); setRefresh((value) => value + 1) }

  const sessionActions = createSessionActionHandlers(async (path, init) => {
    try { return await api(path, token, init) }
    catch (error) { if (error instanceof ApiError && error.status === 401) disconnect(); throw error }
  })
  function completeSessionAction(result: SessionActionResult, target: SessionActionTarget) {
    // Invalidate reads before evicting the old context, including a list request already in flight.
    requestEpoch.current += 1
    setTasks(current => current.filter(task => task.taskId !== result.taskId))
    setDetail(current => current?.taskId === result.taskId ? null : current)
    setDetailError('')
    setDrafts(current => removeSessionState(current, result.taskId))
    setCursors(current => removeSessionState(current, result.taskId))
    setMentionBindings(current => removeSessionState(current, result.taskId))
    setTargets(current => removeSessionState(current, result.taskId))
    setPickedSkill(current => removeSessionState(current, result.taskId))
    setPickedModels(current => removeSessionState(current, result.taskId))
    delete directedRequests.current[result.taskId]
    try { sessionStorage.removeItem(`pidot.directed-input.${result.taskId}`) } catch { /* current tab state still clears */ }
    if (composition.current === result.taskId) resetComposition()
    if (focusDraft.current === result.taskId) focusDraft.current = null
    setMainSessions(current => replaceMainSession(current, result))
    if (target.kind === 'main' && hashTask() === result.taskId) {
      // Direct links to the old main become the Bot's current main, with an empty composer.
      window.history.replaceState(null, '', botDetailHash(result.botId, 'chat'))
      setSelectedId(null); setBotId(result.botId); setView('chats'); setBotTab('chat')
      setDirectory(false); setNewSession(false); setNewBot(false); setPane('chat')
    } else setSelectedId(current => current === result.taskId ? null : current)
    setRefresh(value => value + 1)
  }

  useEffect(() => {
    const update = () => { composition.current = null; setComposingId(null); requestEpoch.current += 1; setDetail(null); setDetailError(''); setSelectedId(hashTask()); setBotId(hashBot() ?? 'chief'); setNewBot(hashNewBot()); setNewSession(hashNewSession()); setDirectory(hashDirectory()); setBotTab(readBotTab(location.hash)); setPane('chat'); if (opensChat()) setView('chats'); else setView(current => current === 'chats' ? 'home' : current); setRefresh(value => value + 1) }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  useEffect(() => subscribeCapabilityChanges(change => {
    setToolLabelsByBot(current => {
      if (!change.botId) return {}
      const next = { ...current }; delete next[change.botId]; return next
    })
    setRefresh(value => value + 1)
  }), [])

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      const epoch = requestEpoch.current
      try {
        const [catalog, list] = await Promise.all([
          api<{ bots: Bot[]; mainSessions?: Record<string, number> }>('/api/bots', token, { signal: controller.signal }),
          api<{ tasks: Task[] }>('/api/tasks?includeMain=1', token, { signal: controller.signal }),
        ])
        if (controller.signal.aborted || epoch !== requestEpoch.current) return
        setBots(catalog.bots); setMainSessions(catalog.mainSessions ?? {}); setTasks(list.tasks)
      } catch (err) { if (!controller.signal.aborted && epoch === requestEpoch.current) report(err) }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => { void load() }, 1500) } }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [token, refresh])

  useEffect(() => {
    if (!token || activeId === null) return
    const controller = new AbortController()
    const epoch = requestEpoch.current
    let timer: ReturnType<typeof setTimeout>
    let retryDelay = 750
    async function load() {
      try {
        const { task } = await api<{ task: Task }>(home ? `/api/bots/chief/tasks/${activeId}` : hashBot() && botId !== 'groups' ? `/api/bots/${encodeURIComponent(botId)}/tasks/${activeId}` : `/api/tasks/${activeId}`, token, { signal: controller.signal })
        if (!controller.signal.aborted && epoch === requestEpoch.current) {
          if (!home && !hashBot()) { setBotId(task.kind === 'group' ? 'groups' : task.bot.id); window.history.replaceState(null, '', `#bot=${encodeURIComponent(task.kind === 'group' ? 'groups' : task.bot.id)}&task=${task.taskId}`) }
          setDetail(task); setTasks((current) => current.map((item) => item.taskId === task.taskId ? task : item)); setDetailError(''); retryDelay = 750
        }
      } catch (err) {
        if (!controller.signal.aborted && epoch === requestEpoch.current) {
          if (err instanceof ApiError && err.status === 401) report(err)
          setDetailError(message(err)); retryDelay = Math.min(15000, retryDelay * 2)
        }
      }
      if (!controller.signal.aborted && epoch === requestEpoch.current) timer = setTimeout(load, retryDelay)
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [token, botId, activeId, home, botDetail, refresh])

  useEffect(() => {
    const id = detail?.bot.id
    if (!token || !id || toolLabelsByBot[id]) return
    const controller = new AbortController()
    api<{ toolLabels: Record<string, string> }>(`/api/bots/${encodeURIComponent(id)}/configuration`, token, { signal: controller.signal })
      .then(configuration => { if (!controller.signal.aborted) setToolLabelsByBot(current => ({ ...current, [id]: configuration.toolLabels })) })
      .catch(() => { if (!controller.signal.aborted) setToolLabelsByBot(current => ({ ...current, [id]: {} })) })
    return () => controller.abort()
  }, [token, detail?.bot.id, toolLabelsByBot])

  const [thinkingPending, setThinkingPending] = useState<number | null>(null)
  // Per-conversation thinking depth: the main session keeps this for its next inputs.
  async function setThinking(task: Task, level: string) {
    if (thinkingPending !== null) return
    setThinkingPending(task.taskId)
    try {
      const next = await api<Task>(taskPath(task, '/parameters'), token, { method: 'PATCH', body: JSON.stringify({ thinkingLevel: level }) })
      setDetail((current) => current?.taskId === next.taskId ? next : current)
      setTasks((current) => current.map((item) => item.taskId === next.taskId ? next : item))
    } catch (err) { report(err) } finally { setThinkingPending(null) }
  }
  async function send(event: FormEvent, steering = false) {
    event.preventDefault()
    if (!detail || sendingRef.current || stateSavingRef.current) return
    const id = detail.taskId
    const content = drafts[id] ?? ''
    if (composition.current === id || !content.trim()) return
    const epoch = requestEpoch.current
    sendingRef.current = true; setSendingId(id); setError('')
    try {
      const targetBotIds = [...new Set([...mentionTargetIds(content, mentionBindings[id] ?? []), ...(targets[id] ?? [])])]
      const signature = JSON.stringify([content, targetBotIds])
      try { if (!directedRequests.current[id]) directedRequests.current[id] = JSON.parse(sessionStorage.getItem(`pidot.directed-input.${id}`) ?? 'null') } catch { /* storage unavailable */ }
      if (!directedRequests.current[id] || directedRequests.current[id].signature !== signature) directedRequests.current[id] = {signature,requestId:crypto.randomUUID()}
      if (!steering && detail.group) { try { sessionStorage.setItem(`pidot.directed-input.${id}`,JSON.stringify(directedRequests.current[id])) } catch { /* in-memory retry remains */ } }
      const skill = !steering && !detail.group ? pickedSkill[id] : undefined
      const model = !steering && !detail.group && detail.kind === 'main' ? pickedModels[id] : undefined
      await api(taskPath(detail, `/${steering ? 'steer' : 'messages'}`), token, { method: 'POST', body: JSON.stringify({ message: content, ...(model ? { model } : {}), ...(skill ? { skillId: skill.id } : {}), ...(!steering && detail.group ? { targetBotIds, requestId: directedRequests.current[id].requestId } : {}) }) })
      if (skill) setPickedSkill(current => { const next = { ...current }; delete next[id]; return next })
      delete directedRequests.current[id]
      try { sessionStorage.removeItem(`pidot.directed-input.${id}`) } catch { /* storage unavailable */ }
      if (epoch !== requestEpoch.current) return
      setDrafts((current) => current[id] === content ? { ...current, [id]: '' } : current)
      setMentionBindings(current => ({ ...current, [id]: [] })); setTargets(current => ({ ...current, [id]: [] })); setCursors(current => ({ ...current, [id]: { start: 0, end: 0 } }))
    } catch (err) {
      if (epoch !== requestEpoch.current) return
      report(err)
      if (!(err instanceof ApiError)) setError('没确认发送成功，先刷新查看消息。')
    } finally {
      sendingRef.current = false; setSendingId(null)
      if (epoch === requestEpoch.current) setRefresh((value) => value + 1)
    }
  }

  function updateComposer(id: number, value: string, start: number, end: number) {
    const previous = drafts[id] ?? ''
    setMentionBindings(current => ({ ...current, [id]: reconcileMentions(previous, value, current[id] ?? []) }))
    setDrafts(current => ({ ...current, [id]: value }))
    setCursors(current => ({ ...current, [id]: { start, end } }))
  }

  function pickMention(pick: MentionPick) {
    if (!detail || composerLocked || composition.current === detail.taskId) return
    const sourceId = detail.taskId
    const candidate = bots.find(bot => bot.id === pick.botId && bot.status !== 'inactive' && !bot.deactivatedAt)
    if (!candidate) { setNotice('这个机器人已不可用，草稿还在。'); return }
    let destination = sourceId
    if (pick.action === 'switch-bot') {
      if (detail.group) return
      const targetId = mainSessions[pick.botId]
      if (!targetId) { setNotice('打不开这个机器人的主会话，请刷新后重试，草稿还在。'); return }
      if (targetId !== sourceId && drafts[targetId] && !window.confirm('目标会话已有未发送草稿，是否用当前草稿替换？取消将留在原会话。')) return
      destination = targetId
    } else if (detail.group && !detail.group.members.some(member => member.id === pick.botId && member.status !== 'inactive')) return
    setDrafts(current => ({ ...current, ...(destination !== sourceId ? { [sourceId]: '' } : {}), [destination]: pick.draft }))
    setMentionBindings(current => ({ ...current, ...(destination !== sourceId ? { [sourceId]: [] } : {}), [destination]: pick.bindings }))
    setCursors(current => ({ ...current, ...(destination !== sourceId ? { [sourceId]: { start: 0, end: 0 } } : {}), [destination]: { start: pick.selectionStart, end: pick.selectionEnd } }))
    if (destination !== sourceId) {
      // A target's own history stays on its server Task. Only unsent text moves; Skill/model stay per Task.
      focusDraft.current = destination
      selectTask(destination, pick.botId)
      setNotice(`已切换到 ${candidate.name}（${candidate.id}），仅携带未发送草稿；未发送消息，也未复制原会话历史。`)
    } else {
      requestAnimationFrame(() => {
        const input = composerRef.current
        if (input?.dataset.taskId !== String(sourceId)) return
        input.focus(); input.setSelectionRange(pick.selectionStart, pick.selectionEnd)
      })
    }
  }

  // "/" menu pick: a Skill applies to the next message; actions call the same handlers as their buttons.
  function runCommand(command: Command) {
    if (!detail) return
    const id = detail.taskId
    setDrafts(current => ({ ...current, [id]: '' })); setMentionBindings(current => ({ ...current, [id]: [] })); setCursors(current => ({ ...current, [id]: { start: 0, end: 0 } }))
    if (command.kind === 'skill' && command.skillId) { setPickedSkill(current => ({ ...current, [id]: { id: command.skillId!, label: command.label } })); composerRef.current?.focus(); return }
    if (command.id === 'new-task') void create(undefined, detail.bot.id)
    else if (command.id === 'pane') setPane(current => current === 'chat' ? 'timeline' : 'chat')
    else if (command.id === 'pause') {
      if (window.confirm('暂停全部自动化？定时任务会停下，改东西需要你确认；到设置里恢复。')) setAutomationPaused(token, true).then(() => setNotice('已暂停全部自动化。恢复在设置页。'), (e: unknown) => setError(message(e)))
    } else if (command.id === 'new-bot') openNewBot()
    else if (command.id === 'details') setDetailsOpen(true)
  }

  async function convertToSteer(messageId: number) {
    if (!detail || sendingRef.current) return
    const id = detail.taskId, epoch = requestEpoch.current
    sendingRef.current = true; setSendingId(id); setError('')
    try {
      await api(taskPath(detail, '/steer'), token, { method: 'POST', body: JSON.stringify({ messageId }) })
    } catch (err) {
      if (epoch === requestEpoch.current) {
        report(err)
        if (!(err instanceof ApiError)) setError('插入结果未确认，请刷新核对，不要重复提交。')
      }
    } finally {
      sendingRef.current = false; setSendingId(null)
      if (epoch === requestEpoch.current) setRefresh((value) => value + 1)
    }
  }

  async function create(event?: FormEvent, forBot = botId) {
    event?.preventDefault()
    if (creatingRef.current) return
    creatingRef.current = true; setCreating(true); setError('')
    const epoch = requestEpoch.current
    try {
      const { task } = await api<{ task: Task }>(`/api/bots/${encodeURIComponent(forBot)}/tasks`, token, {
        method: 'POST', body: JSON.stringify({ botId: forBot }),
      })
      if (epoch !== requestEpoch.current) return
      selectTask(task.taskId, forBot); reload()
    } catch (err) {
      if (epoch !== requestEpoch.current) return
      report(err)
      if (!(err instanceof ApiError)) setError('创建结果未确认。请先刷新会话列表核实，避免重复创建。')
      reload()
    } finally { creatingRef.current = false; setCreating(false) }
  }
  // 新建会话: create the session titled by the first message, then send it. If sending fails the
  // text stays as that session's draft, so nothing typed is lost and nothing is resent silently.
  async function startSession(forBot: string, text: string) {
    if (creatingRef.current) return
    creatingRef.current = true; setCreating(true); setError('')
    const firstLine = text.trim().split('\n')[0].trim()
    const title = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
    let task: Task
    try {
      ({ task } = await api<{ task: Task }>(`/api/bots/${encodeURIComponent(forBot)}/tasks`, token, { method: 'POST', body: JSON.stringify({ botId: forBot, ...(title ? { title } : {}) }) }))
    } catch (err) {
      report(err)
      if (!(err instanceof ApiError)) setError('创建结果未确认。请先刷新会话列表核实，避免重复创建。')
      creatingRef.current = false; setCreating(false); reload(); return
    }
    setDrafts((current) => ({ ...current, [task.taskId]: text }))
    selectTask(task.taskId, forBot)
    try {
      await api(taskPath(task, '/messages'), token, { method: 'POST', body: JSON.stringify({ message: text }) })
      setDrafts((current) => current[task.taskId] === text ? { ...current, [task.taskId]: '' } : current)
    } catch (err) {
      report(err)
      if (!(err instanceof ApiError)) setError('会话已创建，第一条消息的发送结果未确认。请看会话历史再决定是否重发。')
    } finally { creatingRef.current = false; setCreating(false); reload() }
  }

  // PLAN §8.5 / P-15: "接着聊" opens a new derived Task in this Bot's main session; the run stays as it was.
  const [followingUp, setFollowingUp] = useState(false)
  async function followUp(task: Task) {
    if (followingUp) return
    setFollowingUp(true); setError('')
    try {
      const { data } = await api<{ data: { taskId: number } }>(taskPath(task, '/follow-up'), token, { method: 'POST', body: '{}' })
      selectTask(data.taskId, task.bot.id); reload()
    } catch (err) { report(err); if (!(err instanceof ApiError)) setError('没确认结果，请刷新查看机器人的主会话。') }
    finally { setFollowingUp(false) }
  }

  async function updateTaskState(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || stateSavingRef.current || sendingRef.current || detail.activeInputId !== null) return
    const id = detail.taskId
    const epoch = requestEpoch.current
    const data = new FormData(event.currentTarget)
    const lines = (key: string) => String(data.get(key) ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
    stateSavingRef.current = true; setStateSavingId(id); setError('')
    try {
      const { task } = await api<{ task: Task }>(taskPath(detail, '/state'), token, { method: 'PATCH', body: JSON.stringify({
        goal: data.get('goal'), completionCriteria: lines('completionCriteria'), constraints: lines('constraints'),
      }) })
      if (epoch !== requestEpoch.current) return
      setDetail((current) => current?.taskId === id ? task : current)
      setTasks((current) => current.map((item) => item.taskId === id ? task : item))
    } catch (err) {
      if (epoch !== requestEpoch.current) return
      report(err)
      if (!(err instanceof ApiError)) setError('没确认保存成功，先刷新查看任务目标。')
    } finally { stateSavingRef.current = false; setStateSavingId(null) }
  }

  const selectedBot = bots.find((bot) => bot.id === botId)
  const status = detail ? taskStatus(detail, sendingId === detail.taskId) : null
  const archived = tasks.filter(t => t.archived).map(t => t.taskId)
  const confirmations = tasks.filter(t => !archived.includes(t.taskId)).flatMap(t => { const reason = confirmReason(t); return reason ? [{ taskId: t.taskId, title: t.title, botName: t.bot.name, reason }] : [] })
  const groupTasks = tasks.filter(t => t.kind === 'group')
  // Main conversations with activity belong in the session list as well as the Bot entry.
  const sidebarSessions: SidebarSession[] = tasks.filter(t => t.kind !== 'main' || t.bot.id !== 'chief' && (t.lastMessage || t.messages?.some(message => message.role === 'user' || message.role === 'assistant') || t.activeInputId !== null)).map(t => ({ id: t.taskId, owner: ownerOf(t), title: t.kind === 'main' ? t.bot.name : t.title, botId: t.bot.id, botName: t.bot.name, main: t.kind === 'main',
    at: lastActivity(t), confirm: confirmReason(t) !== null, archived: Boolean(t.archived), group: t.kind === 'group', preview: rowPreview(t), figure: sidebarFigure(refineMood(taskStatus(t).mood, t.messages?.at(-1))), crew: t.group?.members.filter(m => m.status !== 'inactive').map(m => m.id) ?? [], running: t.activeInputId !== null || (t.messageControl?.queuedInputIds.length ?? 0) > 0 }))
  const sidebarBots: SidebarBot[] = bots.map(b => ({ id: b.id, name: b.name, inactive: b.status === 'inactive', mainTaskId: mainSessions[b.id] ?? null, ...(detail?.taskId === mainSessions[b.id] && status ? { mainFigure: sidebarFigure(refineMood(status.mood, detail.messages.at(-1))), mainPreview: rowPreview(detail), mainConfirm: confirmReason(detail) !== null } : {}), mainRunning: detail?.taskId === mainSessions[b.id] && (detail.activeInputId !== null || (detail.messageControl?.queuedInputIds.length ?? 0) > 0) }))
  const botSettingsActive = view === 'chats' && botTab !== 'chat'
  const botPage = view === 'chats' && selectedId === null && !newBot && !newSession && !directory ? botId : null
  // The phone top bar names where you are; on desktop the page itself does.
  const mobileTitle = home ? (bots.find(b => b.id === 'chief')?.name ?? 'pipi')
    : view === 'chats' ? (directory ? '机器人' : newSession ? '新建会话' : newBot ? '新建机器人' : selectedId !== null ? (detail?.title ?? '会话') : botId === 'groups' ? '群聊' : (selectedBot?.name ?? '机器人'))
    : view === 'items' ? '事项' : view === 'inbox' ? '通知' : '设置'
  async function deactivate(target: Bot) {
    try { const result = await api<{ bot: Bot }>(`/api/bots/${target.id}/deactivate`, token, { method: 'POST', body: JSON.stringify({ confirm: true }) }); setBots(current => current.map(b => b.id === target.id ? result.bot : b)); setRefresh(v => v + 1) } catch (e) { report(e) }
  }

  const composerLocked = !detail || Boolean(detail.scheduledWorkflow) || managedChild(detail) || taskCancelled(detail) || taskInactive(detail) || sendingId === detail.taskId
  const pendingUserQuestion = detail?.blockers?.items.some(item => item.status === 'pending' && item.assignee === 'user' && !item.rootWorkId) ?? false
  const settledCount = detail ?(detail.approvals?.items ?? []).filter(i => !openApproval(i, taskCancelled(detail))).length
    + [...(detail.blockers?.items ?? []), ...(detail.groupId ? [] : detail.blockers?.related ?? [])].filter(i => !openBlocker(i, taskCancelled(detail))).length : 0
  const setupEntries = detail && (detail.capabilitySetups?.length || detail.messages.some(item => item.role === 'tool' && ['mcp_manage', 'skill_manage'].includes(item.toolName ?? '')))
    ? capabilitySetupEntries(detail.messages, detail.taskId, detail.capabilitySetups) : new Map<string, { receipt: CapabilitySetupReceipt; messageId: number | null }>()
  function openSetupApproval(approvalId: string) {
    setPane('chat')
    requestAnimationFrame(() => {
      const anchor = document.getElementById(`approval-${approvalId}`) ?? document.getElementById('task-open-approvals')
      anchor?.closest('details')?.setAttribute('open', '')
      anchor?.scrollIntoView({ block: 'center' })
      anchor?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    })
  }
  const setupCard = (receipt: CapabilitySetupReceipt) => <CapabilitySetupCard key={receipt.setupId} token={token} receipt={receipt} refreshKey={refresh}
    targetName={bots.find(bot => bot.id === receipt.targetBotId)?.name} botNames={Object.fromEntries(bots.map(bot => [bot.id, bot.name]))}
    readOnly={!detail || taskCancelled(detail) || taskInactive(detail)} onChanged={() => setRefresh(value => value + 1)}
    onOpenBot={id => selectBot(id, 'capabilities')} onOpenApproval={openSetupApproval} />
  const toolLabels: Record<string, string> = { ...(detail ? toolLabelsByBot[detail.bot.id] : {}), bot_inspect: '查看机器人', bot_manage: '管理机器人', mcp_manage: 'MCP 配置', skill_manage: 'Skill 配置' }
  function displayTool(name?: string, external?: ChatMessage['externalMcp']) {
    return external ? `${external.connectionName ?? 'MCP'} · ${external.originalName ?? '工具'}` : toolLabel(name, toolLabels)
  }
  const executionControls = detail && <fieldset disabled={taskInactive(detail) || Boolean(detail.scheduledWorkflow)} className="lifecycle-controls"><ExecutionControls key={`${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
    setDetail((current) => current?.taskId === updated.taskId ? updated : current)
    setRefresh((value) => value + 1)
  }} /></fieldset>
  const limited = detail !== null && detail.runtime.checkpoint?.lastOutcome === 'limited' && !taskCancelled(detail)
  const units = detail ? chatUnits(detail.messages) : []
  const runs = detail ? continuedRuns(units, detail.bot.id) : []
  const lastTools = units.findLast(unit => unit.kind === 'tools')?.key
  const botName = (id: string) => bots.find(bot => bot.id === id)?.name ?? id
  // Tool calls between two replies: one folded row, one line per call inside, arguments and result one
  // click further. Cards that need you (a confirmation, a setup, a saved bot) stay outside the fold.
  function toolRun(unit: Extract<ChatUnit<ChatMessage>, { kind: 'tools' }>, cont: boolean, task: Task) {
    const running = unit.key === lastTools && task.activeInputId !== null && !taskCancelled(task)
    const waitingCallIds = (task.approvals?.items ?? []).filter(item => openApproval(item, taskCancelled(task)) && item.callId).map(item => item.callId!)
    const steps = unit.steps.map(step => {
      const receipt = step.receipt, status: StepStatus = stepStatus(step, { running, waitingCallIds })
      const name = displayTool(receipt?.toolName ?? step.name, externalOf(receipt ?? { callId: step.callId } as ChatMessage, task.approvals))
      const label = status === 'ok' && stepOkLabels[step.name ?? ''] || stepLabels[status]
      const notes: ReactNode[] = [], extras: ReactNode[] = []
      if (receipt?.afterCancellation) notes.push(<p key="late">取消后才返回，没有继续执行{receipt.purpose === 'context-compaction' ? '（整理历史）' : ''}。</p>)
      else if (receipt?.afterControlStop) notes.push(<p key="late">停止后才返回，结果已保留。</p>)
      if (receipt && ['mcp_manage', 'skill_manage'].includes(receipt.toolName ?? '')) {
        const notice = capabilityManagerNotice(receipt, task.taskId, task.messages, task.approvals?.items)
        const setup = capabilitySetupReceipt(receipt.result?.data, task.taskId), entry = setup ? setupEntries.get(setup.setupId) : undefined
        if (notice?.kind === 'inspect') notes.push(<p key="inspect">已查看 {botName(notice.targetBotId)} 的 {notice.managerKind === 'mcp' ? 'MCP' : 'Skill'}（{notice.capabilityCount} 项）。<button type="button" className="text-button" onClick={() => selectBot(notice.targetBotId, 'capabilities')}>查看机器人能力</button></p>)
        else if (notice?.kind === 'approval') extras.push(<div key={step.key} className="management-result"><strong>{({ pending: '等你确认，还没配置', approved: '已同意，结果见配置卡', rejected: '已拒绝', inserted: '已补充修改要求' })[notice.state]}</strong><p>给 {botName(notice.targetBotId)} 配置。</p><button type="button" onClick={() => openSetupApproval(notice.approvalId)}>查看确认</button></div>)
        else if (entry?.messageId === receipt.id) extras.push(setupCard(entry.receipt))
        else if (entry) notes.push(<p key="merged">最新状态见下方的配置卡。</p>)
      }
      if (receipt?.result?.ok && receipt.toolName === 'bot_manage') {
        const data = receipt.result.data as { bot?: { id: string; name: string }; previous?: unknown } | undefined
        if (data?.bot) extras.push(<div key={step.key} className="management-result"><strong>{data.previous ? `已保存 ${data.bot.name}` : `已创建 ${data.bot.name}`}</strong><button type="button" onClick={() => selectBot(data.bot!.id)}>进入 {data.bot.name} 的对话</button></div>)
      }
      return { step, status, name, label, notes, extras, shown: stepDetail(step) }
    })
    const summary = toolSummary(steps.map(step => step.name), steps.map(step => step.status))
    return <li id={`message-${unit.first.id}`} key={unit.key} className={`message message-tool message-bot${cont ? ' is-cont' : ''}`}>
      {!cont && <span className="message-avatar"><BotFace id={unitSpeaker(unit, task.bot.id) ?? task.bot.id} /></span>}
      {!cont && <div className="message-heading"><strong>{unit.first.systemKind === 'group-reply' && unit.first.botName ? unit.first.botName : task.bot.name}</strong><time dateTime={unit.first.createdAt}>{new Date(unit.first.createdAt).toLocaleString('zh-CN')}</time></div>}
      <details className="tool-run" data-tone={summary.tone}>
        <summary><span className="tool-mark" aria-hidden="true" />{summary.text}</summary>
        <ol className="tool-steps">{steps.map(({ step, status, name, label, notes, shown }) => <li key={step.key}>
          <details className="tool-step" data-tone={status}>
            <summary><span className="tool-mark" aria-hidden="true" /><span className="tool-step-name">{name}</span><span className="tool-step-state">{label}</span></summary>
            {notes}
            {shown.arguments && <><p className="tool-step-label">参数</p><pre>{shown.arguments}</pre></>}
            {shown.error && <><p className="tool-step-label">错误</p><p>{shown.error}</p></>}
            {shown.result && <><p className="tool-step-label">结果</p><pre>{shown.result}</pre></>}
            {!notes.length && !shown.arguments && !shown.error && !shown.result && <p>没有返回内容。</p>}
          </details>
        </li>)}</ol>
      </details>
      {steps.flatMap(step => step.extras)}
    </li>
  }
  const chatView = !detail ? <div className="shell-placeholder" role="status"><h2 id="detail-title" className={detailError ? undefined : 'sr-only'}>{detailError ? '无法读取会话' : '正在读取会话…'}</h2>{detailError ? <p>{detailError}。恢复连接后会自动重试。</p> : chatSkeleton}</div> : <div className={`shell-chat ${detailsOpen ? 'details-open' : ''}`}>
            <header className="shell-chat-header">
              <h2 id="detail-title">{detail.title}</h2>
              <ChatStatus taskId={detail.taskId} botId={detail.bot.id} label={status!.label} tone={status!.tone} mood={refineMood(status!.mood, detail.messages.at(-1))} />
              {detail.kind !== 'main' && <button type="button" className="text-button shell-archive" title="归档后从列表隐藏" onClick={() => void toggleArchive(detail)}>{detail.archived ? '取消归档' : '归档'}</button>}
              {!detail.group && <button type="button" className="shell-icon-button" aria-label="机器人设置" onClick={() => selectBot(detail.bot.id, 'capabilities')}><GearIcon /></button>}
              <button type="button" className="shell-icon-button" aria-label="会话详情" aria-expanded={detailsOpen} aria-controls="chat-details" onClick={() => setDetailsOpen(v => !v)}>ⓘ</button>
            </header>
            <div className="shell-chat-column">
              {detail.group && <p className="shell-note" role="status">管理员：{detail.bot.name}。@ 谁就由谁回复，没 @ 时由管理员处理。</p>}
              {/* Approvals, blockers and unknown outcomes stay in the message flow as prominent cards. */}
              <div className="shell-cards">
                <InboxPage key={`proposals:${detail.taskId}:${token}`} proposalTaskId={detail.taskId} token={token} active={true} onCount={() => {}} onOpenTask={selectTask} />
                <CollaborationOverview key={`overview:${detail.taskId}`} task={detail} token={token} onError={report} onUpdated={(updated)=>{setDetail(current=>current?.taskId===updated.taskId?updated:current);setRefresh(v=>v+1)}} />
                <fieldset disabled={taskInactive(detail)} className="lifecycle-controls"><GroupIssueControls items={detail.groupIssues} token={token} onError={report} onRefresh={() => setRefresh(value => value + 1)} />{settledCount > 0 && <details className="shell-settled"><summary>已处理的审批与补充 · {settledCount}</summary><TaskApprovalControls scope="settled" key={`approval-settled:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current); setTasks((current) => current.map((task) => task.taskId === updated.taskId ? updated : task)); setRefresh(value => value + 1)
                }} /><TaskBlockerControls scope="settled" key={`blocker-settled:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} /></details>}
                {detail.group && detail.groupId && <GroupTaskBoard groupId={detail.groupId} groupTaskId={detail.taskId} token={token} relations={detail.collaborations} members={detail.group.members} archivedIds={archived} onError={report} onArchived={() => setRefresh(v => v + 1)} />}
                <CollaborationPanel taskId={detail.taskId} items={detail.collaborations} botNames={Object.fromEntries(bots.map(bot => [bot.id, bot.name]))} />
                <SharedInformationPanel items={detail.sharedInformation} />
                </fieldset>
                <WaitingRecoveryNotice recovered={detail.recoveryHistory?.at(-1)?.waiting} current={detail.waiting} cancelled={taskCancelled(detail)} />
                {detail.runtime.checkpoint?.lastOutcome === 'limited' && !taskCancelled(detail) && <p className="pd-composer-notice" role="status">已到调用上限，进度已保存。<button type="button" className="text-button" onClick={() => setDetailsOpen(true)}>提高上限</button></p>}
              </div>
              {pane === 'timeline' ? <><button type="button" className="text-button timeline-back" onClick={() => setPane('chat')}>← 回到对话</button><TaskTimeline task={detail} toolLabels={toolLabels} /></> : <><ol className="messages" aria-label="会话历史" aria-live="polite">
                {units.map((unit, index) => { if (unit.kind === 'tools') return toolRun(unit, runs[index], detail); const item = unit.item; return item.role === 'system' ? <li id={`message-${item.id}`} key={item.id} className="message message-system">
                  {item.systemKind === 'auto-applied' && item.requestId ? <AutoAppliedCard token={token} requestId={item.requestId} summary={item.summary ?? item.content} undone={item.undone} createdAt={item.createdAt} />
                    : item.systemKind === 'finding' && item.findingId ? <FindingCard token={token} finding={{ id: item.findingId, detector: item.detector ?? '', summary: item.summary ?? item.content, lines: item.lines, state: item.findingState, handledTaskId: item.handledTaskId, assist: item.assist, assistTaskId: item.assistTaskId }} onOpenTask={(id, owner) => selectTask(id, owner)} />
                    : item.systemKind === 'mirror' ? <MirrorCard token={token} item={item as unknown as MirrorMessage} onOpenTask={(id, owner) => selectTask(id, owner)} />
                    : item.systemKind === 'skill' ? <SkillNote item={item} />
                    : <p className={item.systemKind === 'context-floor' ? 'shell-muted small' : undefined}>{item.content}</p>}
                </li> : <li id={`message-${item.id}`} key={item.id} className={`message message-${item.role}${item.role === 'user' ? '' : ' message-bot'}${runs[index] ? ' is-cont' : ''}`}>
                  {(item.role === 'assistant' || item.role === 'error') && !runs[index] && <span className="message-avatar">{item.systemKind === 'group-reply' && item.botId ? <BotFace id={item.botId} /> : <BotFace id={detail.bot.id} />}</span>}
                  <div className="message-heading">{item.role === 'user' && item.skillId && <span className="skill-tag">Skill · {detail.messages.find(m => m.systemKind === 'skill' && m.inReplyTo === item.id)?.skillName ?? item.skillId}</span>}<strong>{item.systemKind === 'group-reply' ? `${item.botName ?? '机器人'} 的回复` : item.role === 'user' ? '你' : item.role === 'error' ? '执行失败' : item.assistant ? detail.bot.name : `${detail.bot.name}${item.mode === 'model' ? '' : ' · 测试回复'}`}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>{item.intermediate && <span className="delivery-status">插入前返回的结果</span>}{item.role === 'user' && deliveryLabel(item, taskCancelled(detail)) && <span className={`delivery-status delivery-${item.deliveryStatus}`} data-testid={`delivery-${item.id}`}>{deliveryLabel(item, taskCancelled(detail))}</span>}</div>
                  {item.role === 'assistant' ? <Markdown className="message-body">{item.content}</Markdown> : <p className="message-body">{item.content}</p>}
                  {item.deliveryStatus === 'queued' && <button type="button" className="text-button" disabled={Boolean(item.skillId) || Boolean(detail.scheduledWorkflow) || managedChild(detail) || sendingId !== null || stateSavingId !== null || Boolean(detailError) || (taskCancelled(detail) || taskInactive(detail)) || (Boolean(detail.approvals?.activeId) || Boolean(detail.blockers?.activeId) && !pendingUserQuestion) || !['pending', 'running'].includes(detail.runtime.status)} onClick={() => void convertToSteer(item.id)}>转为插入到当前回复</button>}
                  {item.afterControlStop && !item.afterCancellation && <small className="late-receipt">停止后才返回，结果已保留。</small>}
                  {item.afterCancellation && <small className="late-receipt">取消后才返回，没有继续执行{item.purpose === 'context-compaction' ? '（整理历史）' : ''}。</small>}
                </li> })}
              </ol>{[...setupEntries.values()].filter(entry => entry.messageId === null).map(entry => setupCard(entry.receipt))}</>}
              {pane === 'chat' && detail.messages.length === 0 && <div className="conversation-empty"><BotFace id={detail.bot.id} size={88} mood="greet" /><h3>会话已就绪</h3><p>在下方输入第一条消息。{detail.parameters.mode !== 'model' && ' · 测试模式'}</p></div>}
              {!taskCancelled(detail) && !taskInactive(detail) && !detail.blockers?.activeId && !detail.approvals?.activeId && detail.activeInputId !== null && <p className="shell-typing" role="status"><MoodFace botId={detail.bot.id} mood={refineMood('thinking', detail.messages.at(-1))} />正在回复…</p>}
              {taskInactive(detail) && <p className="queue-notice" role="status">这个机器人已停用，不再处理新消息，记录都保留。</p>}
              {Boolean(detail.queueLength) && <p className="queue-notice" role="status" data-testid="queue-status">已排队 {detail.queueLength} 条，{taskCancelled(detail) ? '会话已取消，不再处理' : detail.waiting?.kind === 'action-outcome' ? '核对结果后处理' : detail.approvals?.activeId ? '等你确认后处理' : detail.blockers?.activeId ? '正在切换到新消息' : detail.runtime.checkpoint?.lastOutcome === 'limited' ? '提高调用上限后处理' : '当前回复结束后按顺序处理'}。</p>}
              {detailError && <p role="alert" className="shell-alert-card">状态暂未同步：{detailError}。正在自动重试。</p>}
              {Boolean(detail.steerLength) && <p className="queue-notice" data-testid="steer-status">{taskCancelled(detail) ? '未生效插入' : '待插入'} {detail.steerLength} 条，{taskCancelled(detail) ? '会话已取消' : '下一步生效'}。</p>}
              {detail.scheduledWorkflow && <div className="shell-note routine-run-note" role="status"><span>{detail.scheduledWorkflow.test ? '这是一次测试运行，结果不发出。' : '这是定时任务的一次运行，不能在这里追加消息。'}</span>
                <button type="button" className="primary" disabled={followingUp} onClick={() => void followUp(detail)}>{followingUp ? '正在打开…' : '接着聊'}</button></div>}
              {/* D-11: cards waiting for you sit right above the composer, visible after auto-scroll. */}
              <fieldset disabled={taskInactive(detail)} id="task-open-approvals" className="lifecycle-controls shell-pending" aria-label="等你处理"><TaskApprovalControls scope="open" key={`approval-open:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current); setTasks((current) => current.map((task) => task.taskId === updated.taskId ? updated : task)); setRefresh(value => value + 1)
                }} /><TaskBlockerControls scope="open" key={`blocker-open:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} /></fieldset>
              <form className="message-form shell-composer" onSubmit={(event) => void send(event)}>
                {detail.group && <div className="pd-composer-chips" role="group" aria-label="选择要回复的机器人">
                  <span className="pd-composer-hint">@ 谁</span>
                  {detail.group.members.map(b => <label key={b.id} className={`pd-chip${(targets[detail.taskId] ?? []).includes(b.id) ? ' is-picked' : ''}`}><input type="checkbox" checked={(targets[detail.taskId] ?? []).includes(b.id)} disabled={b.status === 'inactive'} onChange={(e) => setTargets(v => ({ ...v, [detail.taskId]: e.target.checked ? [...(v[detail.taskId] ?? []), b.id] : (v[detail.taskId] ?? []).filter(id => id !== b.id) }))} />{b.name}{b.id === detail.bot.id ? '（管理员）' : ''}{b.status === 'inactive' ? '（已停用）' : ''}</label>)}
                  <span className="pd-composer-hint">没选时由管理员处理。</span>
                </div>}
                {pickedSkill[detail.taskId] && <div className="skill-chip" role="status">这条消息按 Skill「{pickedSkill[detail.taskId].label}」处理<button type="button" className="shell-icon-button" aria-label="不用这个 Skill" onClick={() => setPickedSkill(current => { const next = { ...current }; delete next[detail.taskId]; return next })}>×</button></div>}
                <div className="pd-composer-box">
                  <CommandMenu key={`commands:${token}:${detail.taskId}`} task={detail} token={token} draft={drafts[detail.taskId] ?? ''} inputRef={composerRef} onPick={runCommand} enabled={!composerLocked && composingId !== detail.taskId} refreshKey={refresh} />
                  <MentionMenu key={`mentions:${token}:${detail.taskId}`} bots={bots} context={detail.group ? { kind: 'group', memberBotIds: detail.group.members.filter(member => member.status !== 'inactive').map(member => member.id) } : { kind: 'direct', currentBotId: detail.bot.id }}
                    draft={drafts[detail.taskId] ?? ''} selectionStart={cursors[detail.taskId]?.start ?? (drafts[detail.taskId] ?? '').length} selectionEnd={cursors[detail.taskId]?.end ?? (drafts[detail.taskId] ?? '').length}
                    inputRef={composerRef} bindings={mentionBindings[detail.taskId] ?? []} onPick={pickMention} disabled={composerLocked || composingId === detail.taskId || isCommandDraft(drafts[detail.taskId] ?? '')} maxLength={4000} scopeKey={`${token}:${detail.taskId}`} />
                  <label htmlFor="message" className="sr-only">发送消息</label>
                  <textarea key={`${token}:${detail.taskId}`} data-task-id={detail.taskId} ref={composerRef} role="combobox" aria-autocomplete="list" aria-haspopup="listbox" id="message" rows={2} maxLength={4000} value={drafts[detail.taskId] ?? ''}
                    onChange={event => updateComposer(detail.taskId, event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
                    onSelect={event => { const input = event.currentTarget; setCursors(current => ({ ...current, [detail.taskId]: { start: input.selectionStart, end: input.selectionEnd } })) }}
                    onCompositionStart={() => { composition.current = detail.taskId; setComposingId(detail.taskId) }}
                    onCompositionEnd={event => { composition.current = null; setComposingId(null); const input = event.currentTarget; updateComposer(detail.taskId, input.value, input.selectionStart, input.selectionEnd) }}
                    placeholder={`给 ${detail.bot.name} 发消息…（/ 命令，@ 机器人）`} disabled={composerLocked} />
                  <div className="pd-composer-bar">
                    <button type="button" className="pd-tool" title="命令与 Skill" aria-label="打开命令与 Skill 菜单" disabled={composerLocked || Boolean(drafts[detail.taskId])} onClick={() => { updateComposer(detail.taskId, '/', 1, 1); composerRef.current?.focus() }}>/</button>
                    {!detail.group && detail.kind === 'main' && detail.parameters.mode === 'model' && <details className="pd-composer-more"><summary aria-label="模型与思考深度">⋯</summary>
                      <ModelPicker key={`${token}:${detail.taskId}`} token={token} task={detail} value={pickedModels[detail.taskId]} disabled={sendingId === detail.taskId || taskInactive(detail) || taskCancelled(detail)} onChange={model => setPickedModels(current => ({ ...current, [detail.taskId]: model }))} />
                      <label className="pd-tool" title="从下一条消息开始用这个思考深度"><span>思考</span>
                        <select id="thinking-level" aria-label="思考深度" value={thinkingLevelOf(detail.parameters)} disabled={sendingId === detail.taskId || taskInactive(detail) || taskCancelled(detail) || thinkingPending === detail.taskId} onChange={(e) => void setThinking(detail, e.target.value)}><option value="low">低</option><option value="high">高</option></select></label>
                    </details>}
                    <span className="pd-composer-hint pd-composer-count">{(drafts[detail.taskId] ?? '').length} / 4000</span>
                    {(detail.activeInputId !== null || pendingUserQuestion || detail.runtime.checkpoint?.lastOutcome === 'limited') && <button type="button" className="steer-button pd-button" disabled={Boolean(pickedSkill[detail.taskId]) || Boolean(detail.scheduledWorkflow) || managedChild(detail) || sendingId !== null || stateSavingId !== null || Boolean(detailError) || (taskCancelled(detail) || taskInactive(detail)) || (Boolean(detail.approvals?.activeId) || Boolean(detail.blockers?.activeId) && !pendingUserQuestion) || !['pending', 'running'].includes(detail.runtime.status) || !(drafts[detail.taskId] ?? '').trim()} onClick={(event) => void send(event, true)}>插入到当前回复</button>}
                    <button className="primary" disabled={Boolean(detail.scheduledWorkflow) || managedChild(detail) || sendingId !== null || stateSavingId !== null || Boolean(detailError) || (taskCancelled(detail) || taskInactive(detail)) || !['pending', 'running'].includes(detail.runtime.status) || !(drafts[detail.taskId] ?? '').trim()}>{sendingId === detail.taskId ? '正在发送…' : managedChild(detail) ? '由绑定主管验收 / 返工' : taskInactive(detail) ? '已停用' : taskCancelled(detail) ? '已取消' : detail.activeInputId !== null || detail.runtime.checkpoint?.lastOutcome === 'limited' ? '加入队列' : '发送'}</button>
                  </div>
                </div>
                {managedChild(detail) && <p className="muted small steer-help">这个任务由派活的机器人负责验收和返工。</p>}
              </form>
              <div ref={historyEndRef} />
            </div>
            {detailsOpen && detailsOverlay && <div className="shell-details-scrim" onClick={() => setDetailsOpen(false)} aria-hidden="true" />}
            <aside ref={detailsRef} id="chat-details" className="shell-details" aria-label="会话详情" role={detailsOverlay ? 'dialog' : undefined} aria-modal={detailsOverlay ? true : undefined} hidden={!detailsOpen}>
              <div className="shell-details-header"><h3>会话详情</h3><button type="button" className="shell-icon-button" aria-label="关闭会话详情" onClick={() => setDetailsOpen(false)}>×</button></div>
              {limited && executionControls}
              <SkillHistory state={detail.skillState} />
                <details className="task-context">
                  <summary>任务目标</summary>
                  <dl className="task-state-view">
                    <dt>任务目标</dt><dd>{detail.taskState?.goal ?? detail.title}</dd>
                    <dt>完成标准</dt><dd>{detail.taskState?.completionCriteria.join('；') || '尚未单独记录'}</dd>
                    <dt>有效限制</dt><dd>{detail.taskState?.constraints.join('；') || '尚未单独记录'}</dd>
                  </dl>
                <form className="message-form" key={`${detail.taskId}:${JSON.stringify(detail.taskState)}`} onSubmit={updateTaskState}>
                    <label htmlFor="task-goal">任务目标</label>
                    <textarea id="task-goal" name="goal" required maxLength={4000} rows={2} defaultValue={detail.taskState?.goal ?? detail.title} />
                    <label htmlFor="task-criteria">完成标准（每行一项，最多 20 项）</label>
                    <textarea id="task-criteria" name="completionCriteria" rows={2} defaultValue={detail.taskState?.completionCriteria.join('\n') ?? ''} />
                    <label htmlFor="task-constraints">有效限制（每行一项，空白表示清除）</label>
                    <textarea id="task-constraints" name="constraints" rows={2} defaultValue={detail.taskState?.constraints.join('\n') ?? ''} />
                    <div><button className="primary" disabled={Boolean(detail.scheduledWorkflow) || (taskCancelled(detail) || taskInactive(detail)) || stateSavingId === detail.taskId || sendingId === detail.taskId || detail.activeInputId !== null || detail.runtime.status === 'terminal' || Boolean(detailError)}>{stateSavingId === detail.taskId ? '正在保存…' : '保存任务状态'}</button></div>
                  </form>
                </details>
                {detail.kind !== 'main' && <TaskCancellationControls key={`cancel:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} />}
                {!taskInactive(detail) && !detail.scheduledWorkflow && detail.kind !== 'main' && <TaskConfigurationMigration key={`migration:${detail.bot.id}:${detail.taskId}:${token}`} task={detail} token={token} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} />}
                <p className="shell-muted small">模型：{modelName(detail)} · 开始于 {new Date(detail.createdAt).toLocaleString('zh-CN')}</p>
                {!limited && executionControls}
                <button type="button" className="text-button" onClick={() => { setPane('timeline'); setDetailsOpen(false) }}>查看时间线</button>
            </aside>
          </div>

  return (
    <div className="app-shell">
      {error && <div role="alert" className="error-banner shell-alert">{error}<button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
      {!token ? (
        <main className="login-panel shell-login">
          <img className="shell-brand-mark" src="/favicon.svg" alt="" /><h1>连接你的 Pidot</h1>
          <p>你的个人助理，运行在本机。</p>
          <form onSubmit={connect}>
            <label htmlFor="token">本地访问 token</label>
            <input id="token" type="password" autoComplete="off" value={draftToken} onChange={(event) => setDraftToken(event.target.value)} required placeholder="输入 PIDOT_API_TOKEN" />
            <button className="primary" disabled={!draftToken.trim()}>连接</button>
          </form>
          <p className="muted small">填启动服务时终端里打印的 token，只保存在这个标签页。</p>
        </main>
      ) : (
        <main className="workspace-root" onClickCapture={event => {
          // A context-switch notice must not cover actions in the phone navigation drawer.
          if (event.target instanceof Element && event.target.closest('button[aria-controls="shell-sidebar"]')) setNotice('')
        }}>
          {notice && <div role="status" className="shell-alert shell-notice">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}
          <UnifiedWorkspace onOpenCapabilities={() => selectBot('chief', 'capabilities')} key={token} token={token} bots={bots} onOpenTask={selectTask} view={view} onView={(next) => goView(next)} itemTab={itemTab} onItemTab={setItemTab} title={mobileTitle}
            sidebar={(shell) => <ShellSidebar {...shell} view={view} newSession={newSession} inboxCount={inboxCount ?? confirmations.length}
              sessions={sidebarSessions} bots={sidebarBots} selectedId={selectedId} botPage={botPage}
              onSessionAction={sessionActions.action} onVerifySessionAction={sessionActions.verify} onSessionActionComplete={completeSessionAction}
              onHome={() => goView('home')} onNewSession={openNewSession} onOpenSession={(id, owner) => selectTask(id, owner)}
              onOpenBot={(bot) => selectBot(bot.id)} onOpenDirectory={openDirectory}
              onBotSettings={id => selectBot(id, 'capabilities')} onNewBot={openNewBot} onNewGroup={() => selectBot('groups')} onView={(next) => goView(next)} />}
            footer={<><span>仅本机 · 本地存储</span> <button type="button" className="text-button" onClick={disconnect}>断开连接</button></>}
            home={chiefMain === null ? <div className="shell-placeholder" role="status"><h2 className={loading ? 'sr-only' : undefined}>{loading ? '正在读取…' : '找不到 pipi 的主会话'}</h2>{loading && chatSkeleton}</div> : home ? chatView : null}
            inboxSummary={<InboxPage token={token} active={view === 'inbox'} onCount={setInboxCount} onOpenTask={(id, owner) => { const t = tasks.find(x => x.taskId === id); selectTask(id, t ? ownerOf(t) : owner) }} />}>
          {selectedId === null ? (directory ? <BotDirectory bots={bots} loading={loading} onOpen={selectBot} onSettings={id => selectBot(id, 'capabilities')} onCreate={openNewBot} /> : newSession ? <NewSession key={`new-session:${token}`} bots={bots} busy={creating} onStart={(id, text) => void startSession(id, text)} onGroup={() => selectBot('groups')} />
            : newBot ? <BotCreation key={`new-bot:${token}`} token={token} onCancel={openDirectory} onCreated={(bot, mainTaskId) => {
              setBots((current) => current.some((item) => item.id === bot.id) ? current : [...current, bot])
              // T06: detail defaults to the existing main conversation, never creates another Task.
              if (mainTaskId !== null) setMainSessions(current => ({ ...current, [bot.id]: mainTaskId }))
              selectBot(bot.id)
              reload() }} />
            : botId === 'groups' ? <section className="bot-page" aria-labelledby="groups-title"><h1 id="groups-title">群聊</h1>
              <p className="shell-muted">把几个机器人拉到一起，由管理员分派和验收。</p>
              <GroupCreation key={`group:${token}`} bots={bots} token={token} onCreated={(id) => { requestEpoch.current += 1; setBotId('groups'); setSelectedId(id); setDetail(null); window.history.pushState(null, '', `#bot=groups&task=${id}`); reload() }} />
              <ul className="today-list">{groupTasks.map(t => <li key={t.taskId}><button type="button" className="today-link" onClick={() => selectTask(t.taskId, 'groups')}><span>{t.title}</span><span className="shell-muted small">{t.group?.members.map(m => m.name).join('、')}</span></button></li>)}</ul>
            </section>
            : selectedBot && !home ? botTab === 'chat' ? chatView : <BotTemplatePage key={`bot:${selectedBot.id}:${token}`} bot={selectedBot} token={token} active={botSettingsActive} refreshKey={refresh} tab={botTab} onTab={changeBotTab} onChat={() => selectBot(selectedBot.id)} mainTaskId={mainSessions[selectedBot.id] ?? null}
                onSaved={(bot) => { setBots((current) => current.map((item) => item.id === bot.id ? { ...item, ...bot } : item)); setRefresh((value) => value + 1) }}
                onDeactivate={() => void deactivate(selectedBot)} />
            : <div className="shell-placeholder" role="status"><h2>{loading ? '正在读取…' : '找不到这个机器人'}</h2></div>)
 : home ? null : chatView}
          </UnifiedWorkspace>
        </main>
      )}
    </div>
  )
}
export default App
