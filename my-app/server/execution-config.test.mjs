import test from 'node:test'
import assert from 'node:assert/strict'
import { readExecutionDefaults } from './config.mjs'
import { listBots } from './bots.mjs'
import { taskParameters } from './task-config.mjs'

test('execution defaults are validated, versioned, copied and overridden only for new Tasks', () => {
  assert.deepEqual(readExecutionDefaults({}), { callLimits: { modelCalls: 20, toolCalls: 10 }, maxOutputTokens: 4096 })
  const defaults = readExecutionDefaults({ PIDOT_DEFAULT_MODEL_CALLS: '1', PIDOT_DEFAULT_TOOL_CALLS: '0', PIDOT_DEFAULT_TOTAL_TOKENS: '80', PIDOT_MAX_OUTPUT_TOKENS: '512' })
  const bots = listBots(undefined, defaults)
  assert.deepEqual(bots[0].defaults.callLimits, { modelCalls: 1, toolCalls: 0, totalTokens: 80 })
  assert.notEqual(bots[0].configRef.version, listBots()[0].configRef.version)
  assert.equal(taskParameters({ callLimits: null }, bots[0].defaults).callLimits.totalTokens, 80)
  assert.equal(taskParameters({ callLimits: { modelCalls: 2 } }, bots[0].defaults).callLimits.totalTokens, 80)
  assert.equal(taskParameters({ maxOutputTokens: 100 }, bots[0].defaults).maxOutputTokens, 100)
  for (const value of [0, -1, 32769, 1.1, null, '100']) assert.throws(() => taskParameters({ maxOutputTokens: value }, bots[0].defaults))
  for (const value of ['', '-1', '1.1', 'Infinity', '9007199254740992']) assert.throws(() => readExecutionDefaults({ PIDOT_DEFAULT_MODEL_CALLS: value }))
  for (const value of ['0', '32769']) assert.throws(() => readExecutionDefaults({ PIDOT_MAX_OUTPUT_TOKENS: value }))
  defaults.callLimits.modelCalls = 99
  assert.equal(bots[0].defaults.callLimits.modelCalls, 1)
})
