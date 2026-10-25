import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
for (const boundary of ['approved', 'intent', 'sent', 'receipt', 'verified']) test(`Feishu SIGKILL ${boundary} preserves one intent and never redispatches unknown writes`, { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pidot-feishu02-kill-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const run = mode => { const p = spawn(process.execPath, [new URL('./fixtures/feishu-create-process.mjs', import.meta.url).pathname, dir, boundary, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; p.stdout.on('data', d => output += d); p.stderr.on('data', d => output += d); return { p, output: () => output } }
  const first = run('run'); t.after(() => first.p.kill('SIGKILL')); let paused
  for (let i = 0; i < 4000; i++) { try { paused = JSON.parse(await readFile(join(dir, 'paused.json'))); break } catch {} if (first.p.exitCode !== null) throw Error(first.output()); await delay(5) }
  assert(paused, first.output()); const exited = once(first.p, 'exit'); first.p.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL')
  const next = run('recover'); t.after(() => next.p.kill('SIGKILL')); const [code] = await once(next.p, 'exit'); assert.equal(code, 0, next.output()); const recovered = JSON.parse(await readFile(join(dir, 'recovered.json')))
  assert.equal(recovered.items, 1); assert.equal(recovered.writes, boundary === 'intent' ? 0 : 1); assert.equal(recovered.status, ['approved', 'verified'].includes(boundary) ? 'executed' : 'outcome-unknown'); assert(recovered.usage.modelCalls >= paused.usage.modelCalls); assert(recovered.usage.toolCalls >= paused.usage.toolCalls); assert(recovered.usage.totalTokens >= paused.usage.totalTokens)
  if (!['approved', 'verified'].includes(boundary)) assert.equal(recovered.receipt, null)
})
