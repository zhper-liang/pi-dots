import test from 'node:test'
import assert from 'node:assert/strict'
import { ROUTINE_WHEN, routineInput, ruleLabel, routineInstant } from './routines.mjs'
import { normalizeScheduleRule } from '../server/workspace-schedule-rules.mjs'
const base = { title: '整理', prompt: '汇总待办', botId: 'calendar', requestId: 't09-form', now: Date.parse('2026-01-01T00:00:00Z') }

test('T09 form exposes six frequencies and normalizes multi-weekday/month-end rules', () => {
  assert.deepEqual(ROUTINE_WHEN.map(([id]) => id), ['at', 'daily', 'weekly', 'monthly', 'interval', 'event'])
  const weekly = routineInput({ ...base, when: 'weekly', value: '09:00', weekdays: [5, 1, 3], timezone: 'America/New_York' }).input
  assert.deepEqual(weekly.rule, { type: 'weekly', time: '09:00', weekdays: [1, 3, 5] })
  assert.equal(weekly.timezone, 'America/New_York')
  assert.deepEqual(normalizeScheduleRule(weekly.rule, weekly.timezone), { type: 'weekly', time: '09:00', weekdays: [1, 3, 5] })
  assert.equal(ruleLabel(weekly.rule), '每周 周一、周三、周五 09:00')
  const monthly = routineInput({ ...base, when: 'monthly', value: '18:30', day: '31', model: 'fixture/model-2', notification: 'none' }).input
  assert.deepEqual(monthly.rule, { type: 'monthly', time: '18:30', day: 31 })
  assert.deepEqual(monthly.actionSpec.model, { id: 'fixture/model-2' })
  assert.equal(monthly.actionSpec.notification, 'none')
  assert.equal(ruleLabel(monthly.rule), '每月 31 日 18:30（短月取最后一天）')
  assert.ok(!Object.hasOwn(weekly.actionSpec, 'model'))
  assert.deepEqual(routineInput({ ...base, when: 'event', event: 'task_finished' }).input.rule, { type: 'event', event: 'task_finished' })
})

test('T09 form rejects malformed recurrence, model credentials, timezone and unsafe interval', () => {
  for (const input of [
    { when: 'weekly', value: '09:00', weekdays: [] }, { when: 'weekly', value: '09:00', weekdays: [1, 1] },
    { when: 'monthly', value: '09:00', day: '32' }, { when: 'monthly', value: '09:00', day: '1.5' },
    { when: 'daily', value: '9:00' }, { when: 'daily', value: '09:00', timezone: 'No/Zone' },
    { when: 'daily', value: '09:00', model: 'https://host/key?secret=bad' }, { when: 'interval', value: '525601' },
    { when: 'event', event: 'shell' }, { when: 'daily', value: '09:00', botId: '' },
  ]) assert.ok(routineInput({ ...base, ...input }).error, JSON.stringify(input))
})

test('T09 one-time form uses selected timezone, rejects DST gaps and chooses first overlap', () => {
  assert.equal(new Date(routineInstant('2026-11-01T01:30', 'America/New_York')).toISOString(), '2026-11-01T05:30:00.000Z')
  assert.equal(routineInstant('2026-03-08T02:30', 'America/New_York'), null)
  assert.equal(routineInstant('2026-02-30T09:00', 'Asia/Shanghai'), null)
  assert.equal(routineInput({ ...base, when: 'at', value: '2026-10-29T09:00', timezone: 'Asia/Shanghai' }).input.rule.at, '2026-10-29T01:00:00.000Z')
  assert.equal(routineInput({ ...base, when: 'at', value: '2026-10-29T09:00+09:00', timezone: 'Asia/Shanghai' }).input.rule.at, '2026-10-29T00:00:00.000Z')
})

test('T09 confirmation previews the actual frequency even while title/prompt are empty', async () => {
  const { routineRule } = await import('./routines.mjs')
  const defaultForm = { title: '', prompt: '', when: 'daily', value: '08:00' }
  assert.ok(routineInput({ ...base, ...defaultForm }).error)
  assert.equal(ruleLabel(routineRule(defaultForm).rule), '每天 08:00')
  for (const form of [
    { when: 'daily', value: '08:00' },
    { when: 'weekly', value: '09:00', weekdays: [1, 3, 5] },
    { when: 'monthly', value: '09:00', day: '31' },
    { when: 'interval', value: '60' },
    { when: 'event', event: 'event_changed' },
    { when: 'at', value: '2026-12-01T09:00', timezone: 'Asia/Shanghai' },
  ]) assert.deepEqual(routineRule({ ...form, now: base.now }).rule, routineInput({ ...base, ...form }).input.rule)
  assert.ok(routineRule({ when: 'weekly', value: '09:00', weekdays: [] }).error)
})

test('T09 one-time confirmation labels honor the selected timezone, not fixed Shanghai', () => {
  const input = routineInput({ ...base, when: 'at', value: '2026-11-01T01:30', timezone: 'America/New_York' }).input
  assert.equal(input.rule.at, '2026-11-01T05:30:00.000Z')
  assert.equal(ruleLabel(input.rule, input.timezone), '11月1日 01:30 一次')
  assert.equal(ruleLabel(input.rule), '11月1日 13:30 一次')
})
