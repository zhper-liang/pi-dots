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
- agent-allow-rule 已移除（[ADR-015](../decisions/README.md#adr-015-工具组默认开开即直接做)），请求返回 405 `METHOD_NOT_ALLOWED`。
- agent-confirm-local 可带 `always:true`（只与同意一起）：同一提交把该 Bot 的“待办与事项”组设为开。Task 审批 `.../approvals/:id/decide` 同样支持“以后直接做”，包括 bot_manage，作用是把该工具所在组设为开；暂停中、结果未知后的重做审批仍不能设“总是”，服务端拒绝不允许的请求。工具已分配且启用时，默认 allow 的组内写入（含删除）直接执行；确认规则为 ask 时组内写入先问，暂停时写入 allow 降为 ask；无批量或每小时自动写入上限。
- agent-undo：`{requestId, confirmed:true}`；仅撤销 Agent 自动执行的本地 Event/Todo 改动（新建→软删、修改→恢复原字段、删除→恢复）；对象版本已变返回 409 `WORKSPACE_UNDO_CONFLICT`；非自动或对外写入返回 `WORKSPACE_UNDO_UNAVAILABLE`；以 `undo:<operationId>` 幂等，重复返回同一回执。
- decide() 为 allow 时，本地 Event/Todo prepare_change 在同一事务内应用，Operation 直接 succeeded，receipt.autoApplied 记录 write-default 或匹配规则的裁决理由；外部 prepare_change 也按同一规则裁决，allow 时继续原 prepare/execute 路径，不提供撤销。stdio client 不再额外强制先问，但仍受独立范围约束。workspace.prepare_schedule 仅返回不可执行的计划草案，用户在计划界面确认；主会话 routine_propose 按规则创建例行任务，默认直接创建。
- schedule-manage 和 reminder-manage 的动作/参数由对应服务严格校验；调用方不得通过请求构造任意 shell/HTTP 自动动作。
- 例行任务：schedule-manage 的 rule 支持 `{type:'event', event:'todo_due'|'event_changed'|'task_finished'}`（只用于 agent_readonly_workflow，nextDueAt 为 null；运行前多个事件合并，event_changed 运行期间产生的变化和撤销自动改动不触发自己；全局暂停记为 skipped/automation_paused，恢复不补跑）。actionSpec.writes:true 才开放当前已分配的 workspace.prepare_change/operation_status；创建、修改默认直接执行，本地自动改动留撤销卡；origin=routine/event/detector 遇到 ask（规则要求先问或全局暂停）跳过，并记录“已跳过：这一步需要你来做。”，不出卡等待过期。不带 writes 的旧计划保持只读；派发实时检查 Bot、读工具、来源资源及来源许可，失效取消并记原因，仅配置版本变化不取消。schedule-test：`{requestId, id}` → `{receipt:{scheduleId, occurrenceId, taskId}}`，立即运行一次，强制只读、不投递、标记为测试，暂停时也可发起；上一次测试未结束返回 409 WORKSPACE_SCHEDULE_TEST_RUNNING。

详细校验入口：[本地事项](../../my-app/server/workspace-local.mjs)、[外部来源](../../my-app/server/workspace-feishu.mjs)、[授权](../../my-app/server/workspace-grants.mjs)、[MCP业务](../../my-app/server/workspace-mcp-business.mjs)、[计划](../../my-app/server/workspace-schedule.mjs)、[提醒](../../my-app/server/workspace-reminders.mjs)。

## 周期规则与例行任务

`schedule-manage` 与例行任务提案共用结构化规则，不解析自由文本 cron。新增 `weekly: {type:'weekly', weekdays:[1,3,5], time:'09:00'}`（ISO 周一=1 至周日=7）和 `monthly: {type:'monthly', day:31, time:'09:00'}`。时区单独传 IANA 名称；短月取月末，DST 缺失时刻跳过、重复时刻只运行第一次；暂停恢复不补跑。仍支持 at/daily/interval/event。

例行任务可在 `actionSpec.model:{id}` 固定模型名，并以通知开关控制应用内结果通知；地址/key 每次调用实时读取。测试运行保持只读且不投递通知。旧版回滚约束见 [运行手册](../engineering/operations.md#周月计划的回滚边界t09)。

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

## Bot 人格、记忆与共享偏好

所有端点仍要求本机认证 Bearer token；不授予模型或外部 MCP 修改人格的权限。

| 路由 | 方法 | 数据合同 |
|---|---|---|
| `/api/bots/:botId/memory` | GET | `{data:{personality, memory, preferences, history, historyNextBeforeVersion}}`；共享偏好在 Bot 页只读 |
| `/api/bots/:botId/memory` | POST | `{kind:'personality'|'memory', requestId, expectedVersion, action, id?, content?, sourceEntries?}`；人格 action=set，记忆纠正/删除为 update/delete |
| `/api/settings/preferences` | GET | `{data:document}`，含最近历史及历史分页提示，所有 Bot 共用 |
| `/api/settings/preferences` | POST | `{requestId, expectedVersion, action, id?, content?, sourceEntries?}`；不接受 botId/kind，路由固定共享文档 |

文档含版本、更新时间、来源 `{taskId,entryId}`、状态 ready/pending；人格含 content，记忆/偏好含 items。结果 `{data:{ok,code,version,changed,replayed,document}}`；版本/请求内容冲突返回 409，不自动覆盖。未知保存结果重试必须保留原 requestId；纠正/删除产生新版本，来源和历史可查，凭证不回显。用户编辑界面只添加/修改人格、纠正/删除既有记忆与偏好；新的偏好由有来源私聊的空闲批处理产生。

文件模式（默认开启，见 ADR-019）下，GET 返回的 personality、memory、preferences 文档和编辑成功的 `data.document` 都多一个 `file`：`{path, state, code, syncedAt}`。`path` 相对数据目录，例如 `bot-workspaces/bots/chief/MEMORY.md`；`state` 为 `synced`/`rejected`/`pending`；`code` 为 `null` 或 `MEMORY_FILE_TOO_LONG`/`MEMORY_FILE_INVALID`/`MEMORY_FILE_UNAVAILABLE`/`MEMORY_FILE_WRITE_FAILED`；`syncedAt` 在文件生成前为 `null`。`PIDOT_MEMORY_FILES=0` 时 `file` 为 `null`。修订可能是 `actor: 'file'`（文件手改）；`sourceEntries: []` 的条目是手写条目，界面可以纠正，新增条目仍要求来源。

## Bot 能力启停

`GET /api/bots/:botId/capabilities` 返回 `{data:{botId, revision, items}}`。items 为服务端合并的静态工具组与已登记 Skill 投影，含 `id/kind/name/description/status/revision/enabledForBot/partiallyEnabled/assignedToolNames/available`，不接收客户端目录。生产入口已合并受控 R1-09 外部 MCP 目录；配置未验证或绑定版本失效的工具不可运行。

`POST /api/bots/:botId/capabilities` 接受且仅接受 `{requestId, expectedRevision, capabilityId, enabled, expectedCatalogRevision}`，返回 `{data:{botId, capabilityId, kind, revision, enabledForBot, status, toolNames}}`。`expectedRevision` 来自 Bot capability GET 的 revision，`expectedCatalogRevision` 来自对应 item 的 revision。配置过期返回 `CONFIG_VERSION_CONFLICT`，启用时目录版本不符返回 `CAPABILITY_CATALOG_CONFLICT`；相同 requestId/内容重放原回执，改内容返回 `CONFIG_REQUEST_CONFLICT`。未登记能力返回 `CAPABILITY_NOT_FOUND`；已移除能力的保存绑定仍可撤销，不能重新启用。

启停决定当前分配，写入确认的 allow/ask 独立保存。开启 Skill 只分配该 Skill，不授予其声明的工具或来源；新出现的 Skill 不自动启用。实时 schema、调用与新 prompt 均复核当前启停，已固定内容快照保留审计。

## 外部 MCP 连接

以下入口使用普通 API Bearer 认证，响应统一为 `{data}`。`GET /api/external-mcp` 返回 `{data:{items}}`；公开连接包含 connectionId/name/description/transport/status/revision/enabled/hasCredential/credentialRequired/secretEnvKeys/toolCount/lastCheck，只有字段名，不含 credentialRef、启动参数、环境值或秘密。连接配置及独立凭据文件位于数据库同级受控 external-mcp 目录。

| 路径 | 方法 | 输入与结果 |
|---|---|---|
| `/api/external-mcp/configure` | POST | `{requestId, expectedRevision?, config}`；新建可省略 expectedRevision（兼容字符串 `"0"`），已有连接须当前连接 revision；只保存配置，不隐式检查/分配 |
| `/api/external-mcp/credentials` | POST | `{requestId, connectionId, expectedRevision, credential:{bearerToken}|{env}}`；仅安全设置入口可发送秘密，返回 connectionId/revision/status/saved/replayed，不返回 secret/ref |
| `/api/external-mcp/check`、`reconnect` | POST | `{requestId, connectionId, expectedRevision}`；官方 SDK 握手并有界发现，结果为真实状态、toolCount 和 lastCheck，不调用外部写工具验证 |
| `/api/external-mcp/disable` | POST | 同上；停止连接代次与在途调用，后续 schema/派发失效 |
| `/api/external-mcp/remove` | POST | 同上另加 `confirmGlobal:true`；服务端计算 affectedBotIds，忽略客户端影响名单；影响范围和移除回执以原 requestId 持久重放 |
| `/api/external-mcp/requests/:requestId` | GET | 原连接操作状态 pending/succeeded/failed/unknown 与公开回执；不存在为 404，不重新执行 |

连接 mutation revision 与能力 catalog revision 不同：check/重连不改变已经审阅的工具/来源时不使绑定失效；来源或 schema 改变须重新显式绑定，新增工具不自动分配。生产 store 每次模型/派发使用自己的可信动态投影，执行前再次向服务当前状态核对，持久缓存不是授权权威。外部参数按当前登记 schema 校验；无法支持的 schema 显示缺少校验依赖，不展示为可调用。

当前外部工具保守按写入先问，不信任服务端 readOnlyHint；用户精确批准后，既有 Harness 先保存调用意图/预算，再于 commit 外派发。实时绑定、catalog 版本、policy、预算与取消在末次授权 hook 再复核。未确认结果保存 unknown/retryable:false，既有派发意图和已保存回执不自动重发；连接请求状态账本不代替 Task 的工具执行回执。大于 8 KiB 的完整结果存入原 ToolResults，显式获权的 tool_result_read 可按 mcp 来源和 view=text 分页，读取同样复核当前 alias/目录/来源。

MCP 来源单独记录，不混入工作区来源。撤销后，历史/摘要/产物/协作/记忆继续走共同来源 gate；用户新输入可退役旧无效来源的派生上下文并清旧 compaction，再消费已重新审阅绑定的新结果。旧审计保留，退役内容不从历史或产物引用恢复。连接重启后保持登记，需重新 check 才能展示 ready/schema；不自动安装 npx/uvx 或其他服务。

## Agent 能力配置 Host

管理工具 `mcp_manage`、`skill_manage` 登记在“能力配置”组；只有真实 Chief 或经认证宿主显式分配的配置 Agent 可使用，名字/角色文本不授权。既有 Chief 主会话启用后可取得新工具，无需清空聊天；普通 Bot 原分配不扩张。工具组登记或写入确认开关不自行授予管理能力，实际变更须绑定当前真实用户输入与宿主精确批准，包含目标、动作、来源 fingerprint、scope 和原 native tool turn；模型参数不能提供 approved 标志代替。

`GET /api/capability-setups/:setupId?taskId=<原Task>` 经普通 Bearer 认证返回 `{data:setupReceipt}`，仅查询该 Task 的原操作；`POST /api/capability-setups/:setupId/resume` 仅接受 `{taskId,inputId}`，复核当前真实用户输入并续办原固定 setup，不接受改变来源、目标或授权字段。凭据缺失时原 Task 输入保留等待，凭据只通过独立 MCP 安全入口保存，然后同一操作续办；Task 详情的 capabilitySetups 为安全状态投影。其他 Bot 的全局影响和 Skill 三个机制工具需要另一个精确范围确认，Skill 声明不授予业务依赖。

原步骤请求标识、实际回执与必要状态保存在已有 Harness；网络及导入 FS 在提交线外执行，调用前复核权限/预算。未知步骤只核对原 provider requestId，不盲目重派。Skill 导入器现有 durable requestStatus 对新提交的 import/update/rollback/remove 返回真实 operation/succeeded/result；不存在或旧回执无方法元数据返回 null，不从相同 catalog 内容推测成功。ready 以实际登记、绑定和校验回执为依据，不以保存配置或 needs_auth 代替。

## 用户 Skill 管理

以下端点均要求普通 API Bearer 认证、JSON 与 POST，返回 `{data:result}`；其他方法 405。生产在数据库文件同级受控 `skills` 目录持久化用户 Skill，内置源码目录不被修改。

| 路径 | JSON 输入 | 结果语义 |
|---|---|---|
| `/api/skills/import/prepare` | `{kind:'local', path}` 或 `{kind:'repository', url, ref?, directory?}` | 本机目录/SKILL.md 或公开 GitHub 仓库声明式读取。仓库未指定目录时返回 `needs_directory`、candidates 与固定 commit；已选目录返回 preparedId、hash、manifest、source、status、requirements、files 和 warnings |
| `/api/skills/import` | `{requestId, preparedId, expectedRevision}` | 导入已准备内容；返回目录记录及 catalogRevision、`capabilityId:'skill:<id>'`；不自动绑定 Bot |
| `/api/skills/update` | `{requestId, skillId, preparedId, expectedRevision}` | 写入新的不可变版本，已运行 Task 的内容快照保留 |
| `/api/skills/rollback` | `{requestId, skillId, hash, expectedRevision}` | 切回已保留的版本，不销毁历史审计 |
| `/api/skills/remove` | `{requestId, skillId, expectedRevision, confirmGlobal:true}` | 保存移除标记；影响 Bot 列表由服务端当前 CapabilityAssignments 计算，客户端 `affectedBotIds` 不作为依据 |

管理修改使用 Skill 目录的数值 `expectedRevision`，与 Bot 配置版本不同；结果的 `catalogRevision` 用于下一次修改。首次目录版本为 0；导入、更新、回滚及移除必须保留稳定 requestId，冲突后重新核对当前版本。prepare 是进程内暂存，重启或 15 分钟准备期过后需要重新准备；不会运行安装脚本、git hooks 或 Skill scripts。需要脚本执行器的内容可保存但不可标为完全可用。未装配导入服务的实例返回 503 `SKILL_IMPORT_UNAVAILABLE`。

## 会话删除与主会话换新

`POST /api/tasks/:taskId/delete` 接受且仅接受 `{requestId, confirmed:true}`，返回 `{data:{taskId, botId, action:'delete', deleted:true, deletedAt, replacementTaskId:null, requestId, replayed}}`。活动会话须先获得持久停止标记，再写删除标记；删除后的列表不再展示，读取/发送返回 410 `SESSION_DELETED`。Bot、独立子任务和审计记录保留，归档不是删除。

`GET /api/session-requests/:requestId` 返回 `{data:{taskId, action, state, result?, code?, requestedAt?}}`，state 为 pending/succeeded/failed/unknown；未知 requestId 返回 404 `SESSION_REQUEST_NOT_FOUND`。停止 unknown/failed 返回相应 409，保留原 requestId 核对/重试；相同请求跨会话复用返回 `SESSION_REQUEST_CONFLICT`。删除回执在会话不可见后及重启后仍可重放。

主会话仍不能调用普通 delete（返回 `SESSION_ACTION_CONFLICT`），也不能以 archive 代替。本轮已新增认证 `POST /api/tasks/:taskId/clear-main`，输入同为 `{requestId, confirmed:true}`；成功回执 action 为 `clear-main`，replacementTaskId 为同 Bot 的新主会话 ID，并可通过同一 session-requests 入口核对。App 的三个生命周期 callback 已接入。换新原子替换当前 Bot 的主会话引用，新 Task 使用独立上下文；旧详情返回 410，Bot、独立子 Task 及审计不删除。stop/swap 两个提交之间完成的后台结果持久等待新引用后交接一份，直接协作子任务等待换新后继续；普通取消、root stop、停用及实时撤权仍有效。结果镜像保留原来源并跨连续清空/重启去重；task_status 不返回已删除 child，digest 注入前校验真实来源、删除态和当前权限，不复制旧聊天历史。普通会话删除/置顶清理及换新在重载、同一临时库重启后均已验证。

## Agent 运行时主要端点
主会话使用 Bot 当前已分配且启用的工具，可按写入确认规则执行；`task_create` 用于长任务。legacy 主会话的固有工具保存在独立 `mainAssignments`，不混入普通 Bot 分配；显式撤销优先，新 v2 Bot 不获隐式工具。工具、资源及规则无需 Task 配置迁移；模型、提示词等运行配置仍可在安全边界迁移。

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/bots` | GET / POST | 列出/创建 Bot；GET 另返回 `mainSessions: {botId: taskId}`（每个 Bot 一个主会话，PLAN §8.1）。主会话是 `kind:'main'` 的 Task，用 `/api/tasks/:taskId` 读写；不出现在 `/api/tasks` 列表。POST 只需 `{name, requestId}`：`description` 可选（最多 2000 字，省略/空白保持空白，不按名字推断人格），`profile` 默认 `general`；返回 `{bot, created, mainTaskId, inferred:{role, description, template}}`，新建时 inferred 为 `{role:'', description:'', template:'blank'}`。同一 requestId 重放返回原 Bot/主会话。新 Bot 的 `capabilityDefaultsVersion:2`、tools/resources 均空白，`mock-calendar` 也不隐式授权；旧创建回执及原配置保留 |
| `/api/settings/model` | GET / POST | 认证用户模型连接设置；GET 返回 `{baseUrl, model, hasKey, source:'env'\|'file'\|'none'}`（在 `data` 内），永不返回 key；POST `{requestId, baseUrl, model, apiKey?}`，空白/省略 key 保留已有值，初次必填。环境配置生效时 409 `MODEL_SETTINGS_ENV_LOCKED`；非法设置 400 `INVALID_MODEL_SETTINGS`；同进程 requestId 内容冲突 409 `MODEL_SETTINGS_REQUEST_CONFLICT`。连接实时读取、Task 模型名固定，旧地址/provider 字段不参与匹配 |
| `/api/bots/:botId/configuration` | GET / POST | 查询/更新版本化配置；GET 另返回 `toolGroups`（每组 `{id, label, description, mode:allow\|ask, available, tools:[{name, label, status}]}`，status 为 available / revoked / unassigned / main-only / chief-only）。新 Bot 无默认业务工具或来源，旧 Bot 保留当前分配与撤销；POST 通过 `tools`/资源显式调整，资源包含 supportedResources 与当前飞书绑定资源；工具/资源改动对已有 Task 实时生效 |
| `/api/bots/:botId/tool-groups/:groupId` | POST | 工具组开关（ADR-015）：`{requestId, mode:allow\|ask}`。一个事务内清掉该 Bot 在组内写工具上的全部规则，`ask` 再为每个写工具写一条工具级 ask；不分配工具或资源。返回 `{botId, groupId, mode, tools, before, after}`；同一 requestId 不同内容 409 `GROUP_SWITCH_CONFLICT`，未知组或参数 400 `INVALID_TOOL_GROUP`，未知 Bot 404 |
| `/api/bots/:botId/deactivate` | POST | 停用 Bot，保留历史 |
| `/api/tasks` | GET / POST | 列出/创建持久 Task |
| `/api/tasks/:taskId` | GET | 查询 Task |
| `/api/tasks/:taskId/messages` | POST | 持久输入，返回202接受不表示完成。body `{message, skillId?, model?:{id}}`：`skillId` 是输入框“/”菜单选的 Skill，只对这条消息生效（输入开始时以 `user-command` 加载，处理完自动停用）；主会话可选 model.id 在入队时固定，开始消费才生效，不改在途调用/旧消息/用量；独立 Task 显式传 model 返回 409 MODEL_FIXED，不接受地址或 key。发送时检查，不可用返回 409 `SKILL_UNAVAILABLE`（群聊、Bot 未分配 Skill 工具、依赖缺失或未登记），格式错误 400；带 Skill 的排队消息不能转为插入（409 `SKILL_COMMAND_NOT_STEERABLE`）。Skill 加载失败不再挡住后续发送 |
| `/api/skills` | GET | 返回 `{skills}`：合并只读内置 `server/skills/<id>/manifest.json` 与受控用户导入目录，每次读取无需重启；格式坏的列为不可用，必要 scripts 标记缺少脚本执行支持。全局发现/可加载不等于已分配给某 Bot |
| `/api/tasks/:taskId/skills` | GET / POST / DELETE | GET 返回这个 Task 能用“/”选的 Skill 及是否可用、原因（所有 Task 均按 Bot 当前权限及各类任务的工具范围计算）；POST/DELETE `{skillId}` 手动启用/停用（前端已不用，保留兼容）|
| `/api/tasks/:taskId/state` | PATCH | 更新允许的任务状态 |
| `/api/tasks/:taskId/limits` | PATCH | 明确调整调用限制 |
| `/api/tasks/:taskId/steer` | POST | 安全边界插入，返回202 |
| `/api/tasks/:taskId/cancel` | POST | 取消后续调度；主会话返回 409 `MAIN_SESSION_PERMANENT`（归档同样拒绝），可取消它派出的任务 |
| `/api/tasks/:taskId/stop-work` | POST | 工作控制 |
| `/api/tasks/:taskId/follow-up` | POST | 例行任务运行的“接着聊”（P-15）→ `{data:{taskId, href, status}}`：在该 Bot 主会话派生一个新任务，简报带运行链接和（来源权限仍有效时）运行结果摘录；原运行不变，同一运行重复调用返回原任务。非例行任务运行返回 409 `NOT_ROUTINE_RUN`；也可经 `/api/bots/:botId/tasks/:taskId/follow-up` |
| `/api/tasks/:taskId/archive` | POST | `{archived:boolean}` → `{task}`（含 `archived`）。持久归档标记，仅隐藏，不取消、不删除、不改审批与许可；同样可经 `/api/bots/:botId/tasks/:taskId/archive`、`/api/groups/:groupId/archive`、`/api/groups/:groupId/children/:taskId/archive`（子任务须属该群） |
| `/api/inbox` | GET | 应用内通知投影：`{data:{items:[{kind, taskId, botId, botName, approvalId\|blockerId\|requestId\|entryId, summary, createdAt, detail}]}}`；kind 为 `approval`、`blocker`、`workspace-proposal`、`skipped`、`finding`、`auto-applied`。`skipped` 来自原无人值守 Task 的可见工具收据（`entryId`、原因），复核来源历史权限，仅提供原 Task 链接，不生成可审批/重试动作；前端按需要处理/事项提醒分区。kind 含 `auto-applied`（最近 20 条自动执行记录，`detail.undone`，不计入待确认）；本地提案 `detail.allowAlways=false` 时不提供“总是同意”；Task 审批的 `detail.retryOf` 表示结果未知后的重做审批，同样不提供“总是同意”（服务端也拒绝，阶段 4 起透出给收件箱卡片） |
| `/api/rules` | GET | 规则诊断（ADR-014、ADR-015）：返回有效规则 `{id, botId, match, effect, origin, createdAt}`（过滤旧 preset 与 risk 规则）。规则只由工具组开关、“以后直接做”和一次性迁移写入；`POST /api/rules` 与 `/api/rules/remove` 已移除，返回 405 |
| `/api/findings` | GET / POST | 检测器发现（ADR-013）：GET 返回 `{items, muted, labels, wakeAt, lastRunAt}`；POST `{id, action:handle\|dismiss\|mute}` 或 `{action:'unmute', detector}`；handle 在 Chief 主会话派生预填目标的任务并返回 `{taskId, href}`（重复调用返回同一任务）。收件箱另列 `kind:'finding'`，不计入待确认。阶段 7“帮我想办法”（PLAN §8.7）：GET 另返回 `assist`（默认 false）与 `chiefRead:{available, enabled}`；POST `{action:'assist-setting', enabled, chiefRead?}` 开关（`chiefRead:true` 只能随开启提交：给 Chief 当前配置补入 `workspace.list/get` 与 `workspace:local`，实时生效，无档位或能力池；工作区不可用返回 409 `FINDING_ASSIST_READ_UNAVAILABLE`；关闭不撤 Chief 的查看）；POST `{id, action:'assist'}` 在 Chief 主会话派生只读分析任务（origin user，最多 5 次模型 / 10 次工具，只带只读工具），返回 `{taskId, href}`，发现保持未处理，重复调用返回同一任务；未开启 409 `FINDING_ASSIST_OFF`，已处理/忽略 409 `FINDING_CLOSED`。Chief 主会话与收件箱的发现条目带 `assist`、`assistTaskId`；分析完成卡带 `result`（结论前 500 字） |
| `/api/automation` | GET / POST | 全局暂停（ADR-014）：GET 返回 `{paused, since, by, epoch}`；POST `{paused, confirmed:true}` 暂停或恢复。恢复只经此认证入口；Bot 只能用 `automation_pause` 暂停 |

收件箱 kind 与处理入口：`approval` → `POST /api/tasks/:taskId/approvals/:approvalId/decide`；`blocker`（仅 assignee=user）→ `POST /api/tasks/:taskId/blockers/:blockerId/resolve`；`workspace-proposal` → `POST /api/workspace/agent-confirm-local` `{sourceId, requestId, payloadHash: detail.payloadHash, confirmed:true, cancel?}`。只读投影，复用 Task 视图的可见性过滤；summary 为展示文本，不是确认依据。

此表仅列主要端点，不取代群聊/审批等具体路由校验；完整匹配见 [app.mjs](../../my-app/server/app.mjs)。旧 `/api/feishu/*` 与旧聊天审批保留兼容，不意味着新 UI 确认可以绕过原操作身份、精确参数、版本或 unknown 保护。安装、配置和可执行示例见 [工程README](../../my-app/README.md)。
