import { openTaskStore } from '../tasks.mjs'
const [file, phase] = process.argv.slice(2)
const due = '2026-10-19T00:01:00.000Z'
const hold = setInterval(() => {}, 1000)
const tasks = await openTaskStore({ file, workspaceScheduleOptions: { autoStart: false, now: () => Date.parse(due) + (['seed', 'before_due'].includes(phase) ? 1 : 60001), boundary: async (point, value) => { if (point === phase || phase === 'before_due' && point === 'before_claim') { process.send?.({ point: phase === 'before_due' ? 'before_due' : point, value }); await new Promise(() => {}) } } } })
if (phase === 'seed') {
  await tasks.workspace.manageLocalGrant({ requestId: 'seed-grant', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
  // Future relative to fixture's creation clock; due is made past only in next process.
  const plan = await tasks.workspaceSchedules.manage({ requestId: 'seed-plan', command: 'create', title: 'SIGKILL-isolated', timezone: 'UTC', rule: { type: 'at', at: '2026-10-19T00:02:00Z' }, actionSpec: { kind: 'internal_deterministic_record' }, confirmed: true })
  process.send?.({ seeded: plan.receipt.schedule }); await tasks.close(); clearInterval(hold)
} else { await tasks.workspaceScheduler.tick(); process.send?.({ completed: await tasks.workspaceSchedules.list({}) }); await tasks.close(); clearInterval(hold) }
