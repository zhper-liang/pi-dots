import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
for (const boundary of ['in-flight', 'receipt', 'completed']) test(`availability SIGKILL ${boundary}: same identity no writes no lost usage`, { timeout: 30000 }, async t => {
 const dir = await mkdtemp(join(tmpdir(), 'pidot-availability-kill-')); t.after(() => rm(dir, { recursive: true, force: true }))
 const load = n => readFile(join(dir, n), 'utf8').then(JSON.parse)
 const run = mode => { const p = spawn(process.execPath, [new URL('./fixtures/feishu-availability-process.mjs', import.meta.url).pathname, dir, boundary, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); t.after(() => p.kill('SIGKILL')); return { p, out: () => out } }
 const first = run('run'); let paused
 for (let i = 0; i < 2000; i++) { try { paused = await load('paused.json'); break } catch {} if (first.p.exitCode !== null) throw Error(first.out()); await delay(5) }
 assert(paused, first.out()); const exited = once(first.p, 'exit'); first.p.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL')
 const next = run('recover'); assert.equal((await once(next.p, 'exit'))[0], 0, next.out()); const recovered = await load('recovered.json'), manifest = await load('manifest.json'); assert.equal(recovered.id, manifest.id); assert.equal(recovered.conversationId, manifest.conversationId); assert.equal(recovered.effects.writes, 0); assert.equal(recovered.effects.reads, boundary === 'in-flight' ? 2 : 1); assert.equal(recovered.usage.unknownTokenCalls, 0)
 if (boundary === 'completed') { const before = await load('before.json'); assert.deepEqual(recovered.usage, before.usage); assert.deepEqual(recovered.messages, before.messages) }
})
