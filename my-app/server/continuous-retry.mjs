// Retry policy is persisted by the caller in TaskProgress. This module never invokes I/O or
// starts a timer; the existing Harness resumes the recorded checkpoint when it is due.
export const CONTINUOUS_RETRY_DELAYS = Object.freeze([1000, 5000, 15000])
const transientStatuses = new Set([408, 429, 502, 503, 504])
const transientNetworks = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const terminalCodes = new Set(['MODEL_AUTH_FAILED', 'MODEL_CONFIG_UNAVAILABLE', 'MODEL_REJECTED', 'MODEL_INVALID_REPLY', 'MODEL_OUTPUT_LIMIT', 'MODEL_ABORTED', 'CONTEXT_CAPACITY_EXCEEDED', 'CONTEXT_SUMMARY_INVALID'])

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(now)) return null
  const text = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const delay = Number(text) * 1000
    return Number.isSafeInteger(Math.ceil(delay)) ? Math.ceil(delay) : null
  }
  // Do not let permissive Date.parse interpret a negative number as a calendar date.
  if (!/[A-Za-z]/.test(text)) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** Only allowlisted transport metadata is persisted, never provider messages or headers. */
export function safeRetryMetadata({ status, retryAfter, networkCode, now = Date.now() } = {}) {
  return {
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    ...(transientNetworks.has(networkCode) ? { networkCode } : {}),
    ...(retryAfterMs(retryAfter, now) !== null ? { retryAfterMs: retryAfterMs(retryAfter, now) } : {}),
  }
}

export function transientModelFailure(error) {
  if (!error || terminalCodes.has(error.code)) return false
  if (error.code === 'MODEL_TIMEOUT' || error.code === 'MODEL_RATE_LIMITED') return true
  const meta = error.retryMetadata ?? {}
  if (meta.httpStatus !== undefined) return transientStatuses.has(meta.httpStatus)
  return transientNetworks.has(meta.networkCode)
}

export function continuousRetryDecision({ error, retry = null, attemptId, now = Date.now(), deadlineAt }) {
  if (typeof attemptId !== 'string' || !attemptId || !Number.isFinite(now)) throw new TypeError('A durable model attempt and clock are required')
  const deadline = typeof deadlineAt === 'number' ? deadlineAt : Date.parse(deadlineAt)
  if (!Number.isFinite(deadline) || now >= deadline) return { action: 'limited', reason: 'deadline' }
  if (!transientModelFailure(error)) return { action: 'fail', reason: 'non-transient' }
  // A checkpoint replay must not consume another retry or postpone the recorded wake time.
  if (retry?.failedAttemptId === attemptId) return { action: 'retry', retry: structuredClone(retry), replayed: true }
  const attempts = retry?.attempts ?? 0
  if (!Number.isInteger(attempts) || attempts < 0 || attempts >= CONTINUOUS_RETRY_DELAYS.length) return { action: 'fail', reason: 'retry-exhausted' }
  const suppliedDelay = error.retryMetadata?.retryAfterMs
  const delay = Math.max(CONTINUOUS_RETRY_DELAYS[attempts], Number.isSafeInteger(suppliedDelay) && suppliedDelay >= 0 ? suppliedDelay : 0)
  if (!Number.isSafeInteger(now + delay) || now + delay >= deadline) return { action: 'limited', reason: 'deadline' }
  return { action: 'retry', retry: { attempts: attempts + 1, failedAttemptId: attemptId,
    errorCode: ['MODEL_TIMEOUT', 'MODEL_RATE_LIMITED', 'MODEL_UNAVAILABLE', 'MODEL_FAILED'].includes(error.code) ? error.code : 'MODEL_FAILED',
    nextAttemptAt: new Date(now + delay).toISOString() }, replayed: false }
}

export function continuousRetryDue(retry, now = Date.now()) {
  const next = Date.parse(retry?.nextAttemptAt)
  return Number.isFinite(next) && Number.isFinite(now) && now >= next
}
