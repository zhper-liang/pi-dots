import test from 'node:test'
import assert from 'node:assert/strict'
import { continuousWorkFixture } from './fixtures/continuous-work-fixture.mjs'
import { resolveContinuousEvidence, successfulContinuousResult, validContinuousEvidenceRef, continuousEvidenceFingerprint } from './continuous-evidence.mjs'
import { boundToolResult } from './tool-results.mjs'

const binding = f => ({ rootTaskId: 1, rootInputId: 10, goalRevision: 1, planRevision: f.progress.planRevision, stepId: f.progress.currentStepId, submissionRevision: 0 })

test('host file and process receipts preserve their limited proof scope and never claim quality or current file existence', async () => {
  const f = continuousWorkFixture(), ref = f.receipt()
  const resolved = await resolveContinuousEvidence(f.tx, f.card, ref, binding(f), { bots: f.bots })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.evidence.kind, 'artifact-record')
  assert.equal(resolved.evidence.scope, 'write-receipt')
  assert.equal(resolved.evidence.quality, 'requires-review')
  assert.match(resolved.evidence.sha256, /^[a-f0-9]{64}$/)
  assert.equal(resolved.evidence.currentFileExists, undefined)
  const bash = f.receipt('bash', { command: 'true' }, { ok: true, data: { exitCode: 0 } })
  assert.equal((await resolveContinuousEvidence(f.tx, f.card, bash, binding(f), { bots: f.bots })).evidence.scope, 'process-exit')
})

test('fabricated, cross-task, stale and source-revoked evidence returns one non-disclosing refusal', async () => {
  const f = continuousWorkFixture(), ref = f.receipt('calendar_read_schedule', { date: '2026-11-02', resource: 'mock:personal' }, { ok: true, data: { events: [{ title: '秘密会议' }] } })
  const check = (ref, expected = binding(f)) => resolveContinuousEvidence(f.tx, f.card, ref, expected, { bots: f.bots })
  const missing = await check({ taskId: 1, entryId: 999 })
  for (const ref of [{ taskId: 2, entryId: 11 }, { taskId: 1, entryId: 11, ok: true }, { kind: 'child-result', relationId: 'invented', revision: 1 }]) assert.deepEqual(await check(ref), missing)
  assert.deepEqual(await check(ref, { ...binding(f), goalRevision: 2 }), missing)
  assert.deepEqual(await check(ref, { ...binding(f), planRevision: 2 }), missing)
  f.access.assignments.chief.resources = []
  assert.deepEqual(await check(ref), missing)
  assert.equal(JSON.stringify(missing).includes('秘密'), false)
})

test('failed, unknown, prepared, approval-pending and partial source results are not operation-success evidence', async () => {
  for (const result of [{ ok: false }, { ok: true, error: { code: 'unknown' } }, ...['unknown', 'skipped', 'prepared', 'draft', 'pending', 'waiting-for-user-approval'].map(status => ({ ok: true, data: { status } })),
    { ok: true, data: { complete: false } }, { ok: true, data: { approvalId: 'a' } }, { ok: true, data: { operation: { status: 'pending' } } }]) assert.equal(successfulContinuousResult(result), false)
  assert.equal(successfulContinuousResult({ ok: true, data: { state: 'completed', readbackVerified: true } }), true)
  assert.equal(validContinuousEvidenceRef({ taskId: 1, entryId: 11, hash: 'self-reported' }), false)
})

test('bounded source requires authentic artifact and contiguous actual raw reads, not an asserted coverage flag', async () => {
  const f = continuousWorkFixture(), source = { toolName: 'calendar_read_schedule', callId: 'big', turnId: 10, inReplyTo: 10, arguments: { resource: 'mock:personal' } }
  const raw = { ok: true, data: { note: '来源'.repeat(1800) } }, bounded = await boundToolResult(f.tx, f.card, raw, source)
  const ref = f.receipt(source.toolName, source.arguments, bounded, { callId: source.callId, turnId: source.turnId })
  assert.equal((await resolveContinuousEvidence(f.tx, f.card, ref, binding(f), { bots: f.bots })).ok, false)
  const length = Array.from(JSON.stringify(raw)).length
  const readRef = f.receipt('tool_result_read', { resultRef: bounded.data.resultRef, resource: 'mock:personal', view: 'text' }, { ok: true, data: { resultRef: bounded.data.resultRef,
    coverage: { kind: 'raw-text', offset: 1, end: length, totalCharacters: length, originalContentRead: true } } })
  assert.equal((await resolveContinuousEvidence(f.tx, f.card, readRef, binding(f), { bots: f.bots })).ok, false)
  f.receipt('tool_result_read', { resultRef: bounded.data.resultRef, resource: 'mock:personal', view: 'text' }, { ok: true, data: { resultRef: bounded.data.resultRef,
    coverage: { kind: 'raw-text', offset: 0, end: 1, totalCharacters: length } } })
  const resolved = await resolveContinuousEvidence(f.tx, f.card, ref, binding(f), { bots: f.bots })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.evidence.coverage, 'full-result-read')
})

test('child evidence fails closed without exact revision resolver and rejects a substituted binding', async () => {
  const f = continuousWorkFixture(), ref = { kind: 'child-result', relationId: 'relation-1', revision: 2 }, expected = binding(f)
  assert.equal((await resolveContinuousEvidence(f.tx, f.card, ref, expected)).ok, false)
  assert.equal((await resolveContinuousEvidence(f.tx, f.card, ref, expected, { resolveChildEvidence: async () => ({ ok: true, evidence: { kind: 'independent-review', binding: { ...expected, submissionRevision: 99 } } }) })).ok, false)
})

test('progress fingerprints use verified content rather than read receipts, renamed stages or volatile provider metadata', () => {
  const content = '报告与真实出处'
  assert.equal(continuousEvidenceFingerprint('write', { path: 'a.md', content }, { ok: true, data: { bytesWritten: 30 } }),
    continuousEvidenceFingerprint('read', { path: 'renamed.md' }, { ok: true, data: { content } }))
  assert.equal(continuousEvidenceFingerprint('bash', { command: 'date' }, { ok: true, data: { stdout: '今天' } }), null)
  assert.equal(continuousEvidenceFingerprint('edit', { path: 'report.md' }, { ok: true, data: { bytesWritten: 30 } }), null)
  const first = { ok: true, data: { fetchedAt: 'earlier', operationId: 'receipt-a', events: [{ id: 'a', start: '09:00' }, { id: 'b', start: '10:00' }] } }
  const second = { ok: true, data: { fetchedAt: 'later', operationId: 'receipt-b', events: [{ id: 'b', start: '10:00' }, { id: 'a', start: '09:00' }] } }
  assert.equal(continuousEvidenceFingerprint('calendar_read_schedule', {}, first), continuousEvidenceFingerprint('calendar_read_schedule', {}, second))
  second.data.events[0].start = '11:00'
  assert.notEqual(continuousEvidenceFingerprint('calendar_read_schedule', {}, first), continuousEvidenceFingerprint('calendar_read_schedule', {}, second))
})
