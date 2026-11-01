import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createNativeRuntime } from './native-tools.mjs'
import { continuousWorkFixture } from './fixtures/continuous-work-fixture.mjs'
import { resolveContinuousEvidence } from './continuous-evidence.mjs'

const binding = { rootTaskId: 1, rootInputId: 10, goalRevision: 1, planRevision: 1, stepId: 'draft', submissionRevision: 0 }
test('native read pages carry the actual whole-file version, preserving Unicode offsets and detecting equal-length edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pidot-artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const execute = createNativeRuntime({ root }), run = (name, args) => execute({ name, arguments: args }, { botId: 'chief' })
  const original = '甲🙂乙丙', expected = createHash('sha256').update(original).digest('hex')
  await run('write', { path: 'report.md', content: original })
  const first = await run('read', { path: 'report.md', limit: 2 }), rest = await run('read', { path: 'report.md', offset: 2 })
  assert.equal(first.data.content, '甲🙂')
  assert.equal(first.data.sha256, expected)
  assert.equal(rest.data.sha256, expected)
  assert.equal(first.data.content + rest.data.content, original)
  await run('write', { path: 'report.md', content: '新🙂乙丙' })
  const changed = await run('read', { path: 'report.md', offset: 2 })
  assert.equal(changed.data.totalCharacters, rest.data.totalCharacters)
  assert.notEqual(changed.data.sha256, expected)
})

test('real write/read evidence requires complete same-version pages; mixed pages and later mutations invalidate it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pidot-artifact-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const execute = createNativeRuntime({ root }), f = continuousWorkFixture()
  const run = async (name, args) => { const result = await execute({ name, arguments: args }, { botId: 'chief' }); return { result, ref: f.receipt(name, args, result) } }
  const write = await run('write', { path: 'report.md', content: '真实报告🙂完整出处' })
  const check = () => resolveContinuousEvidence(f.tx, f.card, write.ref, binding, { bots: f.bots })
  assert.equal((await check()).evidence.artifactVersion, null)
  await run('read', { path: 'report.md', limit: 3 })
  assert.equal((await check()).evidence.artifactVersion, null)
  await run('read', { path: 'report.md', offset: 3 })
  const version = (await check()).evidence.artifactVersion
  assert.equal(version.coverage, 'full-file-read')
  assert.equal(version.readEntryIds.length, 2)
  assert.equal(version.currentness, 'host-read-version; external-changes-not-monitored')
  await run('bash', { command: 'rm report.md' })
  assert.equal((await check()).evidence.artifactVersion, null)
  assert.equal((await run('read', { path: 'report.md' })).result.ok, false)
  assert.equal((await check()).evidence.artifactVersion, null)
})
