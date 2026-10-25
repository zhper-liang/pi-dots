import UnifiedWorkspace from './UnifiedWorkspace'
import FeishuCalendarPanel from './FeishuCalendarPanel'
import GroupIssueControls, {type GroupIssue} from './GroupIssueControls'
import GroupCreation from './GroupCreation'
import CollaborationOverview, {type Overview} from './CollaborationOverview'
import SharedInformationPanel, {type SharedRecord} from './SharedInformationPanel'
import CollaborationPanel, { type Relation } from './CollaborationPanel'
import GroupTaskBoard from './GroupTaskBoard'
import BotCreation from './BotCreation'
import BotTemplatePage from './BotTemplatePage'
import TodaySummary, { type Confirmation } from './TodayPage'
import TaskTimeline from './TaskTimeline'
import { openApproval, openBlocker } from './system-cards.mjs'
import InboxPage from './InboxPage'
import { AutoAppliedCard } from './AutomationControls'
import { MirrorCard, BotSessions, type MirrorMessage } from './MainSession'
import { FindingCard } from './Findings'
import BotAvatar from './BotAvatar'
import { loadLook } from './botLook'
import type { WorkspaceView } from './workspace-navigation.mjs'
import TaskConfigurationMigration from './TaskConfigurationMigration'
import { taskPath } from './taskPath'
import WaitingRecoveryNotice, { type WaitingSnapshot } from './WaitingRecoveryNotice'
import TaskApprovalControls, { type ApprovalState } from './TaskApprovalControls'
import TaskBlockerControls, { type BlockerState } from './TaskBlockerControls'
import TaskCancellationControls from './TaskCancellationControls'
import { SkillHistory, SkillNote, type SkillMessage, type SkillState } from './SkillControls'
import CommandMenu from './CommandMenu'
import type { Command } from './commands.mjs'
import { setAutomationPaused } from './automation'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import './shell.css'
import { taskStatus } from './taskStatus'

