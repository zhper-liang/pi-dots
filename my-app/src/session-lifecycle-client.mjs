import { isSessionActionReceipt } from './session-list.mjs'

export class SessionActionRecoveryError extends Error {
  constructor(state, { retryable = false, status = 0, code } = {}) {
    super(state === 'not_found' ? '尚未找到原请求。可保留相同请求标识显式重试。' : state === 'failed' ? '原请求已失败，会话未确认删除。可核查或显式重试原请求。' : '原请求已返回未知结果，会话未确认删除。请核查；显式重试仍会保留原请求标识。')
    this.name = 'SessionActionRecoveryError'
    this.state = state
    this.retryable = retryable
    this.status = status
    this.code = code
  }
}

// The injected request uses App's authenticated API client. Verification never resubmits a mutation.
export function createSessionActionHandlers(request) {
  return {
    async action(target, input) {
      const operation = target.kind === 'main' ? 'clear-main' : 'delete'
      try {
        const response = await request(`/api/tasks/${target.taskId}/${operation}`, { method: 'POST', body: JSON.stringify(input) })
        if (!isSessionActionReceipt(response?.data, target, input.requestId)) throw new Error('会话操作结果未确认，请用原请求核查。')
        return response.data
      } catch (error) {
        if (error?.code === 'SESSION_STOP_UNKNOWN') throw new SessionActionRecoveryError('unknown', { status: error.status, code: error.code })
        if (error?.status >= 400 && error.status < 500 && error.status !== 408) throw new SessionActionRecoveryError('failed', { retryable: true, status: error.status, code: error.code })
        throw error
      }
    },
    async verify(target, input) {
      let response
      try { response = await request(`/api/session-requests/${encodeURIComponent(input.requestId)}`, { method: 'GET' }) }
      catch (error) {
        if (error?.status === 404) throw new SessionActionRecoveryError('not_found', { retryable: true, status: 404, code: error.code })
        throw error
      }
      const status = response?.data
      if (!status || status.taskId !== target.taskId || status.action !== (target.kind === 'main' ? 'clear-main' : 'delete')) return null
      if (status.state === 'failed') throw new SessionActionRecoveryError('failed', { retryable: true, code: status.code })
      // The durable unknown record is written after the original POST has ended. A later POST
      // is permitted only by the user's separate retry action, never by this read operation.
      if (status.state === 'unknown') throw new SessionActionRecoveryError('unknown', { retryable: true, code: status.code })
      if (status.state !== 'succeeded') return null
      return isSessionActionReceipt(status.result, target, input.requestId) ? status.result : null
    },
  }
}

/** Drop only the old Task's state; never transfer a draft or selection into its replacement. */
export function removeSessionState(values, taskId) {
  const next = { ...values }
  delete next[taskId]
  return next
}

export function replaceMainSession(current, result) {
  return result.action === 'clear-main' ? { ...current, [result.botId]: result.replacementTaskId } : current
}
