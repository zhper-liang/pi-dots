# 第三轮交接契约（R3-01 / R3-02 冻结）

> 状态：2026-10-31 冻结，由 R3-01、R3-02 交付。R3-03（Calendar）、R3-04（Tasks）、R3-05（workspace-mcp）并行开发时以本文为准。要改契约先找集成负责人（主管），不要各自改共享文件。计划正文见 [README](README.md)。

## 0. 总览

- 只连一个 Google 账号。refresh token 和 client secret 只在 `<数据库目录>/google/credentials.json`（目录 0700、文件 0600）和进程内存里；SQLite 只存不含令牌的 `GoogleAccount` 镜像（`google-account.mjs`）。
- `createWorkspaceService({ external })` 已改成按 provider 的适配表，飞书行为和测试不变。Google 日历、任务的适配器文件已登记为不提供任何来源的空壳，R3-03/04 替换函数体即可，不用再改装配。
- 适配器拿到的是不含令牌的 `google` 句柄（`api` / `current` / `redact`）；重试、超时、大小上限、401 刷新都在 `google-client.mjs`。R3-05 用冻结的 `accessToken()`。
- 测试只打 `server/fixtures/fake-google.mjs`；`guardGoogleNetwork()` 拦下任何发往真实 Google 主机的请求，测试结束时断言为空。

## 1. Provider 适配器如何登记

三处登记（都已完成并冻结）：

| 位置 | 内容 |
|---|---|
| `workspace-providers.mjs` 的 `WORKSPACE_PROVIDERS` | provider id、sourceId 前缀、所需 Google 服务（`service`）、`itemType`、显示名 |
| `workspace-service.mjs` 的 `WORKSPACE_ADAPTERS` | `external` 下的键 → 工厂函数；顺序即路由顺序 |
| `tasks.mjs` | `external: { feishu: {…}, googleCalendar: { google, syncOptions }, googleTasks: { google, syncOptions } }` |

| provider | 前缀 | itemType | 工厂（文件，所有者） |
|---|---|---|---|
| `feishu` | `feishu:` | Event | `createFeishuWorkspaceService`（`workspace-feishu.mjs`，不动） |
| `google-calendar` | `google-calendar:` | Event | `createGoogleCalendarWorkspaceService`（`workspace-google-calendar.mjs`，R3-03） |
| `google-tasks` | `google-tasks:` | Todo | `createGoogleTasksWorkspaceService`（`workspace-google-tasks.mjs`，R3-04） |

工厂签名：`({ repository, authority, google, now = Date.now, syncOptions = {} }) => methods`。`repository`、`authority` 与飞书相同；`google` 见 §1.3。导出名和参数不得改。

### 1.1 方法集（同飞书形状，全部要实现）

| 方法 | 路由依据 | 约定 |
|---|---|---|
| `reminderExternalPermission(tx, actor, sourceId)` | sourceId | 在调用方事务里返回 `{ readScope, grantEpoch, source, binding }`；来源不活跃抛 403 `WORKSPACE_EXTERNAL_REVOKED` |
| `externalSources(actor, input)` | 所有适配器聚合 | 非 user 抛 403；返回 `{ sources, notice }`，每项见 §1.4 |
| `grantExternal`、`queryExternal`、`getExternal`、`prepareExternal` | `input.sourceId` | 语义同飞书；`prepareExternal(actor, input, { expiresInMs, autoApprove, skipReason })` 必须照第三个参数办，见 §5.2 |
| `syncStatus`、`configureSync`、`refreshSync` | `input.sourceId` | 可直接用 `createWorkspaceSync`（同飞书）；`permission()` 返回的 `binding.resource` 要随 authEpoch 变化，重连后旧同步配置自动失效 |
| `confirmExternal`、`cancelExternal`、`getExternalOperation`、`executeExternal` | 已存 Operation | 路由读 `Operation.external` 存在且 `normalizedArgs.sourceId` 以本前缀开头，所以这两个字段的写法要和飞书一致 |
| `recoverExternal`、`tickExternalSync`、`closeExternalSync` | 每个适配器都调 | 只处理本前缀的记录；一个适配器出错不会跳过其他适配器 |

