import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { adaptSkillMetadata, createSkillImportService } from './skill-import.mjs'

const markdown = (version = '1.0', extra = '', body = 'Use declared context only.') => `---\nname: sample-skill\ndescription: A bounded declarative skill\nversion: "${version}"\n${extra}---\n${body}\n`
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-import-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'source'), dataDirectory = join(dir, 'controlled-skills')
  await mkdir(source)
  await writeFile(join(source, 'SKILL.md'), markdown())
  return { dir, source, dataDirectory, service: createSkillImportService({ dataDirectory, ...options }) }
}
const prepare = (service, path) => service.prepareSkillImport({ kind: 'local', path })
const install = (service, prepared, requestId = 'import-1', expectedRevision = 0) => service.importSkill({ requestId, preparedId: prepared.preparedId, expectedRevision })

test('exports controlled services without executing source; adapts standard frontmatter and nested version', () => {
  const adapted = adaptSkillMetadata('---\nname: sample-skill\ndescription: >\n  First line\n  second line\nmetadata:\n  version: "2.1"\nallowed-tools: [calendar_list, "calendar_create"]\nlicense: MIT\n---\nDeclarative rules only.')
  assert.equal(adapted.manifest.version, '2.1')
  assert.equal(adapted.manifest.description, 'First line second line')
  assert.deepEqual(adapted.manifest.requiredTools, ['calendar_list', 'calendar_create'])
  assert.deepEqual(adapted.manifest.botIds, [])
})

test('directory import pins complete content; references are text and binary assets never enter rules', async (t) => {
  const { source, dataDirectory, service } = await fixture(t)
  await mkdir(join(source, 'references', 'nested'), { recursive: true })
  await mkdir(join(source, 'assets'))
  await writeFile(join(source, 'references', 'nested', 'Guide.md'), 'Reference evidence')
  await writeFile(join(source, 'assets', 'image.png'), Buffer.from([137, 80, 78, 71, 0, 255]))
  const prepared = await prepare(service, source)
  assert.equal(prepared.status, 'ready')
  assert.equal(prepared.files.length, 3)
  const record = await install(service, prepared)
  assert.equal(record.capabilityId, 'skill:sample-skill')
  assert.equal(record.revision, 1)
  const pkg = await service.skillSource(record.id)
  assert.equal(pkg.manifest.references[0].file, 'references/nested/Guide.md')
  assert.doesNotMatch(pkg.rules, /Reference evidence|image\.png/)
  await writeFile(join(source, 'SKILL.md'), markdown('9.9'))
  assert.equal((await service.skillSource(record.id)).manifest.version, '1.0')
  const reopened = createSkillImportService({ dataDirectory })
  assert.equal((await reopened.skillCatalog()).skills[0].hash, record.hash)
  assert.equal((await reopened.skillSource(record.id)).manifest.version, '1.0')
})

test('single SKILL.md import derives version from hash; necessary script and tool requirements cannot grant authority', async (t) => {
  const { source, service } = await fixture(t)
  await writeFile(join(source, 'SKILL.md'), '---\nname: sample-skill\ndescription: Needs tools\nallowed-tools:\n  - calendar_list\nrequired-resources: [calendar]\n---\nRun scripts/required.py before continuing.')
  const prepared = await prepare(service, join(source, 'SKILL.md'))
  assert.match(prepared.manifest.version, /^sha256-/)
  assert.equal(prepared.status, 'missing_dependency')
  assert.deepEqual(prepared.requirements.scripts, ['scripts/required.py'])
  const record = await install(service, prepared)
  assert.equal(record.status, 'missing_dependency')
  assert.deepEqual(record.toolNames, [])
  assert.deepEqual(record.requirements.tools, ['calendar_list'])
  assert.equal(record.enabledForBot, undefined)
})

test('exact retry persists receipt; duplicate content is idempotent, changed same-name import never overwrites', async (t) => {
  const { source, dataDirectory, service } = await fixture(t)
  const prepared = await prepare(service, source)
  const first = await install(service, prepared)
  const reopened = createSkillImportService({ dataDirectory })
  assert.deepEqual(await reopened.importSkill({ requestId: 'import-1', preparedId: prepared.preparedId, expectedRevision: 0 }), first)
  const duplicate = await prepare(service, source)
  assert.equal((await install(service, duplicate, 'import-2', 1)).hash, first.hash)
  await writeFile(join(source, 'SKILL.md'), markdown('2.0'))
  const changed = await prepare(service, source)
  await assert.rejects(install(service, changed, 'import-3', 2), { code: 'SKILL_NAME_CONFLICT' })
  assert.equal((await service.skillSource(first.id)).manifest.version, '1.0')
  await assert.rejects(install(service, changed, 'import-1', 2), { code: 'SKILL_REQUEST_CONFLICT' })
})

