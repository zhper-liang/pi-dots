import { createTestReply } from './test-reply.mjs'
export { createTestReply } from './test-reply.mjs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { TaskInputError } from './tasks.mjs'
import { serveStatic } from './static.mjs'

export const MAX_BODY_BYTES = 16 * 1024
export const MAX_MESSAGE_LENGTH = 4000

class RequestError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(res, status, body, headers = {}) {
  // Serialize before committing headers: serialization failures must remain recoverable.
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

async function readJson(req) {
  const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 提交消息。')
  }
  const chunks = []
  let bytes = 0
  // Read events rather than destroying the socket on an over-limit request:
  // the caller must still receive the structured 413 response.
  const body = await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        reject(new RequestError(413, 'PAYLOAD_TOO_LARGE', '请求体不能超过 16 KiB。'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => reject(new RequestError(400, 'INVALID_REQUEST', '请求读取失败。')))
    req.on('aborted', () => reject(new RequestError(400, 'INVALID_REQUEST', '请求已中断。')))
  })
  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw new RequestError(400, 'INVALID_JSON', '请求体必须是有效 JSON。')
  }
  return data
}

// Task messages may carry the Skill picked with "/" in the composer: {message, skillId?}.
async function readTaskMessage(req) {
  const data = await readJson(req)
  if (data && typeof data === 'object' && ['mention','mentions','targetBotId'].some(k => Object.hasOwn(data,k))) throw new RequestError(400, 'GROUP_MENTION_UNSUPPORTED', '暂不支持@定向请求。')
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['message', 'skillId'].includes(k)) ||
    typeof data.message !== 'string' || !data.message.trim() || data.message.length > MAX_MESSAGE_LENGTH || (data.skillId !== undefined && typeof data.skillId !== 'string')) {
    throw new RequestError(400, 'INVALID_MESSAGE', '请提供 message（1–4000 个字符的非空字符串），可选 skillId。')
  }
  return data
}
async function readMessage(req) {
  const data = await readJson(req)
  if (data && typeof data === 'object' && ['mention','mentions','targetBotId'].some(k => Object.hasOwn(data,k))) throw new RequestError(400, 'GROUP_MENTION_UNSUPPORTED', '暂不支持@定向请求。')
  if (
    !data || typeof data !== 'object' || Array.isArray(data) ||
    Object.keys(data).length !== 1 || typeof data.message !== 'string' ||
    !data.message.trim() || data.message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new RequestError(400, 'INVALID_MESSAGE', '请仅提供 message 字段，内容须为 1–4000 个字符的非空字符串。')
  }
  return data.message
}

