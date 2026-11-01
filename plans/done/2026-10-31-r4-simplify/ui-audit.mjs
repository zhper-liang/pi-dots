// R4 acceptance walk. Run from my-app/: node ../plans/done/2026-10-31-r4-simplify/ui-audit.mjs --label before|after
// Isolated: temp DB, scripted model, Feishu client without credentials, no Google, no network, never .env.
// Exit code: "after" returns 1 on any finding; "before" always 0 (it only keeps screenshots).
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../', import.meta.url)), app = join(repo, 'my-app')
const label = process.argv[process.argv.indexOf('--label') + 1] ?? 'before'
const out = join(repo, '.scratch/r4-simplify/audit', label), dist = join(tmpdir(), `pidot-ui-audit-${label}`)
const playwrightPath = '/opt/npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core'
if (!existsSync(playwrightPath)) { console.error(`缺少 ${playwrightPath}。这是新依赖，按计划 §0 第 1 条先问用户。`); process.exit(2) }
const { chromium } = createRequire(import.meta.url)(playwrightPath)
await mkdir(out, { recursive: true })
execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: app, stdio: 'inherit' })

const { createApiServer } = await import(join(app, 'server/app.mjs'))
const { openTaskStore } = await import(join(app, 'server/tasks.mjs'))
const { listBots } = await import(join(app, 'server/bots.mjs'))
const { createFeishuClient } = await import(join(app, 'server/feishu-calendar.mjs'))
const temporary = await mkdtemp(join(tmpdir(), 'pidot-ui-audit-'))
const token = `ui-audit-${randomUUID()}`, config = { baseUrl: 'https://fixture.invalid/v1', model: 'audit-fixture', apiKey: 'not-a-key' }
const text = content => ({ mode: 'model', reply: { role: 'assistant', content },
  execution: { provider: 'fixture', api: 'openai-completions', model: config.model, usage: { input: 4, output: 2, totalTokens: 6 } } })
const turns = {}
const modelReply = async (message, options = {}) => {
  const botId = options.parametersBotId
  if (botId === 'calendar' && options.purpose === 'reply' && (turns[botId] = (turns[botId] ?? 0) + 1) % 2 === 1) {
    const calls = [{ type: 'toolCall', id: `call-${randomUUID()}`, name: 'workspace.list', arguments: { sourceId: 'local', type: 'Event' } }]
    return { ...text('先看一下日程'), toolCalls: calls, assistant: { role: 'assistant', content: calls, api: 'openai-completions', provider: 'fixture', model: config.model, stopReason: 'toolUse', timestamp: Date.now() } }
  }
  return text('好的，下午三点有一个会，其余时间空着。要把写周报排在四点吗？')
}
const store = await openTaskStore({ file: join(temporary, 'tasks.sqlite'), bots: listBots(config), modelReply, r4Migration: true,
  feishuClient: createFeishuClient({ env: {} }),
  detectorOptions: { autoStart: false }, workspaceScheduleOptions: { autoStart: false }, workspaceSyncOptions: { autoStart: false } })
