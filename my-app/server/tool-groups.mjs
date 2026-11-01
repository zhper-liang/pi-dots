// Membership metadata only. ToolAccess owns the group on/off switches (including reads).
// PolicyRules holds runtime rules, independent of capability enablement (ADR-022).
// System safety controls and Chief management availability are enforced by the shared runtime.
export const TOOL_GROUPS = Object.freeze([
  Object.freeze({ id: 'skills', label: 'Skills', description: '按需加载专业做法和参考资料；调用过程中的业务工具仍按各自组开关执行。', requiresMainSession: false, tools: Object.freeze(['skill_activate', 'skill_deactivate', 'skill_read_resource']) }),
  // 'todos' is the merged 日程与待办 group (ADR-022); its persisted capability id stays unchanged.
  Object.freeze({ id: 'todos', label: '日程与待办', description: '查看和整理日程与待办：检查冲突和空档，新建、修改、删除，给事项设提醒和定时任务。', requiresMainSession: false, tools: Object.freeze(['calendar_read_schedule', 'calendar_read_event', 'calendar_reschedule_event',
    'calendar_feishu_read_schedule', 'calendar_feishu_read_event', 'calendar_feishu_freebusy',
    'calendar_feishu_create_event', 'calendar_feishu_update_event', 'calendar_feishu_delete_event',
    'workspace.list', 'workspace.get', 'workspace.prepare_change', 'workspace.operation_status', 'routine_propose', 'workspace.prepare_schedule']) }),
  Object.freeze({ id: 'collaboration', label: '机器人协作', description: '查看其他机器人，派任务、收结果、验收，共享信息。', requiresMainSession: false, tools: Object.freeze(['collaborators_list', 'task_create', 'task_assign', 'task_review', 'shared_publish', 'shared_read', 'shared_link']) }),
  Object.freeze({ id: 'reports', label: '进度与阻塞', description: '卡住时提问，查看派出去的任务进度。', requiresMainSession: false, tools: Object.freeze(['report_blocker', 'blocker_resolve', 'blocker_escalate', 'task_status']) }),
  Object.freeze({ id: 'automation', label: '自动化控制', description: '在对话里一键暂停全部自动化，只在主会话里有。', requiresMainSession: true, tools: Object.freeze(['automation_pause']) }),
  Object.freeze({ id: 'capabilities', label: '能力配置', description: '在对话里添加、更新和停用 MCP 与 Skill。', requiresMainSession: false, tools: Object.freeze(['mcp_manage', 'skill_manage']) }),
  Object.freeze({ id: 'bots', label: '机器人管理', description: '创建、配置和停用机器人，只有 pipi 有。', requiresMainSession: false, tools: Object.freeze(['bot_manage']) }),
])
const byTool = new Map(TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => [tool, group.id])))
export const groupOfTool = (tool) => byTool.get(tool) ?? null
export const groupTools = (id) => TOOL_GROUPS.find((group) => group.id === id)?.tools ?? []
export const isToolGroup = (id) => TOOL_GROUPS.some((group) => group.id === id)

// Both item types share the merged group; PolicyRules may still match the item type.
export const ITEM_WRITE_TOOL = 'workspace.prepare_change'
export const ITEM_WRITE_GROUPS = Object.freeze({ Event: 'todos', Todo: 'todos' })
export const ITEM_TYPES = Object.freeze(Object.keys(ITEM_WRITE_GROUPS))
export const itemTypesOfGroup = (id) => ITEM_TYPES.filter((type) => ITEM_WRITE_GROUPS[type] === id)
/** The capability group owning this write for runtime policy matching. */
export const writeGroupOf = (tool, type) => tool === ITEM_WRITE_TOOL && Object.hasOwn(ITEM_WRITE_GROUPS, type) ? ITEM_WRITE_GROUPS[type] : groupOfTool(tool)
