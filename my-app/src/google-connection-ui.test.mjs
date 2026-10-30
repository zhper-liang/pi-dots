import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { GOOGLE_SERVICE_ROWS, publicGoogleStatus, serviceRowState, googleStatusText, googleResultText, disconnectText, googleErrorText } from './google-connection-ui.mjs'

const base = { connected: false, status: 'disconnected', email: null, services: [], requested: [], client: { configured: true, source: 'file', invalid: false, editable: true }, attempt: null, lastResult: null }
const row = id => GOOGLE_SERVICE_ROWS.find(r => r.id === id)

test('R3-02 UI: public status keeps only the contract fields', () => {
  const view = publicGoogleStatus({ ...base, refreshToken: '1//leak', client: { ...base.client, clientSecret: 'leak' }, services: ['calendar', 'evil'], attempt: { active: true, expiresAt: 'x', authorizeUrl: 'javascript:alert(1)' } })
  assert.ok(!JSON.stringify(view).includes('leak')); assert.deepEqual(view.services, ['calendar']); assert.equal(view.attempt, null)
  assert.throws(() => publicGoogleStatus({ connected: 'yes' }))
})

test('R3-02 UI: rows follow what was granted, not what was ticked', () => {
  const partial = publicGoogleStatus({ ...base, connected: true, status: 'connected', email: 'a@example.test', services: ['calendar', 'gmail'], requested: ['calendar', 'tasks', 'gmail', 'drive', 'docs', 'sheets'] })
  assert.deepEqual(GOOGLE_SERVICE_ROWS.map(r => serviceRowState(r, partial)), ['granted', 'missing', 'partial'])
  const needs = publicGoogleStatus({ ...base, status: 'needs_auth', email: 'a@example.test', requested: ['tasks'] })
  assert.equal(serviceRowState(row('tasks'), needs), 'missing')
  assert.equal(googleStatusText(partial), '已连接：a@example.test'); assert.equal(googleStatusText(needs), '需要重新连接：a@example.test')
  assert.equal(googleStatusText(publicGoogleStatus({ ...base, attempt: { active: true, expiresAt: 'x', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } })), '正在等待 Google 授权…')
})

test('R3-02 UI: result, disconnect and error text never come from arbitrary backend text', () => {
  assert.match(googleResultText({ result: 'denied', code: 'GOOGLE_ACCESS_DENIED' }), /拒绝/)
  assert.match(disconnectText({ revoked: false }), /手动移除/); assert.match(disconnectText({ revoked: true }), /已撤销/)
  assert.equal(googleErrorText(409, { error: { code: 'GOOGLE_ATTEMPT_USED', message: '固定文本' } }), '固定文本')
  assert.equal(googleErrorText(500, { error: { code: 'INTERNAL_ERROR', message: 'stack trace' } }), '服务暂时无法处理，请稍后重试。')
})

test('R3-02 UI: switches use Switch.tsx and secret inputs stay uncontrolled', async () => {
  const source = await readFile(new URL('./GoogleConnection.tsx', import.meta.url), 'utf8')
  assert.match(source, /import Switch from '\.\/Switch'/)
  assert.ok(!/type="checkbox"/.test(source))
  for (const name of ['google-client-secret', 'google-redirect-url']) assert.ok(!new RegExp(`name="${name}"[^>]*value=`).test(source), `${name} must not be a controlled input`)
  assert.match(source, /粘贴跳转地址/)
})