路由规则（`composeExternalAdapters`）：按前缀选适配器；选不到（非法 id、未知前缀、查不到 Operation）一律交给第一个（飞书），飞书原有的校验和拒绝文本因此不变。适配器不必处理别家前缀，但必须自己做 `authority.check(actor)` 和输入校验。只登记一个适配器时直接返回它的方法，不经路由。

### 1.2 sourceId 与资源

- sourceId 一律用 `externalSourceId(providerId, accountKey, containerId)` 生成：`<前缀><sha256([accountKey, containerId])>`。同一账号重连得到同一个 id。containerId：日历用 calendarId，任务用 tasklist id。
- Bot 资源沿用 `workspace:<sourceId>`，工具仍是 `workspace.list/get/prepare_change/operation_status`，不新增工具名。
- 发现来源时，在同一事务里调 `registerExternalSource(tx, { sourceId, title, accountKey, authEpoch, readOnly })`。Bot 配置页的可分配资源和标题（`resourceLabels`）只从这里读；账号断开、`invalid_grant`、某项服务不再授权时，`applyGoogleAccount` 会删掉对应条目，并从所有 Bot 撤下 `workspace:google-calendar:*` / `workspace:google-tasks:*`。

### 1.3 `google` 句柄（适配器唯一的 Google 入口）

```js
google.available            // false：本实例没有 Google 连接，所有调用都会失败
google.api(service, path, { method = 'GET', query, body, headers, signal, limitBytes })
  // → { status, data, etag }；service ∈ 'calendar' | 'tasks'；path 相对基址，id 需 encodeURIComponent
  // headers 只允许 If-Match / If-None-Match；失败抛 GoogleError（§4.2）
google.current(tx)          // → { status, accountKey, authEpoch, services, version }（GoogleAccount 镜像，事务内读）
google.redact(text)         // 把已知秘密换成 [已隐藏凭证]
```

- 适配器拿不到令牌，也改不了主机。`err.outcomeUnknown === true`：写入结果未知，必须记为 unknown，不得重发，恢复时复用原 requestId 和原 Operation。
- 重试已经内置在 `google.api` 里：读最多退避重试一次（429/5xx/传输失败，遵守 `Retry-After`，上限 2 秒）；写从不重发；任何方法遇到 401 都强制刷新令牌并重发一次（401 表示 Google 没有执行）。适配器不要再包一层重试。
- 活跃判定：每次读写都要在同一事务里取 `const a = await google.current(tx)`。只有 `a.status === 'connected'`、`a.services` 含本服务、并且来源 Connection 的 `accountKey`、`authEpoch` 与 `a` 一致时，来源才算活跃；否则抛 403 `WORKSPACE_EXTERNAL_REVOKED`，缓存也不能再读到。`workspaceSourceReadable`（历史、共享、提醒的门）对 Google 来源用的就是这条规则（`externalSourceLive`），所以 Connection 必须写这两个字段。

### 1.4 `externalSources` 每项

`{ id, provider, authority: 'external', capabilities, epoch, authorized, readScope, itemType, title, readOnly }`。飞书的项没有 `itemType` / `title`，读取方按 Event 处理。只返回活跃的来源。`itemType: 'Todo'` 的来源，日历视图（`CalendarBoard.tsx`）显示为截止日标记、不占时段，关联选择（`LocalWorkspace.tsx`）和检测器（`tasks.mjs`）分开处理；这三处已经接好，R3-04 不用再改。

## 2. Source / Event / Todo 字段映射

### 2.1 账号与授权记录（R3-03、R3-04 相同）

| 记录 | 字段 |
|---|---|
| Connection（每个来源一条，以 sourceId 分区） | `id: 'google:' + accountKey.slice(0,16)`，`provider: 'google'`，`accountKey`，`credentialRef: 'google'`，`authEpoch: current.authEpoch`，`status: 'active'`（失效时改为 `'revoked'`） |
| Source | `id = sourceId`，`connectionId`，`providerContainerId`（calendarId / tasklist id），`authority: 'external'`，`capabilities`：可写 `['read','create','update','delete']`，只读 `['read']` |
| Grant `user:authenticated-user` | 待定（§7 D-A）。建议：发现来源时按 capabilities 种 `actions`、`readScope: 'full'`；authEpoch 变化时重种并 `epoch+1`；`grantExternal` 保留给用户收窄 |

