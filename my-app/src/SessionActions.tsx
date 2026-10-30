import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import EditorDialog from './EditorDialog'
import { SessionActionRecoveryError } from './session-lifecycle-client.mjs'
import { isSessionActionReceipt, sessionDeleteLabel, type SessionActionHandler, type SessionActionResult, type SessionActionTarget, type SessionActionVerifier } from './session-list.mjs'
import './session-actions.css'

export type SessionActionsProps = {
  target: SessionActionTarget
  onAction?: SessionActionHandler
  /** Read/verify the original request only. null means it is not confirmed; never implicitly resubmit. */
  onVerify?: SessionActionVerifier
  onComplete?: (result: SessionActionResult) => void
  pinned?: boolean
  onTogglePin?: () => void
}

// App owns routes, current page/cache eviction and main-session references. Never send a message here.
export default function SessionActions({ target, onAction, onVerify, onComplete, pinned = false, onTogglePin }: SessionActionsProps) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const requestId = useRef<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false), [retryable, setRetryable] = useState(false)
  const label = sessionDeleteLabel(target)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!menuOpen) return
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    buttons?.[0]?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menuOpen])

  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') { setMenuOpen(false); return }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); trigger.current?.focus(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (!buttons.length) return
    event.preventDefault()
    const current = buttons.findIndex(button => button === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus()
  }

  async function confirm(retryOriginal = false) {
    if (inFlight.current || !onAction || retryOriginal && !retryable) return
    inFlight.current = true
    setPending(true)
    setRetryable(false)
    setError('')
    let result: SessionActionResult
    try {
      requestId.current ??= crypto.randomUUID()
      const input = { requestId: requestId.current, confirmed: true as const }
      const response = uncertain && onVerify && !retryOriginal ? await onVerify(target, input) : await onAction(target, input)
      if (!isSessionActionReceipt(response, target, requestId.current)) throw new Error('删除结果未核实，请用原请求核实后重试。')
      result = response
    } catch (failure) {
      if (mounted.current) {
        // Keep the original request across dismissal/reopening. Never hide a row on failed/unknown.
        setUncertain(true)
        setRetryable(failure instanceof SessionActionRecoveryError && failure.retryable)
        setError(failure instanceof Error ? failure.message : '删除结果未知，请用原请求核实后重试。')
      }
      return
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
    if (mounted.current) { setConfirmOpen(false); setUncertain(false); setRetryable(false); requestId.current = null }
    onComplete?.(result)
  }

  return <div className="session-actions" ref={container}>
    <button ref={trigger} type="button" className="session-actions-trigger" aria-label={`会话操作：${target.title}`} title="会话操作"
      aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? `${id}-menu` : undefined}
      disabled={pending} onClick={() => setMenuOpen(value => !value)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true) }
      }}><span aria-hidden="true">⋯</span></button>
    {menuOpen && <div id={`${id}-menu`} className="session-actions-menu" role="menu" aria-label={`${target.title} 的操作`} ref={menu} onKeyDown={menuKeys}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false) }}>
      {onTogglePin && <button type="button" role="menuitem" onClick={() => { onTogglePin(); setMenuOpen(false); trigger.current?.focus() }}>{pinned ? '取消置顶' : '置顶'}</button>}
      <button type="button" role="menuitem" className="session-action-danger" disabled={!onAction} title={!onAction ? '会话删除服务尚未接线' : undefined}
        onClick={() => { setMenuOpen(false); setConfirmOpen(true) }}>{label}</button>
      {!onAction && <p className="session-action-hint">会话删除服务尚未接线</p>}
    </div>}
    <EditorDialog open={confirmOpen} title={label} returnFocus={trigger} pending={pending} error={error}
      initialFocus="[data-session-cancel]" onClose={() => { if (!inFlight.current) setConfirmOpen(false) }}
      description={target.kind === 'main' ? '清空当前聊天上下文，并为同一个 Bot 开始新主会话。' : '会话将从列表、置顶、搜索和历史入口移除，刷新后不会恢复。'}
      footer={<>
        <button type="button" data-session-cancel className="editor-control-button" onClick={() => setConfirmOpen(false)} disabled={pending}>{uncertain ? '暂时关闭' : '取消'}</button>
        <button type="button" className="editor-control-button session-action-confirm" onClick={() => void confirm()} disabled={pending || !onAction}>{pending ? '正在处理…' : uncertain ? onVerify ? '核查原请求' : '核实原请求并重试' : label}</button>
        {uncertain && retryable && onVerify && <button type="button" className="editor-control-button session-action-confirm" onClick={() => void confirm(true)} disabled={pending || !onAction}>重试原请求</button>}
      </>}>
      <p className="session-action-name">{target.title}</p>
      <p>{target.kind === 'main' ? 'Bot 和派出的子任务不会删除；后台结果由当前主会话接续，旧聊天不会带入新上下文。' : '如有运行中的工作，将先停止后续执行；停止失败或结果未知时，不会标为删除成功。'}</p>
      <p>审计记录和已有私有记忆默认保留，这不是彻底擦除。已发生的外部操作不会回滚。</p>
      {target.kind === 'group' && <p>这里只删除群会话，不删除 Bot、子任务或外部日程。</p>}
      {uncertain && <p role="status">结果尚未核实；核查只读取原请求状态。只有你明确选择重试时才会再次提交同一请求，仍不会改换会话或请求标识。</p>}
    </EditorDialog>
  </div>
}
