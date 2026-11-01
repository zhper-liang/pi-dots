// Chat history as the conversation view shows it. Tool calls between two replies fold into one
// "调用了 N 个工具" row, each call matched with its receipt by call id, the way mainstream chat
// apps show tool use. Pure so it can be tested directly.

/** Splits messages into units: a plain message, or a run of tool steps. Text an assistant turn
 *  carries before its calls is its own message, so a run stays between two pieces of text. */
export function chatUnits(messages = []) {
  const units = [], byCall = new Map()
  let open = null
  const close = () => { open = null }
  const group = item => {
    if (!open) { open = { kind: 'tools', key: `tools-${item.id}`, first: item, steps: [] }; units.push(open) }
    return open
  }
  for (const item of messages) {
    if (item.role === 'assistant' && item.assistant) {
      const calls = item.assistant.content.filter(block => block.type === 'toolCall')
      if (item.content) { close(); units.push({ kind: 'message', key: `message-${item.id}`, item }) }
      for (const call of calls) {
        const step = { key: `call-${call.id ?? item.id}`, callId: call.id, name: call.name, arguments: call.arguments, receipt: null }
        group(item).steps.push(step)
        if (call.id) byCall.set(call.id, step)
      }
      continue
    }
    if (item.role === 'tool') {
      const step = item.callId ? byCall.get(item.callId) : undefined
      if (step && !step.receipt) { step.receipt = item; continue }
      group(item).steps.push({ key: `receipt-${item.id}`, callId: item.callId, name: item.toolName, arguments: item.arguments, receipt: item })
      continue
    }
    close()
    units.push({ kind: 'message', key: `message-${item.id}`, item })
  }
  return units
}

/** ok / failed from the receipt; without one, the call waits for you, still runs, or never returned. */
export function stepStatus(step, { running = false, waitingCallIds = [] } = {}) {
  if (step.callId && waitingCallIds.includes(step.callId)) return 'waiting'
  if (step.receipt) return step.receipt.result?.ok ? 'ok' : 'failed'
  return running ? 'running' : 'none'
}

export const stepLabels = { ok: '完成', failed: '失败', running: '进行中', waiting: '等你确认', none: '没有结果' }

/** The folded row's one line. One call is named; several are counted. */
export function toolSummary(names, statuses) {
  const count = names.length
  const what = count === 1 ? names[0] : `${count} 个工具`
  if (statuses.includes('waiting')) return { text: `${what}：等你确认`, tone: 'waiting' }
  if (statuses.includes('running')) return { text: `正在调用${count === 1 ? ` ${what}` : '工具'}…`, tone: 'running' }
  const failed = statuses.filter(status => status === 'failed').length, missing = statuses.filter(status => status === 'none').length
  const notes = [failed && `${failed} 个失败`, missing && `${missing} 个没有结果`].filter(Boolean)
  const text = `调用了 ${what}${notes.length ? ` · ${notes.join('，')}` : ''}`
  return { text, tone: failed ? 'failed' : missing ? 'none' : 'ok' }
}

/** Arguments and result as shown when you open one call: readable JSON, the error as one sentence. */
export function stepDetail(step) {
  const show = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const args = step.arguments && Object.keys(step.arguments).length ? show(step.arguments) : null
  const result = step.receipt?.result
  if (!result) return { arguments: args, result: null, error: null }
  if (!result.ok) return { arguments: args, result: null, error: result.error?.message ?? '没有成功。' }
  return { arguments: args, result: result.data === undefined ? null : show(result.data), error: null }
}
