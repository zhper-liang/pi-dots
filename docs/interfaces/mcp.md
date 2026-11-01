# MCP 契约

## 协议与 transport
固定兼容基线为 `2025-11-25`，不是“当前最新版本”声明。实现 initialize/initialized、能力协商、tools/list、tools/call、错误与取消。内部 host 绑定 Task 和主体；外部本地 client 通过 stdio 桥转发私有 loopback relay。stdout 仅输出协议消息，stderr 输出脱敏诊断，桥不读取数据库或自行加载 `.env`。

应用内 Agent 直接由宿主 Task 身份调用，无需凭证发放；设置页已移除 stdio 凭证入口。兼容外部 stdio 客户端的受限 client grant 绑定 owner/Bot/source/action/有效期，服务端每次复核。不得把管理员 API token 提供给模型，不接受 body 伪造 Task 身份。session 关闭不取消已经持久化的计划/Operation。这里描述 Pidot 对外提供的入站 MCP：只支持本机 stdio 桥与私有 loopback relay，未提供公网入站 MCP 服务。

## 外部 MCP 客户端状态

R1-09 的方向是 Pidot 作为客户端连接其他 MCP 服务，与上面的入站桥不同。生产已装配官方 SDK 的 Streamable HTTP 与指定已安装绝对 executable+argv 的本机 stdio 服务；提供认证配置/安全凭据/检查/重连/停用/移除及原请求查询。真实 SDK 临时 HTTP 服务与 Harness 已验证，尚不表示真实供应商或用户已验收。接口见 [HTTP API](http-api.md#外部-mcp-连接)。

每个 store 使用独立动态目录，按 connectionId 稳定映射工具名；能力分配复用 `GET/POST /api/bots/:botId/capabilities`，新出现的工具不会自动授权。schema 展示、参数校验、实时绑定和 catalog revision、ADR-018 / ADR-022 的统一写入 policy、预算/取消及真实回执均进入既有 Harness；服务端 annotations 不构成读写授权。连接检查只握手/发现，不以外部写入测试可用性。当前未知调用不自动重发，大结果完整存储，以默认自带的 tool_result_read 按当前来源授权分页读回。

MCP 外部来源有独立 refs，由共同历史 gate 约束 context/history/artifact/collaboration/memory；重新审阅绑定后，新的认证输入可退役旧派生 context 并清 compaction，旧审计不删除、旧来源不复活。重启持久保存登记但不沿用 live verified 状态，需要显式重新检查。R1-11真实配置Host/卡片及R1-12受控本地回归/核心页面验收已完成，真实账户和用户验收不在通过结论内，详见计划材料，外部 MCP 连接本身不开放任意包安装或完整 OAuth；Agent 原生 Bash 见 ADR-024。

## 实际工具
工具名和 schema 的唯一实现入口是 [workspace-tools.mjs](../../my-app/server/workspace-tools.mjs)。全部禁止额外顶层字段；sourceId 等字符串按 schema 校验。

| 工具 | 必需字段 | 可选字段 / 行为 |
|---|---|---|
| `workspace.list` | sourceId, type | type为Event/Todo；cursor≥0，limit为1–20，start/end/timezone；外部来源需要明确时间窗口 |
| `workspace.get` | sourceId, type | id或eventId二选一：本地用id、外部用eventId |
| `workspace.prepare_change` | sourceId, requestId, action, change | action 为 create/update/delete；持久化精确 Operation，新建/修改允许时直接执行，删除逐次确认，全局暂停时等待认证用户确认 |
| `workspace.prepare_schedule` | sourceId, requestId, draft | 只准备单一来源的只读Agent计划草稿，由用户核对频率、提示、预算和通知后确认 |
| `workspace.operation_status` | sourceId, requestId | 查询原主体请求状态，不再次执行，也不证明通知送达 |

历史提案中的 `schedule.list/prepare_change/run_status` 不是当前实际工具名，不能据此调用。计划查询/执行历史由工作区 HTTP/UI 提供。

## 安全与结果
- 工具展示仅来自已授权集合；真正执行仍复核身份、来源、当前工具/资源分配、实时撤权、参数与预算；内容/运行配置快照不是权限快照。
- busy-only 仅有时段及必要覆盖信息，不能通过get、回执或关联对象恢复正文。
- provider正文属于不可信资料，不作为系统指令。工具结果有界，后续读取同样受权限限制。
- `prepare_change` 由 `decide()` 裁决，规则见[能力与权限](../architecture/capabilities.md#要不要问decide)。本地 Event/Todo 允许时同事务应用并返回 succeeded（`receipt.autoApplied`），在会话留可撤销系统卡；显式 deny 返回 `POLICY_DENIED`，未登记工具返回 `POLICY_UNREGISTERED`。
- `task_create` 只在主会话，用于本机器人的长任务：operationId 幂等，最多 5 个进行中。`automation_pause` 只能暂停全部自动化，不接受恢复参数。
- 例行任务和“帮我想办法”的工具范围见[专用运行的限制](../architecture/capabilities.md#专用运行的限制)。工作流 unknown 只保留在原 Task 和 occurrence，不投递镜像或通知；周期执行确定失败后暂停，须显式恢复；测试运行不投递。
- 主会话清空换新通过认证 HTTP `POST /api/tasks/:taskId/clear-main`，不是 MCP session 关闭或普通 Task cancel。后台结果使用当前主会话映射接续，stop/swap 窗口内结果持久交接一份，连续清空/重启不重复；独立子任务保留，直接协作可等待换新后继续。已删除 child 不进入 task_status，摘要注入复核实际来源及当前权限；普通 cancel/root stop/实时撤权仍按原路径生效。
- 对 dispatching/unknown 查询原 requestId，不生成新请求重试副作用。

实现：[协议](../../my-app/server/workspace-mcp-protocol.mjs)、[host](../../my-app/server/workspace-mcp-host.mjs)、[业务](../../my-app/server/workspace-mcp-business.mjs)、[stdio桥](../../my-app/server/workspace-mcp-stdio.mjs)。启动方式与凭证配置见 [工程README](../../my-app/README.md)。

设置中的本机 stdio 凭证面板已移除；应用内 Agent 无需发放凭证，外部 stdio 兼容接口仍保留 client-issue / list / revoke 契约。机器人能力页的 MCP 子栏只控制已连接外部 MCP 的启停，不发凭证；停用机器人不可发新凭证，已有凭证仍可撤销，不增加协议或权限主体。

## 记忆工具

`memory_read({kind,offset?,limit?})`：kind为personality/memory/preferences；后两类返回version、items、total、nextOffset，limit默认8、最多16。只读本Bot和共享偏好，沿用来源与凭证过滤。`memory_edit({kind,action,expectedVersion,id?,content?})`：memory/preferences为add/update/delete（add不传id时宿主生成），personality仅set。宿主绑定当前认证用户Entry，不接受botId/sourceEntries/requestId覆盖，提交与回执同事务；成功仅返回kind/version/id/action/replayed。冲突 `MEMORY_VERSION_CONFLICT`，缺少本次直接私聊明确要求 `MEMORY_USER_REQUEST_REQUIRED`，日程待办 `MEMORY_TRANSIENT_CONTENT`。这两项是宿主内置模型工具，不是可选外部MCP，也不需要能力开关。

## 主会话历史搜索与手动整理

`session_search({query,after?,before?,offset?,limit?})` 仅主会话使用，关键词支持中文、项目名和代码路径；时间为 ISO 日期时间。分页默认 5、最多 10，查询最长 200 字符，片段最多 160 Unicode 字符。限定本 Bot 私聊及真实同 Bot 派生 Task，先来源检查再计算 total/片段；没有结果返回空列表，不扩大普通 Task 权限。

命中包含宿主绑定 `historyRef`，`session_history_read({historyRef,offset?,limit?,resultRef?,resource?})` 只补读该引用，不能指定任意 taskId；每次重新核验可见性。原始条目按字符分页；完整工具结果必须精确匹配该命中的原始 resultRef/resource 并复用原工具结果权限。引用失效返回拒绝，不提供旧内容或计数。历史只是不可信资料，不恢复 Skill 或旧授权，不重新执行成功操作。

`memory_review({})` 仅主会话且本轮真实用户明确要求整理/回顾记忆时登记本 Bot 后台作业；返回排队回执，不代表已经保存。仍由同一后台预算、来源校验及暂停开关控制。`memory_read`/`memory_edit` 和独立 Task 自身回读不依赖后台学习开关。

自动学习不是可调用的 `skill_manage` 管理权限：宿主只发布本 Bot 有成功原始证据的方法。模型仅提交 methodKey、内容、适用条件、验证步骤及宿主提供的来源引用，不能指定 owner/来源身份/脚本/新依赖。用户正常启禁/按需激活/版本回退继续有效。


### 会话问题表单（ADR-027）

宿主 `report_blocker` 支持可选 questions 数组（1–3题文本/单选/多选），字段和回答规则见 [HTTP 问题表单](http-api.md#问题表单与输入挂起adr-027)。这是信息收集工具，不是授权入口。普通用户问题允许原输入挂起，继续处理新消息；受管子任务仍强制先交绑定主管。删除和其他待批准操作继续使用精确审批链。
