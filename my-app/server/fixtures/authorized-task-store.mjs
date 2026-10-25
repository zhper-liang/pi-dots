// Explicit authenticated-consent setup for legacy deterministic test scenarios.
// Not used by server/index.mjs, HTTP routes, or browser acceptance servers.
// Same immutable request receipt on reopen: never regrant a later revocation.
import { openTaskStore as openStore } from '../tasks.mjs'
import { BotDirectory } from '../bot-directory.mjs'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ToolAccess } from '../tools.mjs'
import { addRule, PolicyRules } from '../policy.mjs'
export async function assignCapabilities(store, { operation, tools = [], resources = [] }) {
  return store.harness.commit(async tx => {
    const access = await tx.doc(ToolAccess), directory = await tx.doc(BotDirectory)
    for (const bot of directory.items) {
      const assigned = access.assignments[bot.id] ??= { tools: [], resources: [] }
      for (const [field, values] of [['tools', tools], ['resources', resources]]) {
        assigned[field] = operation === 'grant'
          ? [...new Set([...assigned[field], ...values])]
          : assigned[field].filter(value => !values.includes(value))
      }
    }
    return { assignments: JSON.parse(JSON.stringify(access.assignments)) }
  }, context)
}
export async function openTaskStore(options) {
  const { legacyApprovalRules = true, ...storeOptions } = options
  const store = await openStore(storeOptions)
  try {
    await store.harness.commit(async (tx) => {
      const d = await tx.doc(BotDirectory), a = await tx.doc(ToolAccess)
      for (const bot of d.items) a.assignments[bot.id] ??= { tools: [...bot.defaults.tools], resources: [...bot.defaults.toolResources] }
      // Approval/recovery fixtures opt into ask. Production still uses S3's direct-write defaults.
      if (legacyApprovalRules) for (const bot of d.items) for (const name of ['calendar_reschedule_event', 'calendar_feishu_create_event', 'calendar_feishu_update_event', 'workspace.prepare_change']) {
        const match = { tool: name }
        if (!(await tx.doc(PolicyRules)).items.some(r => r.botId === bot.id && JSON.stringify(r.match) === JSON.stringify(match)))
          await addRule(tx, { botId: bot.id, match, effect: 'ask' })
      }
      if (legacyApprovalRules) for (const action of ['configure', 'deactivate']) {
        const match = { tool: 'bot_manage', action }
        if (!(await tx.doc(PolicyRules)).items.some(r => r.botId === 'chief' && JSON.stringify(r.match) === JSON.stringify(match)))
          await addRule(tx, { botId: 'chief', match, effect: 'ask' })
      }
    }, context)
    // Legacy test setup shorthand: pool grants now mean direct Bot assignment changes.
    store.updateCapabilityPool = input => assignCapabilities(store, input)
    return store
  } catch (error) { await store.close(); throw error }
}
