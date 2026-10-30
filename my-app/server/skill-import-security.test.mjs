import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createSkillImportService, adaptSkillMetadata } from './skill-import.mjs'

const doc = '---\nname: safe-skill\ndescription: Safe test\n---\nRead reference data.'
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-import-security-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), dataDirectory = join(root, 'controlled')
  await mkdir(source)
  await writeFile(join(source, 'SKILL.md'), doc)
  return { root, source, dataDirectory, service: createSkillImportService({ dataDirectory, ...options }) }
}
const local = (service, path) => service.prepareSkillImport({ kind: 'local', path })
const repo = (service, overrides = {}) => service.prepareSkillImport({ kind: 'repository', url: 'https://github.com/example/skills', directory: 'sample', ...overrides })

test('source symlinks, nested reference symlinks, ancestor symlinks and hardlinks are rejected', async (t) => {
  const { root, source, service } = await fixture(t)
  await symlink(source, join(root, 'alias'))
  await assert.rejects(local(service, join(root, 'alias')), { code: 'SKILL_SYMLINK' })
  await assert.rejects(local(service, join(root, 'alias', 'SKILL.md')), { code: 'SKILL_SYMLINK' })
  await mkdir(join(source, 'references'))
  await symlink(join(source, 'SKILL.md'), join(source, 'references', 'escape.md'))
  await assert.rejects(local(service, source), { code: 'SKILL_SYMLINK' })
  await rm(join(source, 'references', 'escape.md'))
  await link(join(source, 'SKILL.md'), join(source, 'references', 'hard.md'))
  await assert.rejects(local(service, source), { code: 'SKILL_FILE_INVALID' })
})

test('controlled storage refuses built-in/source directories and symlink destinations', async (t) => {
  const { source, root, service } = await fixture(t)
  await assert.rejects(createSkillImportService({ dataDirectory: new URL('./skills/', import.meta.url).pathname }).skillCatalog(), { code: 'SKILL_STORAGE_INVALID' })
  const prepared = await local(service, source)
  await symlink(source, join(root, 'controlled'))
  await assert.rejects(service.importSkill({ requestId: 'try-import', preparedId: prepared.preparedId, expectedRevision: 0 }), { code: 'SKILL_SYMLINK' })
})

test('metadata does not evaluate YAML tags, aliases, invalid names, duplicate fields or unknown execution declarations', () => {
  for (const front of ['name: !!js/function evil\ndescription: text', 'name: &anchor safe\ndescription: *anchor', 'name: ../escape\ndescription: text', 'name: safe\nname: other\ndescription: text', 'name: safe', 'name: safe\ndescription: text\ninstall-command: run-me']) {
    assert.throws(() => adaptSkillMetadata(`---\n${front}\n---\nRules`), (error) => /^SKILL_METADATA_/.test(error.code))
  }
})

test('local payload enforces file count, per-file/total sizes and case-insensitive path uniqueness', async (t) => {
  const { source, service } = await fixture(t, { limits: { files: 3, fileBytes: 1000, totalBytes: 1500 } })
  await mkdir(join(source, 'assets'))
  await writeFile(join(source, 'assets', 'big.png'), Buffer.alloc(1001))
  await assert.rejects(local(service, source), { code: 'SKILL_SIZE_LIMIT' })
  await writeFile(join(source, 'assets', 'big.png'), Buffer.alloc(950))
  await writeFile(join(source, 'assets', 'more.png'), Buffer.alloc(600))
  await assert.rejects(local(service, source), { code: 'SKILL_SIZE_LIMIT' })
  await rm(join(source, 'assets'), { recursive: true })
  await mkdir(join(source, 'assets'))
  for (const name of ['A.png', 'a.png']) await writeFile(join(source, 'assets', name), 'x')
  await assert.rejects(local(service, source), { code: 'SKILL_PATH_COLLISION' })
  await writeFile(join(source, 'assets', 'b.png'), 'x')
  await assert.rejects(local(service, source), { code: 'SKILL_SIZE_LIMIT' })
})

