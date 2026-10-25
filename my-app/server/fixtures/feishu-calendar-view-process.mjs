import { writeFileSync } from 'node:fs'
import { CallUsage } from '../tools.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openTaskStore } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
import { createFeishuClient } from '../feishu-calendar.mjs'
import { projectFeishuEvent } from '../feishu-calendar.mjs'
import { feishuBeforeHash } from '../feishu-mutation.mjs'
import { FEISHU_MUTATION_TOOLS, FEISHU_UPDATE_TOOL, FEISHU_DELETE_TOOL } from '../feishu-mutation.mjs'
import { addRule } from '../policy.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
const FEISHU_CREATE_TOOL = process.argv[5] === 'delete' ? FEISHU_DELETE_TOOL : FEISHU_UPDATE_TOOL
const [directory, boundary, mode] = process.argv.slice(2), config = { baseUrl: 'https://fixture.invalid/v1', model: 'crash-fixture', apiKey: 'fixture-only' }
const load = name => readFile(join(directory, name), 'utf8').then(JSON.parse)
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value))
let manifest = mode === 'recover' ? await load('manifest.json') : {}, effects
try { effects = await load('effects.json') } catch { effects = { writes: 0, event: {event_id:'event-crash_0',organizer_calendar_id:'fixture-calendar',summary:'before',description:'',start_time:{timestamp:'1792458000',timezone:'Asia/Shanghai'},end_time:{timestamp:'1792459800',timezone:'Asia/Shanghai'},free_busy_status:'busy',status:'confirmed'} } }
async function pause() { await save('paused.json', { boundary, usage: (await store.get(manifest.id)).callUsage }); console.log('PAUSED'); await new Promise(() => {}) }
const client = createFeishuClient({ env: { FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-secret' }, fetchImpl: async (url, init) => {
  const response = data => new Response(JSON.stringify({ code: 0, data }))
  if (url.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'fixture-token', expire: 100 }))
  if (!url.includes('/events')) return response({ calendar: { calendar_id: 'fixture-calendar', summary: 'Pidot-test-crash', role: 'owner', type: 'shared' } })
  if (url.includes('instance_view')) return response({items:[effects.event]})
  if (url.includes('/attendees')) return response({items:[],has_more:false})
  if (['PATCH','DELETE'].includes(init.method)) { effects.writes++; effects.event = init.method==='PATCH' ? {...effects.event,...JSON.parse(init.body)} : {...effects.event,status:'cancelled'}; await save('effects.json', effects); if (mode !== 'recover' && boundary === 'sent') await pause(); return response({ event: effects.event }) }
  return response({ event: effects.event })
} })
const modelReply = async (_message, options) => {
  const base = { mode: 'model', reply: { role: 'assistant', content: '按真实宿主状态报告，不重复写入。' }, execution: { usage: { input: 4, output: 2, totalTokens: 6 } } }
  const results=options.context.messages.filter(m => m.role === 'toolResult')
  if(results.length>=2)return base
  const detail=results.length?JSON.parse(results[0].content[0].text).data:null
  const calls = [{type:'toolCall',id:detail?'crash-mutation':'exact-read',name:detail?FEISHU_CREATE_TOOL:'calendar_feishu_read_event',arguments:detail?{...(FEISHU_CREATE_TOOL===FEISHU_UPDATE_TOOL?{title:'after',description:'',start:'2026-10-20T09:00:00+08:00',end:'2026-10-20T09:30:00+08:00',timezone:'Asia/Shanghai',freeBusy:'busy'}:{}),resource:manifest.resource,eventId:'event-crash_0',beforeHash:detail.beforeHash}:{resource:manifest.resource,eventId:'event-crash_0'}}]
  return { ...base, toolCalls: calls, assistant: { role: 'assistant', content: calls, api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
const store = await openTaskStore({ file: join(directory, 'isolated.sqlite'), bots: listBots(config), feishuClient: client, modelReply, calendarWriteImpl: async (_op, { execute }) => { if (mode !== 'recover' && boundary === 'intent') await pause(); return execute() } })
async function until(predicate) { for (let i = 0; i < 4000; i++) { const t = await store.get(manifest.id); if (predicate(t)) return t; await new Promise(r => setTimeout(r, 5)) } throw Error('Timeout') }
if (mode === 'recover') {
  const expected = ['approved', 'verified'].includes(boundary) ? 'executed' : 'outcome-unknown'
  const result = await until(t => t.approvals.items[0].status === expected)
  await save('recovered.json', { status: result.approvals.items[0].status, usage: result.callUsage, items: result.approvals.items.length, operation: result.approvals.items[0].operation, receipt: result.approvals.items[0].receipt, writes: effects.writes }); await store.close()
} else {
  const b = await store.feishuCalendar.manage({ action: 'bind', calendarId: 'fixture-calendar', confirm: true }); manifest.resource = b.resource
  const { bot } = await store.getBotConfiguration('calendar'); await store.updateBotConfiguration('calendar', { requestId: 'crash02-bot', expectedVersion: bot.configRef.version, description: '真实创建', tools: ['calendar_feishu_read_schedule','calendar_feishu_read_event',...FEISHU_MUTATION_TOOLS], resources: [b.resource] })
  await store.harness.commit(tx => addRule(tx, { botId: 'calendar', match: { tool: FEISHU_CREATE_TOOL }, effect: 'ask' }), context)
  manifest.id = (await store.create({ botId: 'calendar' })).taskId; await save('manifest.json', manifest); await store.commandFeishuCalendar({taskId:manifest.id,viewId:(await store.calendarView({taskId:manifest.id,arguments:{resource:manifest.resource,start:'2026-10-20T00:00:00+08:00',end:'2026-10-21T00:00:00+08:00',timezone:'Asia/Shanghai'}})).viewId,requestId:'graph-crash05',operation:FEISHU_CREATE_TOOL===FEISHU_DELETE_TOOL?'delete':'update',arguments:{...(FEISHU_CREATE_TOOL===FEISHU_UPDATE_TOOL?{title:'after',description:'',start:'2026-10-20T09:00:00+08:00',end:'2026-10-20T09:30:00+08:00',timezone:'Asia/Shanghai',freeBusy:'busy'}:{}),resource:manifest.resource,eventId:'event-crash_0',beforeHash:feishuBeforeHash(projectFeishuEvent(effects.event,{}))},...(FEISHU_CREATE_TOOL===FEISHU_DELETE_TOOL?{confirmDelete:true}:{})}); const t = await until(t => t.runtime.checkpoint?.phase === 'awaitApproval')
  const usage = (await store.get(manifest.id)).callUsage
  const target = { approved: 'pidot.approval-decided', receipt: 'pidot.feishu-provider-accepted', verified: 'pidot.feishu-readback-verified' }[boundary]
  store.harness.subscribeCommits(({ changes }) => {
    if (!target || !changes.some(x => x.type === 'entry' && x.value.kind === target)) return
    const u = changes.find(x => x.type === 'document' && x.value?.kind === CallUsage.definition.kind)
    writeFileSync(join(directory, 'paused.json'), JSON.stringify({ boundary, usage: u?.value?.data ?? usage }))
    process.kill(process.pid, 'SIGSTOP')
  })
  void store.decideApproval(manifest.id, t.approvals.items[0].id, { decision: 'approved' })
}
