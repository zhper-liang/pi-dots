import { useCallback, useLayoutEffect, useRef } from 'react'
import { createWorkspaceRefresh, type WorkspaceRead, type WorkspaceRefreshController } from './workspace-refresh.mjs'

type Options = {
  scopeKey: string
  active: boolean
  refreshKey?: number
  load: (read: WorkspaceRead) => void | Promise<void>
  onError?: (error: unknown) => void
  onInvalidate?: (reason: 'scope' | 'permission') => void
}

/** Callers keep components mounted. Only data reads stop when the panel/document is hidden. */
export function useWorkspaceRefresh(options: Options) {
  const latest = useRef(options), controller = useRef<WorkspaceRefreshController | null>(null)
  const identity = useRef(options.scopeKey)
  // A response resolving between render and layout must not commit under a new token/Bot/window.
  identity.current = options.scopeKey
  useLayoutEffect(() => { latest.current = options })
  useLayoutEffect(() => {
    const instance = createWorkspaceRefresh({
      load: read => {
        const scope = latest.current.scopeKey
        return latest.current.load({ ...read, isCurrent: () => identity.current === scope && read.isCurrent() })
      },
      onError: error => latest.current.onError?.(error),
      onInvalidate: reason => latest.current.onInvalidate?.(reason)
    })
    controller.current = instance
    const environment = () => instance.setEnvironment(document.visibilityState !== 'hidden', navigator.onLine !== false)
    environment()
    document.addEventListener('visibilitychange', environment)
    window.addEventListener('online', environment)
    window.addEventListener('offline', environment)
    const focus = () => { environment(); void instance.request() }
    window.addEventListener('focus', focus)
    return () => {
      instance.dispose()
      controller.current = null
      document.removeEventListener('visibilitychange', environment)
      window.removeEventListener('online', environment)
      window.removeEventListener('offline', environment)
      window.removeEventListener('focus', focus)
    }
  }, [])
  useLayoutEffect(() => { controller.current?.setScope(options.scopeKey) }, [options.scopeKey])
  useLayoutEffect(() => { controller.current?.setActive(options.active) }, [options.active])
  useLayoutEffect(() => { if (options.refreshKey !== undefined) void controller.current?.request() }, [options.refreshKey])
  const refresh = useCallback((fresh = false) => controller.current?.request(fresh) ?? Promise.resolve(), [])
  const invalidate = useCallback(() => controller.current?.invalidate(), [])
  const capture = useCallback(() => ({ scope: identity.current, ticket: controller.current?.capture() }), [])
  const isCurrent = useCallback((value: ReturnType<typeof capture>) => value.scope === identity.current && value.ticket !== undefined && Boolean(controller.current?.sameIdentity(value.ticket)), [])
  return { refresh, invalidate, capture, isCurrent }
}