### 2.2 Event ← Calendar v3 event（R3-03 填）

| Event 字段 | 来源 |
|---|---|
| `id` | `payloadHash([sourceId, event.id, instanceKey])`（同飞书） |
| `remoteId` / `instanceKey` | `event.id`；用 `singleEvents=true` 展开时，实例 id 本身就唯一，`instanceKey = event.id` |
| `title` / `description` | `summary`（截 2000）/ `description`（截 16000，整条记录 ≤ 32 KiB） |
| `start` / `end` | `dateTime`（带偏移）或全天的 `date`（`end` 是 Google 的不含当天日期） |
| `timezone` | `start.timeZone` ?? 日历 `timeZone` |
| `version` / `remoteVersion` | 本地版本，`remoteVersion` 变化才 +1 / `etag` |
| `authority` / `deletedAt` | `'external'` / `status === 'cancelled'` 时记时间 |
| `readOnly` | 日历 `accessRole` 为 reader/freeBusyReader，或重复、全天事件（第一版只读） |
| `observedAt` / `providerEvent` | 读取时间 / 精简后的原对象 |

写入：新建用 `id = sha256(requestId)` 的 hex（base32hex 字符集）；结果未知时 GET 这个 id，已存在就算成功，重复插入返回 409 `GOOGLE_CONFLICT`，不会出第二条。改、删带 `If-Match: <etag>`，412 → `GOOGLE_PRECONDITION`（冲突，不覆盖）。`sendUpdates=none`。

### 2.3 Todo ← Tasks v1 task（R3-04 填；Todo 新增字段已在 schema 里）

| Todo 字段 | 来源 |
|---|---|
| `id` | `payloadHash([sourceId, task.id])` |
| `remoteId` / `title` | `task.id` / `title` |
| `status` | `needsAction` ↔ `open`，`completed` ↔ `completed` |
| `due` | `task.due.slice(0, 10)`（全天截止，D8）；写回发 `YYYY-MM-DDT00:00:00.000Z` |
| `version` / `remoteVersion` / `authority` | 同 Event / `etag` / `'external'` |
| `readOnly` | 有 `parent` 的子任务为 `true`（第一版平铺只读） |
| `deletedAt` / `observedAt` / `providerTask` | `deleted` 或已不在列表时记时间 / 读取时间 / 精简原对象 |

外部 Todo 会校验：`authority: 'external'` 必须带 `remoteId`；`readOnly` 为布尔；`observedAt` 可解析；`providerTask` 是对象。本地 Todo 不受影响。

`queryExternal`（Todo 来源）：输入 `{ sourceId, start, end, timezone }`，返回 `{ items, complete, stale, … }`。`items` 包含截止日落在窗口内的任务、所有已过期的未完成任务和没有截止日的未完成任务。检测器靠这一点发现逾期。

## 3. fake-google 怎么用

```js
import { createFakeGoogle, guardGoogleNetwork, FAKE_GOOGLE_CLIENT, FAKE_GOOGLE_SECRET_PREFIXES } from './fixtures/fake-google.mjs'
const fake = await createFakeGoogle({ pageSize: { calendar: 2 }, tasksIfMatch: false, routes: [] })
const guard = guardGoogleNetwork()                        // 测试结束时 assert.deepEqual(guard.blocked, [])
const google = await openGoogleConnection({ dataDirectory, env: {}, envFiles: [], endpoints: fake.endpoints, fetchImpl: guard.fetch })
await google.saveClient({ requestId: 'client-0001', ...FAKE_GOOGLE_CLIENT })
const started = await google.start({ services: ['calendar', 'tasks', 'workspace'] })
await google.paste({ redirectUrl: await fake.approve(started.attempt.authorizeUrl) })   // 或 fetch 回调地址
const store = await openTaskStore({ file, google })     // store 级测试；不传 google 时 Google 路由返回 503
```