type ConfigRef = { botId: string; version: string }
type Bot = { status?: 'active' | 'inactive'; deactivatedAt?: string; id: string; name: string; description: string; configRef: ConfigRef }
type ChatMessage = SkillMessage & { afterControlStop?: boolean; afterCancellation?: boolean; purpose?: string; intermediate?: boolean; targetInputId?: number; appliedAt?: string; deliveryStatus?: 'steer-pending' | 'steer-applied' | 'queued' | 'processing' | 'blocked' | 'waiting' | 'completed' | 'failed' | 'received' | 'cancelled'; queuePosition?: number; id: number; role: 'user' | 'assistant' | 'error' | 'tool' | 'system'; systemKind?: string; requestId?: string; summary?: string; undone?: boolean; findingId?: string; detector?: string; lines?: string[]; findingState?: string; handledTaskId?: number | null; assist?: boolean; assistTaskId?: number | null; callId?: string; toolName?: string; turnId?: number; inReplyTo?: number; arguments?: Record<string, unknown>; result?: { ok: boolean; data?: { simulated?: boolean }; error?: { code: string; message: string } }; assistant?: { content: { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[] }; content: string; createdAt: string; mode?: string; errorCode?: string; execution?: { provider: string; api: string; model: string; thinkingLevel: string; thinking: { type: string }; responseModel?: string; timeoutMs: number } }
type TaskState = { goal: string; completionCriteria: string[]; constraints: string[] }
type MessageControl = { activeInputId: number | null; waitingInputId: number | null; queuedInputIds: number[]; pendingSteers: { entryId: number; targetInputId: number }[]; appliedSteerIds: number[]; cancellationEntryId: number | null }
type Task = {
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
const managedChild = (task: Task) => task.collaborations?.some(r => r.childTaskId === task.taskId && r.reviewRequired) ?? false
const taskInactive = (task: Task) => task.botLifecycle === 'inactive'
const taskCancelled = (task: Task) => Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted'
const deliveryLabels = { blocked: '等待对应问题的回答', cancelled: '已取消 · 原输入记录保留', 'steer-pending': '待插入 · 等待安全边界', 'steer-applied': '已生效 · 当前执行', queued: '已排队', processing: '已接收执行', waiting: '受限等待', completed: '已处理', failed: '处理失败', received: '已接收' }
const tokenKey = 'pidot.api-token'
function savedToken() { try { return sessionStorage.getItem(tokenKey) ?? '' } catch { return '' } }
function hashTask() { const id = new URLSearchParams(location.hash.slice(1)).get('task'); return id && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : null }
function hashBot() { return new URLSearchParams(location.hash.slice(1)).get('bot') }
function hashNewBot() { return new URLSearchParams(location.hash.slice(1)).has('new-bot') }
const opensChat = () => hashTask() !== null || hashBot() !== null || hashNewBot()
// Archive is a persisted server flag (POST …/archive): it only hides, never cancels or deletes.
type TaskGroup = 'active' | 'confirm' | 'done' | 'archived'
const groupLabels: Record<TaskGroup, string> = { active: '进行中', confirm: '等你确认', done: '已完成', archived: '已归档' }
function confirmReason(task: Task): string | null {
  if (taskCancelled(task) || taskInactive(task)) return null
  if (task.waiting?.kind === 'action-outcome') return '结果待核实'
  if (task.approvals?.activeId) return '等待审批'
  if (task.blockers?.activeId) return '等待回答'
  if (task.waiting?.kind === 'limits' || task.runtime.checkpoint?.lastOutcome === 'limited') return '额度受限'
  return null
}
function taskGroup(task: Task, archived: number[]): TaskGroup {
  if (archived.includes(task.taskId)) return 'archived'
  if (confirmReason(task)) return 'confirm'
  if (taskCancelled(task) || taskInactive(task) || task.runtime.status === 'terminal' || task.runtime.status === 'completed') return 'done'
  return 'active'
}
class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.error?.message ?? '请求失败，请稍后重试。', response.status)
  return data
}
function message(error: unknown) { return error instanceof Error ? error.message : '请求失败。' }
const parameterLabels: Record<string, string> = { mode: '会话模式', model: '模型', thinkingLevel: '思考强度', requestTimeoutMs: '请求超时（毫秒）', maxOutputTokens: '单次输出 Token 上限', tools: '工具白名单', toolResources: '允许资源', contextWindows: '已配置模型容量', callLimits: '调用限制' }
function displayParameter(key: string, value: unknown) {
  if (key === 'model' && value === null) return '未接入（旧测试配置）'
  if (key === 'callLimits') return value === null ? '旧快照未设置；执行安全默认上限：模型 20 / 工具 10' : `${JSON.stringify(value)}（每 Task 累计上限）`
  if (key === 'contextWindows') return JSON.stringify(value)
  if (Array.isArray(value)) return value.length ? value.join('、') : '无'
  if (value === 'empty') return '旧版空会话预设（测试续聊兼容）'
  if (key === 'model' && typeof value === 'object' && value !== null) {
    const model = value as { provider?: string; id?: string; api?: string; baseUrl?: string }
    return `${model.provider} / ${model.id} · ${model.api} · ${model.baseUrl}`
  }
  if (value === 'model') return '真实模型回复'
  if (value === 'test') return '确定性测试回复'
  if (value === 'off') return '关闭'
  return String(value)
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
      if (!signal.aborted) onError(error instanceof ApiError ? error : new Error('操作结果未确认，请刷新核对额度与权限，不要直接重复提交。'))
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
  return <section className="execution-controls" aria-label="调用用量与上限">
    <h3>调用用量与上限</h3>{!!task.managementTools?.length && <p>独立管理权限（服务端固定，仅 Chief）：{task.managementTools.join("、")}。业务工具和资源在 Bot 设置中调整。</p>}
    <p>模型 {usage.modelCalls} / {limits.modelCalls} 次 · 工具 {usage.toolCalls} / {limits.toolCalls} 次 · 已知 Token {usage.totalTokens} / {limits.totalTokens ?? '未设阈值'} · 用量未知 {usage.unknownTokenCalls} 次</p>
    {limited && <p role="status" className="limit-notice">受限原因：{task.runtime.checkpoint?.waitingReason}。已保存进度与回执；请提高触发上限并继续原 Task，普通消息不会续额。</p>}
    <details open={limited}>
      <summary>显式提高调用上限</summary>
      <form className="limits-form" key={`${task.taskId}:${JSON.stringify(limits)}`} onSubmit={raise}>
        <label>模型调用上限<input name="modelCalls" aria-label="模型调用上限" type="number" min={limits.modelCalls} max={Number.MAX_SAFE_INTEGER} step="1" required defaultValue={limits.modelCalls} /></label>
        <label>工具调用上限<input name="toolCalls" aria-label="工具调用上限" type="number" min={limits.toolCalls} max={Number.MAX_SAFE_INTEGER} step="1" required defaultValue={limits.toolCalls} /></label>
        {limits.totalTokens !== undefined && <label>累计 Token 阈值<input name="totalTokens" type="number" min={limits.totalTokens} max={Number.MAX_SAFE_INTEGER} step="1" required defaultValue={limits.totalTokens} /></label>}
        {limits.totalTokens !== undefined && usage.unknownTokenCalls > 0 && <label className="token-override"><input type="checkbox" name="removeTokenLimit" />已理解未知用量风险，显式取消 Token 阈值（保留调用硬上限）</label>}
        <p className="muted small">仅修改调用上限，不重置计数。模型请求失败也计次，无自动网络重试；单次输出上限 {String(task.parameters.maxOutputTokens ?? 4096)} Token。Token 按回执累计，可能超出阈值，不是精确费用封顶。</p>
        <button className="primary" disabled={busy || taskCancelled(task) || task.activeInputId !== null || task.runtime.status === 'terminal'}>{busy ? '正在保存…' : limited ? '提高上限并继续原 Task' : '保存提高后的上限'}</button>
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
  const [view, setView] = useState<WorkspaceView>(() => opensChat() ? 'chats' : 'today')
  const [newBot, setNewBot] = useState(hashNewBot)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [inboxCount, setInboxCount] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(token))
  const [detailError, setDetailError] = useState('')
  const [creating, setCreating] = useState(false)
  const [stateSavingId, setStateSavingId] = useState<number | null>(null)
  const stateSavingRef = useRef(false)
  const [targets, setTargets] = useState<Record<number,string>>({})
  const directedRequests = useRef<Record<number,{signature:string;requestId:string}>>({})
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [sendingId, setSendingId] = useState<number | null>(null)
  const sendingRef = useRef(false)
  const [refresh, setRefresh] = useState(0)
  const historyEndRef = useRef<HTMLDivElement>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [pane, setPane] = useState<'chat' | 'timeline'>('chat')
  // "/" menu: the Skill picked for the next message of each Task, and the composer it reads keys from.
  const [pickedSkill, setPickedSkill] = useState<Record<number, { id: string; label: string }>>({})
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // PLAN §8.4 home (P-13): the "today" view is the day summary above the Chief main session.
  const home = view === 'today'
  const chiefMain = mainSessions.chief ?? null
  const activeId = home ? chiefMain : selectedId
  const detail = loadedDetail?.taskId === activeId ? loadedDetail : null
  const latestMessageId = detail?.messages.at(-1)?.id
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
  useEffect(() => {
    if (!detailsOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetailsOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailsOpen])
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
    setDrafts({}); setToken(''); setDraftToken(''); setBots([]); setTasks([]); setDetail(null)
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
  function selectBot(id: string) {
    if (id === botId && selectedId === null && !newBot && view === 'chats') return
    requestEpoch.current += 1
    window.history.pushState(null, '', `#bot=${encodeURIComponent(id)}`)
    setNewBot(false); setView('chats'); setPane('chat'); setBotId(id); setSelectedId(null); setDetail(null); setDetailError(''); setError('')
  }
  function selectTask(id: number, owner = botId) {
    setView('chats'); setNewBot(false); setPane('chat')
    if (id === selectedId && owner === botId) return
    requestEpoch.current += 1
    window.history.pushState(null, '', `#bot=${encodeURIComponent(owner)}&task=${id}`)
    setBotId(owner); setDetail(null); setDetailError(''); setSelectedId(id)
  }
  // Going home clears the Task hash so a reload lands on the home page again.
  function goView(next: WorkspaceView) {
    if (next === 'today' && view !== 'today') {
      requestEpoch.current += 1
      if (location.hash) window.history.pushState(null, '', location.pathname + location.search)
      setSelectedId(null); setDetailError(''); setPane('chat')
    }
    setView(next)
  }
  const ownerOf = (task: Task) => task.kind === 'group' ? 'groups' : task.bot.id
  function openNewBot() {
    requestEpoch.current += 1
    window.history.pushState(null, '', '#new-bot')
    setNewBot(true); setView('chats'); setSelectedId(null); setDetail(null)
  }
  async function toggleArchive(task: Task) {
    try {
      const { task: updated } = await api<{ task: Task }>(taskPath(task, '/archive'), token, { method: 'POST', body: JSON.stringify({ archived: !task.archived }) })
      setDetail(current => current?.taskId === updated.taskId ? { ...current, archived: updated.archived } : current)
      setTasks(current => current.map(t => t.taskId === updated.taskId ? { ...t, archived: updated.archived } : t))
    } catch (e) { setNotice(e instanceof ApiError ? e.message : '归档结果未确认，请刷新后查看。') }
  }
  function reload() { setLoading(true); setDetailError(''); setRefresh((value) => value + 1) }

  useEffect(() => {
    const update = () => { requestEpoch.current += 1; setDetail(null); setDetailError(''); setSelectedId(hashTask()); setBotId(hashBot() ?? 'chief'); setNewBot(hashNewBot()); setPane('chat'); if (opensChat()) setView('chats'); else setView(current => current === 'chats' ? 'today' : current); setRefresh(value => value + 1) }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function load() { return Promise.all([
      api<{ bots: Bot[]; mainSessions?: Record<string, number> }>('/api/bots', token, { signal: controller.signal }),
      api<{ tasks: Task[] }>('/api/tasks', token, { signal: controller.signal }),
    ]).then(([catalog, list]) => {
      if (controller.signal.aborted) return
      setBots(catalog.bots); setMainSessions(catalog.mainSessions ?? {}); setTasks(list.tasks)
    }).catch((err) => { if (!controller.signal.aborted) report(err) })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => { void load() }, 1500) } }) }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [token, refresh])

  useEffect(() => {
    if (!token || activeId === null) return
    const controller = new AbortController()
    const epoch = requestEpoch.current
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const { task } = await api<{ task: Task }>(home ? `/api/bots/chief/tasks/${activeId}` : hashBot() && botId !== 'groups' ? `/api/bots/${encodeURIComponent(botId)}/tasks/${activeId}` : `/api/tasks/${activeId}`, token, { signal: controller.signal })
        if (!controller.signal.aborted && epoch === requestEpoch.current) {
          if (!home && !hashBot()) { setBotId(task.kind === 'group' ? 'groups' : task.bot.id); window.history.replaceState(null, '', `#bot=${encodeURIComponent(task.kind === 'group' ? 'groups' : task.bot.id)}&task=${task.taskId}`) }
          setDetail(task); setTasks((current) => current.map((item) => item.taskId === task.taskId ? task : item)); setDetailError('')
        }
      } catch (err) {
        if (!controller.signal.aborted && epoch === requestEpoch.current) { report(err); setDetailError(message(err)); return }
      }
      if (!controller.signal.aborted && epoch === requestEpoch.current) timer = setTimeout(load, 750)
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [token, botId, activeId, home, refresh])

  async function send(event: FormEvent, steering = false) {
    event.preventDefault()
    if (!detail || sendingRef.current || stateSavingRef.current) return
    const id = detail.taskId
    const content = drafts[id] ?? ''
    if (!content.trim()) return
    const epoch = requestEpoch.current
    sendingRef.current = true; setSendingId(id); setError('')
    try {
      const target = targets[id] ?? ''
      const signature = JSON.stringify([content,target])
      try { if (!directedRequests.current[id]) directedRequests.current[id] = JSON.parse(sessionStorage.getItem(`pidot.directed-input.${id}`) ?? 'null') } catch { /* storage unavailable */ }
      if (!directedRequests.current[id] || directedRequests.current[id].signature !== signature) directedRequests.current[id] = {signature,requestId:crypto.randomUUID()}
      if (!steering && detail.group && target) { try { sessionStorage.setItem(`pidot.directed-input.${id}`,JSON.stringify(directedRequests.current[id])) } catch { /* in-memory retry remains */ } }
      const skill = !steering && !detail.group ? pickedSkill[id] : undefined
      await api(taskPath(detail, `/${steering ? 'steer' : 'messages'}`), token, { method: 'POST', body: JSON.stringify({ message: content, ...(skill ? { skillId: skill.id } : {}), ...(!steering && detail.group && target ? {targetBotId:target,requestId:directedRequests.current[id].requestId} : {}) }) })
      if (skill) setPickedSkill(current => { const next = { ...current }; delete next[id]; return next })
      delete directedRequests.current[id]
      try { sessionStorage.removeItem(`pidot.directed-input.${id}`) } catch { /* storage unavailable */ }
      if (epoch !== requestEpoch.current) return
      setDrafts((current) => current[id] === content ? { ...current, [id]: '' } : current)
    } catch (err) {
      if (epoch !== requestEpoch.current) return
      report(err)
      if (!(err instanceof ApiError)) setError('发送结果未确认。请先刷新查看历史，避免重复发送；系统不会自动重发。')
    } finally {
      sendingRef.current = false; setSendingId(null)
      if (epoch === requestEpoch.current) setRefresh((value) => value + 1)
    }
  }

  // "/" menu pick: a Skill applies to the next message; actions call the same handlers as their buttons.
  function runCommand(command: Command) {
    if (!detail) return
    const id = detail.taskId
    setDrafts(current => ({ ...current, [id]: '' }))
    if (command.kind === 'skill' && command.skillId) { setPickedSkill(current => ({ ...current, [id]: { id: command.skillId!, label: command.label } })); composerRef.current?.focus(); return }
    if (command.id === 'new-task') void create(undefined, detail.bot.id)
    else if (command.id === 'pane') setPane(current => current === 'chat' ? 'timeline' : 'chat')
    else if (command.id === 'pause') {
      if (window.confirm('暂停全部自动化？例行任务会停下，自动执行改为先问你。恢复要到设置页。')) setAutomationPaused(token, true).then(() => setNotice('已暂停全部自动化。恢复在设置页。'), (e: unknown) => setError(message(e)))
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
        method: 'POST', body: JSON.stringify({ botId: forBot, ...(title.trim() ? { title: title.trim() } : {}) }),
      })
      if (epoch !== requestEpoch.current) return
      setTitle(''); selectTask(task.taskId, forBot); reload()
    } catch (err) {
      if (epoch !== requestEpoch.current) return
      report(err)
      if (!(err instanceof ApiError)) setError('创建结果未确认。请先刷新会话列表核实，避免重复创建。')
      reload()
    } finally { creatingRef.current = false; setCreating(false) }
  }

  // PLAN §8.5 / P-15: "接着聊" opens a new derived Task in this Bot's main session; the run stays as it was.
  const [followingUp, setFollowingUp] = useState(false)
  async function followUp(task: Task) {
    if (followingUp) return
    setFollowingUp(true); setError('')
    try {
      const { data } = await api<{ data: { taskId: number } }>(taskPath(task, '/follow-up'), token, { method: 'POST', body: '{}' })
      selectTask(data.taskId, task.bot.id); reload()
    } catch (err) { report(err); if (!(err instanceof ApiError)) setError('结果未确认，请刷新后在 Bot 主会话里查看，不要重复点击。') }
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
      if (!(err instanceof ApiError)) setError('更新结果未确认。请刷新核对任务状态与来源记录，不要直接重复提交。')
    } finally { stateSavingRef.current = false; setStateSavingId(null) }
  }

  const botTasks = tasks.filter((task) => botId === 'groups' ? task.kind === 'group' : task.kind !== 'group' && task.bot.id === botId)
  const selectedBot = bots.find((bot) => bot.id === botId)
  const status = detail ? taskStatus(detail, sendingId === detail.taskId) : null
  const archived = tasks.filter(t => t.archived).map(t => t.taskId)
  const confirmations: Confirmation[] = tasks.filter(t => !archived.includes(t.taskId)).flatMap(t => { const reason = confirmReason(t); return reason ? [{ taskId: t.taskId, title: t.title, botName: t.bot.name, reason }] : [] })
  const chiefBot = bots.find(b => b.id === 'chief')
  const peers = bots.filter(b => b.id !== 'chief')
  const groupTasks = tasks.filter(t => t.kind === 'group')
  const needle = query.trim().toLowerCase()
  const listed = tasks.filter(t => t.kind !== 'group' && (!needle || t.title.toLowerCase().includes(needle) || t.bot.name.toLowerCase().includes(needle)))
  const taskRow = (task: Task) => <button type="button" key={task.taskId} className={`task-link ${selectedId === task.taskId ? 'selected' : ''}`} onClick={() => selectTask(task.taskId, ownerOf(task))} aria-current={selectedId === task.taskId ? 'page' : undefined}>
    {task.kind !== 'group' && <BotAvatar name={task.bot.name} look={loadLook(task.bot.id)} size={22} />}
    <span className="task-link-text"><strong>{task.title}</strong><span>{task.bot.name}{taskInactive(task) ? ' · Bot 已停用' : ''}{taskCancelled(task) ? ' · 已取消' : confirmReason(task) ? ` · ${confirmReason(task)}` : task.activeInputId !== null ? ' · 执行中' : (task.messageControl?.queuedInputIds.length ?? 0) > 0 ? ' · 有排队消息' : ''}</span></span>
  </button>
  const chiefNode = <button type="button" className="shell-chief-button" aria-label="Chief：开始新任务" disabled={creating || chiefBot?.status === 'inactive'} onClick={() => void create(undefined, 'chief')}>
    <BotAvatar name="Chief" look={loadLook('chief')} size={28} /><span className="shell-label"><strong>★ {chiefBot?.name ?? 'Chief'}</strong><small>{creating ? '正在创建…' : '主管 · 开始新任务'}</small></span>
  </button>
  const sidebarNode = <>
    <BotSessions bots={bots} mainSessions={mainSessions} selectedId={selectedId} onOpen={(id, owner) => selectTask(id, owner)} />
    <section className="shell-section" aria-labelledby="side-tasks">
      <div className="shell-section-head"><h2 id="side-tasks">任务</h2><button type="button" className="shell-icon-button" aria-label="刷新任务列表" title="刷新" onClick={() => { setError(''); reload() }} disabled={loading} data-stay>↻</button></div>
      <label htmlFor="task-search" className="sr-only">搜索任务</label>
      <input id="task-search" type="search" className="shell-search" placeholder="搜索任务" value={query} onChange={e => setQuery(e.target.value)} />
      {loading && tasks.length === 0 && <p className="shell-list-empty">正在读取…</p>}
      {!loading && listed.length === 0 && <p className="shell-list-empty">{needle ? '没有匹配的任务' : '还没有任务'}</p>}
      {(['confirm', 'active', 'done', 'archived'] as TaskGroup[]).map(g => {
        const items = listed.filter(t => taskGroup(t, archived) === g)
        if (!items.length) return null
        const list = <nav aria-label={groupLabels[g]} className="shell-task-list">{items.map(taskRow)}</nav>
        return g === 'done' || g === 'archived' ? <details key={g} className="shell-group"><summary>{groupLabels[g]} · {items.length}</summary>{list}</details>
          : <div key={g} className="shell-group"><h3>{groupLabels[g]} · {items.length}</h3>{list}</div>
      })}
    </section>
    <section className="shell-section" aria-labelledby="side-groups">
      <div className="shell-section-head"><h2 id="side-groups">群聊</h2><button type="button" className="shell-icon-button" aria-label="新建群聊" title="新建群聊" onClick={() => selectBot('groups')}>＋</button></div>
      <nav aria-label="群聊列表" className="shell-task-list">{groupTasks.filter(t => !archived.includes(t.taskId)).map(taskRow)}</nav>
    </section>
    <section className="shell-section" aria-labelledby="side-bots">
      <div className="shell-section-head"><h2 id="side-bots">Bot 模板</h2><button type="button" className="shell-text-add" aria-label="新建 Bot" onClick={openNewBot}>＋新建</button></div>
      <nav aria-label="Bot 模板" className="shell-task-list">{peers.map(bot => <button type="button" key={bot.id} className={`task-link ${view === 'chats' && !newBot && selectedId === null && botId === bot.id ? 'selected' : ''}`} aria-current={view === 'chats' && !newBot && selectedId === null && botId === bot.id ? 'page' : undefined} onClick={() => selectBot(bot.id)}>
        <BotAvatar name={bot.name} look={loadLook(bot.id)} size={22} /><span className="task-link-text"><strong>{bot.name}</strong>{bot.status === 'inactive' && <span>已停用</span>}</span>
      </button>)}</nav>
    </section>
  </>
  async function deactivate(target: Bot) {
    try { const result = await api<{ bot: Bot }>(`/api/bots/${target.id}/deactivate`, token, { method: 'POST', body: JSON.stringify({ confirm: true }) }); setBots(current => current.map(b => b.id === target.id ? result.bot : b)); setRefresh(v => v + 1) } catch (e) { report(e) }
  }

  const settledCount = detail ? (detail.approvals?.items ?? []).filter(i => !openApproval(i, taskCancelled(detail))).length
    + [...(detail.blockers?.items ?? []), ...(detail.groupId ? [] : detail.blockers?.related ?? [])].filter(i => !openBlocker(i, taskCancelled(detail))).length : 0
  const chatView = !detail ? <div className="shell-placeholder" role="status"><h2 id="detail-title">{detailError ? '无法读取会话' : '正在读取会话…'}</h2>{detailError && <p>{detailError}。请刷新后核对记录。</p>}</div> : <div className={`shell-chat ${detailsOpen ? 'details-open' : ''}`}>
            <header className="shell-chat-header">
              <h2 id="detail-title">{detail.title}</h2>
              <span className={`status-badge tone-${status!.tone}`} role="status">{status!.label}</span>
              <div className="shell-filter shell-pane-toggle" role="group" aria-label="会话视图"><button type="button" aria-pressed={pane === 'chat'} onClick={() => setPane('chat')}>对话</button><button type="button" aria-pressed={pane === 'timeline'} onClick={() => setPane('timeline')}>时间线</button></div>
              {detail.kind !== 'main' && <button type="button" className="text-button shell-archive" title="归档只是隐藏，不会取消或删除任务" onClick={() => void toggleArchive(detail)}>{detail.archived ? '取消归档' : '归档'}</button>}
              {!detail.group && <button type="button" className="text-button" onClick={() => selectBot(detail.bot.id)}>Bot 设置</button>}
              <button type="button" className="shell-icon-button" aria-label="会话详情" aria-expanded={detailsOpen} aria-controls="chat-details" onClick={() => setDetailsOpen(v => !v)}>ⓘ</button>
            </header>
            <div className="shell-chat-column">
              {detail.group && <p className="shell-note" role="status">群管理员：{detail.bot.name} · 成员：{detail.group.members.map(b => `${b.name}${b.status === 'inactive' ? '（已停用）' : ''}`).join('、')}。可选择单个 @ 目标，管理员统一收取及验收。</p>}
              {/* Approvals, blockers and unknown outcomes stay in the message flow as prominent cards. */}
              <div className="shell-cards">
                <InboxPage key={`proposals:${detail.taskId}:${token}`} proposalTaskId={detail.taskId} token={token} active={true} onCount={() => {}} onOpenTask={selectTask} />
                <CollaborationOverview key={`overview:${detail.taskId}`} task={detail} token={token} onError={report} onUpdated={(updated)=>{setDetail(current=>current?.taskId===updated.taskId?updated:current);setRefresh(v=>v+1)}} />
                <fieldset disabled={taskInactive(detail)} className="lifecycle-controls"><GroupIssueControls items={detail.groupIssues} token={token} onError={report} onRefresh={() => setRefresh(value => value + 1)} />{settledCount > 0 && <details className="shell-settled"><summary>已处理的审批与补充 · {settledCount}</summary><TaskApprovalControls scope="settled" key={`approval-settled:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current); setTasks((current) => current.map((task) => task.taskId === updated.taskId ? updated : task))
                }} /><TaskBlockerControls scope="settled" key={`blocker-settled:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} /></details>}
                {detail.group && detail.groupId && <GroupTaskBoard groupId={detail.groupId} groupTaskId={detail.taskId} token={token} relations={detail.collaborations} members={detail.group.members} archivedIds={archived} onError={report} onArchived={() => setRefresh(v => v + 1)} />}
                <CollaborationPanel taskId={detail.taskId} items={detail.collaborations} />
                <SharedInformationPanel items={detail.sharedInformation} />
                </fieldset>
                <WaitingRecoveryNotice recovered={detail.recoveryHistory?.at(-1)?.waiting} current={detail.waiting} cancelled={taskCancelled(detail)} />
                {!taskCancelled(detail) && detail.runtime.checkpoint?.lastOutcome === 'limited' && <p className="limit-notice" role="status">已达到调用上限：{detail.runtime.checkpoint.waitingReason}。进度已保存，请在 <button type="button" className="text-button" onClick={() => setDetailsOpen(true)}>会话详情</button> 中提高上限后继续。</p>}
              </div>
              {pane === 'timeline' ? <TaskTimeline task={detail} /> : <><ol className="messages" aria-label="会话历史" aria-live="polite">
                {detail.messages.map((item) => item.role === 'system' ? <li id={`message-${item.id}`} key={item.id} className="message message-system">
                  {item.systemKind === 'auto-applied' && item.requestId ? <AutoAppliedCard token={token} requestId={item.requestId} summary={item.summary ?? item.content} undone={item.undone} createdAt={item.createdAt} />
                    : item.systemKind === 'finding' && item.findingId ? <FindingCard token={token} finding={{ id: item.findingId, detector: item.detector ?? '', summary: item.summary ?? item.content, lines: item.lines, state: item.findingState, handledTaskId: item.handledTaskId, assist: item.assist, assistTaskId: item.assistTaskId }} onOpenTask={(id, owner) => selectTask(id, owner)} />
                    : item.systemKind === 'mirror' ? <MirrorCard token={token} item={item as unknown as MirrorMessage} onOpenTask={(id, owner) => selectTask(id, owner)} />
                    : item.systemKind === 'skill' ? <SkillNote item={item} />
                    : <p className={item.systemKind === 'context-floor' ? 'shell-muted small' : undefined}>{item.content}</p>}
                </li> : <li id={`message-${item.id}`} key={item.id} className={`message message-${item.role}`}>
                  <div className="message-heading">{item.role === 'user' && item.skillId && <span className="skill-tag">Skill · {detail.messages.find(m => m.systemKind === 'skill' && m.inReplyTo === item.id)?.skillName ?? item.skillId}</span>}<strong>{item.role === 'user' ? '你' : item.role === 'error' ? '执行失败' : item.role === 'tool' ? `工具回执 · ${item.toolName === 'calendar_read_event' ? '模拟日程详情' : item.toolName === 'calendar_reschedule_event' ? '模拟改期审批登记' : item.toolName === 'calendar_read_schedule' ? '模拟日程列表' : item.toolName}` : item.assistant ? '请求调用工具' : `${detail.bot.name}${item.mode === 'model' ? '' : ' · 测试回复'}`}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>{item.intermediate && <span className="delivery-status">插入前已返回 · 保留真实结果</span>}{item.role === 'user' && item.deliveryStatus && <span className={`delivery-status delivery-${item.deliveryStatus}`} data-testid={`delivery-${item.id}`}>{taskCancelled(detail) && item.deliveryStatus === 'steer-applied' ? '已生效 · 取消前记录' : taskCancelled(detail) && item.deliveryStatus === 'steer-pending' ? '未生效插入 · 已取消，记录保留' : taskCancelled(detail) && item.deliveryStatus === 'queued' ? '未处理 · 已取消，不会执行' : deliveryLabels[item.deliveryStatus]}{item.deliveryStatus === 'queued' ? ` · 第 ${item.queuePosition} 条` : ''}</span>}</div>
                  {item.assistant ? <div className="tool-calls">{item.content && <p>{item.content}</p>}{item.assistant.content.filter((block) => block.type === 'toolCall').map((call) => <details key={call.id}><summary>工具调用 · {call.name}</summary><p className="muted small">调用 ID：{call.id} · 工具回合：{item.id} · 用户消息：{item.inReplyTo}</p><pre>{JSON.stringify(call.arguments, null, 2)}</pre></details>)}</div> : item.role === 'tool' ? <div className="tool-receipt"><p>{item.result?.ok ? item.toolName === 'calendar_reschedule_event' ? '改期意图已登记 · 实际执行状态请看对应审批卡片' : item.toolName === 'report_blocker' ? '问题已登记 · 等待当前处理人回答' : '执行成功 · 按实际工具回执记录' : `未成功 · ${item.result?.error?.code}`}</p>{item.result?.ok && item.toolName === 'bot_manage' && (() => {
                    const data = item.result.data as { bot?: { id: string; name: string }; operationId?: string; action?: string; previous?: { version: string }; next?: { version: string } } | undefined
                    return data?.bot ? <div className="management-result"><strong>Chief 管理已落盘 · {data.action}</strong><p>操作 {data.operationId} · {data.previous?.version ?? '新建'} → {data.next?.version}</p><button type="button" onClick={() => selectBot(data.bot!.id)}>进入 {data.bot.name} · 查看历史与管理记录</button></div> : null
                  })()}<details><summary>调用参数与执行结果</summary><p className="muted small">调用 ID：{item.callId} · 工具回合：{item.turnId} · 用户消息：{item.inReplyTo}</p><pre>{JSON.stringify({ arguments: item.arguments, result: item.result }, null, 2)}</pre></details></div> : <p className="message-body">{item.content}</p>}
                  {item.deliveryStatus === 'queued' && <button type="button" className="text-button" disabled={Boolean(item.skillId) || Boolean(detail.scheduledWorkflow) || managedChild(detail) || sendingId !== null || stateSavingId !== null || Boolean(detailError) || (taskCancelled(detail) || taskInactive(detail)) || (Boolean(detail.blockers?.activeId) || Boolean(detail.approvals?.activeId)) || !['pending', 'running'].includes(detail.runtime.status)} onClick={() => void convertToSteer(item.id)}>转为插入当前执行</button>}
                  {item.afterControlStop && !item.afterCancellation && <small className="late-receipt">停止/停用后真实回执 · 仅留档，不恢复执行</small>}
                  {item.afterCancellation && <small className="late-receipt">取消后返回的真实回执 · {item.purpose === 'context-compaction' ? '历史压缩请求' : '不恢复执行'}</small>}
                  {item.errorCode && <small>{item.errorCode}</small>}
                  {item.execution && <details><summary>请求参数</summary><p className="muted small">{item.execution.provider} / {item.execution.model} · {item.execution.api} · thinking.type={item.execution.thinking?.type ?? '未记录'} · 超时 {item.execution.timeoutMs}ms{item.execution.responseModel ? ` · 服务端报告模型 ${item.execution.responseModel}` : ''}</p></details>}
                </li>)}
              </ol></>}
              {pane === 'chat' && detail.messages.length === 0 && <div className="conversation-empty"><h3>会话已就绪</h3><p>在下方输入第一条消息{detail.parameters.mode === 'model' ? '' : '（测试模式，回复非模型生成）'}。</p></div>}
              {!taskCancelled(detail) && !taskInactive(detail) && !detail.blockers?.activeId && !detail.approvals?.activeId && detail.activeInputId !== null && <p className="shell-typing" role="status">正在回复… 继续发送的消息会排队，不打断当前执行。</p>}
              {taskInactive(detail) && <p className="queue-notice" role="status">Bot 已停用：不再执行排队输入、插入或审批；原等待事项保留。迟到结果如实保存，已发生效果不会回滚，未知结果仍未知。</p>}
              {Boolean(detail.queueLength) && <p className="queue-notice" role="status" data-testid="queue-status">已排队 {detail.queueLength} 条消息。{taskCancelled(detail) ? 'Task 已取消：消息保留，不会自动执行或恢复。' : detail.waiting?.kind === 'action-outcome' ? '等待原操作结果核实：普通消息不算核实或重新批准，不会自动重做。' : detail.approvals?.activeId ? '等待对应操作审批：普通消息不会被当作批准。' : detail.blockers?.activeId ? '等待对应问题回答：普通消息保留在队列，不会解除阻塞。' : detail.runtime.checkpoint?.lastOutcome === 'limited' ? 'Task 受限等待：请显式提高上限并继续原输入，普通消息不会解除等待。' : '当前执行结束后逐条处理。'}请勿重复提交。</p>}
              {detailError && <p role="alert" className="shell-alert-card">读取状态失败：{detailError}。请刷新后核对记录。</p>}
              {Boolean(detail.steerLength) && <p className="queue-notice" data-testid="steer-status">{taskCancelled(detail) ? '保留未生效插入' : '待插入'} {detail.steerLength} 条：{taskCancelled(detail) ? 'Task 已取消，不会自动采纳。' : '将在下一安全边界生效。'}已发生的动作保留真实结果。</p>}
              {detail.scheduledWorkflow && <div className="shell-note routine-run-note" role="status"><span>{detail.scheduledWorkflow.test ? '这是一次测试运行（只读，结果不投递）。' : '这是例行任务的一次运行。'}这里不能追加消息，可查看结果、提高额度或取消。</span>
                <button type="button" className="primary" disabled={followingUp} onClick={() => void followUp(detail)}>{followingUp ? '正在打开…' : '接着聊'}</button></div>}
              {/* D-11: cards waiting for you sit right above the composer, visible after auto-scroll. */}
              <fieldset disabled={taskInactive(detail)} className="lifecycle-controls shell-pending" aria-label="等你处理"><TaskApprovalControls scope="open" key={`approval-open:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current); setTasks((current) => current.map((task) => task.taskId === updated.taskId ? updated : task))
                }} /><TaskBlockerControls scope="open" key={`blocker-open:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} /></fieldset>
              <form className="message-form shell-composer" onSubmit={(event) => void send(event)}>
                {detail.group && <div className="shell-composer-target"><label htmlFor="group-target">@</label><select id="group-target" value={targets[detail.taskId] ?? ''} onChange={e => setTargets(v => ({...v,[detail.taskId]:e.target.value}))}><option value="">管理员直接处理</option>{detail.group.members.map(b => <option key={b.id} value={b.id} disabled={b.status === 'inactive'}>{b.name}{b.id === detail.bot.id ? '（管理员）' : ''}{b.status === 'inactive' ? '（已停用）' : ''}</option>)}</select></div>}
                <label htmlFor="message" className="sr-only">发送消息</label>
                {pickedSkill[detail.taskId] && <div className="skill-chip" role="status">这条消息按 Skill「{pickedSkill[detail.taskId].label}」处理<button type="button" className="shell-icon-button" aria-label="不用这个 Skill" onClick={() => setPickedSkill(current => { const next = { ...current }; delete next[detail.taskId]; return next })}>×</button></div>}
                <CommandMenu task={detail} token={token} draft={drafts[detail.taskId] ?? ''} inputRef={composerRef} onPick={runCommand} />
                <textarea ref={composerRef} role="combobox" aria-autocomplete="list" aria-haspopup="listbox" id="message" rows={2} maxLength={4000} value={drafts[detail.taskId] ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [detail.taskId]: event.target.value }))} placeholder={`给 ${detail.bot.name} 发消息…（打 / 看命令）`} disabled={Boolean(detail.scheduledWorkflow) || managedChild(detail) || (taskCancelled(detail) || taskInactive(detail)) || sendingId === detail.taskId} />
                <div className="message-controls"><span className="muted small">{(drafts[detail.taskId] ?? '').length} / 4000</span>
                  {(detail.activeInputId !== null || detail.runtime.checkpoint?.lastOutcome === 'limited') && <button type="button" className="steer-button" title="插入不撤销已发生动作，也不代表批准" disabled={Boolean(pickedSkill[detail.taskId]) || Boolean(detail.scheduledWorkflow) || managedChild(detail) || sendingId !== null || stateSavingId !== null || Boolean(detailError) || (taskCancelled(detail) || taskInactive(detail)) || (Boolean(detail.blockers?.activeId) || Boolean(detail.approvals?.activeId)) || !['pending', 'running'].includes(detail.runtime.status) || !(drafts[detail.taskId] ?? '').trim()} onClick={(event) => void send(event, true)}>插入当前执行</button>}
                  <button className="primary" disabled={Boolean(detail.scheduledWorkflow) || managedChild(detail) || sendingId !== null || stateSavingId !== null || Boolean(detailError) || (taskCancelled(detail) || taskInactive(detail)) || !['pending', 'running'].includes(detail.runtime.status) || !(drafts[detail.taskId] ?? '').trim()}>{managedChild(detail) ? '由绑定主管验收 / 返工' : taskInactive(detail) ? 'Bot 已停用' : taskCancelled(detail) ? 'Task 已取消' : detail.activeInputId !== null || detail.runtime.checkpoint?.lastOutcome === 'limited' ? '加入队列' : '发送'}</button></div>
                {managedChild(detail) && <p className="muted small steer-help">受管子任务仅由绑定主管发起返工；信息回答、审批及取消仍从各自事项处理。</p>}
              </form>
              <div ref={historyEndRef} />
            </div>
            <aside id="chat-details" className="shell-details" aria-label="会话详情" hidden={!detailsOpen}>
              <div className="shell-details-header"><h3>会话详情</h3><button type="button" className="shell-icon-button" aria-label="关闭会话详情" onClick={() => setDetailsOpen(false)}>×</button></div>
              <SkillHistory state={detail.skillState} />
