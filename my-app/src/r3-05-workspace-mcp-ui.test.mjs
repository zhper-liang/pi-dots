import test from 'node:test'
import assert from 'node:assert/strict'
import { publicWorkspaceMcpStatus, workspaceMcpView, workspaceMcpErrorText } from './google-workspace-mcp-ui.mjs'

const connected = { connected: true, services: ['calendar', 'tasks', 'gmail', 'drive', 'docs', 'sheets'] }
const connection = { connectionId: 'google-workspace', name: 'Google 邮件与文件', revision: 'r1', enabled: true, status: 'ready', toolCount: 41,
  googleServices: ['gmail', 'drive', 'docs', 'sheets'], lastCheck: { status: 'ready', checkedAt: '2026-10-31T00:00:00.000Z' } }
const status = (runtime = 'running', extra = {}) => publicWorkspaceMcpStatus({ runtime: { state: runtime, version: '2.2.1', expectedVersion: '2.2.1', customAddress: false },
  googleTokenSource: true, connection, ...extra })

test('R3-05 UI: the public status keeps only contract fields', () => {
  const view = publicWorkspaceMcpStatus({ runtime: { state: 'running', version: '<b>2</b>', url: 'http://127.0.0.1:8000/mcp' }, googleTokenSource: true, token: 'ya29.leak',
    connection: { ...connection, bearerToken: 'ya29.leak', googleServices: ['gmail', 'calendar'], lastCheck: { checkedAt: 'x', error: { code: 'raw provider text' } } } })
  const json = JSON.stringify(view)
  assert.equal(json.includes('ya29'), false); assert.equal(json.includes('127.0.0.1'), false)
  assert.equal(view.runtime.version, null); assert.deepEqual(view.connection.googleServices, ['gmail']); assert.equal(view.connection.lastCheck.code, null)
  assert.throws(() => publicWorkspaceMcpStatus({ runtime: { state: 'maybe' } }))
  assert.equal(publicWorkspaceMcpStatus({ runtime: { state: 'running' }, connection: { status: 'ready' } }).connection, null)
})

test('R3-05 UI: running, not running and connected are told apart honestly', () => {
  const ready = workspaceMcpView(status(), connected)
  assert.equal(ready.runtime.text, '正在运行（2.2.1）'); assert.equal(ready.runtime.tone, 'ok')
  assert.equal(ready.connection.text, '已连接 · 41 个工具'); assert.equal(ready.canCheck, true); assert.equal(ready.checkLabel, '重新检查')
  const down = workspaceMcpView(status('not_running'), connected)
  assert.equal(down.runtime.text, '没有运行'); assert.equal(down.runtime.tone, 'bad'); assert.match(down.runtime.hint, /启动 workspace-mcp/)
  assert.equal(down.connection.text, '不可用：workspace-mcp 没有运行', 'a stored ready record is not shown as connected'); assert.equal(down.canCheck, false)
  assert.equal(workspaceMcpView(status('unexpected'), connected).runtime.text, '该地址上不是 workspace-mcp')
  assert.equal(workspaceMcpView(status('no_response'), connected).runtime.text, '没有响应')
  assert.match(workspaceMcpView(status('invalid_config'), connected).runtime.hint, /本机地址/)
  const drift = publicWorkspaceMcpStatus({ runtime: { state: 'running', version: '2.3.0', expectedVersion: '2.2.1' }, googleTokenSource: true, connection })
  assert.equal(workspaceMcpView(drift, connected).runtime.tone, 'warn')
})

test('R3-05 UI: connection states follow Google, restart and the last check', () => {
  assert.match(workspaceMcpView(status('running', { connection: null }), connected).connection.hint, /对 Chief 说/)
  const restarted = workspaceMcpView(status('running', { connection: { ...connection, status: 'configured' } }), connected)
  assert.equal(restarted.connection.text, '已保存，需重新检查'); assert.equal(restarted.canCheck, true); assert.equal(restarted.checkLabel, '检查连接')
  const noGoogle = workspaceMcpView(status(), { connected: false, services: [] })
  assert.equal(noGoogle.connection.text, '等待 Google 授权'); assert.equal(noGoogle.canCheck, false)
  assert.equal(workspaceMcpView(status(), { connected: true, services: ['calendar', 'gmail'] }).connection.text, '等待 Google 授权', 'partial grant is not usable')
  const failed = workspaceMcpView(status('running', { connection: { ...connection, status: 'error', lastCheck: { checkedAt: 'x', error: { code: 'MCP_GOOGLE_TOKEN_REJECTED' } } } }), connected)
  assert.equal(failed.connection.text, '连接失败'); assert.match(failed.connection.hint, /拒绝了 Google 令牌/)
  assert.equal(workspaceMcpView(status('running', { connection: { ...connection, enabled: false, status: 'disabled' } }), connected).connection.text, '已停用')
  assert.equal(workspaceMcpView(status('running', { googleTokenSource: false }), connected).connection.text, '本实例没有接通 Google 令牌')
})

test('R3-05 UI: error text comes only from fixed server codes', () => {
  assert.equal(workspaceMcpErrorText(409, { error: { code: 'MCP_GOOGLE_NOT_CONNECTED', message: '固定文案' } }), '固定文案')
  assert.equal(workspaceMcpErrorText(409, { error: { code: 'raw', message: 'provider says ya29.x' } }), '操作没有成功，请重试。')
  assert.equal(workspaceMcpErrorText(404, null), '本实例尚未提供 workspace-mcp 状态。')
  assert.equal(workspaceMcpErrorText(502, null), '服务暂时无法处理，请稍后重试。')
})
