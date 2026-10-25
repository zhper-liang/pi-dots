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
