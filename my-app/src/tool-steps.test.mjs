import test from 'node:test'
import assert from 'node:assert/strict'
import { chatUnits, stepDetail, stepStatus, toolSummary } from './tool-steps.mjs'

const turn = (id, calls, content = '') => ({ id, role: 'assistant', content, assistant: { content: calls.map(([callId, name, args = {}]) => ({ type: 'toolCall', id: callId, name, arguments: args })) } })
const receipt = (id, callId, ok = true, extra = {}) => ({ id, role: 'tool', content: '', callId, toolName: 'todo_list', result: ok ? { ok, data: { items: [] } } : { ok, error: { code: 'FAILED', message: '日历暂时连不上。' } }, ...extra })

test('tool turns between two replies fold into one run, each call matched with its receipt', () => {
  const units = chatUnits([
    { id: 1, role: 'user', content: '明天有什么安排' },
    turn(2, [['a', 'todo_list'], ['b', 'calendar_list']]),
    receipt(3, 'b'), receipt(4, 'a', false),
    turn(5, [['c', 'calendar_list']]), receipt(6, 'c'),
    { id: 7, role: 'assistant', content: '明天 **9 点**有例会。' },
  ])
  assert.deepEqual(units.map(unit => unit.kind), ['message', 'tools', 'message'])
  const run = units[1]
  assert.deepEqual(run.steps.map(step => [step.callId, step.receipt?.id]), [['a', 4], ['b', 3], ['c', 6]])
  assert.equal(run.first.id, 2)
})

test('text an assistant turn says before its calls stays a message, and splits the runs', () => {
  const units = chatUnits([turn(1, [['a', 'todo_list']], '我先查一下。'), receipt(2, 'a'), turn(3, [['b', 'todo_list']], '再看日历。'), receipt(4, 'b')])
  assert.deepEqual(units.map(unit => unit.kind), ['message', 'tools', 'message', 'tools'])
  assert.equal(units[0].item.content, '我先查一下。')
  assert.equal(units[1].steps.length, 1)
})

test('a receipt without its call still shows as a step; a later receipt for the same call does not replace the first', () => {
  const units = chatUnits([receipt(1, 'lost'), turn(2, [['a', 'todo_list']]), receipt(3, 'a'), receipt(4, 'a', false)])
  assert.equal(units.length, 1)
  assert.deepEqual(units[0].steps.map(step => step.receipt?.id), [1, 3, 4])
})

test('status comes from the receipt, a pending confirmation, or whether the task still runs', () => {
  const [run] = chatUnits([turn(1, [['a', 'x'], ['b', 'y'], ['c', 'z']]), receipt(2, 'a')]).filter(unit => unit.kind === 'tools')
  assert.deepEqual(run.steps.map(step => stepStatus(step, { running: true, waitingCallIds: ['b'] })), ['ok', 'waiting', 'running'])
  assert.deepEqual(run.steps.map(step => stepStatus(step)), ['ok', 'none', 'none'])
})

test('the folded row names one call, counts several, and says what went wrong', () => {
  assert.deepEqual(toolSummary(['查看日历'], ['ok']), { text: '调用了 查看日历', tone: 'ok' })
  assert.deepEqual(toolSummary(['a', 'b', 'c'], ['ok', 'failed', 'ok']), { text: '调用了 3 个工具 · 1 个失败', tone: 'failed' })
  assert.deepEqual(toolSummary(['a', 'b'], ['ok', 'running']), { text: '正在调用工具…', tone: 'running' })
  assert.deepEqual(toolSummary(['a', 'b'], ['waiting', 'running']), { text: '2 个工具：等你确认', tone: 'waiting' })
  assert.deepEqual(toolSummary(['a'], ['none']), { text: '调用了 a · 1 个没有结果', tone: 'none' })
})

test('an opened call shows readable arguments and result, an error as its message, never ids', () => {
  const [run] = chatUnits([turn(1, [['call-77', 'todo_list', { day: '2026-11-02' }], ['call-78', 'todo_list']]), receipt(2, 'call-77'), receipt(3, 'call-78', false)])
  const ok = stepDetail(run.steps[0]), failed = stepDetail(run.steps[1])
  assert.equal(ok.arguments, '{\n  "day": "2026-11-02"\n}')
  assert.equal(ok.result, '{\n  "items": []\n}')
  assert.doesNotMatch(JSON.stringify(ok), /call-77/)
  assert.deepEqual(failed, { arguments: null, result: null, error: '日历暂时连不上。' })
})
