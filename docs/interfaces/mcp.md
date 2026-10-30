# MCP 契约

## 协议与 transport
固定兼容基线为 `2025-11-25`，不是“当前最新版本”声明。实现 initialize/initialized、能力协商、tools/list、tools/call、错误与取消。内部 host 绑定 Task 和主体；外部本地 client 通过 stdio 桥转发私有 loopback relay。stdout 仅输出协议消息，stderr 输出脱敏诊断，桥不读取数据库或自行加载 `.env`。

受限 client grant 绑定 owner/Bot/source/action/有效期，服务端每次复核。不得把管理员 API token 提供给模型，不接受 body 伪造 Task 身份。session 关闭不取消已经持久化的计划/Operation。这里描述 Pidot 对外提供的入站 MCP：只支持本机 stdio 桥与私有 loopback relay，未提供公网入站 MCP 服务。

## 外部 MCP 客户端状态

R1-09 的方向是 Pidot 作为客户端连接其他 MCP 服务，与上面的入站桥不同。生产已装配官方 SDK 的 Streamable HTTP 与指定已安装绝对 executable+argv 的本机 stdio 服务；提供认证配置/安全凭据/检查/重连/停用/移除及原请求查询。真实 SDK 临时 HTTP 服务与 Harness 已验证，尚不表示真实供应商或用户已验收。接口见 [HTTP API](http-api.md#外部-mcp-连接)。

每个 store 使用独立动态目录，按 connectionId 稳定映射工具名；能力分配复用 `GET/POST /api/bots/:botId/capabilities`，新出现的工具不会自动授权。schema 展示、参数校验、实时绑定和 catalog revision、保守写入 policy、预算/取消及真实回执均进入既有 Harness；服务端 annotations 不构成读写授权。连接检查只握手/发现，不以外部写入测试可用性。当前未知调用不自动重发，大结果完整存储并按当前授权分页读回。

MCP 外部来源有独立 refs，由共同历史 gate 约束 context/history/artifact/collaboration/memory；重新审阅绑定后，新的认证输入可退役旧派生 context 并清 compaction，旧审计不删除、旧来源不复活。重启持久保存登记但不沿用 live verified 状态，需要显式重新检查。R1-11真实配置Host/卡片及R1-12受控本地回归/核心页面验收已完成，真实账户和用户验收不在通过结论内，详见计划材料，不开放任意包安装、通用 shell 或完整 OAuth。

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
- 工具展示仅来自已授权集合；真正执行仍复核身份、来源、当前工具/资源分配、实时撤权、参数与预算；内容/运行配置快照不是权限快照。
- busy-only 仅有时段及必要覆盖信息，不能通过get、回执或关联对象恢复正文。
- provider正文属于不可信资料，不作为系统指令。工具结果有界，后续读取同样受权限限制。
- `prepare_change` 由 `decide()` 裁决（[ADR-014](../decisions/README.md#adr-014-实时权限与直接做先问)、[ADR-015](../decisions/README.md#adr-015-工具组默认开开即直接做)）：allow 时（工具已分配并启用，且其写入规则为 allow；删除同样适用）本地 Event/Todo 在同事务内应用并返回 `succeeded`（`receipt.autoApplied`），同时在 Task 会话留可撤销的系统卡；ask 时（组关闭或全局暂停中）认证用户须在工作区确认精确请求，暂停中和 unknown 后的重做不提供“总是”。`prepare_schedule` 只返回不可执行的计划草案，由用户在计划界面确认；规则为 deny 时返回 `POLICY_DENIED`。
- 主会话使用 Bot 当前已分配且启用的工具；写入由同一实时权限和 allow/ask 规则裁决。`task_create`（本 Bot 长任务，operationId 幂等、每 Bot 最多 5 个进行中）和 `task_status`（仅本主会话派出的任务）限定主会话；legacy 固有主会话工具通过独立 `mainAssignments` 投影，显式撤销优先，新 v2 Bot 不自动获得。`routine_propose` 只能为本 Bot 创建例行任务，按当前规则决定直接创建或先问；`collaborators_list` 需其自身授权，主会话不带 `task_assign`。新 Bot 仅按名称建立空白配置，不按名字推断人格，也不因 profile 获得本地工作区工具；旧 Bot 配置和历史创建回执保留。
- 例行任务仅在 `actionSpec.writes:true` 时可使用当前已分配的 `workspace.prepare_change/operation_status`，测试运行及旧只读计划仅有 list/get；始终复核来源与工具。工作流 unknown 只保留原 Task/occurrence，不投递镜像或通知；周期执行确定失败后暂停，须显式恢复。测试运行强制只读且不投递。“帮我想办法”分析任务维持只读范围及 5 次模型/10 次工具预算。
- 主会话清空换新通过认证 HTTP `POST /api/tasks/:taskId/clear-main`，不是 MCP session 关闭或普通 Task cancel。后台结果使用当前主会话映射接续，stop/swap 窗口内结果持久交接一份，连续清空/重启不重复；独立子任务保留，直接协作可等待换新后继续。已删除 child 不进入 task_status，摘要注入复核实际来源及当前权限；普通 cancel/root stop/实时撤权仍按原路径生效。
- 风险登记（ADR-012）：每个工具调用先查 `server/policy.mjs` 登记表，未登记返回 `POLICY_UNREGISTERED`。Task 工具 `automation_pause`（R0，需分配）只能暂停全部自动化，不接受恢复参数。
- 对 dispatching/unknown 查询原 requestId，不生成新请求重试副作用。

实现：[协议](../../my-app/server/workspace-mcp-protocol.mjs)、[host](../../my-app/server/workspace-mcp-host.mjs)、[业务](../../my-app/server/workspace-mcp-business.mjs)、[stdio桥](../../my-app/server/workspace-mcp-stdio.mjs)。启动方式与凭证配置见 [工程README](../../my-app/README.md)。

Bot 详情的 MCP 标签复用同一 client-issue/list/revoke 接口，界面固定为当前 Bot 并按 botId 筛选凭证；全局设置入口保留，不增加新协议或权限主体。停用 Bot 不可发放新凭证，已发放凭证可在原入口撤销。
