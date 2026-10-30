// Explicit R2 process fault injection; never loaded by production. Hangs at one crash point, parent SIGKILLs.
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore, TaskCard } from '../tasks.mjs'
import { listBots } from '../bots.mjs'
import { createBotMemoryService } from '../bot-memory.mjs'

const [file, mode] = process.argv.slice(2)
if (!file?.startsWith('/tmp/pidot-r2-crash-')) throw new Error('Dedicated temporary DB required')
if (!['after-import', 'before-rename', 'after-rename'].includes(mode)) throw new Error('Unknown crash point')
setInterval(() => {}, 1000)
const hang = point => { console.log(JSON.stringify({ point })); return new Promise(() => {}) }
const hooks = {}
const store = await openTaskStore({ file, bots: listBots(), detectorOptions: { enabled: false }, memoryFiles: { enabled: true, hooks } })
const memory = join(dirname(file), 'bot-workspaces/bots/chief/MEMORY.md')
await store.editBotMemory('chief', { kind: 'personality', action: 'set', content: '崩溃前人格', expectedVersion: (await store.getBotMemory('chief')).personality.version, requestId: 'crash-personality' })
// A real, durably owned user Entry as source; ledger-only change bypasses the reconciler like background extraction.
const taskId = (await store.mainSessions()).chief
const source = await store.harness.commit(async tx => {
  const card = await tx.doc(TaskCard, taskId)
  const entry = await tx.appendEntry(card.conversationId, { kind: 'pidot.user', data: { role: 'user', content: '崩溃夹具证据' } })
  return { taskId, entryId: entry.id }
}, context)
const service = createBotMemoryService({ getSecrets: () => [] })
const apply = (id, content, expectedVersion) => store.harness.commit(tx => service.applyCandidate(tx, { botId: 'chief', kind: 'memory', requestId: `crash-${id}`, expectedVersion, patches: [{ action: 'add', id, content, sourceEntries: [source] }] }), context)
await apply('a', '原有条目', 0)
await store.memoryFiles.settled()
// The user saves a hand edit while extraction adds C; the next reconcile must import AND write back.
await writeFile(memory, '- 原有条目 <!-- id:a -->\n- 崩溃前手写\n')
await apply('c', '提取条目', 1)
if (mode === 'after-import') hooks.afterImport = () => hang(mode)
if (mode === 'before-rename') hooks.beforeRename = () => hang(mode)
if (mode === 'after-rename') hooks.afterRename = () => hang(mode)
await store.getBotMemory('chief')
console.log(JSON.stringify({ point: 'not-reached' }))
