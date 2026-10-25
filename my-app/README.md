# Pidot 本地原型

> 工程命令与环境说明的唯一正文。阶段状态与交接见 [NEXT_STAGE.md](../NEXT_STAGE.md)；历次按票实现记录见 [已完成计划](../plans/README.md)。

## 前置要求

- Node.js **22.22.1 或更高**（使用 Node 内置 HTTP、测试与 `--env-file` 支持）。
- pnpm **11.21.0**；使用已提交的 lockfile 与项目依赖策略。
- 用户已确认引入 `@earendil-works/pi-durable`、`@earendil-works/chord`、`@earendil-works/pi-ai`，均精确锁定 `1.3.0`，MIT。SQLite 使用 Node 内置 `node:sqlite`，Node 22 的实验性警告为预期。
- 以下命令均在 `my-app` 目录执行。

## 安装与首次配置

```sh
pnpm install --frozen-lockfile
cp .env.example .env  # 仅首次；已有 .env 时不要覆盖
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将生成的随机值填入 `my-app/.env` 的 `PIDOT_API_TOKEN=`。不要提交或分享该文件；示例文件不含实际凭证。

## 配置项

| 配置 | 说明 |
| --- | --- |
| `PIDOT_API_TOKEN` | 必填，32–256 位无空白 ASCII 字符。服务端配置；网页手动输入后仅保存在当前标签页 sessionStorage，断开即清除；不能加 `VITE_` 前缀。 |
| `PIDOT_API_PORT` | 可选，默认 `3001`，范围 `1–65535`。 |
| `PIDOT_DB_PATH` | 可选 SQLite 文件路径；默认 `my-app/data/pidot.sqlite`，不随启动 cwd 改变。相对自定义路径按 cwd 解析。 |
| `PIDOT_REPLY_MODE` | 可选 `model` / `test`。有完整模型配置时为新 Task 启用真实模型；完全无配置时为测试。`model` 强制要求配置完整；`test` 不读取根模型文件，适用于离线测试。旧 Task 始终使用自己的模式。 |
| `OPENAI_BASE_URL` / `base_url` | 服务端模型地址，前者优先。当前确认 `https://www.bb-api.com/v1`。不接受带用户名、密码、查询串或片段的地址；远程必须 HTTPS，本地测试可用 loopback HTTP。 |
| `MODEL` | 服务端新 Task 默认模型，当前确认 `deepseek-v4.1-flash`；改变默认值不会修改旧 Task。 |
| `OPENAI_API_KEY` | 仅服务端调用使用，不进入网页、Document、conversation 或请求 messages。不可用作本地访问 token。 |
| `PIDOT_DEFAULT_MODEL_CALLS` / `PIDOT_DEFAULT_TOOL_CALLS` | 每 Task 默认调用上限，默认 `20` / `10`；仅作用于新 Task。 |
| `PIDOT_DEFAULT_TOTAL_TOKENS` | 可选 Token 阈值，非负安全整数；仅作用于新 Task。 |
| `PIDOT_MAX_OUTPUT_TOKENS` | 单次输出上限，默认 `4096`，范围 `1–32768`；创建时可经 `parameters.maxOutputTokens` 覆盖。 |

本地 API 配置由启动命令读取 `my-app/.env`，已有进程环境变量优先。模型配置由服务端读取项目根 `../.env`；显式进程变量或 `my-app/.env` 同名/别名变量优先于根文件。根文件沿用 `base_url`、`OPENAI_API_KEY`、`MODEL`，权限 `0600`。不要给模型凭证加 `VITE_` 前缀。完全无模型配置才允许默认测试；部分或无效配置启动失败，不伪装成测试成功。

## 启动与停止

```sh
pnpm build
pnpm start:api
# 浏览器访问 http://127.0.0.1:3001；端口按实际配置调整
```

服务固定绑定 `127.0.0.1`，不接受公网绑定。终端显示本地 API 地址；按 **Ctrl+C** 停止，或向进程发送 `SIGTERM`。停止时关闭连接，最迟约 1 秒强制关闭剩余请求。端口占用或配置错误时以非零码退出并给出说明，不输出 token。

## 开发模式

分别运行 `pnpm dev:api` 与 `pnpm dev`。Vite 仅绑定 `127.0.0.1`，`/api` 同源代理到本地 API，端口读取 `.env` 或进程环境中的 `PIDOT_API_PORT`。生产预览由 API 直接提供 `dist` 静态文件；仅 HTML/打包资源公开，所有业务 API 都要求认证，不启用 CORS、不向前端包注入 token 或模型密钥。本原型不作为公网部署服务。

## 依赖策略

不运行 `@google/genai` 与 `protobufjs` 的安装脚本；发布冷却例外仅限用户批准的 earendil `1.3.0` 包版本，详见 `pnpm-workspace.yaml`。模型调用使用已安装的 pi-ai OpenAI 适配器，无额外依赖。

## 网页使用

