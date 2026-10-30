import { useEffect, useRef, useState } from 'react'
import Switch from './Switch'

// Skills are picked on demand: by the Bot from its catalog, or by the user with "/" in the composer.
// There is no activation panel; the conversation shows a one-line card per use and the session
// details keep the read-only history (pinned versions, references read, lifecycle).
export type SkillRef = { id: string; version: string; sha256: string }
type Failure = { code: string; message: string; missing?: string[] }
export type SkillState = {
  active: { id: string; name: string; ref: SkillRef; rules: string; applicability: string; source: string }[]
  pinned?: { id: string; name: string; ref: SkillRef; rules: string }[]
  resourceAccesses?: { source: string; offset: number; end: number; totalCharacters: number; accessedAt: string }[]
  history: { source?: string; entryId: number; skillId: string; status: string; createdAt: string; ref?: SkillRef; error?: Failure }[]
  lastFailure: { error: Failure } | null
}
export type SkillMessage = { skillId?: string; skillStatus?: string; skillSource?: string; skillName?: string; skillVersion?: string | null; skillRules?: string | null; skillError?: Failure | null }

const SOURCES: Record<string, string> = { 'model-selection': 'Bot 自己选的', 'user-command': '你用 / 指定的', 'user-request': '你手动启用的' }
const EVENTS: Record<string, string> = { 'model-selection': 'Bot 自主选择', 'user-command': '你用 / 指定', 'user-request': '用户操作', 'phase-completed': '请求阶段完成', 'model-phase-ended': 'Bot 结束阶段', 'phase-failed': '阶段失败', 'root-work-stopped': '上级工作停止' }

/** One line in the conversation: which Skill handled a message, or why it could not load. */
export function SkillNote({ item }: { item: SkillMessage }) {
  const source = SOURCES[item.skillSource ?? ''] ?? ''
  if (item.skillStatus !== 'active') return <p className="skill-note skill-note-failed">
    Skill「{item.skillName ?? item.skillId}」没能加载{item.skillError ? `：${item.skillError.message}` : ''}{item.skillError?.missing?.length ? `（缺少 ${item.skillError.missing.join('、')}）` : ''}{item.skillSource === 'model-selection' ? '，Bot 按普通方式继续。' : '，这条消息按普通方式处理。'}
  </p>
  return <details className="skill-note">
    <summary>已按 Skill「{item.skillName ?? item.skillId}」{item.skillVersion ? ` v${item.skillVersion}` : ''} 处理{source ? ` · ${source}` : ''}</summary>
    {item.skillRules ? <pre className="skill-rules">{item.skillRules}</pre> : <p className="muted small">规则原文不可用。</p>}
  </details>
}

/** Read-only record for the session details drawer. */
export function SkillHistory({ state }: { state?: SkillState }) {
  if (!state || (!state.history.length && !state.active.length)) return <details className="task-context"><summary>Skill · 还没用过</summary><p className="muted small">Bot 会按需选用 Skill；也可以在输入框打 / 选一个，只对那条消息生效。Skill 只加载规则，不给任何权限。</p></details>
  const old = state.pinned?.filter((skill) => !state.active.some((active) => active.id === skill.id)) ?? []
  return <details className="task-context">
    <summary>Skill · {state.active.length ? `正在用 ${state.active.map((s) => `${s.name} v${s.ref.version}`).join('、')}` : `用过 ${state.pinned?.length ?? 0} 个`}</summary>
    <p className="muted small">每条消息处理完就停用；版本按第一次使用时固定，之后不会自动升级。Skill 只加载规则，不给任何权限。</p>
    {state.active.map((skill) => <details key={skill.id}><summary>正在用 · {skill.name} v{skill.ref.version}</summary><p className="muted small">SHA256：{skill.ref.sha256}</p><pre className="skill-rules">{skill.rules}</pre></details>)}
    {old.length > 0 && <details><summary>用过的版本（已停用）</summary>{old.map((skill) => <details key={skill.id}><summary>{skill.name} v{skill.ref.version}</summary><p className="muted small">SHA256：{skill.ref.sha256}</p><pre className="skill-rules">{skill.rules}</pre></details>)}</details>}
    {!!state.resourceAccesses?.length && <details><summary>读过的参考资料（{state.resourceAccesses.length}）</summary><ul>{state.resourceAccesses.map((item, index) => <li key={index}>{item.source} · 字符 [{item.offset}, {item.end}) / {item.totalCharacters} · {new Date(item.accessedAt).toLocaleString('zh-CN')}</li>)}</ul></details>}
    <details><summary>使用记录（{state.history.length}）</summary><ul>{state.history.map((event) => <li key={event.entryId}>{new Date(event.createdAt).toLocaleString('zh-CN')} · {event.skillId} {event.ref?.version} · {event.status === 'active' ? '已加载' : event.status === 'inactive' ? '已停用' : `没能加载：${event.error?.message ?? event.error?.code}`} · {EVENTS[event.source ?? ''] ?? '用户操作'}</li>)}</ul></details>
  </details>
}


