import { writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openTaskStore } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
import { createFeishuClient, FEISHU_TOOLS } from '../feishu-calendar.mjs'
const [dir, boundary, mode] = process.argv.slice(2), config = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture' }, file = n => join(dir, n), save = (n, d) => writeFile(file(n), JSON.stringify(d)), load = n => readFile(file(n), 'utf8').then(JSON.parse)
let m = mode === 'recover' ? await load('manifest.json') : {}, effects = mode === 'recover' ? await load('effects.json') : { reads: 0, writes: 0 }
const pause = async () => { await save('paused.json', { boundary }); console.log('PAUSED'); await new Promise(() => {}) }
const client = createFeishuClient({ env: { FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture' }, fetchImpl: async (url, init) => {
 const ok = data => new Response(JSON.stringify({ code: 0, data }))
 if (url.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'fixture', expire: 100 }))
 if (init.method !== 'GET') { effects.writes++; await save('effects.json', effects); throw Error('Forbidden write') }
 if (!url.includes('instance_view')) return ok({ calendar_id: 'fixture-calendar', summary: 'Pidot-test-crash', role: 'owner', type: 'shared' })
 effects.reads++; await save('effects.json', effects)
 if (mode !== 'recover' && boundary === 'in-flight') await pause()
 return ok({ items: [] })
} })
const modelReply = async (_msg, options) => {
 const base = { mode: 'model', reply: { role: 'assistant', content: '仅应用日历快照，不保证预订。' }, execution: { usage: { input: 4, output: 2, totalTokens: 6 } } }
 if (options.context.messages.some(x => x.role === 'toolResult')) return base
 const calls = [{ type: 'toolCall', id: 'freebusy-call', name: FEISHU_TOOLS[2], arguments: { resource: m.resource, start: '2026-10-20T00:00:00+08:00', end: '2026-10-21T00:00:00+08:00' } }]
 return { ...base, toolCalls: calls, assistant: { role: 'assistant', content: calls, api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
}
const s = await openTaskStore({ file: file('isolated.sqlite'), bots: listBots(config), feishuClient: client, modelReply })
const until = async predicate => { for (let i = 0; i < 2000; i++) { const t = await s.get(m.id); if (predicate(t)) return t; await new Promise(r => setTimeout(r, 5)) } throw Error('timeout') }
if (mode === 'recover') {
 const t = await until(t => t.runtime.disposition === 'idle'); await save('recovered.json', { id: t.taskId, conversationId: t.conversationId, usage: t.callUsage, messages: t.messages, effects }); await s.close()
} else {
 const b = await s.feishuCalendar.manage({ action: 'bind', calendarId: 'fixture-calendar', confirm: true }); m.resource = b.resource
 const { bot } = await s.getBotConfiguration('calendar'); await s.updateBotConfiguration('calendar', { requestId: 'crash04-bot', expectedVersion: bot.configRef.version, description: '应用日历忙闲', tools: FEISHU_TOOLS, resources: [b.resource] }); const t = await s.create({ botId: 'calendar' }); m.id = t.taskId; m.conversationId = t.conversationId; await save('manifest.json', m); await save('effects.json', effects)
 if (boundary === 'receipt') s.harness.subscribeCommits(({ changes }) => { if (changes.some(c => c.type === 'entry' && c.value.kind === 'pidot.tool-result')) { writeFileSync(file('paused.json'), JSON.stringify({ boundary })); process.kill(process.pid, 'SIGSTOP') } })
 await s.send(m.id, '查询应用日历忙闲'); if (boundary === 'completed') { const done = await until(t => t.runtime.disposition === 'idle'); await save('before.json', { usage: done.callUsage, messages: done.messages }); await pause() }
}
