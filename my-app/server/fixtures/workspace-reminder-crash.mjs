import { openTaskStore } from '../tasks.mjs'
const [file, phase] = process.argv.slice(2), start = Date.parse('2026-10-19T00:00:00Z'), hold = setInterval(() => {}, 1000)
const pause = async (point, row) => { if (point === phase) { process.send?.({ point, row }); await new Promise(() => {}) } }
const tasks = await openTaskStore({ file, modelReply: async () => { throw Error('07 no model allowed') }, workspaceScheduleOptions: { autoStart: false, now: () => start + (phase === 'seed' ? 0 : 60001), boundary: pause }, workspaceReminderOptions: { now: () => start + (phase === 'seed' ? 0 : 60001), boundary: pause } })
if (phase === 'seed') {
  await tasks.workspace.manageLocalGrant({ requestId: 'grant', sourceId: 'local', enabled: true, expectedEpoch: 0, confirmed: true })
  const target = (await tasks.workspace.executeLocal({ requestId: 'todo', sourceId: 'local', type: 'Todo', action: 'create', data: { title: 'kill-secret', due: new Date(start + 60000).toISOString(), timezone: 'UTC' } })).receipt.target
  const op = await tasks.workspaceReminders.manage({ requestId: 'reminder', command: 'create', targetRef: target, targetVersion: 1, offset: 0, channel: 'inbox', confirmed: true }); process.send?.({ seeded: op.receipt.reminder })
} else { await tasks.workspaceScheduler.tick(); process.send?.({ completed: await tasks.workspaceReminders.list({}) }) }
await tasks.close(); clearInterval(hold)
