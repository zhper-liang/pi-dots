// One dedicated child owns the isolated DB; parent waits for IPC then SIGKILLs.
import { openLinkFixture, seedLinkFixture, linkInput } from './workspace-link-crash.mjs'
import { dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
const [file, boundary] = process.argv.slice(2)
if (!file || dirname(dirname(file)) !== tmpdir() || !basename(dirname(file)).startsWith('pidot-v2-09-link-kill-') || basename(file) !== 'isolated.sqlite' || !['before-operation', 'after-commit'].includes(boundary) || !process.send) throw Error('Dedicated temporary DB and IPC required')
const s = await openLinkFixture(file, boundary)
await seedLinkFixture(s)
const operation = await s.service.executeLocal(s.actor, linkInput)
process.send({ point: 'committed-before-response', operation })
await new Promise(() => {})
