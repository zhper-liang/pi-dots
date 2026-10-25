# HTTP API

## 认证与请求边界
服务默认只监听本机。普通 `/api` 请求使用 `Authorization: Bearer <PIDOT_API_TOKEN>`；凭证由服务端环境保存，不能进入模型、URL或 VITE 构建变量。请求/响应为 JSON，错误形如 `{"error":{"code":"…","message":"…"}}`。请求体上限16 KiB，聊天 message 上限4000字符。认证、方法和错误以 [app.mjs](../../my-app/server/app.mjs) 为准。

HTTP 成功状态不等于业务 Operation 已 succeeded；必须读取 data 内的状态/回执。409/版本冲突时获取当前版本并重新确认，不自动覆盖。网络中断时按原 requestId 查询，不生成重复命令。

## 工作区路由
`GET /api/workspace/status` 返回 `{data: diagnostics}`。下表全部为 `POST /api/workspace/<名称>`，JSON body 直接交给对应服务校验，成功响应为 `{data: result}`。这是当前真实路由映射，不是通用 REST 资源推定。

| 名称 | 服务入口 |
|---|---|
| `reminder-manage` | `workspaceReminders.manage` |
| `reminder-list` | `workspaceReminders.list` |
| `notification-read` | `workspaceReminders.read` |
| `schedule-manage` | `workspaceSchedules.manage` |
| `schedule-list` | `workspaceSchedules.list` |
| `schedule-test` | `workspaceSchedules.testRun` |
| `client-issue` | `workspaceAgent.issueClient` |
| `client-list` | `workspaceAgent.listClients` |
| `client-revoke` | `workspaceAgent.revokeClient` |
| `agent-pending` | `workspaceAgent.pending` |
| `agent-operation` | `workspaceAgent.operationStatus` |
| `agent-confirm-local` | `workspaceAgent.confirmLocal` |
| `agent-allow-rule` | `workspaceAgent.manageAllowRule` |
| `agent-undo` | `workspaceAgent.undoAuto` |
| `query` | `workspace.query` |
| `get` | `workspace.getLocalItem` |
| `command` | `workspace.executeLocal` |
| `grant` | `workspace.manageLocalGrant` |
| `operation` | `workspace.getLocalOperation` |
| `external-sync-status` | `workspace.syncStatus` |
| `external-sync-configure` | `workspace.configureSync` |
| `external-sync-refresh` | `workspace.refreshSync` |
| `external-sources` | `workspace.externalSources` |
| `external-grant` | `workspace.grantExternal` |
| `external-query` | `workspace.queryExternal` |
| `external-get` | `workspace.getExternal` |
| `external-prepare` | `workspace.prepareExternal` |
| `external-confirm` | `workspace.confirmExternal` |
| `external-cancel` | `workspace.cancelExternal` |
| `external-execute` | `workspace.executeExternal` |
| `external-operation` | `workspace.getExternalOperation` |