<p className="muted small">{detail.parameters.mode === 'model' ? (Array.isArray(detail.parameters.tools) && detail.parameters.tools.some((name: string) => name.startsWith('calendar_feishu_')) ? '真实模型持续对话 · 按 Bot 当前工具、资源和规则使用飞书应用日历；默认删除先问，其余直接做。外部内容仅作资料。' : '真实模型持续对话 · 使用 Bot 当前工具、资源和规则；默认删除先问，其余直接做。') : '确定性测试对话 · 非模型输出。旧会话保留固定配置，不自动升级为真实模型。'}</p>
                {detail.kind !== 'main' && <TaskCancellationControls key={`cancel:${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} />}
                {!taskInactive(detail) && !detail.scheduledWorkflow && detail.kind !== 'main' && <TaskConfigurationMigration key={`migration:${detail.bot.id}:${detail.taskId}:${token}`} task={detail} token={token} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} />}
                <fieldset disabled={taskInactive(detail) || Boolean(detail.scheduledWorkflow)} className="lifecycle-controls"><ExecutionControls key={`${detail.taskId}:${token}`} task={detail} token={token} onError={report} onUpdated={(updated) => {
                  setDetail((current) => current?.taskId === updated.taskId ? updated : current)
                  setRefresh((value) => value + 1)
                }} /></fieldset>
                <details className="task-context">
                  <summary>当前任务目标、完成标准与有效限制</summary>
                  <p className="muted small">状态由你明确保存，每轮重新组装；普通消息不会自动改写。工具、资源与规则按 Bot 当前设置实时生效；模型与提示词可通过配置迁移更新。</p>
                  <dl className="task-state-view">
                    <dt>任务目标</dt><dd>{detail.taskState?.goal ?? detail.title}</dd>
                    <dt>完成标准</dt><dd>{detail.taskState?.completionCriteria.join('；') || '尚未单独记录'}</dd>
                    <dt>有效限制</dt><dd>{detail.taskState?.constraints.join('；') || '尚未单独记录'}</dd>
                  </dl>
                  <p className="muted small">{detail.taskStateSources ? Object.entries(detail.taskStateSources).map(([key, source]) => `${({ goal: '目标', completionCriteria: '完成标准', constraints: '限制' } as Record<string, string>)[key]}：${source.type === 'user-request' ? '用户明确保存' : source.type.startsWith('legacy-') ? '旧卡兼容' : 'Bot 默认'}${source.entryId ? ` · 记录 #${source.entryId}` : ` · ${source.source ?? '未记录'}`}`).join(' / ') : '旧 Task 以原任务卡标题为目标，不改写旧配置或补造来源。'}</p>
                  {detail.scheduledWorkflow && <p role="status">定时只读执行：固定输入/提示不能追加、插入或迁移。可查看原结果、提高原Task额度或取消当前Task；未来计划须单独管理。</p>}
                <form className="message-form" key={`${detail.taskId}:${JSON.stringify(detail.taskState)}`} onSubmit={updateTaskState}>
                    <label htmlFor="task-goal">任务目标</label>
                    <textarea id="task-goal" name="goal" required maxLength={4000} rows={2} defaultValue={detail.taskState?.goal ?? detail.title} />
                    <label htmlFor="task-criteria">完成标准（每行一项，最多 20 项）</label>
                    <textarea id="task-criteria" name="completionCriteria" rows={2} defaultValue={detail.taskState?.completionCriteria.join('\n') ?? ''} />
                    <label htmlFor="task-constraints">有效限制（每行一项，空白表示清除）</label>
                    <textarea id="task-constraints" name="constraints" rows={2} defaultValue={detail.taskState?.constraints.join('\n') ?? ''} />
                    <div><button className="primary" disabled={Boolean(detail.scheduledWorkflow) || (taskCancelled(detail) || taskInactive(detail)) || stateSavingId === detail.taskId || sendingId === detail.taskId || detail.activeInputId !== null || detail.runtime.status === 'terminal' || Boolean(detailError)}>{stateSavingId === detail.taskId ? '正在保存…' : '保存任务状态'}</button></div>
                  </form>
                  {detail.taskStateHistory?.map((entry) => <p className="muted small" key={entry.id}>记录 #{entry.id} · {new Date(entry.createdAt).toLocaleString('zh-CN')} · {JSON.stringify(entry.changes)}</p>)}
                </details>
                <details className="tool-status" data-testid="compaction-status"><summary>上下文压缩 · 已完成 {detail.compaction?.revision ?? 0} 次</summary>
                  <p>{detail.contextPolicy ? `当前模型配置容量 ${detail.contextPolicy.contextWindow} Token；估算达到 ${detail.contextPolicy.triggerTokens} 时压缩，预留输出 ${detail.contextPolicy.outputTokens} 和安全空间 ${detail.contextPolicy.reserveTokens}。估算不是账单。` : '当前模型未配置经核实的容量，自动压缩未启用；服务端可通过 PIDOT_CONTEXT_WINDOWS 为新 Task 按模型登记容量，旧快照不变。'}</p>
                  <p>摘要调用和用量计入 Task 累计限制；原始历史、工具回执和产物不删除。摘要仅为历史资料，当前任务卡和活动 Skill 仍是规则来源。</p>
                  {detail.compaction?.latest && <><p>最新检查点 #{detail.compaction.latest.entryId} · {detail.compaction.latest.createdAt}</p><pre className="skill-rules">{detail.compaction.latest.summary}</pre></>}
                </details>
                <details className="tool-status"><summary>工具权限与调用用量</summary><p>已安装：{detail.toolSets?.installed.join('、') || '无'}；Bot 已分配：{detail.toolSets?.assigned?.join('、') || '无'}；即时有效：{detail.toolSets?.authorized.join('、') || '无'}；本轮可展示：{detail.toolSets?.displayed.join('、') || '无'}</p><p>每 Task 累计：模型 {detail.callUsage?.modelCalls ?? 0} / {detail.effectiveCallLimits?.modelCalls ?? 20}；工具尝试 {detail.callUsage?.toolCalls ?? 0} / {detail.effectiveCallLimits?.toolCalls ?? 10}；已知 token {detail.callUsage?.totalTokens ?? 0}，用量未知请求 {detail.callUsage?.unknownTokenCalls ?? 0}。受限时请使用上方显式提额入口继续原 Task，计数不会清零。</p></details>
                <details><summary>技术信息：配置版本与任务引用</summary>
                  {!!detail.recoveryHistory?.length && <section className="task-notice" aria-label="执行恢复记录">
                    <strong>已从持久化检查点恢复</strong>
                    <p>沿用原 Task、配置版本、历史和累计用量。已保存的工具回执不会因重启重新执行。</p>
                    <ul>{detail.recoveryHistory.map((item) => <li key={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.checkpoint?.phase ?? '—'}
                      {item.messageControl && <span data-testid={`recovered-message-control-${item.id}`}> · 恢复时{item.messageControl.cancellationEntryId ? '已取消，不执行旧输入' : item.messageControl.activeInputId ? `执行输入 #${item.messageControl.activeInputId}` : item.messageControl.waitingInputId ? `受限等待输入 #${item.messageControl.waitingInputId}` : '无执行输入'}；FIFO 待处理 {item.messageControl.queuedInputIds.length} 条；待生效插入 {item.messageControl.pendingSteers.length} 条；已生效插入 {item.messageControl.appliedSteerIds.length} 条。</span>}
                      {item.uncertainAttempt && <span> · 中断的{item.uncertainAttempt.kind === 'model' ? '模型请求' : '只读工具'}第 {item.uncertainAttempt.attempt} 次尝试：未取得持久化结果，不能视为成功；未知模型用量不记为零。</span>}
                    </li>)}</ul>
                  </section>}
                  <dl className="identity-grid"><div><dt>Harness Task ID</dt><dd data-testid="task-id">{detail.taskId}</dd></div><div><dt>Conversation ID</dt><dd>{detail.conversationId}</dd></div><div><dt>Bot 配置引用</dt><dd>{detail.configRef.botId}@{detail.configRef.version}</dd></div><div><dt>创建时间</dt><dd>{new Date(detail.createdAt).toLocaleString('zh-CN')}</dd></div><div><dt>Harness 状态 / 检查点</dt><dd>{detail.runtime.status} / {detail.runtime.checkpoint?.phase ?? '—'}</dd></div><div><dt>执行恢复状态</dt><dd>{{ resumable: '按原检查点继续', waiting: '保持等待，不自动解除', idle: '空闲，已结束输入不重跑', ended: '已结束，不重新执行' }[detail.runtime.disposition ?? ''] ?? '—'}</dd></div><div><dt>会话名称来源</dt><dd>{detail.titleSource === 'user-request' ? '本次创建请求' : 'Bot 默认值'}</dd></div></dl>
                  <div className="table-scroll"><table><caption className="sr-only">实际固定参数与来源</caption><thead><tr><th>参数</th><th>固定值</th><th>参数来源</th></tr></thead><tbody>{Object.entries(detail.parameters).map(([key, value]) => <tr key={key}><td>{parameterLabels[key] ?? key}</td><td>{displayParameter(key, value)}</td><td>{detail.parameterSources[key]?.type === 'configuration-migration' ? '用户明确确认迁移' : detail.parameterSources[key]?.type === 'user-limit-increase' ? '用户显式提额（见调整记录）' : detail.parameterSources[key]?.type === 'user-request' ? '本次创建请求' : 'Bot 默认值'} · {detail.parameterSources[key]?.configRef.botId}@{detail.parameterSources[key]?.configRef.version}</td></tr>)}</tbody></table></div>
                </details>
            </aside>
          </div>

  return (
    <div className="app-shell">
      {error && <div role="alert" className="error-banner shell-alert">{error}<button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
      {!token ? (
        <main className="login-panel shell-login">
          <span className="shell-brand-mark" aria-hidden="true">p</span><h1>连接你的 Pidot</h1>
          <p>你的个人助理，运行在本机。</p>
          <form onSubmit={connect}>
            <label htmlFor="token">本地访问 token</label>
            <input id="token" type="password" autoComplete="off" value={draftToken} onChange={(event) => setDraftToken(event.target.value)} required placeholder="输入 PIDOT_API_TOKEN" />
            <button className="primary" disabled={!draftToken.trim()}>连接</button>
          </form>
          <p className="muted small">使用服务端配置的访问 token（不是模型 API key），仅保存在当前标签页，断开后清除。</p>
        </main>
      ) : (
        <main className="workspace-root">
          {notice && <div role="status" className="shell-alert shell-notice">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}
          <UnifiedWorkspace key={token} token={token} view={view} onView={goView} chief={chiefNode} sidebar={sidebarNode} inboxCount={inboxCount ?? confirmations.length}
            footer={<><span>仅本机 · 本地存储</span> <button type="button" className="text-button" onClick={disconnect}>断开连接</button></>}
            today={<div className="home"><TodaySummary token={token} active={home} confirmations={confirmations} onOpenTask={id => { const t = tasks.find(x => x.taskId === id); selectTask(id, t ? ownerOf(t) : botId) }}
              onOpenInbox={() => goView('inbox')} onOpenCalendar={() => goView('calendar')} onOpenTodos={() => goView('todos')} />
              {chiefMain === null ? <div className="shell-placeholder" role="status"><h2>{loading ? '正在读取…' : '找不到 Chief 主会话'}</h2></div> : home ? chatView : null}</div>}
            inboxSummary={<InboxPage token={token} active={view === 'inbox'} onCount={setInboxCount} onOpenTask={(id, owner) => { const t = tasks.find(x => x.taskId === id); selectTask(id, t ? ownerOf(t) : owner) }} />}>
          {selectedId === null ? (newBot ? <BotCreation key={`new-bot:${token}`} token={token} onCancel={() => goView('today')} onCreated={(bot, mainTaskId) => {
              setBots((current) => current.some((item) => item.id === bot.id) ? current : [...current, bot])
              // PLAN §8.6 (T6-04): go straight into the new Bot's main session.
              if (mainTaskId !== null) { setMainSessions(current => ({ ...current, [bot.id]: mainTaskId })); selectTask(mainTaskId, bot.id) } else selectBot(bot.id)
              reload() }} />
            : botId === 'groups' ? <section className="bot-page" aria-labelledby="groups-title"><h1 id="groups-title">群聊</h1>
              <p className="shell-muted">把几个 Bot 拉到一起，由管理员分派和验收。</p>
              <GroupCreation key={`group:${token}`} bots={bots} token={token} onCreated={(id) => { requestEpoch.current += 1; setBotId('groups'); setSelectedId(id); setDetail(null); window.history.pushState(null, '', `#bot=groups&task=${id}`); reload() }} />
              <ul className="today-list">{groupTasks.map(t => <li key={t.taskId}><button type="button" className="today-link" onClick={() => selectTask(t.taskId, 'groups')}><span>{t.title}</span><span className="shell-muted small">{t.group?.members.map(m => m.name).join('、')}</span></button></li>)}</ul>
            </section>
            : selectedBot ? <><BotTemplatePage key={`bot:${selectedBot.id}:${token}`} bot={selectedBot} token={token} creating={creating}
                tasks={botTasks.map(t => ({ taskId: t.taskId, title: t.title, createdAt: t.createdAt, statusLabel: `${archived.includes(t.taskId) ? '已归档 · ' : ''}${taskStatus(t).label.split(' · ')[0]}` }))}
                onNewTask={() => void create(undefined, selectedBot.id)} onOpenTask={id => selectTask(id, selectedBot.id)}
                onSaved={(bot) => { setBots((current) => current.map((item) => item.id === bot.id ? { ...item, ...bot } : item)); setRefresh((value) => value + 1) }}
                onDeactivate={() => void deactivate(selectedBot)} />
              <details className="shell-more bot-page"><summary>飞书日历（任务工具）</summary><FeishuCalendarPanel token={token} taskId={selectedId} /></details></>
            : <div className="shell-placeholder" role="status"><h2>{loading ? '正在读取…' : '找不到这个 Bot'}</h2></div>)
 : home ? null : chatView}
          </UnifiedWorkspace>
        </main>
      )}
    </div>
  )
}
export default App
