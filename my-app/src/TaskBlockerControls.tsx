import { taskPath } from './taskPath'
import SystemCard from './SystemCard'
import { openBlocker } from './system-cards.mjs'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { canSkipQuestions, questionDraftKey, questionsFor, validateAnswers, type Question, type QuestionAnswers } from '../shared/question-form.mjs'
import './question-form.css'

export type BlockerItem = {
  id: number; taskId: number; question: string; requiredInformation: string; assignee: string;
  version?: number; rootWorkId?: string; inReplyTo?: number; parentTaskId?: number; supervisorBotId?: string;
  parked?: boolean; questions?: Question[];
  history?: {action:string; assignee:string; reason?:string; createdAt:string}[];
  status: 'pending' | 'resolved' | 'cancelled' | 'superseded' | 'skipped'; createdAt: string;
  answer: { id: number; content: string; createdAt: string; source: string; answers?: QuestionAnswers } | null
}
export type BlockerState = { activeId: number | null; related?: BlockerItem[]; items: BlockerItem[] }
export type BlockedTask = { bot: { id: string }; taskId: number; title: string; groupId?: string; groupChild?: boolean; blockers?: BlockerState;
  collaborations?: {childTaskId:number;executorBotId:string}[]; cancellation?: unknown; runtime: { status: string; outcome?: { status: string } } }
type Action = 'resolve' | 'skip' | 'cancel' | 'adjust'
type Draft = { answers: QuestionAnswers; adjustment: string; collapsed: boolean }
function restore(key: string): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (saved && saved.answers && typeof saved.answers === 'object' && !Array.isArray(saved.answers)) return { answers: saved.answers, adjustment: typeof saved.adjustment === 'string' ? saved.adjustment : '', collapsed: saved.collapsed === true }
  } catch { /* Drafts remain usable when browser storage is unavailable. */ }
  return { answers: {}, adjustment: '', collapsed: false }
}

function QuestionFields({ questions, answers, disabled, onChange, prefix }: { questions: Question[]; answers: QuestionAnswers; disabled: boolean; onChange: (answers: QuestionAnswers) => void; prefix: string }) {
  return <>{questions.map(question => {
    const id = `${prefix}-${question.id}`, value = answers[question.id]
    const selected = value && typeof value === 'object' ? 'optionIds' in value ? Array.isArray(value.optionIds) ? value.optionIds : [] : [value.optionId] : []
    const other = value && typeof value === 'object' && typeof value.other === 'string' ? value.other : ''
    function choice(optionId: string, checked: boolean) {
      if (question.type === 'single') onChange({ ...answers, [question.id]: { optionId, ...(optionId === 'other' && other ? { other } : {}) } })
      else {
        const optionIds = checked ? [...new Set([...selected, optionId])] : selected.filter(option => option !== optionId)
        onChange({ ...answers, [question.id]: { optionIds, ...(optionIds.includes('other') && other ? { other } : {}) } })
      }
    }
    return <fieldset key={question.id} className="question-field" disabled={disabled}>
      <legend>{question.question}<span className="question-required">{question.required !== false ? '必填' : '可跳过'}</span></legend>
      {question.type === 'text' ? <><label className="sr-only" htmlFor={id}>你的回答：{question.question}</label><textarea id={id} rows={2} maxLength={4000} value={typeof value === 'string' ? value : ''} onChange={event => onChange({ ...answers, [question.id]: event.target.value })} placeholder="填写你的回答" /></>
        : <div className="question-options">{[...(question.options ?? []), { id: 'other', label: '自己填写' }].map(option => <label key={option.id} className={`question-option${selected.includes(option.id) ? ' is-selected' : ''}`}>
          <input type={question.type === 'single' ? 'radio' : 'checkbox'} name={id} value={option.id} checked={selected.includes(option.id)} onChange={event => choice(option.id, event.target.checked)} />
          <span><span>{option.label}</span>{'description' in option && option.description && <small>{option.description}</small>}</span>
        </label>)}{selected.includes('other') && <><label className="sr-only" htmlFor={`${id}-other`}>自己填写：{question.question}</label><textarea id={`${id}-other`} rows={2} maxLength={4000} value={other} placeholder="填写其他答案" onChange={event => onChange({ ...answers, [question.id]: question.type === 'single' ? { optionId: 'other', other: event.target.value } : { optionIds: selected, other: event.target.value } })} /></>}</div>}
      {question.required === false && question.defaultAnswer && <p className="muted small">跳过时：{question.defaultAnswer}</p>}
    </fieldset>
  })}</>
}

