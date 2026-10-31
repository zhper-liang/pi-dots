import test from 'node:test'
import assert from 'node:assert/strict'
import { describeGroups } from './tool-group-settings.mjs'
import { TOOL_GROUPS } from './tool-groups.mjs'

const group = id => TOOL_GROUPS.find(item => item.id === id)
const view = (overrides = {}) => describeGroups({ botId: 'calendar', assigned: [], revoked: [], mainSession: true, ...overrides })

test('R1-08 projection: read-only tools can be disabled independently', () => {
  const names = [...group('history').tools]
  const enabled = view({ assigned: names }).find(item => item.id === 'history')
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.partiallyEnabled, false)
  assert.equal(enabled.available, true)
  assert.ok(enabled.tools.every(tool => tool.enabled && !tool.write))
  const disabled = view({ assigned: names, revoked: names }).find(item => item.id === 'history')
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.available, false)
  assert.ok(disabled.tools.every(tool => !tool.enabled && tool.status === 'revoked'))
})

test('R1-08 projection: enabled follows live assignment and revocation', () => {
  const names = [...group('todos').tools]
  const before = JSON.stringify({ names })
  for (const assigned of [[], [names[0]], names]) {
    for (const revoked of [[], names]) {
      const current = view({ assigned, revoked }).find(item => item.id === 'todos')
      assert.equal(current.enabled, assigned.some(name => !revoked.includes(name)))
      assert.equal(current.partiallyEnabled, assigned.length > 0 && assigned.length < names.length && revoked.length === 0)
      for (const tool of current.tools) assert.equal(tool.enabled, assigned.includes(tool.name) && !revoked.includes(tool.name))
    }
  }
  assert.equal(JSON.stringify({ names }), before)
})

test('R1-08 projection: tools stay off without assignment', () => {
  const current = view().find(item => item.id === 'todos')
  assert.equal(current.enabled, false)
  assert.equal(current.available, false)
  assert.ok(current.tools.every(tool => !tool.enabled))
})

test('R1-08 projection: partial read grants stay partial and do not grant writes', () => {
  const current = view({ assigned: ['calendar_read_schedule'] }).find(item => item.id === 'todos')
  assert.equal(current.enabled, true)
  assert.equal(current.partiallyEnabled, true)
  assert.deepEqual(current.tools.filter(tool => tool.enabled).map(tool => tool.name), ['calendar_read_schedule'])
})

test('R1-08 projection: session and Chief restrictions are not replaced by assignment', () => {
  const groups = view({ assigned: ['automation_pause', 'bot_manage'], mainSession: false })
  const automation = groups.find(item => item.id === 'automation')
  assert.equal(automation.enabled, true)
  assert.equal(automation.available, false)
  assert.equal(automation.tools[0].status, 'main-only')
  const bots = groups.find(item => item.id === 'bots')
  assert.equal(bots.enabled, true)
  assert.equal(bots.available, false)
  assert.equal(bots.tools[0].status, 'chief-only')
})
