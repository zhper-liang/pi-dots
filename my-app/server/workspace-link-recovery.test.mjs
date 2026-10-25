import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLinkFixture, linkInput } from './fixtures/workspace-link-crash.mjs'
const query = { sourceId: 'local', type: 'ItemLink' }

for (const boundary of ['before-operation', 'after-commit']) test(`09 cross-source SIGKILL ${boundary}: atomic relation/outbox/receipt, replay and revocation survive`, { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-v2-09-link-kill-')), file = join(dir, 'isolated.sqlite')
  const child = fork(new URL('./fixtures/workspace-link-crash-worker.mjs', import.meta.url), [file, boundary], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = '', s
  child.stderr.on('data', data => { stderr += data })
  try {
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error(`worker timeout: ${stderr}`)) }, 10000)
      const ready = message => { cleanup(); resolve(message) }
      const exit = (code, signal) => { cleanup(); reject(Error(`worker exited ${code}/${signal}: ${stderr}`)) }
      const error = e => { cleanup(); reject(e) }
      function cleanup() { clearTimeout(timer); child.off('message', ready); child.off('exit', exit); child.off('error', error) }
      child.once('message', ready); child.once('exit', exit); child.once('error', error)
    })
    assert.equal(message.point, boundary === 'before-operation' ? 'link-and-outbox-uncommitted' : 'committed-before-response')
    const exited = once(child, 'exit'); assert(child.kill('SIGKILL')); assert.equal((await exited)[1], 'SIGKILL')
    s = await openLinkFixture(file)
    const list = type => s.repo.transaction(tx => s.repo.list(tx, type, s.actor.ownerId, 'local'))
    const legacy = (await s.service.query(s.actor, query)).items.find(r => r.eventRef.sourceId === 'local')
    assert(legacy)
    const committed = boundary === 'after-commit', before = await s.service.getLocalOperation(s.actor, { sourceId: 'local', requestId: linkInput.requestId })
    assert.equal((await list('ItemLink')).items.length, committed ? 2 : 1)
    assert.equal((await list('Outbox')).items.length, committed ? 2 : 1)
    assert.equal(before === null, !committed)
    if (committed) assert.deepEqual(before, message.operation)
    const op = await s.service.executeLocal(s.actor, linkInput)
    if (committed) assert.deepEqual(op, before)
    assert.equal(op.receipt.eventRef.sourceId, 'external-fixture'); assert.equal(op.receipt.eventVersion, 1)
    const rows = (await s.service.query(s.actor, query)).items
    assert.equal(rows.length, 2); assert.deepEqual(rows.find(r => r.id === legacy.id), legacy)
    assert.equal((await list('Outbox')).items.length, 2)
    assert.equal((await s.repo.transaction(tx => s.repo.list(tx, 'Operation', s.actor.ownerId, 'operations'))).items.filter(r => r.requestId === linkInput.requestId).length, 1)
    await s.close(); s = await openLinkFixture(file)
    assert.deepEqual(await s.service.executeLocal(s.actor, linkInput), op)
    // Busy-only immediately hides cross-source history and rejects old request replay.
    await s.repo.transaction(async tx => {
      const g = await s.repo.get(tx, 'Grant', s.actor.ownerId, 'external-fixture', 'user:authenticated-user')
      await s.repo.put(tx, 'Grant', { ...g, epoch: g.epoch + 1, readScope: 'busy' })
    })
    await s.close(); s = await openLinkFixture(file)
    assert.deepEqual((await s.service.query(s.actor, query)).items, [legacy])
    await assert.rejects(s.service.executeLocal(s.actor, linkInput), { code: 'WORKSPACE_FORBIDDEN' })
    await assert.rejects(s.service.getLocalOperation(s.actor, { sourceId: 'local', requestId: linkInput.requestId }), { code: 'WORKSPACE_FORBIDDEN' })
    await s.service.executeLocal(s.actor, { requestId: 'delete-only-todo', sourceId: 'local', type: 'Todo', action: 'delete', id: 'same-id', expectedVersion: 1, confirmedDelete: true })
    const event = await s.repo.transaction(tx => s.repo.get(tx, 'Event', s.actor.ownerId, 'external-fixture', 'same-id'))
    assert.equal(event.version, 1); assert.equal(event.deletedAt, undefined)
    assert.equal((await list('ItemLink')).items.length, 2)
    console.log(JSON.stringify({ boundary, signal: 'SIGKILL', crossSourceRelations: 1, legacyPreserved: true, receiptReplay: true, busyAfterRestart: 'hidden', realProviderCalls: 0, modelCalls: 0 }))
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    await s?.close(); await rm(dir, { recursive: true, force: true })
  }
})