1. 输入 `my-app/.env` 中的 `PIDOT_API_TOKEN` 连接本地服务；错误 token 退回连接页。
2. 选择 Chief、日程助理或待办助理，可选填会话名称，点击“开始会话”。
3. 左侧列出已保存会话；详情显示 Harness Task ID、独立 Conversation ID、配置版本与固定参数来源。
4. 刷新保留选中 Task；列表可重开，浏览器前进/后退可切换；关闭标签页后重新输入 token 仍可打开本地会话。
5. 正常停止/重启 API 后数据仍在；“断开连接”只清除标签页 token，不删除本地会话。

发送框展示历史、执行中、分类失败与实际请求参数。`/api/chat` 是不持久化的测试接口，不代表真实模型流程。

## API

### 认证与错误

除特别说明外，所有端点要求 `Authorization: Bearer <PIDOT_API_TOKEN>`，JSON 响应禁止缓存。错误统一为 `{"error":{"code":"...","message":"可理解的说明"}}`，不带成功回复。

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `INVALID_JSON` / `INVALID_MESSAGE` / `INVALID_REQUEST` / `INVALID_TASK` | 无效 JSON、字段或内容不符、请求读取失败、任务结构无效 |
| 401 | `UNAUTHORIZED` | token 缺失或不匹配（查询参数不作为认证） |
| 404 | `NOT_FOUND` / `TASK_NOT_FOUND` / `BOT_NOT_FOUND` | 路由、Task 或 Bot 不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不允许 |
| 409 | `TASK_BUSY` / `SKILL_NOT_READY` / `TASK_LIMITED` / `LIMITS_STILL_BLOCKED` | 忙碌、Skill 未就绪、受限等待、阻塞未解除 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 16 KiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 未使用 JSON |
| 500 | `INTERNAL_ERROR` | 服务异常；不泄露内部异常、token 或伪造成功 |

### 端点

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/chat` | 不持久化测试接口，只接受 `{"message":"..."}`（非空、≤4000 个 UTF-16 单元）。 |
| `GET /api/bots` | 预置 Bot 身份、说明、配置引用及默认值。 |
| `POST /api/tasks` | 创建会话；`botId` 必填，`title` 1–100 字符，`taskState` 与 `parameters` 选填。返回 `201`。 |
| `GET /api/tasks` | 所有会话按原生 Task id 新到旧排列。 |
| `GET /api/tasks/:taskId` | 含有序 `messages`、`activeInputId`、原生状态、`toolSets`、`callUsage`、`effectiveCallLimits`。 |
| `PATCH /api/tasks/:taskId/state` | 部分更新 `goal` / `completionCriteria` / `constraints`；忙碌返回 `409`。 |
| `POST /api/tasks/:taskId/messages` | 发送消息，返回 `202` 与 `status`（`accepted` 立即执行 / `queued` 持久化排队）及 `queuePosition`。 |
| `PATCH /api/tasks/:taskId/limits` | 只提高现有上限，如 `{"modelCalls":30,"toolCalls":20}`；执行中 `409`。 |
| `GET /api/tools` | 工具参数与结果 schema。 |
| `GET /api/bots/:id/tool-access` | 预置工具及撤权状态。 |
| `PATCH /api/bots/:id/tool-access` | 全量撤销/恢复，如 `{"revoked":[...]}`；不能新增白名单外工具。 |
| `DELETE /api/bots/:id/tool-access/:tool` | 原子撤销单项，不覆盖其他撤权。 |
| `GET /api/skills` | 本地 Skill 目录及可加载状态。 |
| `POST /api/tasks/:id/skills` | 仅接受 `{"skillId":"calendar-conflict-analysis"}`；200 表示已处理，不代表加载必然成功。 |

### 请求示例

```json
{
  "botId": "chief",
  "title": "周五安排",
  "taskState": {
    "goal": "梳理周五会议时间",
    "completionCriteria": ["给出两个候选时间"],
    "constraints": ["只用北京时间", "不操作外部日历"]
  },
  "parameters": {
    "thinkingLevel": "off",
    "requestTimeoutMs": 60000,
    "callLimits": { "modelCalls": 10, "toolCalls": 0 }
  }
}
```

`parameters` 仅支持 `model.id`、`thinkingLevel`、`requestTimeoutMs`、`callLimits`、`maxOutputTokens`；服务端接口、provider、API、mode、Bot 身份、配置引用与工具白名单不可覆盖。

## 可复现验收

先启动服务，另开终端在 `my-app` 执行。token 只从本地文件读取，不写进命令或记录；不要启用 `set -x`。

```sh
export PIDOT_API_TOKEN="$(node --env-file=.env -p 'process.env.PIDOT_API_TOKEN')"
export PIDOT_API_PORT="$(node --env-file=.env -p 'process.env.PIDOT_API_PORT || "3001"')"

# 1. 正常请求 → 200，含 mode:test 与非模型输出标记
curl -sS -i "http://127.0.0.1:$PIDOT_API_PORT/api/chat" \
  -H "Authorization: Bearer $PIDOT_API_TOKEN" \
  -H 'Content-Type: application/json' --data '{"message":"你好，Pidot"}'

# 2. 未认证 → 401 UNAUTHORIZED，无 reply
curl -sS -i "http://127.0.0.1:$PIDOT_API_PORT/api/chat" \
  -H 'Content-Type: application/json' --data '{"message":"你好，Pidot"}'

