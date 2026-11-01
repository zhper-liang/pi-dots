import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { taskStatus } from './taskStatus.ts'

test('continuous projection overrides active input and terminal runtime status', () => {
  const task = { activeInputId: 11, parameters: {}, runtime: { status: 'terminal', checkpoint: null }, continuous: { state: 'paused' } }
  assert.equal(taskStatus(task).label, '已暂停')
  task.continuous.state = 'completed'
  assert.equal(taskStatus(task).label, '已完成')
  task.continuous.state = 'pausing'
  assert.equal(taskStatus(task).label, '正在暂停')
  task.continuous = null
  task.runtime.status = 'running'
  assert.equal(taskStatus(task).label, '正在回复')
})