### 输入与语义
- query/get 使用来源及对象身份；本地类型含 Event/Todo/ItemLink，外部使用显式窗口和精确外部ID。
- command 本地写使用 requestId、sourceId、type、action 及相应数据/版本，用户主体由服务端建立，客户端不得传入可信 actor 或事务回调。
- 外部变更走 prepare/confirm/execute；确认绑定原操作、参数、当前权限和版本，cancel 不等于撤回已发生外部效果。
- local 来源的用户许可为所有者隐式完整许可（ADR-011）：status 恒返回 local `authorized:true` 与 `grantEpoch`；grant 仅接受 `enabled:true`（递增 epoch），`enabled:false` 返回 400 `WORKSPACE_OWNER_IMPLICIT`。外部来源仍用 external-grant。
- Bot 工作区能力只看当前工具/来源资源分配与撤销：读需 workspace.list/get，写需 workspace.prepare_change，并分配 workspace:<sourceId>。来源/连接须 active，保留来源能力与用户许可；外部用户 readScope 继续约束正文。没有 Bot Grant、档位、Task 许可快照或权限 epoch 比对（[ADR-014](../decisions/README.md#adr-014-实时权限与直接做先问)）。
- client-issue：`{botId, sourceId, actions, readScope:busy|full, ttlSeconds, confirmed:true}`；actions 为非空、不重复的 read/create/update/delete 数组，含写动作须 full，ttlSeconds 为 60–3600 整数。Bot 须 active 且当前分配对应工具和来源资源，用户须有相应来源许可。返回 `{token, clientId, expiresAt, notice}`，token 仅发行时显示，运行中再取 Bot 当前分配与 client scope、用户许可的交集，不把管理员 token 当 MCP token。
- client-list：`{}` → `{items:[{clientId, botId, scope, expiresAt, revoked, expired}]}`，不返回 token；client-revoke：`{clientId, confirmed:true}` → `{clientId, revoked:true}`。设置页提供发放、列表、刷新和撤销入口。
- agent-allow-rule：`{botId, tool:'workspace.prepare_change', action:create|update|delete, enabled, confirmed:true}`；设置或移除 origin=user、sourceId=local 的精确动作 allow 规则，返回 `{botId, rules}`。启用时须有 active Bot、当前本地写工具与 workspace:local 资源；不再检查档位。其他工具的规则走 /api/rules。
- agent-confirm-local 可带 `always:true`（只与同意一起）：同一提交写入 tool+action+sourceId+type 的 allow 规则。Task 审批 `.../approvals/:id/decide` 同样支持“以后直接做”，包括 bot_manage；暂停中、结果未知后的重做审批仍不能设“总是”，服务端拒绝不允许的请求。默认只有删除先问，匹配规则后可直接执行，暂停时写入 allow 降为 ask；无批量或每小时自动写入上限。
- agent-undo：`{requestId, confirmed:true}`；仅撤销 Agent 自动执行的本地 Event/Todo 改动（新建→软删、修改→恢复原字段、删除→恢复）；对象版本已变返回 409 `WORKSPACE_UNDO_CONFLICT`；非自动或对外写入返回 `WORKSPACE_UNDO_UNAVAILABLE`；以 `undo:<operationId>` 幂等，重复返回同一回执。
- decide() 为 allow 时，本地 Event/Todo prepare_change 在同一事务内应用，Operation 直接 succeeded，receipt.autoApplied 记录 write-default 或匹配规则的裁决理由；外部 prepare_change 也按同一规则裁决，allow 时继续原 prepare/execute 路径，不提供撤销。stdio client 不再额外强制先问，但仍受独立范围约束。workspace.prepare_schedule 仅返回不可执行的计划草案，用户在计划界面确认；主会话 routine_propose 按规则创建例行任务，默认直接创建。
- schedule-manage 和 reminder-manage 的动作/参数由对应服务严格校验；调用方不得通过请求构造任意 shell/HTTP 自动动作。
- 例行任务：schedule-manage 的 rule 支持 `{type:'event', event:'todo_due'|'event_changed'|'task_finished'}`（只用于 agent_readonly_workflow，nextDueAt 为 null；运行前多个事件合并，event_changed 运行期间产生的变化和撤销自动改动不触发自己；全局暂停记为 skipped/automation_paused，恢复不补跑）。actionSpec.writes:true 才开放当前已分配的 workspace.prepare_change/operation_status；创建、修改默认直接执行，本地自动改动留撤销卡；origin=routine/event/detector 遇到 ask（默认删除或规则要求先问）跳过，并记录“已跳过：这一步需要你来做。”，不出卡等待过期。不带 writes 的旧计划保持只读；派发实时检查 Bot、读工具、来源资源及来源许可，失效取消并记原因，仅配置版本变化不取消。schedule-test：`{requestId, id}` → `{receipt:{scheduleId, occurrenceId, taskId}}`，立即运行一次，强制只读、不投递、标记为测试，暂停时也可发起；上一次测试未结束返回 409 WORKSPACE_SCHEDULE_TEST_RUNNING。

详细校验入口：[本地事项](../../my-app/server/workspace-local.mjs)、[外部来源](../../my-app/server/workspace-feishu.mjs)、[授权](../../my-app/server/workspace-grants.mjs)、[MCP业务](../../my-app/server/workspace-mcp-business.mjs)、[计划](../../my-app/server/workspace-schedule.mjs)、[提醒](../../my-app/server/workspace-reminders.mjs)。

## 本地事项请求字段

| 请求 | 字段与约束 |
|---|---|
| query | sourceId、type；可选 cursor、limit；type允许Event/Todo/ItemLink |
| get | sourceId、type、id；精确读取仅Event/Todo |
| command/create | requestId、sourceId、type、action=create、data；不允许传id/expectedVersion |
| command/update | requestId、sourceId、type、action=update、id、expectedVersion、data |
| command/delete | requestId、sourceId、type、action=delete、id、expectedVersion、confirmedDelete=true；不传data |
| operation | sourceId、requestId；查询认证用户的原Operation |

Event data 允许title、description、start、end、timezone；创建必须有标题/起止/时区。标题1–500字符，描述至多4000字符；start/end必须是带偏移ISO时间，end晚于start，timezone为IANA时区。当前不支持全天/重复写。

Todo data 允许title、status、due、timezone；创建必须有标题，status为open/completed（默认open），due可为null、YYYY-MM-DD或带偏移ISO时间；默认时区Asia/Shanghai。ItemLink只允许create，关系不支持update/delete；两端引用和版本按[关联服务](../../my-app/server/workspace-links.mjs)校验。

以下仅是请求结构示例（不是已执行操作）；本机所有者对 local 来源有隐式许可：

```json
{"requestId":"client-todo-001","sourceId":"local","type":"Todo","action":"create","data":{"title":"整理周计划","status":"open","timezone":"Asia/Shanghai"}}
```

## 本机 MCP relay
`POST /api/workspace/mcp-dispatch` 不是普通用户业务 API，也不是公网 HTTP MCP。只接受无 Origin、本机来源和本机 Host、受限 client bearer；管理员 API token 不可用。body 仅包含 message/close，session 使用 `x-pidot-mcp-session`。身份由可信 session 绑定，不接受任意 taskId 冒用。见 [MCP契约](mcp.md)。

## Agent 运行时主要端点
主会话使用 Bot 当前全部可用工具，可直接执行写入；task_create 用于长任务。工具、资源及规则无需 Task 配置迁移；模型、提示词等运行配置仍可在安全边界迁移。

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/bots` | GET / POST | 列出/创建 Bot；GET 另返回 `mainSessions: {botId: taskId}`（每个 Bot 一个主会话，PLAN §8.1）。主会话是 `kind:'main'` 的 Task，用 `/api/tasks/:taskId` 读写；不出现在 `/api/tasks` 列表。POST 只需 `{name, requestId}`（PLAN §8.6）：`description` 可选（1–2000 字，不填时按名字套固定模板生成，同名同结果，不调模型；空串仍 400），`profile` 默认 `general`；返回 `{bot, created, mainTaskId, inferred:{role, description, template}}`，`mainTaskId` 是新 Bot 的主会话，同一 requestId 重放返回同一个。新 Bot 默认分配本地 `workspace.list/get/prepare_change/operation_status` 与 `workspace:local`（不含 `prepare_schedule`）；默认新建/修改直接做、删除先问，不存在档位或能力池 |
| `/api/bots/:botId/configuration` | GET / POST | 查询/更新版本化配置；已安装的非管理工具可勾选，资源包含 supportedResources 与当前飞书绑定资源；工具/资源改动对已有 Task 实时生效 |
| `/api/bots/:botId/deactivate` | POST | 停用 Bot，保留历史 |
| `/api/tasks` | GET / POST | 列出/创建持久 Task |
| `/api/tasks/:taskId` | GET | 查询 Task |
| `/api/tasks/:taskId/messages` | POST | 持久输入，返回202接受不表示完成。body `{message, skillId?}`：`skillId` 是输入框“/”菜单选的 Skill，只对这条消息生效（输入开始时以 `user-command` 加载，处理完自动停用）；发送时检查，不可用返回 409 `SKILL_UNAVAILABLE`（群聊、Bot 未分配 Skill 工具、依赖缺失或未登记），格式错误 400；带 Skill 的排队消息不能转为插入（409 `SKILL_COMMAND_NOT_STEERABLE`）。Skill 加载失败不再挡住后续发送 |
| `/api/skills` | GET | 已登记 Skill 目录：自动扫描服务端 `server/skills/<id>/manifest.json`，每次读取，不用重启；格式坏的列为不可用 |
| `/api/tasks/:taskId/skills` | GET / POST / DELETE | GET 返回这个 Task 能用“/”选的 Skill 及是否可用、原因（所有 Task 均按 Bot 当前权限及各类任务的工具范围计算）；POST/DELETE `{skillId}` 手动启用/停用（前端已不用，保留兼容）|
| `/api/tasks/:taskId/state` | PATCH | 更新允许的任务状态 |
| `/api/tasks/:taskId/limits` | PATCH | 明确调整调用限制 |
| `/api/tasks/:taskId/steer` | POST | 安全边界插入，返回202 |
| `/api/tasks/:taskId/cancel` | POST | 取消后续调度；主会话返回 409 `MAIN_SESSION_PERMANENT`（归档同样拒绝），可取消它派出的任务 |
| `/api/tasks/:taskId/stop-work` | POST | 工作控制 |
| `/api/tasks/:taskId/follow-up` | POST | 例行任务运行的“接着聊”（P-15）→ `{data:{taskId, href, status}}`：在该 Bot 主会话派生一个新任务，简报带运行链接和（来源权限仍有效时）运行结果摘录；原运行不变，同一运行重复调用返回原任务。非例行任务运行返回 409 `NOT_ROUTINE_RUN`；也可经 `/api/bots/:botId/tasks/:taskId/follow-up` |
| `/api/tasks/:taskId/archive` | POST | `{archived:boolean}` → `{task}`（含 `archived`）。持久归档标记，仅隐藏，不取消、不删除、不改审批与许可；同样可经 `/api/bots/:botId/tasks/:taskId/archive`、`/api/groups/:groupId/archive`、`/api/groups/:groupId/children/:taskId/archive`（子任务须属该群） |
| `/api/inbox` | GET | 统一“待你确认”：`{data:{items:[{kind, taskId, botId, botName, approvalId\|blockerId\|requestId, summary, createdAt, detail}]}}`；kind 含 `auto-applied`（最近 20 条自动执行记录，`detail.undone`，不计入待确认）；本地提案 `detail.allowAlways=false` 时不提供“总是同意”；Task 审批的 `detail.retryOf` 表示结果未知后的重做审批，同样不提供“总是同意”（服务端也拒绝，阶段 4 起透出给收件箱卡片） |
| `/api/rules`、`/api/rules/remove` | GET / POST | 规则表（ADR-014）：GET 返回有效规则 `{id, botId, match, effect, origin, createdAt}`（过滤旧 preset 与 risk 规则）；POST `/api/rules` `{botId, match:{tool, action?, sourceId?, type?}, effect:allow\|ask\|deny}`，tool 须为已登记写工具，不接受 risk；最具体优先，同级 deny > ask > allow；POST `/api/rules/remove` `{id}` 删除规则，找不到返回 404 POLICY_RULE_NOT_FOUND；写规则时清除旧 preset |
| `/api/findings` | GET / POST | 检测器发现（ADR-013）：GET 返回 `{items, muted, labels, wakeAt, lastRunAt}`；POST `{id, action:handle\|dismiss\|mute}` 或 `{action:'unmute', detector}`；handle 在 Chief 主会话派生预填目标的任务并返回 `{taskId, href}`（重复调用返回同一任务）。收件箱另列 `kind:'finding'`，不计入待确认。阶段 7“帮我想办法”（PLAN §8.7）：GET 另返回 `assist`（默认 false）与 `chiefRead:{available, enabled}`；POST `{action:'assist-setting', enabled, chiefRead?}` 开关（`chiefRead:true` 只能随开启提交：给 Chief 当前配置补入 `workspace.list/get` 与 `workspace:local`，实时生效，无档位或能力池；工作区不可用返回 409 `FINDING_ASSIST_READ_UNAVAILABLE`；关闭不撤 Chief 的查看）；POST `{id, action:'assist'}` 在 Chief 主会话派生只读分析任务（origin user，最多 5 次模型 / 10 次工具，只带只读工具），返回 `{taskId, href}`，发现保持未处理，重复调用返回同一任务；未开启 409 `FINDING_ASSIST_OFF`，已处理/忽略 409 `FINDING_CLOSED`。Chief 主会话与收件箱的发现条目带 `assist`、`assistTaskId`；分析完成卡带 `result`（结论前 500 字） |
| `/api/automation` | GET / POST | 全局暂停（ADR-014）：GET 返回 `{paused, since, by, epoch}`；POST `{paused, confirmed:true}` 暂停或恢复。恢复只经此认证入口；Bot 只能用 `automation_pause` 暂停 |

收件箱 kind 与处理入口：`approval` → `POST /api/tasks/:taskId/approvals/:approvalId/decide`；`blocker`（仅 assignee=user）→ `POST /api/tasks/:taskId/blockers/:blockerId/resolve`；`workspace-proposal` → `POST /api/workspace/agent-confirm-local` `{sourceId, requestId, payloadHash: detail.payloadHash, confirmed:true, cancel?}`。只读投影，复用 Task 视图的可见性过滤；summary 为展示文本，不是确认依据。

此表仅列主要端点，不取代群聊/审批等具体路由校验；完整匹配见 [app.mjs](../../my-app/server/app.mjs)。旧 `/api/feishu/*` 与旧聊天审批保留兼容，不意味着新 UI 确认可以绕过原操作身份、精确参数、版本或 unknown 保护。安装、配置和可执行示例见 [工程README](../../my-app/README.md)。