# 3. 无效消息 → 400 INVALID_MESSAGE，无 reply
curl -sS -i "http://127.0.0.1:$PIDOT_API_PORT/api/chat" \
  -H "Authorization: Bearer $PIDOT_API_TOKEN" \
  -H 'Content-Type: application/json' --data '{"message":"   "}'

unset PIDOT_API_TOKEN PIDOT_API_PORT
```

自动验证不需要 `.env`（使用临时测试 token、随机端口与模拟供应商）：

```sh
pnpm test
pnpm lint
pnpm build
```

测试 CLI 显式隔离真实模型配置，不调用用户供应商；服务异常通过可注入 reply 函数验证，不提供对外故障注入接口。

## 已知边界

- 单进程单数据库：一个数据库只由一个 API 实例打开，不支持多进程共享写入。数据库与 WAL/SHM 位于被忽略的 `data/`，主文件权限 `0600`，不存模型凭证。
- 仅绑定 `127.0.0.1`，不启用 CORS，不向前端注入 token 或模型密钥，不作为公网服务。
- SQLite 使用 WAL / synchronous NORMAL，不承诺断电零丢失。
- 保留旧模拟日历验收工具；V2另有真实飞书应用日历与本地待办/日程。未接入邮件或外部待办；飞书不承诺原子CAS或真实外部 exactly-once。
- 供应商输出不具确定性；未知价格、上下文容量与输出上限不猜测，也不计算美元费用。

## 统一工作区存储与本地事项

同一 SQLite/Harness 初始化 `pidot.workspace.*` schemaVersion 1 Documents，不自动给用户/Bot新来源权限。`GET /api/workspace/status` 查看诊断；用户本地许可与Bot来源许可独立。

- 业务请求、字段和版本/幂等规则见 [HTTP契约](../docs/interfaces/http-api.md) 与 [工作区架构](../docs/architecture/unified-workspace-v2.md)，能力矩阵见 [MVP范围](../docs/product/mvp-scope.md)。
- 修改/删除使用 expectedVersion；断线按原 requestId 查询，不创建重复副作用。待办与本地/外部事件只显式关联，不级联删除。
- `PIDOT_WORKSPACE_ENABLED=0` 禁用新入口/初始化但保留数据和审计。仅空白业务v0标记可显式 `PIDOT_WORKSPACE_MIGRATION=v0-to-v1` 升级；未知/非空旧版本拒绝启动，须单独评审。不对正式库做迁移演练。
- 同库只允许一个后端；无第二数据库。故障与回滚见 [运行手册](../docs/engineering/operations.md)。

### V2 本机MCP工作区（固定兼容2025-11-25）
- `workspace.list/get/prepare_change/prepare_schedule/operation_status`为真实JSON-RPC MCP工具。内部Bot经宿主client/session握手调用；非workspace旧工具不重写。模型provider只接收明确映射的`workspace_*`别名，宿主恢复成规范MCP名字；不是额外执行工具。
- 先在原能力池与Bot配置显式分配workspace工具及`workspace:local`（或已绑定飞书对应`workspace:<sourceId>`），在Agent工作区面板独立授予Bot来源范围，并新建Task。旧Task不自动升级；配置迁移须用户查看差异明确确认。用户来源许可仍是上限。
- stdio：面板发行10分钟受限client凭证，放入本地进程环境`PIDOT_MCP_TOKEN`；`PIDOT_MCP_URL=http://127.0.0.1:3001`指向运行中的同一后端。独立MCP client配置命令`node`、参数`server/workspace-mcp-stdio.mjs`（cwd为my-app）。不要把API管理员token、凭证写进模型、命令参数或版本库。
- 桥只转发本机私有`/api/workspace/mcp-dispatch`，不打开SQLite、不加载.env、stdout仅逐行JSON-RPC；拒绝Origin、远程目标、任意路径、凭证URL及重定向。该relay不是公网HTTP MCP transport，远程MCP不支持。
- Agent与client只准备精确Operation；本地/外部修改均须面板批准。确认5分钟绑定参数/原主体/版本/权限，拒绝保留cancelled；unknown禁止盲重发。断线后用原requestId查状态，桥关闭不取消已持久操作。
- client凭证同库只存SHA256摘要，最多100个保留记录；会话内最多4096请求、同一ID拒绝重放。过期/撤销不可复活；用户可用已知clientId调用认证`client-revoke`，不删审计。MCP消息16KiB，来源分页保持业务覆盖信息，busy-only无标题正文。

## V2 统一工作区

八页导航将事项、计划、执行记录、通知与权限分开；切页保留草稿和未确认原请求，Task链接仍进入原会话。来源状态统一显示authority与用户权限，飞书窗口保留新鲜度/完整性。

[完整支持矩阵、在线条件、运行与回滚说明](../docs/engineering/operations.md)。不将缓存、候选、recorded/read或关闭浏览器等同于外部写回/系统送达/停机执行。

## 文档与历史

[正式文档](../docs/README.md) 为当前规范；[计划](../plans/README.md) 保存已完成计划的正文与验收结论。
