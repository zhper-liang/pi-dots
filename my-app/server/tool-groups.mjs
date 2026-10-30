// Membership metadata only. ToolAccess owns enabled/disabled (including reads);
// PolicyRules independently owns write confirmation. Toggling capability never changes policy.
// System safety controls and Chief management availability are enforced by the shared runtime.
export const TOOL_GROUPS = Object.freeze([
  Object.freeze({ id: 'skills', label: 'Skills', description: '按需加载专业做法和参考资料；调用过程中的业务工具仍按各自组开关执行。', requiresMainSession: false, tools: Object.freeze(['skill_activate', 'skill_deactivate', 'skill_read_resource']) }),
  Object.freeze({ id: 'calendar', label: '日历与日程', description: '查看日程、检查冲突、新建或调整日历事件；经工作区工具改飞书、Google 等来源的日程，也按本组的写入确认。', requiresMainSession: false, tools: Object.freeze(['calendar_read_schedule', 'calendar_read_event', 'calendar_reschedule_event',
    'calendar_feishu_read_schedule', 'calendar_feishu_read_event', 'calendar_feishu_freebusy',
    'calendar_feishu_create_event', 'calendar_feishu_update_event', 'calendar_feishu_delete_event']) }),
  Object.freeze({ id: 'todos', label: '待办与事项', description: '查看、整理待办和为事项设定时提醒；经工作区工具改日程时，写入确认按「日历与日程」。', requiresMainSession: false, tools: Object.freeze(['workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status', 'routine_propose', 'workspace.prepare_schedule']) }),
  Object.freeze({ id: 'collaboration', label: 'Bot 协作', description: '查看其他 Bot、派发任务、收取和验收结果、共享信息。', requiresMainSession: false, tools: Object.freeze(['collaborators_list', 'task_create', 'task_assign', 'task_review', 'shared_publish', 'shared_read', 'shared_link']) }),
  Object.freeze({ id: 'reports', label: '进度与阻塞', description: '上报和解除阻塞、查询主会话派出的任务进度。', requiresMainSession: false, tools: Object.freeze(['report_blocker', 'blocker_resolve', 'blocker_escalate', 'task_status']) }),
  Object.freeze({ id: 'history', label: '历史与回读', description: '回读本会话历史、工具结果和 Skill 参考资料。', requiresMainSession: false, tools: Object.freeze(['task_history_read', 'tool_result_read']) }),
  Object.freeze({ id: 'automation', label: '自动化控制', description: '在对话里一键暂停全部自动化（恢复需在设置页操作），只在主会话中提供。', requiresMainSession: true, tools: Object.freeze(['automation_pause']) }),
  Object.freeze({ id: 'capabilities', label: '能力配置', description: '登记、更新和停用 MCP 与 Skills；仅 Chief 或宿主明确赋权的配置 Agent 可用。写入确认为直接执行时配置即时生效，设为先问才逐项确认。', requiresMainSession: false, tools: Object.freeze(['mcp_manage', 'skill_manage']) }),
  Object.freeze({ id: 'bots', label: 'Bot 管理', description: '创建、配置和停用 Bot（仅 Chief 持有）。', requiresMainSession: false, tools: Object.freeze(['bot_manage']) }),
])
const byTool = new Map(TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => [tool, group.id])))
export const groupOfTool = (tool) => byTool.get(tool) ?? null
export const groupTools = (id) => TOOL_GROUPS.find((group) => group.id === id)?.tools ?? []
export const isToolGroup = (id) => TOOL_GROUPS.some((group) => group.id === id)

// D15: one workspace write tool serves both item types, so its write confirmation is routed by the
// item it changes (PolicyRules `type`): schedules by 日历与日程, todos by 待办与事项. Enablement is
// unchanged: the tool still belongs to 待办与事项 above, and enabling 日历与日程 never grants it.
export const ITEM_WRITE_TOOL = 'workspace.prepare_change'
export const ITEM_WRITE_GROUPS = Object.freeze({ Event: 'calendar', Todo: 'todos' })
export const ITEM_TYPES = Object.freeze(Object.keys(ITEM_WRITE_GROUPS))
export const itemTypesOfGroup = (id) => ITEM_TYPES.filter((type) => ITEM_WRITE_GROUPS[type] === id)
/** The group whose 直接做/先问 switch decides this write. */
export const writeGroupOf = (tool, type) => tool === ITEM_WRITE_TOOL && Object.hasOwn(ITEM_WRITE_GROUPS, type) ? ITEM_WRITE_GROUPS[type] : groupOfTool(tool)