| 能力 | API |
|---|---|
| OAuth | `/o/oauth2/v2/auth` 校验 client_id、127.0.0.1 redirect、S256 后直接 302 回调；`/token` 校验 PKCE、一次性 code、client secret，支持 refresh；`/revoke`；`fake.approve(url)` 模拟浏览器点同意 |
| userinfo | `fake.userinfoUrl`：bearer 有效时返回 `{ sub, email, email_verified }`，否则 401（R3-05 的仿 workspace-mcp 用它校验令牌） |
| Calendar v3 | `users/me/calendarList`（分页），`calendars/{id}`，`calendars/{id}/events` 的 list（`timeMin`/`timeMax`/`showDeleted`/分页）、insert（客户端 id，重复返回 409）、get、patch/put/delete（`If-Match`，不符返回 412；删除改为 cancelled，再删返回 410） |
| Tasks v1 | `users/@me/lists`，`lists/{id}/tasks` 的 list/insert/get/patch/delete；`due` 丢掉时刻（按字面日期）；`tasksIfMatch: true` 时才校验 `If-Match`（真实行为未核实） |
| 种子数据 | `addCalendar({ id, summary, accessRole, timeZone, primary })`，`addEvent(calId, event)`，`addTaskList({ id, title })`，`addTask(listId, task)`；`fake.state` 可直接查看 |
| 同意页 | `setGrant({ scopes, deny, refreshToken, sub, email })`：只授予部分 scope、拒绝、不给 refresh token、换账号 |
| 撤权 | `revokeAll()`（之后刷新得到 `invalid_grant`）；`expireAccessTokens()` |
| 故障脚本 | `fake.fail({ method, path, times = 1, status, reason, body, headers, oauthError, delayMs, hang, disconnect, huge, after })`；`clearFailures()` |
| 请求记录 | `fake.requests`（method、path、query、ifMatch），`fake.count(pathSuffix, method)` |
| 加端点 | `options.routes: [{ method, path: RegExp, handler(req, res, ctx) }]`，`ctx = { url, body(), json, error, token, state, fake }`；同样要求 bearer 和 scope。各票在自己的测试文件里加，不改 fixture |

故障对照：`status: 401` → 一次刷新后重发；`status: 403, reason: 'rateLimitExceeded'` → 限流；`status: 403, reason: 'insufficientPermissions'` → `GOOGLE_SCOPE_MISSING`；`412` → 冲突；`429` 加 `headers: { 'Retry-After': '1' }`；`5xx`；`oauthError: 'invalid_grant'`（作用于 `/token`）；`hang: true`（配合短 `timeoutMs`）；`disconnect: true`（断连）；`huge: 2*1024*1024`（超出 1 MiB 上限）；`after: true` 先真实执行再延迟/断连/替换响应，用来模拟“已生效但响应丢了”（写入结果未知）。`path` 可以是后缀字符串或正则。

秘密前缀：fake 发出的所有秘密都以 `FAKE_GOOGLE_SECRET_PREFIXES` 中的某一项开头（`ya29.fake-access-`、`1//fake-refresh-`、`4/fake-code-`、`GOCSPX-fake-`）。秘密扫描测试对除 `google/credentials.json` 以外的数据目录文件、HTTP 响应、日志和 Task 历史 grep 这些前缀，结果必须为零（范例：`google-http.test.mjs`）。

## 4. 令牌 API（给 R3-05）

### 4.1 签名（冻结）

```js
// server/google-connection.mjs，openGoogleConnection() 返回的对象
google.accessToken({ services = [], signal } = {}) → Promise<string>   // 当前有效的 ya29.* 访问令牌
google.rejectToken(token) → void                                       // 拿这个令牌收到 401 后调用，下次 accessToken() 强制刷新
```

