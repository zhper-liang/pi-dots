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
  ['chief', 'Chief', '你的个人助理入口，帮助梳理目标与下一步。'],
  ['calendar', '日程助理', '梳理日程与时间安排；可读取模拟日程，尚未连接真实日历。'],
  ['todo', '待办助理', '整理事项与优先级；当前尚未连接待办服务。'],
]

export function listBots(modelConfig, executionDefaults = readExecutionDefaults({})) {
  const defaults = modelConfig ? modelParameters(modelConfig) : { mode: 'test', model: null, thinkingLevel: 'off', tools: [], callLimits: { ...DEFAULT_CALL_LIMITS } }
  Object.assign(defaults, structuredClone(executionDefaults))
  const version = `${BOT_CONFIG_VERSION}.${createHash('sha256').update(JSON.stringify(defaults)).digest('hex').slice(0, 16)}`
  return presets.map(([id, name, description]) => ({
    id, name, description,
    configRef: { botId: id, version },
    defaults: { ...structuredClone(defaults), tools: id === 'calendar' ? [CALENDAR_TOOL, CALENDAR_EVENT_TOOL, RESULT_READ_TOOL, HISTORY_TOOL, ...skillTools.map((tool) => tool.name), BLOCKER_TOOL, CALENDAR_WRITE_TOOL] : [BLOCKER_TOOL],
      toolResources: id === 'calendar' ? ['mock:personal'] : [] },
  }))
}
