# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

项目处于快速迭代期，模块划分、界面结构和权限模型都可能变。本文只记录相对稳定的约束和入口；文件名、函数名在动手前以当前源码为准，架构变动后同步修正本文失效的条目。代码风格、文档放置和提交规范见 `AGENTS.md` 与 `AGENT.md`，这里不重复。

## 先读什么

- `NEXT_STAGE.md`：已交付状态与授权边界。新阶段、新连接器、新依赖需要用户另行授权。
- 进行中的工作：`plans/active*`，以及本地未入库的 `.planning/<topic>/`、`.scratch/<topic>/`（被 gitignore，记录当前阶段的决策与进度，可能比 `NEXT_STAGE.md` 新）。
- `docs/project-guide.md`：整体架构图和源码阅读顺序。其中部分旧描述已过时，当前权限以 `server/policy.mjs`、ADR-014、ADR-015、ADR-018 与 ADR-021 为准。
- `my-app/README.md`：环境变量、启动方式、API 端点的唯一正文。

## 命令

均在 `my-app/` 下执行。

```sh
pnpm test                                                  # node --test server/*.test.mjs src/*.test.mjs
node --test server/policy.test.mjs                         # 单个文件
node --test --test-name-pattern='<关键词>' server/groups.test.mjs   # 单个用例
node --test src/calendar-layout.test.mjs                   # 也可单独跑前端纯逻辑测试；pnpm test 已包含 src/*.test.mjs
pnpm lint                                                  # oxlint
pnpm build                                                 # tsc -b + vite build；前端唯一的类型检查
```

开发时两个终端分别运行 `pnpm dev:api` 和 `pnpm dev`；Vite 绑定 127.0.0.1，把 `/api` 代理到 `PIDOT_API_PORT`（默认 3001）。

全量测试要从 `my-app/` 运行：迁移类用例的子进程 fixture 使用相对路径，从仓库根目录运行会失败。lint 目前有 13 条既有的 React warning，build 有 chunk 体积提示，都不算新问题。

测试不需要 `.env`：每个用例用临时目录建 SQLite、注入脚本化的 `modelReply`，不调用真实模型。交付前 test、lint、build 都要跑，并照实报告结果。

## 架构要点

一个 Node 进程（`server/index.mjs`）只监听 127.0.0.1，独占一个 SQLite 文件和一个 pi-durable Harness。不要引入第二个数据库、执行引擎或 Task 身份；群聊、委派、例行任务、简报都复用同一个 Harness Task 循环。

