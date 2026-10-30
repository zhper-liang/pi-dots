import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { getLocalTimezone, isValidLocalDate, isValidLocalTime, localInstant, localDateTime, formatLocalDateTime, validateLocalRange } from './local-time.mjs'

const wall = (date, time, timezone = 'America/New_York') => ({ date, time, timezone })

test('R1-02 validates actual dates and every hour/minute without date normalization', () => {
  for (const date of ['2024-02-29', '2026-12-31', '2000-02-29']) assert.equal(isValidLocalDate(date), true)
  for (const date of ['2026-02-29', '2026-02-30', '2026-04-31', '1900-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '', null]) assert.equal(isValidLocalDate(date), false)
  for (let hour = 0; hour < 24; hour++) for (let minute = 0; minute < 60; minute++) assert.equal(isValidLocalTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`), true)
  for (const time of ['24:00', '23:60', '9:00', '12:3', '12:00:00', '', null]) assert.equal(isValidLocalTime(time), false)
})

test('R1-02 local conversion uses the supplied zone and crosses UTC dates correctly', () => {
  assert.deepEqual(localDateTime('2026-10-29T02:15:00Z', 'America/Los_Angeles'), wall('2026-10-28', '19:15', 'America/Los_Angeles'))
  assert.equal(new Date(localInstant(wall('2026-10-28', '19:15', 'America/Los_Angeles'))).toISOString(), '2026-10-29T02:15:00.000Z')
  assert.deepEqual(localDateTime('2026-10-29T00:00:00Z', 'Asia/Kathmandu'), wall('2026-10-29', '05:45', 'Asia/Kathmandu'))
  assert.equal(new Date(localInstant(wall('2026-10-29', '05:45', 'Asia/Kathmandu'))).toISOString(), '2026-10-29T00:00:00.000Z')
  assert.equal(formatLocalDateTime('2026-10-29T02:15:00Z', 'America/Los_Angeles'), '2026年10月28日 19:15')
})

test('R1-02 rejects missing DST wall times and whole skipped dates', () => {
  assert.equal(localInstant(wall('2026-03-08', '02:30')), null)
  assert.equal(localInstant(wall('2026-10-04', '02:15', 'Australia/Lord_Howe')), null)
  assert.equal(localInstant(wall('2011-12-30', '12:00', 'Pacific/Apia')), null)
  assert.equal(new Date(localInstant(wall('2026-03-08', '03:00'))).toISOString(), '2026-03-08T07:00:00.000Z')
})

test('R1-02 repeated DST wall time uses the existing first-instant schedule policy', () => {
  assert.equal(new Date(localInstant(wall('2026-11-01', '01:30'))).toISOString(), '2026-11-01T05:30:00.000Z')
  assert.equal(new Date(localInstant(wall('2026-04-05', '01:45', 'Australia/Lord_Howe'))).toISOString(), '2026-04-04T14:45:00.000Z')
})

test('R1-02 malformed dates, times, instants and zones fail without throwing', () => {
  for (const value of [null, {}, wall('2026-02-30', '12:00'), wall('2026-10-29', '25:00'), wall('2026-10-29', '12:00', 'No/Zone'), wall('2026-10-29', '12:00', '')]) assert.equal(localInstant(value), null)
  for (const instant of [NaN, Infinity, new Date('invalid'), '2026-02-30T12:00:00Z', '2026-10-29T24:00:00Z', '2026-10-29T09:00', '2026-10-29', 'not a date']) assert.equal(localDateTime(instant), null)
  assert.equal(localDateTime(0, 'No/Zone'), null)
  assert.equal(formatLocalDateTime(NaN), null)
  assert.equal(localInstant(wall('2026-10-29', '00:00', 'UTC')), Date.parse('2026-10-29T00:00:00Z'))
})

test('R1-02 cross-day ranges compare instants; equal/backwards ends require an explicit next date', () => {
  const start = wall('2026-10-29', '23:45'), end = wall('2026-10-30', '00:15')
  assert.equal(validateLocalRange(start, end).end - validateLocalRange(start, end).start, 30 * 60000)
  assert.match(validateLocalRange(start, wall('2026-10-29', '00:15')).error, /跨日/)
  assert.match(validateLocalRange(start, start).error, /晚于/)
  assert.match(validateLocalRange(wall('2026-03-08', '02:30'), end).error, /开始/)
  assert.match(validateLocalRange(start, wall('2026-02-30', '12:00')).error, /结束/)
})

test('R1-02 duration across spring DST uses elapsed time, not naive wall-clock hours', () => {
  const result = validateLocalRange(wall('2026-03-08', '01:30'), wall('2026-03-08', '03:30'))
  assert.equal(result.end - result.start, 60 * 60000)
})

test('R1-02 device timezone changes do not rewrite an existing saved schedule timezone', () => {
  assert.equal(typeof getLocalTimezone(), 'string')
  const script = `import { getLocalTimezone, localDateTime, localInstant } from ${JSON.stringify(new URL('./local-time.mjs', import.meta.url).href)}; console.log(JSON.stringify({ zone: getLocalTimezone(), local: localDateTime('2026-10-29T02:15:00Z'), saved: localInstant({ date: '2026-10-29', time: '09:00', timezone: 'Asia/Tokyo' }) }))`
  const run = timezone => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' }))
  const la = run('America/Los_Angeles'), tokyo = run('Asia/Tokyo')
  assert.equal(la.zone, 'America/Los_Angeles')
  assert.equal(la.local.date, '2026-10-28')
  assert.equal(tokyo.zone, 'Asia/Tokyo')
  assert.equal(tokyo.local.date, '2026-10-29')
  assert.equal(la.saved, tokyo.saved)
  assert.equal(la.saved, Date.parse('2026-10-29T00:00:00Z'))
})