test('explicit update/rollback preserve immutable old package and removal tombstones without deleting audit files', async (t) => {
  const { source, dataDirectory, service } = await fixture(t)
  const first = await install(service, await prepare(service, source))
  const fixed = await service.skillSource(first.id)
  await writeFile(join(source, 'SKILL.md'), markdown('2.0', '', 'Changed rules'))
  const second = await prepare(service, source)
  const updated = await service.updateSkill({ requestId: 'update', skillId: first.id, preparedId: second.preparedId, expectedRevision: 1 })
  assert.equal(updated.version, '2.0')
  assert.equal(fixed.manifest.version, '1.0')
  assert.equal((await service.skillSource(first.id, { hash: first.hash })).rules, fixed.rules)
  const rolled = await service.rollbackSkill({ requestId: 'rollback', skillId: first.id, hash: first.hash, expectedRevision: 2 })
  assert.equal(rolled.version, '1.0')
  await assert.rejects(service.removeSkill({ requestId: 'remove', skillId: first.id, expectedRevision: 3 }), { code: 'SKILL_REMOVE_CONFIRMATION_REQUIRED' })
  await service.removeSkill({ requestId: 'remove', skillId: first.id, expectedRevision: 3, affectedBotIds: ['calendar'], confirmGlobal: true })
  assert.deepEqual((await service.skillCatalog()).skills, [])
  await assert.rejects(service.skillSource(first.id), { code: 'SKILL_NOT_FOUND' })
  assert.equal(JSON.parse(await readFile(join(dataDirectory, 'packages', first.hash, 'package.json'), 'utf8')).rules, fixed.rules)
})

test('prepared imports are immutable despite source changes; new versions require a fresh preparation', async (t) => {
  const { service, source } = await fixture(t)
  const first = await prepare(service, source)
  first.manifest.name = 'changed-in-caller'
  await writeFile(join(source, 'SKILL.md'), markdown('2.0'))
  assert.equal((await install(service, first)).version, '1.0')
  assert.equal((await prepare(service, source)).manifest.version, '2.0')
})

test('two service instances serialize revisions instead of losing catalog writes', async (t) => {
  const { service, source, dataDirectory } = await fixture(t)
  const second = createSkillImportService({ dataDirectory })
  const [one, two] = await Promise.all([prepare(service, source), prepare(second, source)])
  const results = await Promise.allSettled([install(service, one), install(second, two, 'other')])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'SKILL_REVISION_CONFLICT')
})

function repositoryFixture() {
  const bytes = Buffer.from(markdown()), commit = 'a'.repeat(40)
  const blobHash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const urls = []
  const fetchImpl = async (url, options) => {
    urls.push(url)
    assert.equal(options.redirect, 'manual')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.headers.Authorization, undefined)
    if (url.includes('/commits/')) return Response.json({ sha: commit })
    if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'examples/sample/SKILL.md', type: 'blob', mode: '100644', size: bytes.length, sha: blobHash }] })
    return Response.json({ encoding: 'base64', content: bytes.toString('base64') })
  }
  return { fetchImpl, urls, commit }
}

test('public repository with no explicit directory returns candidates; explicit selection pins commit and blob hashes', async (t) => {
  const remote = repositoryFixture()
  const { service } = await fixture(t, remote)
  const source = { kind: 'repository', url: 'https://github.com/example/skills', ref: 'main' }
  const ambiguous = await service.prepareSkillImport(source)
  assert.equal(ambiguous.status, 'needs_directory')
  assert.deepEqual(ambiguous.candidates, ['examples/sample'])
  assert.equal(remote.urls.length, 2)
  const prepared = await service.prepareSkillImport({ ...source, directory: 'examples/sample' })
  const record = await install(service, prepared)
  assert.equal(record.source.commit, remote.commit)
  assert.ok(remote.urls.some((url) => url.includes(`/git/trees/${remote.commit}`)))
  assert.equal(record.hash.length, 64)
})


test('durable requestStatus proves the exact committed import/update/rollback/remove after reopen', async t => {
  const { service, source, dataDirectory } = await fixture(t)
  assert.equal(await service.requestStatus('not-committed'), null)
  const original = await install(service, await prepare(service, source), 'status-import')
  await writeFile(join(source, 'SKILL.md'), markdown('2.0'))
  const changed = await service.updateSkill({ requestId: 'status-update', skillId: original.id, preparedId: (await prepare(service, source)).preparedId, expectedRevision: 1 })
  const rolled = await service.rollbackSkill({ requestId: 'status-rollback', skillId: original.id, hash: original.hash, expectedRevision: 2 })
  const removed = await service.removeSkill({ requestId: 'status-remove', skillId: original.id, expectedRevision: 3, affectedBotIds: [], confirmGlobal: true })
  const reopened = createSkillImportService({ dataDirectory })
  for (const [requestId, operation, result] of [['status-import', 'import', original], ['status-update', 'update', changed], ['status-rollback', 'rollback', rolled], ['status-remove', 'remove', removed]]) {
    assert.deepEqual(await reopened.requestStatus(requestId), { requestId, operation, state: 'succeeded', result })
  }
  assert.equal((await reopened.skillCatalog()).revision, 4)
})
