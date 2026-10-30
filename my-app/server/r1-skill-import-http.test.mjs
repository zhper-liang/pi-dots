import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApiServer } from './app.mjs'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { SKILL_DIRECTORY, skillCapabilityCatalog } from './skills.mjs'
import { createSkillImportService } from './skill-import.mjs'

const markdown = (name = 'http-import') => `---\nname: ${name}\ndescription: Imported over the authenticated management API\nversion: "1.0"\n---\nFollow the imported declarative rules.\n`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pidot-r1-skill-http-'))
  const source = join(root, 'source')
  const controlled = join(root, 'controlled')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), markdown())
  const service = createSkillImportService({ dataDirectory: controlled })
  const directory = { builtinDirectory: SKILL_DIRECTORY, userSkills: service }
  const token = randomUUID()
  const store = await openTaskStore({
    file: join(root, 'tasks.sqlite'),
    bots: listBots(),
    skillDirectory: directory,
    readCapabilityCatalog: () => skillCapabilityCatalog(directory),
  })
  const server = createApiServer({ token, tasks: store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const request = async (path, { method = 'GET', body, auth = true } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, allow: response.headers.get('allow'), json: await response.json() }
  }
  return { request, store, source }
}

test('R1 Skill import HTTP authenticates and bounds management methods', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/skills/import/prepare', { method: 'POST', body: { kind: 'local', path: '/tmp/nope' }, auth: false })).status, 401)
  const method = await f.request('/api/skills/import/prepare')
  assert.equal(method.status, 405)
  assert.equal(method.allow, 'POST')
  const malformed = await f.request('/api/skills/import/prepare', { method: 'POST', body: null })
  assert.ok(malformed.status >= 400)
  assert.match(malformed.json.error.code, /^SKILL_(SOURCE|IMPORT)_/)
})

test('R1 Skill import HTTP exposes imported capability, computes removal impact, and tombstones it', async t => {
  const f = await fixture(t)
  const prepared = await f.request('/api/skills/import/prepare', { method: 'POST', body: { kind: 'local', path: f.source } })
  assert.equal(prepared.status, 200)
  const imported = await f.request('/api/skills/import', { method: 'POST', body: { requestId: 'http-import', preparedId: prepared.json.data.preparedId, expectedRevision: 0 } })
  assert.equal(imported.status, 200)
  assert.equal(imported.json.data.capabilityId, 'skill:http-import')

  const catalog = await f.request('/api/bots/calendar/capabilities')
  assert.equal(catalog.status, 200)
  const item = catalog.json.data.items.find(entry => entry.id === 'skill:http-import')
  assert.ok(item)
  assert.equal(item.enabledForBot, false)
  const enabled = await f.request('/api/bots/calendar/capabilities', { method: 'POST', body: {
    requestId: 'http-bind',
    expectedRevision: catalog.json.data.revision,
    expectedCatalogRevision: item.revision,
    capabilityId: item.id,
    enabled: true,
  } })
  assert.equal(enabled.status, 200)

  const current = await f.request('/api/bots/calendar/capabilities')
  const removed = await f.request('/api/skills/remove', { method: 'POST', body: {
    requestId: 'http-remove', skillId: 'http-import', expectedRevision: imported.json.data.revision,
    affectedBotIds: [], confirmGlobal: true,
  } })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.json.data.affectedBotIds, ['calendar'])
  assert.equal((await f.request('/api/bots/calendar/capabilities')).json.data.items.some(entry => entry.id === 'skill:http-import'), false)
  // Removal hides the capability, while its saved binding can still be explicitly revoked.
  const stale = await f.request('/api/bots/calendar/capabilities', { method: 'POST', body: {
    requestId: 'http-stale', expectedRevision: current.json.data.revision,
    expectedCatalogRevision: item.revision, capabilityId: item.id, enabled: false,
  } })
  assert.equal(stale.status, 200)
  assert.equal(stale.json.data.enabledForBot, false)
  const reenable = await f.request('/api/bots/calendar/capabilities', { method: 'POST', body: {
    requestId: 'http-removed-enable', expectedRevision: stale.json.data.revision,
    expectedCatalogRevision: item.revision, capabilityId: item.id, enabled: true,
  } })
  assert.equal(reenable.status, 404)
  assert.equal(reenable.json.error.code, 'CAPABILITY_NOT_FOUND')
})
