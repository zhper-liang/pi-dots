import { useCallback, useEffect, useRef, useState } from 'react'

/** Poll only visible views. Sequence guards prevent stale reads from undoing acknowledged edits. */
export function useMemoryResource<T>(read: (signal?: AbortSignal) => Promise<T>, active: boolean) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const state = useRef({ live: false, sequence: 0, controller: null as AbortController | null })
  const refresh = useCallback(async () => {
    const guard = state.current
    guard.controller?.abort()
    const sequence = ++guard.sequence
    const controller = new AbortController()
    guard.controller = controller
    setLoading(true)
    try {
      const next = await read(controller.signal)
      if (guard.live && sequence === guard.sequence) { setData(next); setError('') }
    } catch (cause) {
      if (guard.live && sequence === guard.sequence && !(cause instanceof Error && cause.name === 'AbortError')) setError('暂时无法读取记忆。现有内容和草稿保留，请重试。')
    } finally {
      if (guard.live && sequence === guard.sequence) setLoading(false)
    }
  }, [read])
  const update = useCallback((change: (old: T) => T) => {
    state.current.sequence++
    state.current.controller?.abort()
    if (state.current.live) { setData(old => old ? change(old) : old); setLoading(false) }
  }, [])
  useEffect(() => {
    const guard = state.current
    guard.live = true
    return () => { guard.live = false; guard.sequence++; guard.controller?.abort() }
  }, [])
  useEffect(() => {
    if (!active) return
    let subscribed = true
    queueMicrotask(() => { if (subscribed) void refresh() })
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 15000)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { subscribed = false; clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [active, refresh])
  return { data, error, loading, refresh, update }
}