/** reply is injectable so service failures can be verified without a debug API. */
export function createApiServer({ token, reply = createTestReply, tasks, staticDir, onError = () => {} }) {
  if (typeof token !== 'string' || !token) throw new Error('API token is required')
  const digest = (value) => createHash('sha256').update(value).digest()
  const expected = digest(`Bearer ${token}`)
  const server = createServer(async (req, res) => {
    try {
      // Private loopback relay for the stdio transport, NOT public HTTP MCP.
      // UI/admin bearer tokens are deliberately not accepted by this endpoint.
      if (req.url === '/api/workspace/mcp-dispatch') {
        if (req.headers.origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new RequestError(403, 'MCP_ORIGIN', '仅允许无Origin的本机桥。')
        let host
        try { host = new URL(`http://${req.headers.host}`).hostname } catch { throw new RequestError(403, 'MCP_HOST', '本机目标无效。') }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new RequestError(403, 'MCP_HOST', '本机目标无效。')
        if (!tasks || req.method !== 'POST') throw new RequestError(405, 'METHOD_NOT_ALLOWED', '桥仅允许POST。')
        const credential = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1]
        const body = await readJson(req)
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['message', 'close'].includes(k)) || body.close !== undefined && body.close !== true) throw new RequestError(400, 'MCP_INPUT', '桥参数无效。')
        const session = req.headers['x-pidot-mcp-session']
        if (session !== undefined && (typeof session !== 'string' || !/^[a-f0-9-]{36}$/.test(session))) throw new RequestError(400, 'MCP_INPUT', '会话标识无效。')
        sendJson(res, 200, await tasks.workspaceMcpMessage(credential, session, body.message, body.close === true)); return
      }
      if (staticDir && await serveStatic(req, res, staticDir)) return
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) {
        req.resume()
        sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '缺少或无效的访问 token。' } }, {
          'WWW-Authenticate': 'Bearer',
        })
        return
      }
      if (tasks && req.url === '/api/inbox') {
        if (req.method !== 'GET') { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET。' } }, { Allow: 'GET' }); return }
        req.resume(); sendJson(res, 200, { data: await tasks.inbox() }); return
      }
      if (tasks && (req.url === '/api/rules' || req.url === '/api/rules/remove')) {
        if (req.url === '/api/rules' && req.method === 'GET') { req.resume(); sendJson(res, 200, { data: await tasks.rules.list() }); return }
        if (req.method === 'POST') { const input = await readJson(req); sendJson(res, 200, { data: await (req.url === '/api/rules' ? tasks.rules.add(input) : tasks.rules.remove(input)) }); return }
        req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '方法不支持。' } }); return
      }
      if (tasks && req.url === '/api/findings') {
        if (req.method === 'GET') { req.resume(); sendJson(res, 200, { data: await tasks.findings.list() }); return }
        if (req.method === 'POST') { sendJson(res, 200, { data: await tasks.findings.act(await readJson(req)) }); return }
        req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET 与 POST。' } }, { Allow: 'GET, POST' }); return
      }
      if (tasks && req.url === '/api/automation') {
        if (req.method === 'GET') { req.resume(); sendJson(res, 200, { data: await tasks.automationStatus() }); return }
        if (req.method === 'POST') { sendJson(res, 200, { data: await tasks.setAutomation(await readJson(req)) }); return }
        req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET 与 POST。' } }, { Allow: 'GET, POST' }); return
      }
      if (tasks && req.url?.startsWith('/api/workspace/')) {
        const path = req.url.slice('/api/workspace/'.length)
        if (path === 'status' && req.method === 'GET') { req.resume(); sendJson(res, 200, { data: await tasks.workspaceDiagnostics() }); return }
        const reminderMethods = { 'reminder-manage': 'manage', 'reminder-list': 'list', 'notification-read': 'read' }
        if (req.method === 'POST' && Object.hasOwn(reminderMethods, path)) { sendJson(res, 200, { data: await tasks.workspaceReminders[reminderMethods[path]](await readJson(req)) }); return }
        const scheduleMethods = { 'schedule-manage': 'manage', 'schedule-list': 'list', 'schedule-test': 'testRun' }
        if (req.method === 'POST' && Object.hasOwn(scheduleMethods, path)) { sendJson(res, 200, { data: await tasks.workspaceSchedules[scheduleMethods[path]](await readJson(req)) }); return }
        const agentMethods = { 'client-issue': 'issueClient', 'client-revoke': 'revokeClient', 'client-list': 'listClients', 'agent-pending': 'pending', 'agent-operation': 'operationStatus', 'agent-confirm-local': 'confirmLocal', 'agent-allow-rule': 'manageAllowRule', 'agent-undo': 'undoAuto' }
        if (req.method === 'POST' && Object.hasOwn(agentMethods, path)) { sendJson(res, 200, { data: await tasks.workspaceAgent[agentMethods[path]](await readJson(req)) }); return }
        const methods = { query: 'query', get: 'getLocalItem', command: 'executeLocal', grant: 'manageLocalGrant', operation: 'getLocalOperation', 'external-sync-status': 'syncStatus', 'external-sync-configure': 'configureSync', 'external-sync-refresh': 'refreshSync', 'external-sources': 'externalSources', 'external-grant': 'grantExternal', 'external-query': 'queryExternal', 'external-get': 'getExternal', 'external-prepare': 'prepareExternal', 'external-confirm': 'confirmExternal', 'external-cancel': 'cancelExternal', 'external-execute': 'executeExternal', 'external-operation': 'getExternalOperation' }
        if (req.method !== 'POST' || !Object.hasOwn(methods, path)) {
          req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '业务路由或方法不支持。' } }); return
        }
        sendJson(res, 200, { data: await tasks.workspace[methods[path]](await readJson(req)) }); return
      }
      if (tasks && req.url?.startsWith('/api/feishu/')) {
        const path = req.url.slice('/api/feishu/'.length)
        let data
        if (path === 'status' && req.method === 'GET') data = await tasks.feishuCalendar.status()
        else if (path === 'calendars' && req.method === 'GET') data = await tasks.feishuCalendar.calendars()
        else if (path === 'manage' && req.method === 'POST') data = await tasks.feishuCalendar.manage(await readJson(req))
        else if (path === 'view' && req.method === 'POST') data = await tasks.calendarView(await readJson(req))
        else if (path === 'command' && req.method === 'POST') data = await tasks.commandFeishuCalendar(await readJson(req))
        else if (path === 'read' && req.method === 'POST') {
          const input = await readJson(req)
          if (!input || Object.keys(input).some(k => !['taskId', 'name', 'arguments'].includes(k))) throw new RequestError(400, 'INVALID_REQUEST', '日历读取必须绑定Task。')
          data = await tasks.readFeishuCalendar(input)
        } else { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '日历接口方法无效。' } }); return }
        sendJson(res, 200, { data }); return
      }
      const groupRoute = /^\/api\/groups(?:\/([a-f0-9-]{36})(\/.*)?)?$/.exec(req.url)
      if (tasks && groupRoute) {
        if (!groupRoute[1]) {
          if (req.method === 'GET') { req.resume(); sendJson(res, 200, { groups: await tasks.listGroups() }) }
          else if (req.method === 'POST') { const result = await tasks.createGroup(await readJson(req)); sendJson(res, result.created ? 201 : 200, result) }
          else { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持GET/POST。' } }) }
          return
        }
        const groupTask = await tasks.getGroup(groupRoute[1])
        const childRoute=/^\/children\/([1-9]\d*)(\/(?:cancel|archive|limits|blockers\/[1-9]\d*\/resolve|approvals\/[1-9]\d*\/(?:decide|insert|verify)))$/.exec(groupRoute[2]??'')
        if(childRoute) {
          const child=await tasks.assertGroupChild(groupRoute[1],Number(childRoute[1]))
          req.url=`/api/tasks/${child.taskId}${childRoute[2]}`
        } else req.url = `/api/tasks/${groupTask.taskId}${groupRoute[2] ?? ''}`
      }
      const ownedTask = /^\/api\/tasks\/([1-9]\d*)(?:\/|$)/.exec(req.url)
      if (tasks && ownedTask) await tasks.get(Number(ownedTask[1]), false)
      // Optional Bot-qualified routes bind ALL existing task controls to the selected Bot.
      const scoped = /^\/api\/bots\/([a-z][a-z0-9-]*)\/tasks(?:\/([1-9]\d*)(\/.*)?)?$/.exec(req.url)
      let scopedBot
      if (tasks && scoped) {
        scopedBot = scoped[1]
        if (scoped[2] && !Number.isSafeInteger(Number(scoped[2]))) throw new TaskInputError(404, 'TASK_NOT_FOUND', '会话不存在。')
        await tasks.assertBotTask(scopedBot, scoped[2] ? Number(scoped[2]) : undefined)
        req.url = scoped[2] ? `/api/tasks/${scoped[2]}${scoped[3] ?? ''}` : '/api/tasks'
      }
      const skillMatch = /^\/api\/tasks\/([1-9]\d*)\/skills$/.exec(req.url)
      if (tasks && (req.url === '/api/skills' || skillMatch)) {
        const method = skillMatch ? 'POST' : 'GET'
        if (req.method !== method && !(skillMatch && ['DELETE', 'GET'].includes(req.method))) {
          req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `该接口仅支持 ${skillMatch ? 'GET / POST / DELETE' : method}。` } }, { Allow: skillMatch ? 'GET, POST, DELETE' : method }); return
        }
        // GET: the Skills this Task can use with "/" (availability and reason per Skill).
        if (skillMatch && req.method === 'GET') { req.resume(); sendJson(res, 200, { skills: await tasks.taskSkills(Number(skillMatch[1])) }); return }
        if (skillMatch) {
          const id = Number(skillMatch[1])
          if (!Number.isSafeInteger(id)) throw new TaskInputError(400, 'INVALID_TASK', 'Task ID 无效。')
          sendJson(res, 200, { task: await tasks[req.method === 'DELETE' ? 'deactivateSkill' : 'activateSkill'](id, await readJson(req)) })
        } else { req.resume(); sendJson(res, 200, { skills: await tasks.skillCatalog() }) }
        return
      }
      const verifyMatch = /^\/api\/tasks\/([1-9]\d*)\/approvals\/([1-9]\d*)\/verify$/.exec(req.url)
      if (tasks && verifyMatch) {
        if (req.method !== 'POST') { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST。' } }, { Allow: 'POST' }); return }
        sendJson(res, 200, { task: await tasks.verifyAction(Number(verifyMatch[1]), Number(verifyMatch[2]), await readJson(req)) })
        return
      }
      const insertionMatch = /^\/api\/tasks\/([1-9]\d*)\/approvals\/([1-9]\d*)\/insert$/.exec(req.url)
      if (tasks && insertionMatch) {
        if (req.method !== 'POST') { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST。' } }, { Allow: 'POST' }); return }
        sendJson(res, 200, { task: await tasks.submitApprovalInsertion(Number(insertionMatch[1]), Number(insertionMatch[2]), await readJson(req)) })
        return
      }
      const approvalMatch = /^\/api\/tasks\/([1-9]\d*)\/approvals\/([1-9]\d*)\/decide$/.exec(req.url)
      if (tasks && approvalMatch) {
        if (req.method !== 'POST') { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST。' } }, { Allow: 'POST' }); return }
        sendJson(res, 200, { task: await tasks.decideApproval(Number(approvalMatch[1]), Number(approvalMatch[2]), await readJson(req)) })
        return
      }
      const blockerMatch = /^\/api\/tasks\/([1-9]\d*)\/blockers\/([1-9]\d*)\/resolve$/.exec(req.url)
      if (tasks && blockerMatch) {
        if (req.method !== 'POST') { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST。' } }, { Allow: 'POST' }); return }
        sendJson(res, 200, { task: await tasks.resolveBlocker(Number(blockerMatch[1]), Number(blockerMatch[2]), await readJson(req)) })
        return
      }
      const migrationMatch = /^\/api\/tasks\/([1-9]\d*)\/configuration-migration$/.exec(req.url)
      if (tasks && migrationMatch) {
        if (!Number.isSafeInteger(Number(migrationMatch[1]))) throw new TaskInputError(400, 'INVALID_TASK', 'Task ID 无效。')
        if (!['GET', 'POST'].includes(req.method)) { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持GET、POST。' } }, { Allow: 'GET, POST' }); return }
        const id = Number(migrationMatch[1])
        const result = req.method === 'GET' ? { preview: await tasks.previewMigration(id) } : await tasks.migrateConfiguration(id, await readJson(req))
        req.resume(); sendJson(res, 200, result); return
      }
      const deactivationMatch = /^\/api\/bots\/([a-z][a-z0-9-]*)\/deactivate$/.exec(req.url)
      if (tasks && deactivationMatch) {
        if (req.method !== 'POST') { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持POST。' } }, { Allow: 'POST' }); return }
        sendJson(res, 200, await tasks.deactivateBot(deactivationMatch[1], await readJson(req))); return
      }
      const configurationMatch = /^\/api\/bots\/([a-z][a-z0-9-]*)\/configuration$/.exec(req.url)
      if (tasks && configurationMatch) {
        if (!['GET', 'POST'].includes(req.method)) { req.resume(); sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持GET、POST。' } }, { Allow: 'GET, POST' }); return }
        const result = req.method === 'GET' ? await tasks.getBotConfiguration(configurationMatch[1]) : await tasks.updateBotConfiguration(configurationMatch[1], await readJson(req))
        req.resume(); sendJson(res, 200, result); return
      }
      const accessMatch = /^\/api\/bots\/([a-z][a-z0-9-]*)\/tool-access$/.exec(req.url)
      const revokeMatch = /^\/api\/bots\/([a-z][a-z0-9-]*)\/tool-access\/([A-Za-z0-9_]+)$/.exec(req.url)
      const taskMatch = /^\/api\/tasks\/([1-9]\d*)(\/(?:messages|state|limits|steer|cancel|stop-work|archive|follow-up))?$/.exec(req.url)
      const route = tasks && revokeMatch ? 'revoke-tool' : tasks && accessMatch ? 'tool-access' : tasks && req.url === '/api/tools' ? 'tools' : req.url === '/api/chat' ? 'chat'
        : tasks && req.url === '/api/bots' ? 'bots'
        : tasks && req.url === '/api/tasks' ? 'tasks'
        : tasks && taskMatch && Number.isSafeInteger(Number(taskMatch[1])) ? (taskMatch[2] === '/follow-up' ? 'follow-up' : taskMatch[2] === '/stop-work' ? 'stop-work' : taskMatch[2] === '/archive' ? 'archive' : taskMatch[2] === '/cancel' ? 'cancel' : taskMatch[2] === '/steer' ? 'steer' : taskMatch[2] === '/limits' ? 'limits' : taskMatch[2] === '/state' ? 'state' : taskMatch[2] ? 'messages' : 'task') : null
      if (!route) {
        req.resume()
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } })
        return
      }
      const methods = route === 'revoke-tool' ? ['DELETE'] : route === 'tool-access' ? ['GET', 'PATCH'] : ['state', 'limits'].includes(route) ? ['PATCH'] : ['chat', 'messages', 'steer', 'cancel', 'stop-work', 'archive', 'follow-up'].includes(route) ? ['POST'] : ['tasks', 'bots'].includes(route) ? ['GET', 'POST'] : ['GET']
      if (!methods.includes(req.method)) {
        req.resume()
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `该接口仅支持 ${methods.join('、')}。` } }, { Allow: methods.join(', ') })
        return
      }
      if (route === 'revoke-tool') {
        req.resume()
        sendJson(res, 200, { access: await tasks.revokeTool(revokeMatch[1], revokeMatch[2]) })
      } else if (route === 'follow-up') {
        req.resume()
        sendJson(res, 200, { data: await tasks.followUpRun(Number(taskMatch[1])) })
      } else if (route === 'archive') {
        sendJson(res, 200, { task: await tasks.setArchived(Number(taskMatch[1]), await readJson(req)) })
      } else if (route === 'stop-work') {
        sendJson(res,200,{task:await tasks.stopWork(Number(taskMatch[1]),await readJson(req))})
      } else if (route === 'cancel') {
        sendJson(res, 200, { task: await tasks.cancel(Number(taskMatch[1]), await readJson(req)) })
      } else if (route === 'steer') {
        sendJson(res, 202, await tasks.steer(Number(taskMatch[1]), await readJson(req)))
      } else if (route === 'limits') {
        sendJson(res, 200, { task: await tasks.raiseLimits(Number(taskMatch[1]), await readJson(req)) })
      } else if (route === 'tool-access' && req.method === 'GET') {
        req.resume()
        sendJson(res, 200, { access: await tasks.getToolAccess(accessMatch[1]) })
      } else if (route === 'tool-access') {
        sendJson(res, 200, { access: await tasks.updateToolAccess(accessMatch[1], await readJson(req)) })
      } else if (route === 'tools') {
        req.resume()
        sendJson(res, 200, { tools: tasks.toolCatalog() })
      } else if (route === 'chat') {
        sendJson(res, 200, await reply(await readMessage(req)))
      } else if (route === 'state') {
        sendJson(res, 200, { task: await tasks.updateState(Number(taskMatch[1]), await readJson(req)) })
      } else if (route === 'messages') {
        const accepted = groupRoute?.[1] ? await tasks.send(Number(taskMatch[1]), await readJson(req).then(data => data && Object.keys(data).length === 1 && typeof data.message === 'string' ? data.message : data))
          : await readTaskMessage(req).then(({ message, skillId }) => tasks.send(Number(taskMatch[1]), message, undefined, skillId === undefined ? {} : { skillId }))
        sendJson(res, 202, accepted)
      } else if (route === 'bots' && req.method === 'POST') {
        const result = await tasks.createBot(await readJson(req))
        sendJson(res, result.created ? 201 : 200, result)
      } else if (route === 'bots') {
        req.resume()
        sendJson(res, 200, { bots: tasks.bots(), mainSessions: tasks.mainSessions ? await tasks.mainSessions() : {} })
      } else if (route === 'tasks' && req.method === 'POST') {
        const input = await readJson(req)
        if (scopedBot && input?.botId !== undefined && input.botId !== scopedBot) throw new TaskInputError(400, 'BOT_BINDING_MISMATCH', '请求Bot与路由不一致。')
        const task = await tasks.create(scopedBot && input && typeof input === 'object' && !Array.isArray(input) ? { ...input, botId: scopedBot } : input)
        sendJson(res, 201, { task }, { Location: `/api/tasks/${task.taskId}` })
      } else if (route === 'tasks') {
        req.resume()
        sendJson(res, 200, { tasks: await tasks.list(scopedBot) })
      } else {
        req.resume()
        const task = await tasks.get(Number(taskMatch[1]))
        if (!task) throw new RequestError(404, 'TASK_NOT_FOUND', '会话不存在。')
        sendJson(res, 200, { task })
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return
      if (res.headersSent) { res.destroy(); onError('API response interrupted'); return }
      if (error instanceof RequestError || error instanceof TaskInputError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } }, { Connection: 'close' })
      } else {
        // Do not serialize exception details: they can contain user data or credentials.
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务暂时无法处理请求，请稍后重试。' } })
        onError('API request failed')
      }
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.maxRequestsPerSocket = 100
  return server
}
