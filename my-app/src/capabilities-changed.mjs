// A local invalidation signal, never an authorization source. Readers recheck the server.
const listeners = new Set()

export function publishCapabilityChange({ botId, revision } = {}) {
  const change = { ...(typeof botId === 'string' ? { botId } : {}), ...(typeof revision === 'string' ? { revision } : {}) }
  for (const listener of [...listeners]) listener(change)
}

export function subscribeCapabilityChanges(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