test('script files are retained as unavailable dependencies, never executed; archives are rejected not extracted', async (t) => {
  const { root, source, service } = await fixture(t)
  await mkdir(join(source, 'scripts'))
  await writeFile(join(source, 'scripts', 'install.sh'), `touch '${join(root, 'should-not-exist')}'`)
  const prepared = await local(service, source)
  assert.equal(prepared.status, 'missing_dependency')
  assert.deepEqual(prepared.requirements.scripts, ['scripts/install.sh'])
  await assert.rejects(readFile(join(root, 'should-not-exist')), { code: 'ENOENT' })
  await mkdir(join(source, 'assets'))
  await writeFile(join(source, 'assets', 'escape.zip'), 'not extracted')
  await assert.rejects(local(service, source), { code: 'SKILL_ASSET_UNSUPPORTED' })
})

test('private/local/non-GitHub URLs, credentials, URL query and ambiguous tree URLs are rejected before network', async (t) => {
  let calls = 0
  const { service } = await fixture(t, { fetchImpl: () => { calls++; throw new Error('network forbidden') } })
  for (const url of ['http://github.com/example/skills', 'https://127.0.0.1/a/b', 'https://github.com.evil.test/a/b', 'https://user:password@github.com/a/b', 'https://github.com/a/b?token=secret', 'https://github.com/a/b/tree/main']) {
    await assert.rejects(repo(service, { url }), { code: 'SKILL_REMOTE_FORBIDDEN' })
  }
  assert.equal(calls, 0)
})

test('download redirects, oversized streamed responses and HTTP errors never become successful imports', async (t) => {
  for (const makeResponse of [() => new Response('', { status: 302, headers: { Location: 'http://127.0.0.1' } }), () => new Response('x'.repeat(200)), () => new Response('unauthorized', { status: 401 })]) {
    const { service } = await fixture(t, { limits: { treeBytes: 100 }, fetchImpl: async () => makeResponse() })
    await assert.rejects(repo(service), (error) => ['SKILL_REDIRECT_FORBIDDEN', 'SKILL_SIZE_LIMIT', 'SKILL_DOWNLOAD_FAILED'].includes(error.code))
    assert.deepEqual((await service.skillCatalog()).skills, [])
  }
})

test('repository traversal, symlink, oversized blob and truncated tree are refused without blob download', async (t) => {
  const commit = 'a'.repeat(40)
  for (const entry of [{ path: 'sample/references/../../escape.md', type: 'blob', mode: '100644', size: 1, sha: commit }, { path: 'sample/SKILL.md', type: 'blob', mode: '120000', size: 1, sha: commit }, { path: 'sample/SKILL.md', type: 'blob', mode: '100644', size: 9999999, sha: commit }]) {
    let blobs = 0
    const { service } = await fixture(t, { fetchImpl: async (url) => {
      if (url.includes('/commits/')) return Response.json({ sha: commit })
      if (url.includes('/trees/')) return Response.json({ tree: [entry] })
      blobs++; return Response.json({})
    } })
    await assert.rejects(repo(service), (error) => ['SKILL_PATH_INVALID', 'SKILL_SYMLINK', 'SKILL_SIZE_LIMIT'].includes(error.code))
    assert.equal(blobs, 0)
  }
  const { service } = await fixture(t, { fetchImpl: async (url) => Response.json(url.includes('/commits/') ? { sha: commit } : { truncated: true, tree: [] }) })
  await assert.rejects(repo(service), { code: 'SKILL_FILE_LIMIT' })
})

test('blob integrity and stored package content/metadata tampering are detected', async (t) => {
  const bytes = Buffer.from(doc), commit = 'a'.repeat(40)
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const { service, source, dataDirectory } = await fixture(t, { fetchImpl: async (url) => Response.json(url.includes('/commits/') ? { sha: commit } : url.includes('/trees/') ? { tree: [{ path: 'sample/SKILL.md', type: 'blob', mode: '100644', size: bytes.length, sha }] } : { encoding: 'base64', content: Buffer.from('tampered').toString('base64') }) })
  await assert.rejects(repo(service), { code: 'SKILL_HASH_MISMATCH' })
  const prepared = await local(service, source)
  const record = await service.importSkill({ requestId: 'import-safe', expectedRevision: 0, preparedId: prepared.preparedId })
  const path = join(dataDirectory, 'packages', record.hash, 'package.json')
  const pkg = JSON.parse(await readFile(path, 'utf8'))
  pkg.manifest.requiredTools = []
  pkg.rules = 'malicious rules'
  await writeFile(path, JSON.stringify(pkg))
  await assert.rejects(service.skillSource(record.id), { code: 'SKILL_HASH_MISMATCH' })
  assert.equal((await service.skillCatalog()).skills[0].status, 'error')
})
