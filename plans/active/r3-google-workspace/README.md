# 第三轮计划：Google Workspace 账号授权与业务适配

> **2026-10-30 实现完成，待用户验收。** R3-01 至 R3-07 与 R3-06 集成完成：test 1531/1531，lint exit 0（11 条既有 warning），build exit 0；1440/375 浏览器检查无溢出、无秘密泄漏。决策记为 ADR-020、ADR-021。真实 Google 账号与真实 workspace-mcp 登录未验，手测步骤见[运行手册](../../../docs/engineering/operations.md#google-连接与-workspace-mcpr3)。

> 状态：**2026-10-30 用户授权开工**（“开”），D1–D13 已答复（§9）。按票派子 agent 实施，主管协调与验收，子 agent 返回后先停下向用户汇报。固定版本 workspace-mcp 的安装已批准（D11）。不连接任何真实 Google 账号。来源：[INT-01](../../backlog/2026-10-29-workspace-experience.md#int-01--p3--未来--google-workspace-mcp-接入调研) 与该文 §5 的三轮顺序。票据格式沿用[第一轮分票](../../done/2026-10-30-workspace-experience-r1/PLAN.md)。
>
> 权限按 ADR-015：工具组开 = 组内写入直接执行（含删除）。本文不新增确认关卡（D4 已选直接做）。

## 0. 结论

2026-10-30 用户选定**混合路线**：
- **Calendar、Tasks 原生适配**：服务端用 Node 自带 `fetch` 和 `node:crypto` 直接调用 Google REST API，像飞书一样接进现有 `workspace-service`。Calendar 进 Event 文档，Tasks 进 Todo 文档，日历视图、同步、提醒、检测器直接复用；写入结果不明时按确定性 id 或 etag 核实。不需要新 npm 依赖。
- **Gmail、Drive、Docs、Sheets 经 workspace-mcp**（taylorwilsdon/google_workspace_mcp，即 workspacemcp.com），通过第一轮的外部 MCP 接入。Google 登录由 Pidot 统一做一次，把访问令牌传给 workspace-mcp（D13）；workspace-mcp 在 127.0.0.1 常驻运行。Pidot 只做配置模板、令牌转交、对话接入和验收，不写这几项的适配代码。ADR-018 后已启用的外部 MCP 工具直接执行，没有逐次确认。

代价：要装固定版本的 workspace-mcp 并让它常驻运行（已批准，D11；本机已有 uv）；workspace-mcp 的写入结果不明时 Pidot 只能记为 unknown、不自动重试，是否重复发信要用户自己核对。统一授权要在开工第一步按固定版本核实；不成立时退回 workspace-mcp 自己登录，即授权两次（§4.5）。

整套设计要能原样迁到服务器：任何一步都不假设浏览器和 Pidot 在同一台机器（§4.5，D12）。Pidot 自身的服务器部署现在不做。

## 1. 范围

- **原生做**：单个 Google 账号的连接、刷新、断开；Calendar 与 Tasks 和现有日历、事项的映射；全部用假服务自动验收。
- **经 workspace-mcp 做**：Gmail、Drive、Docs、Sheets。用它的 `--tools` 只开这四项，不开它的 Calendar、Tasks 工具，避免两条路径写同一份数据。Slides、Forms、Chat、Contacts 等是否加开，开工时由用户决定（§9 D10）。
- **不做**：多账号；服务账号与域委派；内置共享 OAuth 客户端；系统钥匙串；推送通知（Calendar/Drive watch 需要公网 HTTPS 回调）；为 Gmail、Drive、Docs、Sheets 写 Pidot 原生适配；托管版 workspace-mcp（令牌会放在第三方）。
- **前提**：第一轮、第二轮已于 2026-10-30 验收。单 Node 进程、单 SQLite、单 Harness 不变。迁到服务器时行为不变（§4.5）。

## 2. 现状：能复用什么

| 现有能力 | 位置 | 本轮用法 |
|---|---|---|
| 外部来源适配 | `workspace-feishu.mjs` 经 `createWorkspaceService({ external })` 挂入 | 照同样形状写 Google 适配；把 `external` 从“只有飞书”改成按 provider 的表，飞书行为不变 |
| 业务对象 | `workspace-schema.mjs`：Connection、Source、Event（已有 remoteId、remoteVersion、authority、readOnly、providerEvent） | Event 直接用；Todo 需补几个可选外部字段（见 §5） |
| 窗口重扫同步 | `workspace-sync.mjs` | Google 日历、任务列表复用，不另建调度 |
| 日历界面 | `CalendarBoard.tsx` 已按 `external-sources` / `external-query` 通用读取外部来源 | 预计只需小改显示来源名 |
| 凭据文件写法 | `external-mcp.mjs`、`model-settings.mjs`：0700 目录、0600 临时文件原子替换、O_NOFOLLOW | 原样照搬到 Google 凭据文件 |
| 秘密兜底 | `external-mcp.mjs` 的已知秘密替换（redact） | 工具结果、错误出口再扫一遍 |
| 外部 MCP | `external-mcp*.mjs`、`capability-management*.mjs`（第一轮） | workspace-mcp 经 loopback HTTP 接入（退回方案用 stdio）；Chief 在对话里添加、分配、停用 |
| 凭据表单 | `McpCredentialForm.tsx`：密码字段只活在表单和请求里 | Google 客户端 ID/密钥表单复用写法 |
| 工具组与裁决 | `tool-groups.mjs`、`policy.mjs` 的 `decide()` | 新工具登记读/写；读 allow，写按组开关 |
| 断开撤资源 | 飞书断开/换绑会从所有 Bot 移除旧资源（ADR-014 第 1 条） | Google 断开、令牌失效同样处理 |

## 3. 路线对比

### 3.1 workspace-mcp 现状（2026-10-30 核对）

workspacemcp.com 即 taylorwilsdon/google_workspace_mcp，MIT 开源，不隶属 Google。当前 v2.2.1（2026-10-26），覆盖 Gmail、Drive、Docs、Sheets、Slides、Forms、Calendar、Chat、Tasks、Contacts、Apps Script、Custom Search 共 12 项。可以按服务加载（`--tools`）、按三档层级裁剪工具（`--tool-tier` core/extended/complete）、只读模式（只申请 readonly scope、不注册写工具）。自己运行需要 Python 和 uv；另有付费托管版，令牌放在维护方。单用户本机运行时由它自己完成 Google 登录并在本地保存令牌。

Google 官方远程 MCP（开发者预览）仍没有 Tasks，官方配置页 Calendar 只列只读 scope，且需要 Pidot 另写 MCP OAuth，这次不考虑。

### 3.2 三条路线

| 维度 | 全部原生 | 全部 workspace-mcp | **混合（已选）** |
|---|---|---|---|
| 工作量 | 最大：五个适配 | 最小：配置与验收 | 中：两个适配加配置 |
| 日历视图、提醒、检测器 | 都能用 | Google 日程和任务进不来，与 D7、D8 冲突 | 都能用 |
| 结果不明 | 每个写工具可核实 | 只能记 unknown，不自动重试 | 日历和任务可核实；邮件、文件只能记 unknown |
| 新运行时 | 无 | uv 与 workspace-mcp | uv 与 workspace-mcp |
| 授权 | 一次 | 一次（在 workspace-mcp） | 一次（Pidot 统一授权，D13）；核实不成立时两次 |
| 覆盖 | 五项 | 12 项 | 原生两项，加 MCP 四项起，可加开 |
| 维护 | API 变化自己跟 | 上游维护 | 日历和任务自己跟，其余上游维护 |

混合路线保住了用户要的日历显示（D7 全部日历、D8 任务按截止日显示）和日程写入的可核实，同时让邮件、文件、表格基本不写代码。

## 4. OAuth 与令牌存放

### 4.1 客户端

- 用户在自己的 Google Cloud 项目里建 **桌面应用（Desktop app）** 类型 OAuth 客户端，启用所需 API（Calendar、Tasks，以及 workspace-mcp 用到的 Gmail、Drive、Docs、Sheets）。统一授权时 workspace-mcp 不需要客户端密钥，只使用 Pidot 传来的访问令牌；退回方案时它用同一个客户端，Pidot 把 ID 和密钥经第一轮外部 MCP 的凭据存储传给它。用户都只填一次。Pidot 不内置共享客户端：Gmail、Drive 的只读 scope 属“受限”，共享发布的客户端要过 Google 安全评估；个人自建客户端只给自己用，不需要验证。
- 客户端 ID 和密钥按 ADR-016 的顺序读取：进程环境、`my-app/.env`、根 `.env`（变量名如 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`），再到设置页保存的凭据文件。桌面客户端被 Google 视为公开客户端，密钥不算真正保密，但仍只留在服务端。
- **发布状态**：外部（External）应用停在“测试”时，授权和 refresh token 7 天过期，测试用户上限 100。推荐改为“正式发布（未验证）”：登录时多一次“未经验证的应用”提示，100 个用户终身上限对个人使用无影响，令牌不再按周过期。Workspace 账号可选“内部”。这是用户在 Google 控制台的一次设置；用户已选正式发布（未验证），见 §9 D2。

### 4.2 连接流程

1. 用户在设置页点“连接 Google”，勾选 Calendar、Tasks 和经 workspace-mcp 的 Gmail、Drive、Docs、Sheets（统一授权时一并申请这些 scope）；或对 Chief 说“连接我的 Google”，Chief 只回一张“去设置页连接”的卡片，不经手任何凭据。
2. 服务端生成 `state`（随机 32 字节）和 PKCE `code_verifier`（43–128 字符），`code_challenge = BASE64URL(SHA256(verifier))`，方法 S256。
3. 服务端在 `127.0.0.1` 随机端口起**一次性回调监听**，5 分钟超时，只接受一次带正确 `state` 的 GET，然后关闭。不用主 API 端口：主 API 要求 bearer token，浏览器跳转带不上，也不该为它开免认证路由。
4. 前端打开 `accounts.google.com/o/oauth2/v2/auth`，参数含 `client_id`、`redirect_uri=http://127.0.0.1:<port>`、`response_type=code`、所选 scope、`openid email`、`access_type=offline`、首次及补授权时 `prompt=consent`、`include_granted_scopes=true`、`state`、`code_challenge`。
5. 回调拿到 `code` 后，服务端向 `oauth2.googleapis.com/token` 换令牌，带 `code_verifier`。回调页只显示“已连接，可关闭此页”，不回显任何参数。浏览器和 Pidot 不在同一台机器（例如 Pidot 在服务器上）时，浏览器跳回 `127.0.0.1` 会打不开；设置页始终提供“粘贴跳转地址”，用户把地址栏里的完整地址粘回来，服务端校验 `state`、一次性和 5 分钟时限后走同一个换令牌步骤。粘贴内容按秘密处理，不进日志。Google 的设备码流程不支持 Calendar、Tasks、Gmail 等 scope，不能代替。
6. 读响应里的 `scope` 字段确认实际授予的范围；用户可能只勾了一部分，**按实际 scope 开启对应服务**，不足的服务显示“未授权”。
7. 从 `id_token` 取 `sub` 和 `email` 作账号身份（直接来自 token 端点的 HTTPS 响应，不另做签名校验）；`accountKey = sha256(sub)`。

### 4.3 令牌放哪里

| 内容 | 位置 | 说明 |
|---|---|---|
| refresh token、已授予 scope、sub、email、client 来源标记 | `<数据库目录>/google/credentials.json`，目录 0700、文件 0600、原子替换、O_NOFOLLOW | 与 `external-mcp/credentials.json`、`model-settings.json` 同写法；不进 SQLite |
| 设置页保存的 client ID/密钥 | 同一文件 | 环境变量生效时界面只读，同 ADR-016 |
| access token | 只在进程内存 | 过期前 60 秒刷新；按账号串行，避免并发刷新拿到两个令牌 |
| workspace-mcp 的令牌 | 统一授权时它不存 refresh token，只收到 Pidot 每次调用带的短期访问令牌；退回方案时它自己保存在 `<数据库目录>/google/workspace-mcp/`（0700，目录变量名开工时核对） | 退回方案下 Pidot 不读不写这些文件，断开时删除整个目录 |
| Connection 文档 | SQLite（Harness Document） | 只存 provider、accountKey、credentialRef、authEpoch、status、已授予服务；无任何令牌 |

令牌**不得出现在**：聊天、模型上下文、Bot 记忆、工具结果、Task 历史、HTTP 响应、日志、错误信息、截图、测试断言、文档。API 只返回 `connected`、`email`、`services`、`status`。工具结果和错误出口沿用 `external-mcp` 的已知秘密替换做兜底。

### 4.4 失效、断开与限制

- 刷新得到 `invalid_grant`（用户在 Google 撤权、测试期 7 天到期、改密码等）：Connection 置 `needs_auth`，authEpoch +1，从所有 Bot 撤掉 Google 资源，界面显示“重新连接”。在途调用返回明确错误，不自动重试写入。
- 断开：先调 `oauth2.googleapis.com/revoke`，无论成功与否都删本地凭据、撤资源；撤销失败时提示用户到 Google 账号页手动移除。统一授权时撤销即同时切断 workspace-mcp；退回方案下另外停用 workspace-mcp 连接并删除它的令牌目录。
- Google 对每个客户端/用户组合的 refresh token 数量有上限，超出后旧令牌失效。重连同一账号要覆盖旧令牌，不要反复申请；第一版只支持一个账号。
- Workspace 管理员可能禁止第三方应用（`admin_policy_enforced`）；高级保护账号可能完全拒绝。都按“未连接”如实显示。

### 4.5 迁到服务器

用户 2026-10-30 要求本轮设计能原样迁到服务器，但服务器部署现在不做（D12）。因此：
- 不假设浏览器和 Pidot 同机：原生 OAuth 有“粘贴跳转地址”兜底（§4.2 第 5 步）；workspace-mcp 由 Pidot 统一授权，不需要在服务器上另开浏览器登录。
- workspace-mcp 用 `--transport streamable-http` 只监听 127.0.0.1，启动命令和环境变量在本机和服务器相同；服务器上给出 systemd 单元示例。Pidot 按第一轮外部 MCP 的 loopback HTTP 连接它，每次调用带当前访问令牌，令牌刷新后自动用新的。
- 连接配置里不存本机绝对路径；workspace-mcp 的地址和端口来自配置项。
- 迁移步骤：停服务 → 复制数据库目录（含 `google/`、`bot-workspaces/` 等）→ 服务器上装同一版本 workspace-mcp → 设置相同的环境变量 → 启动 → 在设置页检查一次 Google 与 workspace-mcp 连接。
- 统一授权核实不成立时的退回方案：workspace-mcp 用 stdio 自己登录；服务器上首次登录要用 `ssh -L` 把它的回调端口转到用户电脑，或按它的 `WORKSPACE_EXTERNAL_URL` / `GOOGLE_OAUTH_REDIRECT_URI` 走反向代理。
- Pidot 自身仍只监听 127.0.0.1，远程打开靠 SSH 隧道等用户自己的做法；公网域名、HTTPS、绑定地址不在本轮。

## 5. 各产品 scope 与映射

敏感级别引自 Google 各 API 的 scope 页；Calendar、Tasks 页未标级别，按 Google 控制台归类核对。个人自建、未验证的客户端无论敏感还是受限，表现都是登录时一次警告，不影响使用。

| 产品 | 默认 scope（级别） | 工具 / 映射 | 写入一致性 |
|---|---|---|---|
| Calendar | `calendar.events`，`calendar.calendarlist.readonly` | 连接后列出的全部日历各为一个 Source（D7），accessRole 为 reader/freeBusyReader 的标 readOnly，（`google:<hash(accountKey, calendarId)>`），事件进 **Event**（authority=external，remoteId、remoteVersion=etag、readOnly、providerEvent）。Bot 通过现有 `workspace.list/get/prepare_change` 和 `workspace:<sourceId>` 资源使用，不新增日历工具名 | 新建：事件 id 由 `requestId` 派生（sha256 十六进制，符合 base32hex 字符集），结果不明时按 id 查询，已存在即成功，重复插入返回冲突而不是第二条。改/删：带 `If-Match: <etag>`，412 = 冲突。`sendUpdates=none`，第一版不设参会人。重复/全天事件只读，同飞书首轮 |
| Tasks | `tasks` | 每个任务列表 = 一个 Source，任务进 **Todo**（authority=external）。`due` 只有日期（Google 会丢掉时间部分），映射为全天截止，在日历里按截止日显示、不占时段（D8）；`needsAction`/`completed` ↔ `open`/`completed`。子任务第一版平铺只读 | 改/删：写前比对 etag、写后回读；不承诺服务端 CAS。新建无客户端 id：结果不明时在该列表按标题 + 创建时间窗查找候选，找不到记 unknown，不自动重建 |

| Gmail、Drive、Docs、Sheets | 统一授权时由 Pidot 一并申请：`openid`、`userinfo.email`、`gmail.readonly`、`gmail.compose`、`gmail.send`、`drive`、`drive.file`、`drive.readonly`、`documents`、`spreadsheets`（按 2.2.1 的 `--permissions` 映射） | 经第一轮外部 MCP 的 loopback HTTP 接入，作为一个外部 MCP 能力分给 Bot；工具名和参数以 workspace-mcp 为准。按 D3（读、草稿、发送）、D5（Drive 全盘读写）、D6（Docs 追加与替换）选 `--tool-tier` | 不映射文档。写入结果不明记 unknown、不自动重试；重复发信或重复建文件由用户核对 |

**Todo 补字段**：`workspace-schema.mjs` 的 Todo 加可选 `remoteId`、`remoteVersion`、`authority`、`readOnly`、`observedAt`、`providerTask`，与 Event 现有字段同名同义；旧本地 Todo 不受影响，不需要迁移。

**外部内容不可信**：邮件正文、文档内容、日程描述一律标为外部文本，不构成授权，与飞书描述的处理相同。

**工具组**：Calendar、Tasks 通过已有“日历与日程”“待办与事项”组和来源资源控制。workspace-mcp 是一个外部 MCP 能力，在 Bot 能力页按连接启用，启用后直接执行（ADR-018）。新 Bot 仍从空白开始，由用户或 Chief 打开。例行任务仍只开放工作区工具（ADR-014 第 3 条），所以无人值守运行碰不到 workspace-mcp，Calendar/Tasks 走现有来源规则。

## 6. 工作票

通用约束同第一轮：不访问 `.env`、正式 data 或真实账号；不自行安装依赖（已批准的固定版本 workspace-mcp 除外）、提交、推送；Worker 只写自己的范围，公共入口（`tasks.mjs`、`tools.mjs`、`policy.mjs`、`tool-groups.mjs`、`app.mjs`、`index.mjs`、`App.tsx`）由集成负责人接线。所有票的自动测试只打本机假服务。

### R3-01 契约、假 Google 服务与多来源接口

**负责人：集成负责人；复杂度 M；依赖：无（第一、二轮已于 2026-10-30 验收）。**

**交付**
1. 把 `createWorkspaceService` 的 `external`（目前只挂飞书）改成按 provider 的适配表；飞书行为、测试逐条不变。
2. Todo 补 §5 所列可选外部字段，Event 不动。
3. 新建 `server/fixtures/fake-google.mjs`：127.0.0.1 上的假 OAuth（authorize 直接 302 回调、token、revoke）和 Calendar、Tasks 的最小端点，可脚本化注入 401、`invalid_grant`、412、429、5xx、超时、断连、分页、巨型响应、部分 scope。
4. Google 基地址只能由测试注入（与 `createFeishuClient` 的 `fetchImpl` 同法），生产代码固定主机。
5. 外部来源写入按 D4“组开即直接做”。确认 `decide()` 和外部确认流程的实际行为；不一致处按 D4 修正，并在交付记录里列出。

**写入范围**：`workspace-service.mjs`、`workspace-schema.mjs`、新增 fixture；公共入口最小接线。

**复用**：`workspace-feishu.mjs` 的接入形状、现有临时库测试写法。

**不做**：Google 业务逻辑；新框架；把 stub 当功能交付。

**验收**：`pnpm test` 全绿且飞书相关用例计数不变；假服务可被 02–04 独立使用；生产路径无法指向非 Google 主机。

### R3-02 Google 连接、令牌与设置页

**负责人：连接 Worker；复杂度 L；依赖：01。**

**交付**：§4 全部流程，含“粘贴跳转地址”兜底和统一授权的 workspace-mcp scope。服务端新增 `google-oauth.mjs`（PKCE、state、一次性回调、换令牌、刷新、撤销）、`google-credentials.mjs`（0600 凭据文件）、`google-client.mjs`（固定主机、不跟随跳转、超时、大小上限、读请求最多一次退避重试、写请求不重试、401 刷新一次）。HTTP：连接状态、保存客户端配置、开始连接、断开。前端新增 `GoogleConnection.tsx`：Calendar、Tasks 勾选，连接/重新连接/断开，状态；开关用 `Switch.tsx`。Chief 的“去设置页连接”卡片。

**写入范围**：上述新文件及同名测试；`app.mjs` 路由由集成负责人接。

**复用**：`external-mcp.mjs` 存储与 redact、`model-settings.mjs` 环境优先级、`McpCredentialForm.tsx` 密码字段写法、飞书断开撤资源。

**不做**：多账号、服务账号、系统钥匙串、内置共享客户端、设备码流程。

**验收**：假服务下完整连接；回调端口不可达时粘贴跳转地址完成连接；state 不符、回调重放、5 分钟超时、用户拒绝、只授予部分 scope、`invalid_grant`、撤销失败、并发刷新、进程重启后保持连接；凭据文件权限与软链防护；对测试库、日志、HTTP 响应、Task 历史做秘密扫描为零命中。1440/375 双宽度手测设置页。

### R3-03 Google Calendar 来源

**负责人：日历 Worker；复杂度 L；依赖：01、02。**

**交付**：新增 `workspace-google-calendar.mjs`：全部日历 → Source（D7）；窗口读取进 Event 缓存；复用 `workspace-sync` 后台重扫；`workspace.prepare_change` 新建/修改/删除；结果不明按确定性 id 或 etag 回读核实。日历视图显示 Google 来源与只读标记。

**写入范围**：新模块及测试；`CalendarBoard.tsx` 如需改动只限来源显示。

**复用**：`workspace-feishu.mjs` 的 cache/permission/sync 结构，Operation、Reminder、检测器。

**不做**：重复/全天事件写入、参会人与邀请邮件、会议链接、推送订阅、忙闲 API（第一版从缓存算）。

**验收**：读/建/改/删全链路；412 冲突不覆盖；新建超时后回读找到即成功、重复插入不产生第二条；撤权后缓存不可见；跨日/夏令时/时区；重启后同步状态恢复。

### R3-04 Google Tasks 来源

**负责人：事项 Worker；复杂度 M；依赖：01、02。**

**交付**：新增 `workspace-google-tasks.mjs`：任务列表 → Source，任务 → Todo；读、同步、新建、完成/改、删除；日期型截止。

**写入范围**：新模块及测试。

**复用**：R3-03 的同步与缓存写法；现有 Todo UI 与提醒。

**不做**：子任务层级编辑、移动排序、跨列表移动。

**验收**：状态双向映射；截止日期不变成时间段占用；新建结果不明不重建；etag 变化提示冲突；撤权即不可见。

### R3-05 workspace-mcp 接入

**负责人：MCP Worker；复杂度 M；依赖：01、02；本机已有 uv，用户已批准安装固定版本的 workspace-mcp（D11）。**

**交付**
1. 已核实（主管 2026-10-30，按 2.2.1 源码）：`MCP_ENABLE_OAUTH21=true` + `EXTERNAL_OAUTH21_PROVIDER=true`，`--transport streamable-http`，只需 `GOOGLE_OAUTH_CLIENT_ID`（外部模式不要密钥）；`ya29.*` 访问令牌经 Google userinfo 校验，所以令牌必须带 `openid` 与 `userinfo.email`。还要核实：监听地址是否只限 127.0.0.1、`--permissions` 能否与 `--tool-tier` 同用、工具调用是否用该 bearer 访问 Google。不成立时按 §4.5 的退回方案做，并告诉用户这会变成授权两次。
2. 安装：本机已装 `uv tool install workspace-mcp==2.2.1`（主管 2026-10-30），服务器迁移时用同一命令。不用 `uvx`/`npx` 浮动启动。
3. 运行：`--transport streamable-http` 只监听 127.0.0.1，`--permissions gmail:readonly+drafts+send drive:full docs:full sheets:full --tool-tier extended`（D3、D5、D6、D10；`--permissions` 与 `--tools` 互斥，服务由它决定）。给出本机启动命令和服务器 systemd 单元示例，两处参数相同。
4. 连接：第一轮外部 MCP 的 loopback HTTP 连接加一种凭据来源“取自 Google 连接”：每次调用带 Pidot 当前的访问令牌，不保存静态 bearer。用户对 Chief 说“接上 Google 邮件和文件”时，Chief 用 `mcp_manage` 按模板添加并分给指定 Bot，和第一轮的 MCP 接入同一条路。
5. 设置页“连接 Google”区域显示 workspace-mcp 的运行和连接状态；没在运行时如实显示，不假装可用。

**写入范围**：交接契约、操作说明、模板与其测试；新增一个仿 workspace-mcp 的假服务（工具名与参数照固定版本，不连 Google，校验收到的 bearer）；`external-mcp*.mjs` 只加“取自 Google 连接”的凭据来源，并在交付记录说明。

**复用**：第一轮外部 MCP 的 HTTP 传输、能力开关、对话配置（`mcp_manage`）、unknown 回执；R3-02 的令牌刷新。

**不做**：为 Gmail、Drive、Docs、Sheets 写原生适配；托管版；开启 workspace-mcp 的 Calendar、Tasks 工具；由 Pidot 拉起或守护 workspace-mcp 进程（本轮用一条启动命令或 systemd）。

**验收**：用假服务：Chief 一句话接入并分给目标 Bot；目标 Bot 调发信类工具直接执行，不出确认卡；Pidot 刷新令牌后调用带新令牌；断开 Google 后调用立即失败；超时记 unknown、不重发；停用后调用被拒；workspace-mcp 没在运行时显示未运行；重启后连接需重新检查才可用。安装后对真实 workspace-mcp 只做不登录的启动和工具列表检查。真实 Google 登录与发信由用户手测。

### R3-07 权限降级（D14、D15）

**负责人：权限 Worker；复杂度 M；依赖：01、02；与 03/04/05 并行。**

**交付**：外部日历来源（飞书，以及经 01 的按 provider 钩子接入的 Google）连上即可用，去掉逐个来源授权；Bot 能力页的按 Bot 分配和断开/换绑时撤资源不变，已有授权继续有效。日程写入按“日历与日程”组、事项写入按“待办与事项”组裁决，用现有 PolicyRules 的 `type` 匹配，组开关写对应规则，已有规则照常生效。飞书日历工具不再有普通写工具之外的权限特例；requestId、expectedVersion、unknown 不自动重试照旧。改掉与 ADR-018 矛盾的旧文案。ADR 草稿写进交接契约。

**写入范围**：`policy.mjs`、`tool-groups.mjs`、`tool-group-settings.mjs`、`workspace-grants.mjs`、`workspace-feishu.mjs` 的授权部分、飞书来源授权界面及其测试；其他文件需要的接线写进交付记录，由集成负责人接。

**验收**：飞书与 Google 来源连上后无需授权即可被已分配的 Bot 读写；把“日历与日程”设为先问后，经工作区工具改日程会等确认，事项不受影响；断开后所有 Bot 失去该来源；原有飞书测试除授权步骤外行为不变；界面改动做 1440/375 实际操作。

### R3-06 总集成、文档与用户验收材料

**负责人：集成负责人；复杂度 M；依赖：02–05、07 全部合入。**

**交付**：工具组、`policy` 读写登记、`tools`/`tasks` 接线；“断开 Google”撤销令牌后 workspace-mcp 调用随即失效（退回方案下另外停用连接并删除其令牌目录）；迁到服务器的操作说明（§4.5）；`docs/` 产品/架构/HTTP/MCP 与新 ADR（Google 连接、令牌存放与混合路线）；`my-app/README.md` 环境变量；用户自建 OAuth 客户端和安装 workspace-mcp 的操作说明；未验真实账号清单。

**必过业务链**：连接 → 全部日历和任务列表出现在日历视图 → 对话里让 Bot 建日程、完成任务 → Chief 接入 workspace-mcp（假服务）→ Bot 查邮件、写草稿并发送、读文档 → 断开 → 所有 Bot 立即失去 Google 资源和 workspace-mcp 工具 → 重启后状态一致。

**验证**：`pnpm test`、`pnpm lint`、`pnpm build`；1440/375 真实页面操作；秘密扫描。真实 Google 账号的手测由用户自己做或另行授权，自动测试通过不写成已手测。

## 7. 统一验收

- **不需要真实 Google 账号**：原生部分的自动测试打 `fake-google.mjs`，workspace-mcp 部分打仿它的 stdio 假服务；测试中若有请求发往真实 `*.googleapis.com` / `accounts.google.com` 即判失败。
- **换机器**：浏览器与 Pidot 不在同一台机器时（回调端口不可达），粘贴跳转地址完成连接；workspace-mcp 不需要另外登录。
- **故障矩阵**：网络中断、超时、乱序响应、429/5xx、401 后刷新、`invalid_grant`、部分 scope、412/etag 冲突、重复提交同一 `requestId`、结果不明、进程重启、Bot 停用、组关闭、断开连接、巨型或恶意外部数据、跨日/夏令时。
- **秘密扫描**：用假令牌的固定字符串，扫测试库文件、日志输出、HTTP 响应、Task 历史、工具结果，全部零命中。
- **结果不明**：原生写工具都有“超时后不重复副作用”的用例，且复用原 `requestId` 和原 Operation；workspace-mcp 的工具超时记 unknown、不自动重发。
- 测试、lint、build 照实报告计数；不沿用第一轮的通过数。

## 8. 依赖与外部前提

| 项 | 是否需要批准 | 说明 |
|---|---|---|
| 新 npm 依赖 | 不需要 | 原生部分只用 Node 自带 `fetch`、`node:crypto`、`node:http`。`node_modules` 里已有的 `google-auth-library`、`gaxios` 只是 `@google/genai` 的传递依赖，不直接引用 |
| uv 与固定版本的 workspace-mcp | 已批准（D11） | 本机已有 uv 0.11.11；workspace-mcp 2.2.1 已于 2026-10-30 装在本机（uv tool），服务器迁移时装同一版本；升级另行决定 |
| Google Cloud 项目、OAuth 客户端、启用 API | 用户自己在 Google 控制台操作 | 不是代码依赖；R3-06 附操作说明 |
| 真实账号手测 | 用户另行授权 | 本轮自动验收不依赖 |

## 9. 决定（2026-10-30 用户答复）

| # | 问题 | 结论 |
|---|---|---|
| D1 | 接入路线 | 已选：Calendar、Tasks 原生，Gmail、Drive、Docs、Sheets 经 workspace-mcp |
| D2 | Google 应用发布状态 | 已选：正式发布（未验证） |
| D3 | Gmail 范围 | 已选：读、草稿、发送 |
| D4 | 对外写入是否“组开即直接做” | 已选：直接做 |
| D5 | Drive 范围 | 已选：全盘读写 |
| D6 | Docs 编辑 | 已选：允许追加与替换文字 |
| D7 | 日历显示哪些 | 已选：全部订阅日历 |
| D8 | Google 任务在日历里怎么显示 | 已选：按截止日显示，不占时段 |
| D9 | 开工时机 | 已选：第二轮验收后；2026-10-30 用户授权开工 |
| D10 | workspace-mcp 开哪些服务 | 已选：只开 Gmail、Drive、Docs、Sheets |
| D11 | 安装固定版本的 workspace-mcp | 已批准；2.2.1 已于 2026-10-30 用 uv tool 装在本机，固定此版本 |
| D12 | 迁到服务器 | 已定：设计不假设浏览器与 Pidot 同机；Pidot 自身的服务器部署现在不做（用户原话：“只是让你有这个考虑。但是不是现在做”） |
| D13 | workspace-mcp 的 Google 登录 | 已选：Pidot 统一授权，把访问令牌传给它；2026-10-30 按 2.2.1 源码核实可行，余项见 R3-05 第 1 步 |
| D14 | 连上 Google 后发现的日历和任务列表 | 已选：连上即可用，不逐个来源授权；哪个 Bot 能用仍在 Bot 能力页分配，新 Bot 仍是空白 |
| D15 | 日程与事项的权限 | 用户原话：“权限权重降级，飞书日历日程降级为普通工具，只是优化更好”。做法：飞书日历来源也连上即可用；日程写入按“日历与日程”组、事项写入按“待办与事项”组，和普通工具一样，不加关卡（R3-07） |

D3、D5、D6 在 workspace-mcp 2.2.1 上落到 `--permissions gmail:readonly+drafts+send drive:full docs:full sheets:full`（Gmail 不含整理标签与设置）；`--tool-tier extended` 是包含草稿与查找替换的最小层级，多出来的工具（如 Drive 共享与权限、Docs 样式）在交接契约里列出，需要时用 `--disabled-tools` 屏蔽。Sheets 未单独答复，按全读写。

## 10. 参考（核对日期 2026-10-30）

- 桌面应用 OAuth（PKCE、127.0.0.1 回调、refresh token 数量上限、撤销端点）：https://developers.google.com/identity/protocols/oauth2/native-app
- 发布状态、测试用户 100 人、测试期 7 天过期、未验证应用 100 用户上限：https://support.google.com/cloud/answer/15549945
- 个人使用（少于 100 用户）可不验证：https://support.google.com/cloud/answer/13464323
- 发布状态与用户类型对照：https://developers.google.com/identity/protocols/oauth2/production-readiness/overview
- Gmail scope 级别：https://developers.google.com/workspace/gmail/api/auth/scopes
- Calendar scope：https://developers.google.com/workspace/calendar/api/auth
- Calendar 新建事件可指定 id（base32hex、5–1024 字符、日历内唯一）：https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- Tasks scope：https://developers.google.com/workspace/tasks/auth
- Tasks `due` 只记日期：https://googleapis.dev/dotnet/Google.Apis.Tasks.v1/latest/api/Google.Apis.Tasks.v1.Data.Task.html
- Drive scope 与受限范围资格：https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Docs scope：https://developers.google.com/workspace/docs/api/auth
- Google 官方远程 MCP（产品列表、Web 客户端、AI 代理选项、各服务 scope、`access_type=offline`）：https://developers.google.com/workspace/guides/configure-mcp-servers
- 官方 MCP 公开预览公告：https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html
- workspacemcp.com（v2.2.1 同步日期 2026-10-26、12 项服务、工具层级、只读模式、托管版）：https://workspacemcp.com/ 、https://workspacemcp.com/google-sheets
- 设备码流程只支持 openid/email/profile、drive.file、drive.appdata 和 YouTube scope：https://developers.google.com/identity/protocols/oauth2/limited-input-device
- taylorwilsdon/google_workspace_mcp（README：外部 OAuth provider 模式、`WORKSPACE_EXTERNAL_URL`、`GOOGLE_OAUTH_REDIRECT_URI`、`--transport streamable-http`）：https://github.com/taylorwilsdon/google_workspace_mcp （此前固定提交 `c0bff66e` 的 scope 定义见 INT-01 §7）
- google-workspace-suite-mcp（发布状态实践说明）：https://pypi.org/project/google-workspace-suite-mcp/0.6.0/

未核实、实施时需用假服务契约先固定再找真实账号确认：Tasks API 是否支持 `If-Match`；Gmail 草稿发送后草稿 id 的确切行为；`calendar.events` 是否足以调用 freeBusy（第一版不用）；workspace-mcp 的监听地址、`--permissions` 与 `--tool-tier` 能否同用、工具调用是否以该 bearer 访问 Google（外部 OAuth provider 模式本身已按 2.2.1 源码核实）；退回方案下的令牌目录环境变量名和登录回调方式。
