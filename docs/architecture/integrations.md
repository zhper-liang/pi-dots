# 外部连接

Pidot 连接的外部服务：模型供应商、飞书日历、Google、第三方 MCP 服务，以及反方向让本机程序调用 Pidot 的 stdio 桥。所有凭据存在数据库同目录的单独文件里（0600，原子替换），不进 SQLite、模型上下文、日志或响应。连接后谁能用见[能力与权限](capabilities.md)，日历和待办数据怎么进工作区见[工作区](workspace.md)。

## 模型供应商

每次模型调用都实时读取连接地址和 Key，不存进 Task；改连接不改机器人版本，也不要求迁移旧 Task（ADR-016）。适配在 `model-reply.mjs`，用 OpenAI 兼容接口。

**默认连接**按优先级取：进程环境 → `my-app/.env` → 项目根 `.env` → 数据库同目录的 `model-settings.json`。环境变量生效时界面只读。配置不完整拒绝启动；`PIDOT_REPLY_MODE=test` 强制测试回复，不调用模型。

**已登记模型**存在 `model-registrations.json`（`model-registry.mjs`）。每条独立保存供应商 ID、URL、Key、模型名和容量，供应商 ID + 模型名组合唯一。选择标识是 `registered:<UUID>:<模型名摘要>`，调用时按标识取对应的 URL 和 Key，发给供应商的是原始模型名，所以不同供应商的同名模型不会串用。

- 改供应商 ID、URL、Key 不改选择标识；改模型名产生新标识，旧选择明确不可用，不会回落到别的连接。
- 没有默认连接时，第一个登记项作为新建机器人的默认。
- Key 保存后只返回 hasKey，不回显；所有登记项的当前 Key 都纳入记忆的凭证过滤。

模型不存在时返回 `MODEL_REJECTED`，不自动换模型，不重试业务副作用。

请求兼容：`thinking` 是 DeepSeek 扩展，只对 DeepSeek 模型名发送；普通 GPT / OpenAI 兼容请求不附带该字段。用户选 low/high 时仍发送标准 `reasoning_effort`。执行回执只记实际发送的字段，未发送的 `thinking` 不伪造为 disabled。2026-11-01 真实接口诊断确认：向 jinpai 的 GPT 请求附带 `thinking: {type: 'disabled'}` 会返回 HTTP 400，去掉后普通回复、low 推理和工具调用均成功。

## 飞书日历

管理入口统一在机器人「能力 → 工具集 → 日程与待办」内嵌的使用范围。飞书连接由所有机器人共享，来源勾选只控制当前机器人的使用范围，连接状态与管理按钮放在同一来源行；复用原来源排除规则，断开前展示受影响机器人。设置和机器人高级旧入口跳转到能力页；日程正文查询和编辑仍在事项日历，连接状态自动读取，不自动绑定或授权。正常界面不提供常驻刷新按钮，后台同步保留内容，失败时自动重试并提供重新读取。

一个显式绑定的飞书应用日历（`feishu-calendar.mjs`、`workspace-feishu.mjs`）。窗口查询和精确读取进同步缓存；普通事件的新建、修改、删除按精确参数和 `decide()` 执行，删除每次确认。邀请、会议室、重复与例外、全天事件的写入会被拒绝。写入前比较版本，结果不明记 `unknown`，不重发。断开或换绑时，所有机器人的旧飞书资源都被撤下。

## Google

混合接入（ADR-020）：

- **Calendar、Tasks 原生适配**：`workspace-google-calendar.mjs`、`workspace-google-tasks.mjs` 注册在 `workspace-providers.mjs` 的适配表里，数据进 Event / Todo，日历视图、同步、提醒、检测器直接复用。新建日程的事件 id 由 requestId 派生，结果不明时按 id 回查；修改和删除带 etag，412 是冲突。
- **Gmail、Drive、Docs、Sheets 经 workspace-mcp**：固定版本 2.2.1，作为一条凭据来源是“取自 Google 连接”的外部 MCP 连接，走 loopback HTTP。Pidot 每次调用把当前访问令牌作为 bearer 传给它；传输层 401 时作废令牌重试一次，工具已经执行后不重试。必须设置 `WORKSPACE_MCP_HOST=127.0.0.1`。

授权是单个 Google 账号、用户自建的桌面应用 OAuth 客户端：PKCE + state，一次性 127.0.0.1 回调，5 分钟时限；浏览器和 Pidot 不在同一台机器时可以粘贴跳转地址。refresh token 只存在 `google/credentials.json`，访问令牌只在内存（`google-*.mjs`）。断开即撤销令牌、删本地凭据、从所有机器人撤下 Google 资源。

测试只连 `fixtures/fake-google.mjs` 和 `fixtures/fake-workspace-mcp.mjs`，请求真实 Google 主机会失败。真实账号的手测步骤见[运行手册](../engineering/operations.md#google-连接与-workspace-mcpr3)。

## 外部 MCP 客户端

Pidot 作为客户端，用官方 `@modelcontextprotocol/sdk` 1.32.2 连接远程 Streamable HTTP 服务或本机已安装的 stdio 程序（`external-mcp*.mjs`）。不支持任意 npx 安装或通用 OAuth。配置和凭据存在 `external-mcp/`。

连接状态分开显示：已登记、缺凭据、已绑定机器人、ready、unknown。工具目录有稳定的 catalog revision，和连接的修改 revision 分开；正常重连不扩权，schema 或来源变化要重新审阅。缓存只存无秘密的元数据，不当作授权依据。每个工具要在机器人能力页的 MCP 栏打开才可用，调用走 `decide()`。

现有的内部工作区 MCP client 不当作通用第三方连接器用。

## 对外 stdio 桥

反方向：本机的外部 MCP 客户端通过 `workspace-mcp-stdio.mjs` 调用 Pidot 的工作区工具。桥是无状态的，不打开数据库，只转发到后端的受限 loopback relay。入站协议基线固定为 `2025-11-25`，不开放公网传输（ADR-009）。

后端保留独立的 stdio 凭证接口，凭证受来源、动作、读取范围、有效期和撤销约束，实际权限不超过对应机器人的当前能力。设置页的凭证面板已经移除（ADR-024）：应用内 Agent 用宿主 Task 身份直接调用，不需要凭证。

## 源码入口

[model-reply.mjs](../../my-app/server/model-reply.mjs) · [model-settings.mjs](../../my-app/server/model-settings.mjs) · [model-registry.mjs](../../my-app/server/model-registry.mjs) · [workspace-feishu.mjs](../../my-app/server/workspace-feishu.mjs) · [google-connection.mjs](../../my-app/server/google-connection.mjs) · [external-mcp.mjs](../../my-app/server/external-mcp.mjs) · [workspace-mcp-stdio.mjs](../../my-app/server/workspace-mcp-stdio.mjs)