- 每次请求都调用，不要自己缓存令牌。令牌在过期前约 60 秒刷新；同一账号的并发调用共用一次刷新；刷新期间断开或换号时，刷新结果丢弃并抛 `GOOGLE_NEEDS_AUTH`。
- `services` 里的服务（`calendar`、`tasks`、`gmail`、`drive`、`docs`、`sheets`）必须都已授予，否则抛 `GOOGLE_SCOPE_MISSING`。传 `[]` 只要求已连接。`signal` 只取消调用方自己的等待，共享的刷新照常完成。
- 只在服务端进程内使用：不经 HTTP、不写日志、不进模型上下文、工具结果、Task 历史或文件。实例是 `index.mjs` 里的 `google`。

### 4.2 错误（`GoogleError extends TaskInputError`，带 `status`、`code`、`kind`、`outcomeUnknown`、`retryable`）

| kind | code | 含义 |
|---|---|---|
| `needs_auth` | `GOOGLE_NOT_CONNECTED`（409）、`GOOGLE_NEEDS_AUTH`（401）、`GOOGLE_SCOPE_MISSING`（403） | 要用户去设置页（重新）连接；R3-05 把这类错误映射为外部 MCP 的 `needs_auth` |
| `config` | `GOOGLE_UNAVAILABLE`（503）、`GOOGLE_NOT_CONFIGURED`、`GOOGLE_CLIENT_INVALID`、`GOOGLE_STORAGE_FAILED` | 实例没有 Google 连接，或客户端配置、凭据文件有问题 |
| `transport` / `provider` / `rate_limit` | `GOOGLE_TRANSPORT`、`GOOGLE_TIMEOUT`、`GOOGLE_PROVIDER_ERROR`、`GOOGLE_RATE_LIMIT`… | 暂时性错误（刷新也可能这样失败）；不改变连接状态 |

`isGoogleNeedsAuth(err)` 判断第一类。错误信息是固定中文，不含 provider 原文、URL、令牌或路径。完整的错误码见 `GOOGLE_ERROR_CODES`（`google-client.mjs`）。

### 4.3 R3-05 的接线

`createExternalMcpService` 新增一个选项（由 R3-05 加），`index.mjs` 只改一行：`createExternalMcpService({ dataDirectory, googleAccessToken: options => google.accessToken(options) })`。凭据来源“取自 Google 连接”的 HTTP 连接，在每个请求上调用它作为 bearer，并把拿到的令牌加入已知秘密，参与 `redact`。不保存静态 bearer。

## 5. HTTP 路由（已接入 `app.mjs`，都要 bearer）

| 方法与路径 | 请求体 | `data` |
|---|---|---|
| `GET /api/google/status` | — | `GoogleStatus` |
| `POST /api/google/client` | `{ requestId, clientId, clientSecret? }`（留空 secret 保留原值；环境变量生效时返回 409 `GOOGLE_CLIENT_ENV_LOCKED`） | `GoogleStatus` |
| `POST /api/google/connect` | `{ services: ('calendar'\|'tasks'\|'workspace')[] }` | `GoogleStatus`（`attempt.authorizeUrl` 由前端打开） |
| `POST /api/google/paste` | `{ redirectUrl }`（按秘密处理，不记日志、不回显） | `GoogleStatus` |
| `POST /api/google/disconnect` | `{}` | `{ disconnected: true, revoked: true \| false \| null }` |

```ts
type GoogleStatus = {
  connected: boolean; status: 'connected' | 'needs_auth' | 'disconnected'; email: string | null
  services: ('calendar'|'tasks'|'gmail'|'drive'|'docs'|'sheets')[]   // 实际授予（未连接时为 []）
  requested: GoogleStatus['services']                                 // 上次连接勾选的
  client: { configured: boolean; source: 'env' | 'file' | 'none'; invalid: boolean; editable: boolean }
  attempt: { active: true; expiresAt: string; authorizeUrl: string } | null
  lastResult: { result: 'connected' | 'denied' | 'failed' | 'expired'; code: string | null; at: string } | null
}
```