- **持久化**：执行状态和业务对象都是 pi-durable Documents（`defineDoc`），在 `store.harness.commit(async tx => ...)` 事务里读写，没有手写 SQL 表。
- **装配根**：`server/tasks.mjs` 的 `openTaskStore()` 组装 Bot、工具、规则、工作区、后台计划与检测器，返回 store；`app.mjs` 的 `createApiServer({ token, tasks })` 做认证、JSON 校验和路由。模型/工具循环在 `tasks.mjs` 的 `chatDefinition()`，单次 provider 调用在 `model-reply.mjs`。
- **工具裁决**：每次工具调用实时检查机器人当前分配、日历/任务列表许可、预算和取消，再由 `policy.mjs` 的 `decide()` 裁决。能力页 Skills / MCP / 工具集开关决定启用；写入直接执行，全局暂停时确认，无人值守遇 ask 跳过并记录。日历与待办合为 `todos`，所有已连接日历和任务列表随该工具集分配，单机器人高级设置可收窄并跨重连保留。新机器人默认 `tool:todos` + `tool:history`，Skill 开启自动附带机制工具。权限以 ADR-014、ADR-018、ADR-021、ADR-022 为准，不新增写入模式、确认环节或 Task 权限快照。
- **工作区**：用户手动 CRUD 走 HTTP → `workspace-service`，不经过模型；Agent 走内部 MCP（规范名 `workspace.*`，模型侧是 `workspace_*` 别名）。两条路径共用同一业务服务，不要在 UI、API、MCP 各写一份规则。
- **副作用**：写操作带 `requestId`，修改带 `expectedVersion`。外部（飞书）结果不明时记为 `unknown`，不能换新 `requestId` 自动重试；恢复复用原 Task 和原 Operation。
- **配置快照**：模型名、提示词等运行配置在创建 Task 时固定；连接地址和 key 每次调用实时读取（ADR-016），旧 Task 不随默认值变化；工具、资源、规则实时生效。
- **Skill**：内置的 `server/skills/<id>/manifest.json` 存在即注册，每次使用时读取；用户导入的 Skill 走 `skill-import.mjs`，存放在数据库同级的 `skills/` 目录，不写进源码目录。开启 Skill 自动附带加载所需的机制工具，不授予其业务依赖；正文里的 `allowed-tools` 只是声明。
- **外部 MCP**：用官方 `@modelcontextprotocol/sdk` 连接远程 Streamable HTTP 或本机已安装的 stdio 程序（`external-mcp*.mjs`），凭据单独存储，不进聊天、日志或工具结果。现有内部 MCP client 不当作通用第三方连接器用。Agent 通过 `capability-management*.mjs` 的管理工具（`mcp_manage`/`skill_manage`，只给 Chief 或宿主明确赋权的配置 Agent）在对话里添加、绑定、停用 MCP 和 Skill，和 UI 走同一服务层。
- **记忆**：每 Bot 的 `PROFILE.md`、`MEMORY.md` 和共享的 `shared/USER.md` 放在数据库同级的 `bot-workspaces/`，是内容真源；`pidot.bot-memory.*` Document 改作台账（版本、来源、防复活、提取水位）。只有 `memory-files.mjs` 的对账读写这些文件，读之前对账，不用 fs.watch。测试 store 默认只用台账，文件模式用 `openTaskStore({ memoryFiles: { enabled: true } })` 开启（ADR-019）。
- **Google**：Calendar、Tasks 是 workspace-service 的原生 provider 适配，进 Event/Todo；Gmail、Drive、Docs、Sheets 经 loopback HTTP 上固定版本的 workspace-mcp，Pidot 登录 Google 一次，每次调用把访问令牌传给它。refresh token 只在数据库同级的 `google/credentials.json`。测试只打 `fixtures/fake-google.mjs` 与 `fixtures/fake-workspace-mcp.mjs`，请求真实 Google 主机即失败（ADR-020、ADR-021）。
- **会话删除**：`session-lifecycle.mjs` 负责持久删除和主会话换新；读取时会过滤已删除的来源，不新增会话库。
- **前端**：React 19 + React Compiler（babel 插件），没有 UI 框架和路由库，使用 hash 路由。纯逻辑放在 `src/*.mjs` 并配手写的 `*.d.mts` 类型声明，这样 `server/*.test.mjs` 能直接 import 测试。外壳 2026-10-31 由 Hermes 直角风格改为圆润风格：大圆角、胶囊按钮、轻阴影、动效、对话气泡，深色跟随系统。颜色、圆角、阴影、动效全是 `shell.css` `:root` 里的 token（深色在同文件的 `prefers-color-scheme` 块），新样式只引用 token，不写死颜色；动效要在 `prefers-reduced-motion` 下停住。机器人形象是同一个电视机器人（`BotAvatar.tsx` + `bot-figure.css`，颜色和配饰存在 localStorage），按运行状态播放动作；颜文字只留在状态胶囊和「正在回复」里。主管 Bot 的 id 仍是 `chief`，显示名 2026-10-31 起叫 pipi；应用图标 `public/favicon.svg` 是平面版 pipi。开关用 `Switch.tsx`，弹窗和时间选择复用 `EditorDialog.tsx`、`LocalTimePicker.tsx`。机器人回复用 `Markdown.tsx`（react-markdown + remark-gfm，原始 HTML 按文本显示）渲染；两段回复之间的工具调用由 `tool-steps.mjs` 折成一行「调用了 N 个工具」，展开看每个工具，再展开看参数和结果。界面不显示内部编号（调用 ID、版本号、requestId、原始 JSON），参数和结果只出现在工具调用的展开里，其他卡片用一句话说结果。

## 测试写法

- 典型用例：`mkdtemp` 建临时目录 → `openTaskStore({ file, bots: listBots(config), modelReply })` → 在 `t.after` 里 `close()` 并删目录。需要 HTTP 时再套 `createApiServer`。
- `server/fixtures/authorized-task-store.mjs` 包装了 `openTaskStore`，为旧的审批/恢复场景预置工具分配和 ask 规则。生产默认是直接写入，新测试按场景选用。
- 崩溃/重启恢复测试会 `spawn` `server/fixtures/*-process.mjs` 子进程，操作同一个临时库。

## 手测与数据安全

- 不要碰 `my-app/data/`（正式库 `pidot.sqlite`，以及同目录的 `bot-workspaces/` 记忆文件、`skills/`、`external-mcp/` 凭据）和 `my-app/.env`（含真实 token 与飞书凭据）。手测时用 `PIDOT_DB_PATH` 指向 /tmp 的临时库、一次性 32–256 位 `PIDOT_API_TOKEN` 和单独端口，结束后清理。
- 模型配置从项目根 `.env` 读取（`OPENAI_BASE_URL`/`base_url`、`OPENAI_API_KEY`、`MODEL`），进程环境和 `my-app/.env` 优先；`PIDOT_REPLY_MODE=test` 强制测试回复。配置不完整会拒绝启动。
- UI 改动要在 1440 和 375 两种宽度手测；没做就说没做，不能把自动测试通过写成已手测。
- 新依赖先问用户。`pnpm-workspace.yaml` 设有发布冷却期策略，只对已批准的 `@earendil-works/*@1.3.0` 例外；`@modelcontextprotocol/sdk@1.32.2` 和 `zod@4.6.7` 是 2026-10-29 单独批准的固定版本。`react-markdown@10.1.0` 和 `remark-gfm@4.0.1` 是 2026-11-01 批准的固定版本。
- 现有约定：面向用户的文案、错误和日志用中文，代码注释用英文；错误响应和日志不输出 provider 配置、文件路径或 SQL 细节。

你可以拒绝，反驳，派遣子agent