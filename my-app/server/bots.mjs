import { CALENDAR_WRITE_TOOL } from './approvals.mjs'
import { BLOCKER_TOOL } from './blockers.mjs'
import { HISTORY_TOOL } from './history-tool.mjs'
import { skillTools } from './skill-tools.mjs'
import { createHash } from 'node:crypto'
import { CALENDAR_EVENT_TOOL, CALENDAR_TOOL, DEFAULT_CALL_LIMITS } from './tools.mjs'
import { RESULT_READ_TOOL } from './tool-results.mjs'
import { readExecutionDefaults } from './config.mjs'
import { modelParameters } from './model-reply.mjs'

/** First-initialization seeds only. Runtime reads the persisted TaskStore directory. Never contain credentials. */
export const BOT_CONFIG_VERSION = '2026-10-17.v11'

const presets = [
  ['chief', 'pipi', '你的个人助理入口，帮助梳理目标与下一步。'],
  ['calendar', '日程助理', '梳理日程与时间安排，找出冲突和空档。'],
  ['todo', '待办助理', '整理待办和优先级，提醒快到期的事。'],
]

export function listBots(modelConfig, executionDefaults = readExecutionDefaults({})) {
  const defaults = modelConfig ? modelParameters(modelConfig) : { mode: 'test', model: null, thinkingLevel: 'off', tools: [], callLimits: { ...DEFAULT_CALL_LIMITS } }
  Object.assign(defaults, structuredClone(executionDefaults))
  const fingerprint = { ...defaults, ...(defaults.model ? { model: { id: defaults.model.id, api: defaults.model.api } } : {}) }
  const version = `${BOT_CONFIG_VERSION}.${createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 16)}`
  return presets.map(([id, name, description]) => ({
    id, name, description,
    configRef: { botId: id, version },
    defaults: { ...structuredClone(defaults), tools: id === 'calendar' ? [CALENDAR_TOOL, CALENDAR_EVENT_TOOL, RESULT_READ_TOOL, HISTORY_TOOL, ...skillTools.map((tool) => tool.name), BLOCKER_TOOL, CALENDAR_WRITE_TOOL] : [BLOCKER_TOOL],
      toolResources: id === 'calendar' ? ['mock:personal'] : [] },
  }))
}