错误统一是 `{ error: { code, message } }`。本实例没有 Google 连接时，各路由返回 503 `GOOGLE_UNAVAILABLE`。连接成功的回调页只显示“已连接，可关闭此页”，不回显任何参数。断开流程：先撤销 refresh token；无论撤销是否成功，都删除本机账号（客户端配置保留，方便重连）；`GoogleAccount` 置为 disconnected、`authEpoch+1`；所有 Bot 的 `workspace:google-*` 资源撤下；来源索引清空。`revoked: false` 时界面提示用户到 Google 账号页手动移除。

## 6. 共享文件归属（并行期间）

| 文件 | R3-03 | R3-04 | R3-05 |
|---|---|---|---|
| `workspace-google-calendar.mjs`（替换空壳）及 `r3-03-*.test.mjs` | 独占 | — | — |
| `CalendarBoard.tsx`（来源名、只读标记）、`ExternalSync.tsx`、`ExternalWorkspace.tsx` | 独占 | 不改（Todo 分流已接好） | — |
| `workspace-google-tasks.mjs`（替换空壳）及 `r3-04-*.test.mjs` | — | 独占 | — |
| `workspace-mcp-business.mjs`、`workspace-tools.mjs`（外部 Todo 的 list/get 目前只认 Event）、`workspace-reminders.mjs`（外部 Todo 提醒的预检） | 不改 | 独占 | — |
| `external-mcp*.mjs`（加“取自 Google 连接”）、仿 workspace-mcp 的新 fixture、模板与说明、`r3-05-*.test.mjs` | — | — | 独占 |
| `index.mjs` | — | — | 只改 §4.3 那一行 |
| `GoogleConnection.tsx` | — | — | 只在 `R3-05 slot` 注释处插入一个新组件（如 `WorkspaceMcpStatus.tsx`） |
| `fixtures/fake-google.mjs` | 冻结：用 `options.routes` 加端点，确实缺能力时找主管 | 同左 | 同左 |
| `workspace-service.mjs`、`workspace-providers.mjs`、`workspace-sync.mjs`、`workspace-feishu.mjs`、`google-*.mjs`、`workspace-schema.mjs`、`workspace-grants.mjs`、`bot-configuration.mjs`、`BotConfiguration.tsx`、`tasks.mjs`、`app.mjs`、`policy.mjs`、`tool-groups.mjs`、`tools.mjs`、`App.tsx`、`SettingsPage.tsx` | 冻结，要改先找主管 | 同左 | 同左 |

新测试文件以票号开头，避免同名。各票要求的一致性保护（写前比较、结果未知、unknown 不重发、重启恢复）由各适配器自己实现，用 §3 的故障脚本覆盖。

## 7. 待主管或用户确认

- **D-A 用户 Grant 默认值**：飞书要用户对每个来源单独点一次授权；Google 在连接时已勾选服务。建议按 §2.1 发现来源时直接授予完整读写（不加确认步骤，符合 D4 和“不加关卡”）。R3-03/04 开工前请确认。
- **D-B 日历写入归哪个工具组**：`workspace.prepare_change` 属于「待办与事项」组，所以飞书和 Google 日历经工作区工具的写入由这个组的开关控制，而不是「日历与日程」组。现状对组开（直接执行）没有影响，但把「日历与日程」设为先问挡不住经工作区工具的日历写入。改 `decide()` / `tool-groups.mjs` 属于 R3-06，需要先定。
- **D-C Chief 的“去设置页连接”卡片**（§4.2 第 1 步）：没有做。需要新的系统卡类型，还要改 `tasks.mjs` 和前端卡片渲染，建议放到 R3-06。
- **未核实**：Tasks API 是否支持 `If-Match`（fake 默认不校验）；带时刻的 `due` 被 Google 截成哪一天（fake 取字面日期，写入时一律发 UTC 零点）。

## 8. R3-07 ADR 草稿

> 编号由 R3-06 分配（下称 ADR-0xx）。依据：D14、D15，用户原话“权限权重降级，飞书日历日程降级为普通工具，只是优化更好”。同时回答 §7 的 D-A 与 D-B。

### ADR-0xx 外部来源连上即可用，日程与事项写入各归其组

