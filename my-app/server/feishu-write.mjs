import { createHash } from 'node:crypto'
export const FEISHU_CREATE_TOOL = 'calendar_feishu_create_event'
export const feishuCreateCapability = Object.freeze({ reliableQuery: false, stableIdempotency: false })
const keys = ['resource', 'title', 'description', 'start', 'end', 'timezone', 'freeBusy']
function zonedTime(value, timezone) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(p => [p.type, p.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === value.slice(0, 19)
}
export function normalizeFeishuCreate(a) {
  try {
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length !== keys.length || !keys.every(k => Object.hasOwn(a, k)) || !/^feishu:[a-f0-9]{64}$/.test(a.resource)) return null
    if (typeof a.title !== 'string' || !a.title.trim() || a.title !== a.title.trim() || a.title.length > 300 || typeof a.description !== 'string' || a.description.length > 2000 || [...a.title + a.description].some(c => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))) return null
    if (typeof a.timezone !== 'string' || !a.timezone || !['busy', 'free'].includes(a.freeBusy) || !zonedTime(a.start, a.timezone) || !zonedTime(a.end, a.timezone) || Date.parse(a.end) <= Date.parse(a.start)) return null
    return { resource: a.resource, title: a.title, description: a.description, start: new Date(a.start).toISOString(), end: new Date(a.end).toISOString(), timezone: a.timezone, freeBusy: a.freeBusy }
  } catch { return null }
}
export const feishuCreateHash = args => { const value = normalizeFeishuCreate(args); return value ? createHash('sha256').update(JSON.stringify(value)).digest('hex') : null }
export const feishuCreateTool = Object.freeze({ name: FEISHU_CREATE_TOOL, effect: 'write', requiresConfirmation: true, recovery: feishuCreateCapability,
  description: '在明确获准的真实飞书日历创建普通单次定时日程。宿主默认直接执行；规则或全局暂停可要求网页确认，聊天或模型自称同意无效。提供标题、说明、带偏移起止、IANA时区和busy/free。禁止全天、重复、参会人、会议室、通知和透传字段。未知时不得重复创建或声称成功；以最终回执为准。',
  parameters: { type: 'object', additionalProperties: false, required: keys, properties: { resource: { type: 'string', pattern: '^feishu:[a-f0-9]{64}$' }, title: { type: 'string', minLength: 1, maxLength: 300 }, description: { type: 'string', maxLength: 2000 }, start: { type: 'string' }, end: { type: 'string' }, timezone: { type: 'string' }, freeBusy: { type: 'string', enum: ['busy', 'free'] } } } })
// No verified retention window: neither automatic retry nor mock query capability.
export async function dispatchFeishuCreate({ client, operation: op, guard, persist, signal }) {
  const a = normalizeFeishuCreate(op.arguments)
  if (!a || op.toolName !== FEISHU_CREATE_TOOL || op.parametersHash !== feishuCreateHash(op.arguments) || op.idempotencyKey !== op.id || !/^[a-f0-9-]{36}$/.test(op.id)) throw new Error('Invalid Feishu create intent')
  const base = `/calendar/v4/calendars/${encodeURIComponent(op.source.calendarId)}/events`
  const time = value => ({ timestamp: String(Date.parse(value) / 1000), timezone: a.timezone })
  const body = { summary: a.title, description: a.description, start_time: time(a.start), end_time: time(a.end), free_busy_status: a.freeBusy, need_notification: false, visibility: 'private', vchat: { vc_type: 'no_meeting' } }
  const data = await client.api(`${base}?idempotency_key=${encodeURIComponent(op.idempotencyKey)}`, { method: 'POST', body, signal, beforeRequest: () => guard(true) })
  const e = data?.event
  if (!e || typeof e.event_id !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(e.event_id) || ['.', '..'].includes(e.event_id)) throw new Error('Missing provider receipt')
  await persist({ eventId: e.event_id, acceptedAt: new Date().toISOString(), source: op.source, operationId: op.id, parametersHash: op.parametersHash })
  const read = await client.api(`${base}/${encodeURIComponent(e.event_id)}`, { signal, beforeRequest: () => guard(false) })
  await guard(false)
  const v = read?.event
  if (!v || v.event_id !== e.event_id || v.summary !== a.title || (v.description ?? '') !== a.description || v.recurrence || v.recurring_event_id || v.is_exception || v.status === 'cancelled' || v.start_time?.date || v.end_time?.date || Number(v.start_time?.timestamp) !== Date.parse(a.start) / 1000 || Number(v.end_time?.timestamp) !== Date.parse(a.end) / 1000 || v.start_time?.timezone !== a.timezone || v.end_time?.timezone !== a.timezone || v.free_busy_status !== a.freeBusy) throw new Error('Readback did not verify exact target')
  const { projectFeishuEvent } = await import('./feishu-calendar.mjs')
  const result = { ok: true, data: { simulated: false, provider: 'feishu', source: op.source, operationId: op.id, approvalId: op.approvalId, eventId: e.event_id, apiAccepted: true, readbackVerified: true, event: { id: e.event_id, ...a }, providerEvent: projectFeishuEvent(v, op.source), notice: '真实飞书API接受且精确ID回读匹配；不是模拟，不承诺外部exactly-once。' } }
  await persist(null, result)
  return result
}