type SkillCapability = {
  id: string; kind: string; name: string; description: string; version?: string; revision: string
  enabledForBot: boolean; available: boolean; status: string
  requirements: { kind: string; id: string }[]
}
type CapabilityView = { botId: string; revision: string; items: SkillCapability[] }
export type BotSkillsProps = { token: string; botId: string; readOnly: boolean; active: boolean }
const STATUS: Record<string, string> = { ready: '已就绪', configured: '需核对依赖', missing_dependency: '缺少依赖', needs_auth: '需要授权', error: '校验失败', disabled: '已停用' }

/** Bot-scoped assignment intent only; never uses a main Task as a permission proxy. */
export function BotSkills(props: BotSkillsProps) {
  return <BotSkillsPanel key={`${props.botId}:${props.active}:${props.token}`} {...props} />
}
function BotSkillsPanel({ token, botId, readOnly, active }: BotSkillsProps) {
  const [view, setView] = useState<CapabilityView | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const retry = useRef<{ botId: string; capabilityId: string; input: { requestId: string; expectedRevision: string; expectedCatalogRevision: string; capabilityId: string; enabled: boolean } } | null>(null)
  const scope = useRef('')
  const scopeKey = `${token}:${botId}:${active}`
  async function request(path: string, input?: unknown, signal?: AbortSignal) {
    const response = await fetch(path, { method: input === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? '无法读取或调整 Skill。'), { code: body.error?.code, definitive: true })
    return body
  }
  useEffect(() => {
    scope.current = `${token}:${botId}:${active}`
    if (!active) return
    const controller = new AbortController()
    fetch(`/api/bots/${encodeURIComponent(botId)}/capabilities`, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? '无法读取 Skill。'); return body as CapabilityView })
      .then(body => { if (!controller.signal.aborted && body.botId === botId) setView(body) })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '无法读取 Skill。') })
    return () => controller.abort()
  }, [token, botId, active])
  async function toggle(skill: SkillCapability) {
    if (readOnly || pending || !view || !active) return
    const targetScope = scopeKey
    const previous = retry.current
    const input = previous?.botId === botId && previous.capabilityId === skill.id ? previous.input : {
      requestId: crypto.randomUUID(), expectedRevision: view.revision, expectedCatalogRevision: skill.revision,
      capabilityId: skill.id, enabled: !skill.enabledForBot,
    }
    retry.current = { botId, capabilityId: skill.id, input }
    setPending(skill.id); setError('')
    try {
      await request(`/api/bots/${encodeURIComponent(botId)}/capabilities`, input)
      retry.current = null
      const fresh = await request(`/api/bots/${encodeURIComponent(botId)}/capabilities`) as CapabilityView
      if (scope.current === targetScope && fresh.botId === botId) setView(fresh)
    } catch (caught) {
      const failure = caught as Error & { definitive?: boolean; code?: string }
      if (failure.definitive) retry.current = null
      if (scope.current !== targetScope) return
      setError(`${failure.message}${failure.definitive ? ' 请重新核对当前目录后操作。' : ' 再点同一开关将用原 requestId 核对，不会重复授权。'}`)
      if (failure.definitive) {
        try { const fresh = await request(`/api/bots/${encodeURIComponent(botId)}/capabilities`) as CapabilityView; if (scope.current === targetScope && fresh.botId === botId) setView(fresh) } catch { /* Keep existing view and explicit failure. */ }
      }
    } finally { if (scope.current === targetScope) setPending(null) }
  }
  const skills = view?.items.filter(item => item.kind === 'skill') ?? []
  return <section aria-label="Skill 目录"><h2>Skills</h2><p className="shell-muted">开关只选择本 Bot 可用的 Skill，不授予依赖工具或来源。对话中输入 / 按需使用；旧版本审计保留。</p>
    {readOnly && <p className="shell-muted">此 Bot 为只读，不能调整 Skill 分配。</p>}
    {error && <p role="alert" className="shell-note">{error}</p>}
    {view === null ? !error && <p role="status">正在读取 Skill 目录…</p> : skills.length === 0 ? <p>没有已注册的 Skill。</p> : <ul className="bot-skill-list">{skills.map(skill => <li key={skill.id}>
      <div className="shell-inline"><h3>{skill.name}{skill.version ? ` · v${skill.version}` : ''}</h3><Switch label={`为本 Bot 启用 ${skill.name}`} checked={skill.enabledForBot}
        disabled={readOnly || pending !== null || !active || (!skill.enabledForBot && skill.status === 'disabled')} onChange={() => { void toggle(skill) }} /></div>
      {skill.description && <p>{skill.description}</p>}
      <p>{skill.enabledForBot ? skill.available ? '已选择 · 可在对话中按需使用' : `已选择 · ${STATUS[skill.status] ?? '暂不可用'}` : `未选择 · ${STATUS[skill.status] ?? '状态未知'}`}</p>
      {!!skill.requirements.length && <p className="shell-muted small">依赖（需单独授权）：{skill.requirements.map(item => `${item.kind}:${item.id}`).join('、')}</p>}
    </li>)}</ul>}
  </section>
}
