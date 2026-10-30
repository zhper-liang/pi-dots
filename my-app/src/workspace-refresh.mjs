import { createWorkspaceRequestGuard } from './workspace-request-guard.mjs'

export const WORKSPACE_REFRESH_MS = 15000
export const WORKSPACE_REQUEST_TIMEOUT_MS = 12000

/** Only permission fields form this fingerprint. Never put credentials into diagnostics. */
export function workspacePermissionKey(local, external) {
  const entries = (sources, kind) => sources.map(source => [kind, source.id, source.authorized, source.readScope ?? 'full', source.grantEpoch ?? source.epoch ?? 0])
  return JSON.stringify([...entries(local, 'local'), ...entries(external, 'external')].sort((a, b) => String(a[0] + a[1]).localeCompare(String(b[0] + b[1]))))
}
export function isWorkspacePermissionError(error) {
  return [401, 403].includes(error?.status) || /^(401|403|WORKSPACE_FORBIDDEN|WORKSPACE_EXTERNAL_REVOKED|UNAUTHORIZED|FORBIDDEN)$/.test(error?.name ?? '')
}

/** One private scope, one in-flight read, one merged follow-up; no global cache or event bus. */
export function createWorkspaceRefresh({ load, onError = () => {}, onInvalidate = () => {}, interval = WORKSPACE_REFRESH_MS, timeout = WORKSPACE_REQUEST_TIMEOUT_MS, timers = globalThis }) {
  const guard = createWorkspaceRequestGuard()
  let disposed = false, active = false, visible = true, online = true, scope, timer, flight, queued = false
  const delay = Math.max(1000, Math.min(WORKSPACE_REFRESH_MS, interval))
  const allowed = () => !disposed && active && visible && online
  const stopTimer = () => { if (timer !== undefined) timers.clearTimeout(timer); timer = undefined }
  const cancel = () => {
    guard.invalidate()
    if (flight) { const old = flight; flight = undefined; old.controller.abort(); old.cancel() }
    queued = false
  }
  const schedule = () => {
    stopTimer()
    if (allowed()) timer = timers.setTimeout(() => { timer = undefined; void request(false); schedule() }, delay)
  }
  async function request(fresh = false) {
    if (fresh) cancel()
    if (!allowed()) return
    if (flight) { queued = true; return flight.promise }
    const ticket = guard.begin(), controller = new AbortController()
    let cancelWait, timeoutId
    const current = { controller, cancel: () => cancelWait?.(), promise: undefined }
    flight = current
    const context = { signal: controller.signal, isCurrent: () => !disposed && !controller.signal.aborted && guard.current(ticket) }
    const cancelled = new Promise(resolve => { cancelWait = resolve })
    const task = Promise.resolve().then(() => { if (context.isCurrent()) return load(context) }).catch(error => { if (context.isCurrent()) onError(error) })
    timeoutId = timers.setTimeout(() => {
      if (flight !== current) return
      controller.abort(); guard.invalidate()
      onError(Object.assign(new Error('工作区读取超时，将自动重试。'), { name: 'TimeoutError' }))
      cancelWait()
    }, Math.min(timeout, delay))
    current.promise = Promise.race([task, cancelled]).finally(() => {
      timers.clearTimeout(timeoutId)
      if (flight !== current) return
      flight = undefined
      if (queued && allowed()) { queued = false; void request(false) }
    })
    return current.promise
  }
  return {
    request,
    capture: () => guard.capture(),
    sameIdentity: ticket => !disposed && guard.sameIdentity(ticket),
    setScope(next) {
      if (disposed || scope === next) return
      scope = next; cancel(); onInvalidate('scope'); schedule(); void request(false)
    },
    setActive(next) {
      if (disposed || active === next) return
      active = next
      if (!active) { stopTimer(); cancel() } else { schedule(); void request(false) }
    },
    setEnvironment(nextVisible, nextOnline) {
      if (disposed) return
      const resumed = (!visible && nextVisible) || (!online && nextOnline)
      visible = nextVisible; online = nextOnline
      if (!allowed()) { stopTimer(); cancel() }
      else { schedule(); if (resumed) void request(false) }
    },
    invalidate() { if (!disposed) { cancel(); onInvalidate('permission'); void request(false) } },
    dispose() { if (!disposed) { disposed = true; stopTimer(); cancel() } }
  }
}

/** Project a verified local receipt before background reconciliation; never invent a server version. */
export function applyWorkspaceReceipt(items, input, operation) {
  const receipt = operation?.receipt
  if (operation?.state !== 'succeeded' || input?.sourceId !== 'local' || !receipt?.target?.id || !Number.isFinite(receipt.version)) return items
  const id = receipt.target.id, previous = items.find(item => item.id === id)
  const record = { ...previous, ...input.data, id, sourceId: 'local', version: receipt.version, ...(input.action === 'delete' ? { deletedAt: receipt.deletedAt } : {}) }
  return previous ? items.map(item => item.id === id ? record : item) : [...items, record]
}
