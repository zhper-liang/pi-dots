// One gate per mounted origin or goal. Version is part of the payload signature.
export function createContinuousRequestGate({ storage, key, makeId }) {
  let active = false, disposed = false, pending = null
  try { pending = JSON.parse(storage?.getItem(key) ?? 'null') } catch { /* memory fallback */ }
  return {
    begin(path, method, payload, idempotent = true) {
      if (active || disposed) return null
      const signature = JSON.stringify([path, method, payload])
      if (!pending || pending.signature !== signature) pending = { signature, requestId: makeId() }
      if (idempotent) { try { storage?.setItem(key, JSON.stringify(pending)) } catch { /* memory fallback */ } }
      active = true
      return { requestId: pending.requestId }
    },
    finish(success) {
      active = false
      if (success && !disposed) {
        pending = null
        try { storage?.removeItem(key) } catch { /* memory fallback */ }
      }
    },
    current() { return !disposed },
    dispose() { disposed = true }
  }
}
