import { useCallback, useEffect, useState } from 'react'
import SystemCard from './SystemCard'
import { loadAutomation, setAutomationPaused, undoAutomatic, pausedBy, type AutomationState } from './automation'

function useAutomation(token: string) {
  const [state, setState] = useState<AutomationState | null>(null)
  const refresh = useCallback(async () => { try { setState(await loadAutomation(token)) } catch { /* keep the last known state */ } }, [token])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10000)
    window.addEventListener('focus', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [refresh])
  return { state, setState, refresh }
}

// Shell banner: visible on every page while paused. Resume lives only in Settings (I-05).
export function AutomationBanner({ token, onOpenSettings }: { token: string; onOpenSettings: () => void }) {
  const { state } = useAutomation(token)
  if (!state?.paused) return null
  return <p role="status" className="shell-note automation-banner">自动化已暂停（{pausedBy(state)}{state.since ? ` · ${new Date(state.since).toLocaleString('zh-CN')}` : ''}）。例行任务不运行，自动执行改为先问你。<button type="button" className="text-button" onClick={onOpenSettings}>去设置恢复</button></p>
}

export function AutomationSettings({ token }: { token: string }) {
  const { state, setState } = useAutomation(token)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function toggle(paused: boolean) {
    setBusy(true); setError('')
    try { setState(await setAutomationPaused(token, paused)) } catch (e) { setError(e instanceof Error ? e.message : '操作失败。') } finally { setBusy(false) }
  }
  if (!state) return <p className="shell-muted">正在读取…</p>
  return <div>
    <p>{state.paused ? `已暂停（${pausedBy(state)}${state.since ? ` · ${new Date(state.since).toLocaleString('zh-CN')}` : ''}）` : '正在运行'}</p>
    <p className="shell-muted small">暂停后：例行任务不运行，恢复后不补跑；原本自动执行的改动改为先问你；正在进行的任务继续，但写入要你确认。Bot 可以替你暂停，只有你能在这里恢复。</p>
    <button type="button" className={state.paused ? 'primary' : ''} disabled={busy} onClick={() => void toggle(!state.paused)}>{state.paused ? '恢复自动化' : '暂停全部自动化'}</button>
    {error && <p role="alert" className="shell-note">{error}</p>}
  </div>
}

// "已自动做了 X｜撤销" card (I-13). Shared by the Task conversation and the inbox record.
export function AutoAppliedCard({ token, requestId, summary, undone: initiallyUndone = false, createdAt }: { token: string; requestId: string; summary: string; undone?: boolean; createdAt?: string | null }) {
  const [undoneHere, setUndone] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const undone = initiallyUndone || undoneHere
  async function undo() {
    setBusy(true); setError('')
    try { await undoAutomatic(token, requestId); setUndone(true) }
    catch (e) { setError((e as { code?: string }).code === 'WORKSPACE_UNDO_CONFLICT' ? '已被修改，不能撤销。' : e instanceof Error ? e.message : '撤销失败。') }
    finally { setBusy(false) }
  }
  return <SystemCard card={{ kind: 'auto-applied', state: undone ? 'undone' : 'applied' }} title={summary} error={error}
    meta={createdAt ? new Date(createdAt).toLocaleString('zh-CN') : undefined}
    actions={undone ? undefined : <button type="button" disabled={busy} onClick={() => void undo()}>撤销</button>} />
}
