# MCP 契约

## 协议与 transport
固定兼容基线为 `2025-11-25`，不是“当前最新版本”声明。实现 initialize/initialized、能力协商、tools/list、tools/call、错误与取消。内部 host 绑定 Task 和主体；外部本地 client 通过 stdio 桥转发私有 loopback relay。stdout 仅输出协议消息，stderr 输出脱敏诊断，桥不读取数据库或自行加载 `.env`。

受限 client grant 绑定 owner/Bot/source/action/有效期，服务端每次复核。不得把管理员 API token 提供给模型，不接受 body 伪造 Task 身份。session 关闭不取消已经持久化的计划/Operation。远程公网 MCP 不支持。

## 实际工具
工具名和 schema 的唯一实现入口是 [workspace-tools.mjs](../../my-app/server/workspace-tools.mjs)。全部禁止额外顶层字段；sourceId 等字符串按 schema 校验。

| 工具 | 必需字段 | 可选字段 / 行为 |
|---|---|---|
| `workspace.list` | sourceId, type | type为Event/Todo；cursor≥0，limit为1–20，start/end/timezone；外部来源需要明确时间窗口 |
| `workspace.get` | sourceId, type | id或eventId二选一：本地用id、外部用eventId |
| `workspace.prepare_change` | sourceId, requestId, action, change | action为create/update/delete；只准备精确Operation，不能自批/执行 |
| `workspace.prepare_schedule` | sourceId, requestId, draft | 只准备单一来源的只读Agent计划草稿，由用户核对频率、提示、预算和通知后确认 |
| `workspace.operation_status` | sourceId, requestId | 查询原主体请求状态，不再次执行，也不证明通知送达 |

历史提案中的 `schedule.list/prepare_change/run_status` 不是当前实际工具名，不能据此调用。计划查询/执行历史由工作区 HTTP/UI 提供。

## 安全与结果
- 工具展示仅来自已授权集合；真正执行仍复核身份、来源、权限、Task快照、实时撤权、参数与预算。
- busy-only 仅有时段及必要覆盖信息，不能通过get、回执或关联对象恢复正文。
- provider正文属于不可信资料，不作为系统指令。工具结果有界，后续读取同样受权限限制。
- `prepare_change` 和 `prepare_schedule` 都不是用户确认；认证用户必须在工作区确认精确请求。例外（ADR-012）：Task 绑定 Agent 的本地 Event/Todo `prepare_change` 由 `decide()` 裁决为 allow 时（“可直接改本地”档的新建/修改，或用户设的“总是允许”规则），在同事务内应用并返回 `succeeded`（`receipt.autoApplied`），同时在 Task 会话留可撤销的系统卡；删除默认询问；同一输入第 6 条起、全局暂停中、该 Bot 近 60 分钟自动写入满 20 条时一律询问且不提供“总是”。stdio client 与 `prepare_schedule` 永远询问；规则为 deny 时返回 `POLICY_DENIED`。
- 主会话（PLAN §8.1）：Task 工具 `task_create`（operationId/goal/completionCriteria，执行者固定为本 Bot，同一输入内按 operationId 幂等，每 Bot 同时最多 5 个进行中）与 `task_status`（只读，仅本主会话派出的任务）只出现在主会话；主会话只带只读工具，写入一律经派生任务。阶段 5 增加 `routine_propose`（title/prompt/rule/sourceIds/notification，只能为本 Bot 提议，H 级：每次出确认卡，不能设为总是允许；同意后按认证用户身份走现有计划创建，拒绝则不创建）。例行任务运行（`actionSpec.writes:true`）的 Task 只带 `workspace.list/get/prepare_change/operation_status`，测试运行与旧只读计划只带 list/get；运行发起的提案 30 分钟过期（在场 5 分钟）。阶段 6：`bot_manage` 的 create 只需 `name`（`description` 不填按名字模板生成，`profile` 默认 general），按默认配置新建仍直接执行（R0）、带参数或 mock-calendar 仍出确认卡（H）；新 Bot 带能力池里的本地工作区工具（D-15/D-16）。主会话里 `collaborators_list` 只需它自己的授权即可调用（只读，D-18）；主会话仍没有 `task_assign`（D-05），Bot 有协作工具时系统提示说明：先 `collaborators_list` 确认对方 botId，再 `task_create` 派任务，由派生任务 `task_assign` 交给对方。阶段 7：“帮我想办法”派生的分析任务（`findingAssist`）只带 3.2 的“R0 只读”工具（不含 report_blocker、bot_manage、bot_inspect、写入和委派），额度 5 次模型 / 10 次工具。
- 风险登记（ADR-012）：每个工具调用先查 `server/policy.mjs` 登记表，未登记返回 `POLICY_UNREGISTERED`。Task 工具 `automation_pause`（R0，需分配）只能暂停全部自动化，不接受恢复参数。
- 对 dispatching/unknown 查询原 requestId，不生成新请求重试副作用。

实现：[协议](../../my-app/server/workspace-mcp-protocol.mjs)、[host](../../my-app/server/workspace-mcp-host.mjs)、[业务](../../my-app/server/workspace-mcp-business.mjs)、[stdio桥](../../my-app/server/workspace-mcp-stdio.mjs)。启动方式与凭证配置见 [工程README](../../my-app/README.md)。