**替代关系**
- **ADR-014 第 2 条**：外部来源的“用户 Grant/readScope 须逐个来源授权”改为连接即授权。Grant 与 readScope 仍保留，只用于用户主动收窄（`grantExternal`）和 epoch 失效。
- **ADR-015 第 2 条**：“一组一个开关”对启停不变；写入确认改为按被改对象裁决：`workspace.prepare_change` 改 Event 归「日历与日程」，改 Todo 归「待办与事项」，用 PolicyRules 已有的 `type` 匹配。
- **ADR-011** 中“外部来源（飞书）仍按用户 grant + readScope”同样改为连接即授权。
- 不变：ADR-006（requestId、expectedVersion、unknown 不自动重试、恢复复用原 Operation）、ADR-014 的实时能力、Bot 按资源分配、暂停、无人值守遇 ask 跳过、ADR-018。

**决定**
1. **连上即可用（D14）**：来源的 Connection 以新 authEpoch 写入（首次连接、重连、换绑）时，同一事务调用 `seedSourceGrant(repo, tx, { sourceId, capabilities })`（`workspace-grants.mjs`）：用户 Grant 设为来源能力的完整读写（只读来源只给 read），epoch +1，旧连接上的待确认意图随之失效。飞书在 `workspace-feishu.mjs` 的 `sync()` 调用；Google 由 R3-03/R3-04 在写 Connection 的同一事务调用，替代 §2.1 的“待定”（D-A 结论：发现即授予，不加步骤）。
2. **Bot 分配不变**：哪个 Bot 能用仍在 Bot 能力页分配 `workspace:<sourceId>`，新 Bot 仍是空白。飞书断开或换绑另一日历时，所有 Bot 的 `workspace:feishu:*` 资源都被撤下（此前只撤 `feishu:*` 日历工具资源）；同一日历断开后重连，旧分配也不恢复。Google 照旧由 `applyGoogleAccount` 撤 `workspace:google-*`。
3. **已有授权继续有效**：已有的完整、仅忙闲或已撤销的授权都不改。唯一例外是一次性升级：D14 前已连接、用户从未点过授权（空 Grant 且没有对应 epoch 的授权操作）的飞书来源，启动时补成完整授权；用户明确撤销过的保持撤销。不改 schema，不删数据。
4. **按对象裁决（D15）**：`decide()` 取对象类型时，外部来源由 provider 定（飞书、Google 日历 = Event，Google 任务 = Todo），调用方传的 `type` 改不了；本地来源用 `change.type`；无法确定时取两类中最严格的结果。「日历与日程」设为先问写入 4 条日历工具 ask 加 `{ tool: 'workspace.prepare_change', type: 'Event' }`；「待办与事项」写入 `routine_propose`、`workspace.prepare_schedule` 两条 ask 加 `type: 'Todo'` 那条。
5. **旧规则照常生效**：R3-07 之前写入的无类型 `workspace.prepare_change` 规则同时作用于两类对象，所以两个开关都显示它；切换其中一个组时，先把它收窄为另一类对象的带类型副本（`splitFrom` 记原规则 id），另一组的效果不变。
6. **飞书没有特例**：飞书日历工具走普通写工具的同一条路：组开即直接执行（含删除），组设为先问才确认，暂停时改为先问；requestId、写前比较、unknown 不重发照旧。

**原因与代价**
用户嫌关卡多；连上来源本身就是用户的明确意图，按 Bot 分配已经限定了谁能用。代价：已分配该来源的 Bot 在连接后立即能读取并直接写入外部日历，对外写入无法撤销；同一日历重连时，在重连与第一次同步之间做的分配会被撤下，需要重新分配（宁可多撤一次，也不让旧分配复活）。旧的无类型规则在两个开关上都显示，切换时会拆成一条带类型的规则。引入多用户、远程访问或改变来源信任边界前，要恢复逐个来源授权，并另记决策。

**待接线（集成负责人）**：见 R3-07 交付记录。`workspace-mcp-business.mjs` 的 `confirmLocal` 要把对象类型传给 `openGroup`；`BotRules.tsx` 的写入确认下拉按服务端 `switchable` 显示；飞书来源界面去掉“明确授权”按钮；`task-context.mjs` 里“删除默认先问”的模型提示要删掉。
