import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityStatusLabel, filterCapabilities, visibleCapabilities } from './bot-capabilities.mjs'

const item = (id, kind = 'tool', name = id, description = '') => ({ id, kind, name, description, status: 'ready' })

test('capability visibility hides system and skill tools, including the Chief management capability', () => {
  const items = [item('tool:skills'), item('tool:automation'), item('tool:bots'), item('tool:capabilities'), item('tool:todos'), item('skill:notes', 'skill'), item('mcp:local', 'mcp')]
  const visible = ['tool:capabilities', 'tool:todos', 'skill:notes', 'mcp:local']
  assert.deepEqual(visibleCapabilities(items, null).map(item => item.id), visible)
  assert.deepEqual(visibleCapabilities(items, 'assistant').map(item => item.id), visible)
  assert.deepEqual(visibleCapabilities(items, 'chief').map(item => item.id), visible.slice(1))
})

test('capability filtering uses the selected category and matches names or descriptions without case sensitivity', () => {
  const tools = item('tool:todos', 'tool', '日程与待办', 'Calendar and tasks')
  const skill = item('skill:notes', 'skill', 'NOTES', '整理记录')
  const mcp = item('mcp:local', 'mcp', 'Local server', 'Notes search')
  const items = [tools, skill, mcp]
  assert.deepEqual(filterCapabilities(items, 'tool', '  '), [tools])
  assert.deepEqual(filterCapabilities(items, 'tool', '  CALENDAR  '), [tools])
  assert.deepEqual(filterCapabilities(items, 'tool', '待办'), [tools])
  assert.deepEqual(filterCapabilities(items, 'skill', 'notes'), [skill])
  assert.deepEqual(filterCapabilities(items, 'mcp', 'nOtEs'), [mcp])
  assert.deepEqual(filterCapabilities(items, 'tool', 'Notes'), [])
})

test('capability statuses use the simplified interface labels', () => {
  assert.deepEqual(['ready', 'configured', 'needs_auth', 'missing_dependency', 'error', 'disabled'].map(capabilityStatusLabel), ['', '待检查', '需要凭据', '缺少依赖', '连接失败', '已停用'])
})
