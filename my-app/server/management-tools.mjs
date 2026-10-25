// Management is a separate server-granted Chief capability.
export const MANAGEMENT_TOOLS = ['bot_inspect', 'bot_manage']
export const managementTools = [
  { name: 'bot_inspect', description: 'Chief只读管理目录，返回精确botId、当前版本、职责及实时分配的工具和资源。先读取再变更；名称相似或意图不清时report_blocker询问用户，不得默选。管理权不等于业务执行权。', parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'bot_manage', description: 'Chief管理Bot。先明确用户目标和变更。create只需name，可选description和profile（general或mock-calendar，默认general）；configure需精确botId、expectedVersion、完整description/tools/resources，可选parameters；deactivate需精确botId、expectedVersion、confirm=true。不能停用Chief。同一用户输入每种动作每目标仅一次持久操作，重复返回原回执。版本冲突须重新读取，不得自作主张重放。create和configure默认直接执行，新增Bot默认分配本地工作区工具；deactivate默认等待用户确认。工具分配变更从已有Task的下一次调用起生效。以执行回执为准。', parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['create', 'configure', 'deactivate'] }, botId: { type: 'string' }, expectedVersion: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, profile: { type: 'string', enum: ['general', 'mock-calendar'] }, parameters: { type: 'object' }, tools: { type: 'array', items: { type: 'string' } }, resources: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' },
  } } },
]
export function validManagementArgs(call) {
  const a = call.arguments
  if (call.argumentsError || !a || typeof a !== 'object' || Array.isArray(a)) return false
  if (call.name === 'bot_inspect') return Object.keys(a).length === 0
  const fields = { create: ['action', 'name', 'description', 'profile', 'parameters'], configure: ['action', 'botId', 'expectedVersion', 'description', 'parameters', 'tools', 'resources'], deactivate: ['action', 'botId', 'expectedVersion', 'confirm'] }[a.action]
  if (!fields || Object.keys(a).some(k => !fields.includes(k))) return false
  // PLAN §8.6 / D-16: only name is required; description comes from the name template, profile defaults to general.
  if (a.action === 'create') return typeof a.name === 'string' && !!a.name.trim() && (a.description === undefined || typeof a.description === 'string' && !!a.description.trim()) && (a.profile === undefined || ['general', 'mock-calendar'].includes(a.profile))
  return typeof a.botId === 'string' && !!a.botId && typeof a.expectedVersion === 'string' && !!a.expectedVersion && (a.action === 'configure' ? typeof a.description === 'string' && Array.isArray(a.tools) && Array.isArray(a.resources) : a.confirm === true)
}