export function QuestionCard<T extends BlockedTask>({ item, task, token, editable, cancelled, onUpdated, onError }: { item: BlockerItem; task: T; token: string; editable: boolean; cancelled: boolean; onUpdated: (task: T) => void; onError: (error: unknown) => void }) {
  const key = questionDraftKey(task.bot.id, task.taskId, item)
  const [draft, setDraft] = useState(() => restore(key))
  const [adjusting, setAdjusting] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState('')
  const pending = useRef<{ signature: string; requestId: string } | null>(null)
  const request = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const questions = questionsFor(item)
  const open = openBlocker(item, cancelled)
  const canChangeRequest = editable && !item.rootWorkId
  const result = validateAnswers(questions, draft.answers)
  useEffect(() => {
    if (!open) { try { sessionStorage.removeItem(key) } catch { /* Optional browser storage. */ }; return }
    try { sessionStorage.setItem(key, JSON.stringify(draft)) } catch { /* Keep editing in memory. */ }
  }, [draft, key, open])
  useEffect(() => () => request.current?.abort(), [])

  async function submit(action: Action) {
    if (!editable || !open || submitting.current || (action === 'adjust' || action === 'cancel') && !canChangeRequest || action === 'skip' && !canSkipQuestions(questions)) return
    if (action === 'resolve' && !result.ok || action === 'adjust' && !draft.adjustment.trim()) return
    const body = {
      action, version: item.version ?? 1, inReplyTo: item.inReplyTo,
      ...(item.rootWorkId ? { rootWorkId: item.rootWorkId } : {}),
      ...(action === 'resolve' && result.ok ? { answer: result.answer, answers: result.answers } : {}),
      ...(action === 'adjust' ? { answer: draft.adjustment.trim() } : {}),
    }
    const signature = JSON.stringify(body)
    if (pending.current?.signature !== signature) pending.current = { signature, requestId: crypto.randomUUID() }
    submitting.current = true; setBusy(action); setError('')
    const controller = new AbortController(); request.current = controller
    try {
      const response = await fetch(taskPath(task, `/blockers/${item.id}/resolve`), {
        method: 'POST', body: JSON.stringify({ ...body, requestId: pending.current.requestId }), signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error?.message ?? '操作未确认，请刷新状态后核对。')
      if (!controller.signal.aborted) {
        pending.current = null
        try { sessionStorage.removeItem(key) } catch { /* Optional browser storage. */ }
        onUpdated(value.task)
      }
    } catch (caught) {
      if (!controller.signal.aborted) { setError(caught instanceof Error ? caught.message : '操作未确认，可重试原操作。'); onError(caught) }
    } finally { if (!controller.signal.aborted) { submitting.current = false; setBusy(null) } }
  }
  function answer(event: FormEvent) { event.preventDefault(); void submit(adjusting ? 'adjust' : 'resolve') }
  const state = cancelled || item.status === 'cancelled' ? '已取消' : item.status === 'superseded' ? '已按调整继续' : item.status === 'skipped' ? '已跳过' : item.status === 'resolved' ? '已回答' : item.assignee === 'supervisor' ? '等派活的机器人处理' : '等你回答'
  return <SystemCard className={`blocker-item ${item.status}`} card={{ kind: 'blocker', state: open ? 'pending' : item.status }} title="需要补充" state={state}>
    <p className="blocker-question">{item.question}</p>
    <p className="question-owner muted small">{task.title}{item.inReplyTo ? ` · 请求 #${item.inReplyTo}` : ''}</p>
    {item.requiredInformation && <p className="muted small">需要：{item.requiredInformation}</p>}
    {!open ? <details className="question-summary"><summary>{state}{item.answer?.content ? `：${item.answer.content.slice(0, 80)}` : ''}</summary>{item.answer && <div className="blocker-answer"><p>{item.answer.content}</p><span className="muted small">{new Date(item.answer.createdAt).toLocaleString('zh-CN')}</span></div>}</details>
      : !editable ? <p className="muted">{item.assignee !== 'user' ? '由派活的机器人回答，它答不了会转给你。' : <>这个问题在子任务里，<a href={`#bot=${encodeURIComponent(task.collaborations?.find(relation => relation.childTaskId === item.taskId)?.executorBotId ?? '')}&task=${item.taskId}`}>去子任务回答</a>。</>}</p>
        : draft.collapsed ? <div className="question-actions"><span className="muted small">问题已暂存，可以继续聊天。</span><button type="button" onClick={() => setDraft(current => ({ ...current, collapsed: false }))}>展开回答</button></div>
          : <form onSubmit={answer} aria-label="回答补充问题">
            {adjusting ? <><label htmlFor={`adjust-question-${item.id}`}>补充或调整这次请求</label><textarea id={`adjust-question-${item.id}`} rows={3} maxLength={4000} disabled={busy !== null} placeholder="说明新的要求，机器人会重新判断需要哪些信息" value={draft.adjustment} onChange={event => setDraft(current => ({ ...current, adjustment: event.target.value }))} /><p className="muted small">这会替代当前问题，按你的调整继续处理原请求。</p></>
              : <QuestionFields prefix={`question-${task.taskId}-${item.id}`} questions={questions} answers={draft.answers} disabled={busy !== null} onChange={answers => setDraft(current => ({ ...current, answers }))} />}
            {error && <p role="alert" className="question-error">{error}</p>}
            <div className="question-actions">
              <button className="primary" disabled={busy !== null || (adjusting ? !draft.adjustment.trim() : !result.ok)}>{busy ? '正在提交…' : adjusting ? '提交调整并继续' : '提交回答并继续'}</button>
              <button type="button" disabled={busy !== null} onClick={() => setDraft(current => ({ ...current, collapsed: true }))}>稍后回答</button>
              {!adjusting && canSkipQuestions(questions) && <button type="button" disabled={busy !== null} onClick={() => void submit('skip')}>跳过，使用默认方案</button>}
              {canChangeRequest && <button type="button" disabled={busy !== null} onClick={() => setAdjusting(value => !value)}>{adjusting ? '返回回答问题' : '补充／调整这次请求'}</button>}
              {canChangeRequest && <button type="button" className="question-cancel" disabled={busy !== null} onClick={() => void submit('cancel')}>取消这次请求</button>}
            </div>
            <p className="muted small">回答仅补充信息；你也可以在聊天输入框发送新消息。</p>
          </form>}
  </SystemCard>
}

export default function TaskBlockerControls<T extends BlockedTask>({ task, token, onUpdated, onError, scope }: {
  task: T; token: string; onUpdated: (task: T) => void; onError: (error: unknown) => void; scope?: 'open' | 'settled'
}) {
  const cancelled = Boolean(task.cancellation) || task.runtime.outcome?.status === 'aborted'
  const items = [...(task.blockers?.items ?? []), ...(task.groupId ? [] : task.blockers?.related ?? [])].filter(item => !scope || (scope === 'open') === openBlocker(item, cancelled))
  if (!items.length) return null
  return <section className="task-blockers" aria-label="待处理问题" data-testid="task-blockers">
    <h3>待处理问题</h3>
    {items.map(item => <QuestionCard key={`${token}:${task.taskId}:${item.id}:${item.version ?? 1}`} item={item} task={task} token={token} cancelled={cancelled} editable={!cancelled && task.blockers?.items.some(own => own.id === item.id) === true && item.assignee === 'user'} onUpdated={onUpdated} onError={onError} />)}
  </section>
}