const server = createApiServer({ token, tasks: store, staticDir: dist })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}`

// COPY.md 禁用词. Checked on visible text after opening every <details> except .tech-info.
const BANNED = [/requestId/, /epoch/i, /(?<![A-Za-z])Task(?![A-Za-z])/, /(?<![A-Za-z])Bot(?![A-Za-z])/, /资源/, /快照/, /审计/, /不代表/, /不会/, /先问/,
  /直接执行/, /写入确认/, /工具组/, /例行任务/, /简报/, /真实模型/, /模拟日程/, /回执/, /幂等/, /来源/, /workspace\./, /mcp_[0-9a-f]{6}/]
const ALLOWED_FAILURES = [/^\/api\/google\//, /^\/api\/external-mcp/]
const results = { label, surfaces: [], structure: [], failedRequests: [], pageErrors: [], notes: [] }
let browser, page

async function capture(name) {
  await page.waitForTimeout(700)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true })
  await page.evaluate(() => { for (const d of document.querySelectorAll('details:not(.tech-info):not([open])')) d.open = true })
  await page.waitForTimeout(300)
  const visible = await page.evaluate(() => document.body.innerText)
  const banned = [...new Set(BANNED.filter(rule => rule.test(visible)).map(String))]
  results.surfaces.push({ name, overflow, banned })
  return visible
}
const expect = (name, ok, detail) => { if (!ok) results.structure.push(`${name}: ${detail}`) }
async function nav(name) {
  if ((page.viewportSize()?.width ?? 1440) < 720) for (const toggle of await page.locator('button[aria-controls="shell-sidebar"]').all()) if (await toggle.isVisible()) { await toggle.click(); break }
  await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click()
}
const tabTexts = async selector => (await page.locator(selector).allInnerTexts()).map(t => t.trim())
async function send(message) { await page.locator('#message').fill(message); await page.getByRole('button', { name: '发送', exact: true }).click(); await page.waitForTimeout(3000) }

try {
  browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }))
  page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
  page.on('pageerror', e => results.pageErrors.push(e.message.slice(0, 200)))
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) results.pageErrors.push(m.text().slice(0, 200)) })
  page.on('response', r => { const path = new URL(r.url()).pathname; if (r.status() >= 400 && !ALLOWED_FAILURES.some(rule => rule.test(path))) results.failedRequests.push(`${r.status()} ${path}`) })
  await page.goto(url); await capture('01-login')
  await page.getByLabel('本地访问 token').fill(token); await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.locator('#message').waitFor()
  await send('今天有什么安排'); await capture('02-home')
  await page.getByRole('button', { name: '会话详情' }).first().click(); await capture('03-session-details'); await page.keyboard.press('Escape')
  await page.goto(`${url}/#new`); await capture('04-new-session')
  await page.goto(`${url}/#bots`); await capture('05-directory')
  await page.goto(`${url}/#new-bot`); await page.locator('#bot-name').waitFor()
  expect('新建机器人', await page.locator('details.bot-advanced summary').count() === 1, '缺少「高级」折叠')
  expect('新建机器人', /已开/.test(await page.locator('details.bot-advanced summary').innerText().catch(() => '')), '「高级」摘要没有列出已开能力')
  await capture('06-new-bot')
  await page.goto(`${url}/#bot=calendar`); await page.locator('#message').waitFor({ timeout: 10000 })
  await send('下午有什么会')
  const chat = await capture('07-bot-chat')
  expect('对话页', !(await page.getByText('请求参数').count()), '仍有「请求参数」')
  expect('对话页', !(await page.locator('[aria-label="会话视图"]').count()), '仍有「对话 / 时间线」切换')
  if (!chat.includes('列出待办和日程')) results.notes.push('对话页没看到「列出待办和日程」回执，请对照截图 07-bot-chat 人工确认')
  await page.goto(`${url}/#bot=calendar&tab=capabilities`); await page.waitForTimeout(800)
  expect('机器人设置', JSON.stringify(await tabTexts('[aria-label="机器人设置"] [role=tab]')) === JSON.stringify(['能力', '记忆', '设置']), '设置 tab 不是「能力 / 记忆 / 设置」')
  const sub = await tabTexts('[aria-label="能力分类"] [role=tab]')
  expect('能力', sub.length === 3 && /^Skills/.test(sub[0]) && /^MCP/.test(sub[1]) && /^工具集/.test(sub[2]), `子栏是 ${JSON.stringify(sub)}`)
  for (const [i, tab] of (await page.locator('[aria-label="能力分类"] [role=tab]').all()).entries()) { await tab.click(); await capture(`08-capabilities-${i}`) }
  await page.goto(`${url}/#bot=calendar&tab=memory`); await capture('09-memory')
  await page.goto(`${url}/#bot=calendar&tab=settings`); await capture('10-bot-settings')
  await page.goto(url); await page.locator('#message').waitFor()
  await nav('事项'); await page.waitForTimeout(500)
  const items = await tabTexts('.pd-subtabs [role=tab]')
  expect('事项', JSON.stringify(items) === JSON.stringify(['日历', '定时任务', '执行记录']), `tab 是 ${JSON.stringify(items)}`)
  for (const [i, tab] of (await page.locator('.pd-subtabs [role=tab]').all()).entries()) { await tab.click(); await capture(`11-items-${i}`) }
  await nav(/^通知/); await capture('12-inbox')
  await nav('设置'); await page.waitForTimeout(500)
  const sections = (await page.locator('#workspace-panel-settings section.today-card > h2').allInnerTexts()).map(t => t.trim())
  expect('设置', JSON.stringify(sections) === JSON.stringify(['连接', '模型', '自动化', '偏好', '高级']), `区块是 ${JSON.stringify(sections)}`)
  await capture('13-settings')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(url); await page.locator('#message').waitFor(); await capture('20-home-375')
  await page.goto(`${url}/#new-bot`); await capture('21-new-bot-375')
  await page.goto(`${url}/#bot=calendar&tab=capabilities`); await capture('22-capabilities-375')
  await page.goto(`${url}/#bot=calendar&tab=settings`); await capture('23-bot-settings-375')
  await page.goto(url); await page.locator('#message').waitFor(); await nav('设置'); await capture('24-settings-375')
} catch (error) {
  results.structure.push(`脚本中断：${String(error?.message ?? error).slice(0, 300)}`)
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  await browser?.close(); server.close(); await store.close(); await rm(temporary, { recursive: true, force: true })
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2))
}
const findings = [...results.surfaces.filter(s => s.overflow || s.banned.length).map(s => `${s.name}: ${s.overflow ? '横向溢出 ' : ''}${s.banned.join(' ')}`),
  ...results.structure, ...results.failedRequests.map(r => `失败请求 ${r}`), ...results.pageErrors.map(e => `页面错误 ${e}`)]
console.log(findings.length ? findings.join('\n') : '没有问题'); for (const note of results.notes) console.log(`提示：${note}`)
console.log(`截图与结果：${out}`)
process.exit(label === 'after' && findings.length ? 1 : 0)
