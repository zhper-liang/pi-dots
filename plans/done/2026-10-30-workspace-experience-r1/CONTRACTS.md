# 第一轮交接契约与默认决策

> 当前：本轮实现、共享接线和受控本地核心验收完成，待用户验收，保留active。原分票/波次/SDK审批过程作为历史；现行接口以docs为准，逐票及最终1395/页面/清理证据见[ACCEPTANCE](ACCEPTANCE.md)。

## C1 · 保留原架构，收敛写入负责人

- 不新增数据库、调度器、长期 Agent 执行引擎或独立权限系统；复用 Harness commit、Task、请求幂等与既有审批/取消边界。
- 公共入口由总管修改，Worker 以小模块和明确导出交付；允许少量必要依赖注入，不先构建通用插件框架。
- R1-01 固定接线清单：会话生命周期服务、外部工具目录/派发、Skill 注册源/分配检查、配置工具处理器、结果卡投影。现有功能在没有新配置时必须行为兼容。
- 所有 mutation 复用 requestId/expectedVersion（或当前等价字段），重试同内容重放；同 ID 不同内容冲突，未知结果不换 ID 盲重做。

## C2 · 删除会话

- 最小实现：服务端持久删除标记 + 现有停止逻辑；不新增独立会话数据库，不把 archive 改字当 delete。列表、详情、搜索、置顶、历史读取、记忆抽取同时过滤删除态。
- 运行中的普通会话提供“停止并删除”；迟到回执仅用于原执行审计，不入可见会话、不恢复执行。已发生外部效果不回滚。
- 主会话显示“清空并开始新会话”：替换当前主会话引用，Bot 及子 Task 不删除；旧引用退出上下文。旧子 Task 结果如何回当前主会话，由总管在 `main-session.mjs` 接线：保留来源且去重，不把已删除历史注入新会话。
- 审计与私有记忆默认保留；确认文案不宣称彻底擦除。第二轮再处理文件记忆迁移，本轮只防止从已删除来源新提取记忆。

## C3 · 本机时间与两类卡片

- R1-02 提供一个小的弹窗壳、日期/时分选择控件、本机时区读取/展示纯函数。CalendarBoard 已有焦点与弹窗能力优先提炼可复用部分，不另加组件库。
- 建议 UI 交接形状：`date: YYYY-MM-DD`、`time: HH:mm`、`timezone: IANA string`、`onChange`；内部转换复用现有 calendar-layout/routines helper，避免两套转换算法。时分可以完整选择，常用 chip 只是快捷项。
- 新建按客户端本机时区；周期规则保存创建时区，设备时区变化不静默改旧计划。UI 不常驻显示时区、ISO 或 cron。
- 普通日程是 Event，不自动执行 Bot；定时任务才保存 Schedule + actionSpec。既有 Todo/历史不删，只收起独立 UI。
- 定时任务第一版单选 Bot，执行者与接收者相同；不做跨 Bot 广播。模型默认目标 Bot，既有固定快照规则不改。修改执行 Bot 只影响后续触发，已发生运行不改归属。
- 投递采用既有主会话镜像/通知索引，补齐缺口而非新增聊天线程；通知是索引，不重复发一份消息。使用当前主会话映射，清空旧主会话不丢后续投递。

## C4 · 无感刷新

- R1-06 负责一个有界刷新 hook，R1-07 先接收 `onChanged`/`refreshKey` 等小回调，总管在后者就绪时接线；两票不可同时改同一个刷新文件。
- 本地 mutation 成功先更新相关数据，再后台核对；回到前台/重新联网补读；先复用已有通道，没有可复用通道才有界轮询，默认可见时最多每 15 秒，隐藏时停轮询。
- 一次刷新在途时合并请求；卸载/范围切换取消或按序号丢弃旧响应；刷新不重置弹窗草稿/滚动/焦点。权限失效必须立即隐藏旧数据，不能用缓存掩盖撤权。
- 不为此引入全局查询框架或跨页事件系统。具体 cache key 采用当前 Bot/source/date-window/token-scope，严禁把 token 本身写到可见日志。

## C5 · @ 与模型

- @ 菜单沿用 `/` 的键盘与焦点模型，但按光标附近 token 触发；不需要弹窗基础票。候选显示所有可用 Bot；不可在当前上下文直接路由的项给明确后续动作，不静默加入群或泄露历史。
- 群内选成员沿用现有多 @ 按序派发；群外 Bot 标示“加入后 @”，有现有显式加入链路才复用，否则不给假可执行按钮。
- 私聊/主会话选另一 Bot，最小行为为“转到该 Bot 会话并带上尚未发送的草稿”，再次发送前提示目标变化；不复制原私聊历史、不隐式建群。跨 Bot 原地委派不是本票新建协作协议。
- 稳定 botId 随候选选择保存；后端仍复核 active/成员身份，不把用户文本中的任意 `@名称` 当新授权。
- 模型只整理当前单连接 UI；不新增多 provider 路由或承诺新的模型协议。选择器保持真实可选模型与已有 Task 固定模型语义，key 不回读。

## C6 · 能力注册与 Bot 分配

仅新增缺失元数据，不做通用插件 SDK。拟议的只读能力投影：

```text
id, kind(tool|mcp|skill), name, description,
status(ready|configured|needs_auth|missing_dependency|error|disabled),
version/revision, enabledForBot, requirements, lastCheck
```

- 工具分配继续由 `ToolAccess.assignments/revoked` 决定；Skill 的 per-Bot enable 和 MCP 连接元数据可用少量独立 Harness Document。不得在配置文件/前端/数据库各留一套“真正权限”。
- 全局登记 ≠ 所有 Bot 获权；“加给 Bot A”的用户明确指令允许完成登记 + A 的绑定，其他 Bot 不变。模型不能自行把自己的管理权限加给别的 Bot。
- 启用是拥有该能力；写入模式另为 ask/allow，复用现有裁决。新导入的外部工具未知风险默认 ask，不能信任 MCP 的 readOnly/destructive 声明直接放行；用户已确认的映射才可放宽。
- 关掉后不仅隐藏 schema，后端调用/历史来源读取也须拒绝；Skill 关掉后不再注入新 prompt，原固定快照保留审计。已发出的外部请求不可假称撤回。
- 现有 Bot 保留原有效工具/ask-allow/来源。只有新 Bot 是空白业务能力、无名字推断人格、无跨 Bot 记忆；Chief 管理职责保留。旧迁移不能在重启后把新 Bot 的工具全部补回。
- UI 用 `Switch` + 同一行展示，详情才显示写入确认/依赖；设置页保留现有对外 MCP 凭证管理并清楚命名。不要用第三方连接卡替换旧凭证治理。

## C7 · MCP 配置与调用

- 第一轮支持 Streamable HTTP 的无认证/安全凭据引用配置，以及指定已安装可执行文件的 stdio；不宣称支持所有 OAuth 提供方、旧 SSE、自定义 transport、采样/roots/elicitation 等所有能力。未支持的服务端请求拒绝并给明确信息。
- 优先官方 SDK；选择兼容 Node 和项目 MCP 基线的固定版本，许可证/依赖变更由总管统一审查。新增依赖未获确认前不得安装；也不因此自行实现完整协议。
- 用户配置是数据，Agent 调受控接口写连接记录；本机进程启动必须在该请求授权范围内。`spawn` 使用 executable + argv、`shell:false`、环境白名单、超时/退出清理；不继承全量宿主环境、不执行网页提供的脚本。stdio 进程并不因此拥有文件系统沙箱，UI 如实标示信任边界。
- URL 按授权端点校验；仅明确允许的 loopback 本机服务可访问私网，不接受重定向/DNS 绕到未授权目标，不在 Agent 输出中回显凭据。
- 工具标识内部用 connectionId + original tool name，模型别名映射需稳定、防冲突、符合 provider 限制；schema/结果有大小、数量、深度上限，列表分页有界。工具清单变化新增权限不能自动授权。
- 动态 MCP tools 必须进入当前 `toolSets`、schema 展示、`checkToolCall`、policy/预算/取消和回执链；只让聊天模型“看见工具”不算接入完成。
- 连接失败、配置成功、可用、需认证分别报告；断线不自动重试未知写入。验证只握手/发现工具，或明确只读检查，不通过发邮件/改日历验证连接。

## C8 · Skill 导入与使用

- 用户给本机目录、SKILL.md 或公开仓库 URL + 指定目录；导入器解析声明式文件，不运行安装脚本/git hooks。远端固定到 commit/hash，目录选择有歧义时返回候选，不让 Agent 悄悄装整个仓库。
- 标准 SKILL.md 元数据适配到当前内部 manifest；本机内置 `server/skills/` 保持只读来源，用户 Skill 放受控 data 目录，不修改源码目录。Source + version/hash 防重复、同名不覆盖。
- 按白名单/大小/文件数/路径检查导入 references/assets；二进制 assets 不进入文本 prompt；目录/符号链接/下载跳转不逃逸。限制解析器能力，不执行 YAML tag。
- 沿用 `skills.mjs` 的按需激活、固定 Task 快照、来源及依赖检查；启用 Skill 不授予其依赖工具/来源。`allowed-tools` 或正文只是声明，不是授权。
- 第一轮无通用脚本执行器：含必要 scripts 的 Skill 显示“缺少脚本执行支持”，可以保存但不能标记为完全可用；不得删除脚本字段绕过依赖校验。
- 当前正在运行的 Task 继续其固定 Skill 内容，更新仅供后续新激活选择；撤销启用优先于旧快照。版本切换和卸载不毁掉历史审计。

## C9 · Agent 自动配置链路

建议少量明确管理工具，最终命名由 R1-01 冻结：MCP 管理、Skill 管理；Bot 分配复用现有 Bot 配置服务。不要为每个 UI 按钮再创建一套工具，也不要增加万能 shell 配置工具。

- 只有 Chief/显式获权的配置 Agent 可管理；普通 Bot 可引导用户给配置 Agent 操作，不自行升权。
- 服务层输入最少包含 operation/requestId、来源/连接配置、targetBotId、expectedRevision；服务层输出 capabilityId、状态、缺项、绑定结果及校验摘要。secret 只用 credentialRef/hasCredential，不通过模型工具参数传明文。
- 用户具体添加请求允许自动处理解析、配置和绑定；授权上下文来自真实已认证用户输入/既有确认回执，不接受模型自己传 `approved:true`。
- 缺少凭据时生成安全设置入口；用户完成后用同一操作记录续办。第一轮不新建通用 OAuth 引擎，需浏览器授权的连接明确 pending，不伪称 ready。
- 复用现有请求回执、审批/阻塞与任务恢复：检查→登记/导入→绑定→验证；只为这些必要阶段记状态，不造通用工作流引擎。失败可以重试/禁用清理，不用空壳“成功卡”掩盖配置失败。
- 更新/卸载显示影响到哪些 Bot；有其他 Bot 引用时不能无提示全局删除。停用只影响指定 Bot；全局移除需明确意图。

## C10 · 文档与测试交接

- Worker 提供局部测试/最小接线说明，必须明确未验真实供应商/操作系统/账号；总管完成跨模块回归后才更新现行 docs。
- baseline 与新验收分别记录，失败/unknown 不能清账。新接口只有实际实现和测试通过后写入 `docs/interfaces/`。
- `.env`、正式数据库、用户文件、真实 Gmail/飞书写入不作为本轮测试资源。使用临时目录/临时库、loopback 假模型、假的 MCP 服务和 Skill fixture。
- 当前用户已明确授权分票实施，主管只协调/审核/验收，集成负责人负责共享接线；SDK 安装仍待单独确认。计划自检、启动基线和局部测试均不等同产品验收。


## C11 · R1-01 首波冻结与逐波接线（2026-10-29）

**R1-01 基线/接口核查已完成，第一轮实现进行中，非完成/验收。** 当前用户授权“派遣子agent完成分票你只作为主管”覆盖旧未授权/总管亲写描述。主管只协调、审核和验收；Sagan 集成负责人独占共享入口，Worker 只写 PLAN 的独占范围。本负责人不派生子 Agent。02/04/08 均可按以下契约实施，不需等所有核心接线完成。下列为冻结的待实现交接，不是已部署 API；现行 docs 等真实接线测试通过再更新。

### 首波人员与放行

| 票 | Worker / chat ID | 状态与交接门槛 |
|---|---|---|
| R1-02 | Ohm / 01a18676-508c-7632-be92-1938466fe915 | 局部实现完成/集成待验；主管交接新 8/8 + 回归 24/24、tsc/lint；05 接第一处消费 |
| R1-04 | Averroes / 01a18676-8645-7452-99ad-49e543450fe7 | 已获主管放行；本负责人确认稳定 ID/绑定契约；App 与后端由集成负责人接 |
| R1-08 | Leibniz / 01a18676-aedb-7192-9dfd-e92f6594cdb4 | 已获主管放行；先服务 API/测试，后 UI |
| QA | Copernicus / 01a18677-5085-72d2-b104-b47d9e3bc23f | 只读准备验收，不能改实现或共享文件 |

### 02：弹窗与本机时间（确认 Worker 提案）

- `EditorDialog` default：必需 `open/title/onClose/children`；可选 `description/footer/pending/disabled/error/initialFocus/returnFocus`。复用 useDrawer 焦点机制；pending 防重复提交，关闭/取消不造成 mutation；焦点圈定、Esc、回焦、滚动锁由控件兜底。
- `LocalTimePicker` default：必需 `date/time/timezone/onChange({ date, time, timezone })`；可选 `label/mode('time')/disabled/pending/error`；值为 YYYY-MM-DD / HH:mm / IANA。mode=time 隐藏日期输入，但不丢弃受控 date/timezone。
- `local-time.mjs` 导出 `getLocalTimezone/localDateTime/localInstant/formatLocalDateTime/validateLocalRange`，精确参数与返回类型以 Worker 同步提交的 `.d.mts` 为唯一约定，消费者不可各造一套。`localInstant` 复用 `routineInstant`，不能拿 calendar-layout 的固定 UTC+8 当任意时区转换。
- 创建读客户端本机时区；编辑保留已保存时区；DST 缺失时间拒绝，重叠沿用 routineInstant 的首个 UTC；结束早于/等于开始给校验提示。不要改服务端周期算法或给旧计划改时区。
- 03/05/06/07 等 02 交付后由集成负责人验证至少两个实际消费点再推进；当前未做此项集成验收。

### 04：候选菜单与稳定目标（确认 Worker 提案）

- `ComposerSuggestions.tsx` 共用候选容器/↑↓/Enter/Tab/Esc/ARIA，一时只有 `/` 或 `@` 一个菜单持有键盘；IME 合成不消费 Enter。保留 CommandMenu 现有 props 与 Command/SkillOption 接口。
- `MentionMenu` 接收 `bots/context/draft/selectionStart/selectionEnd/inputRef/disabled/onPick`。候选有稳定 botId、名称/描述/头像、可路由状态及原因，同名附 ID；所有 active 候选可见，群外无加入链路则禁用“加入后 @”。
- 纯函数：`findMentionToken(draft, selectionStart, selectionEnd)`、`buildMentionCandidates(bots, context, query)`、`applyMention(draft, token, candidate)`、`reconcileMentions(previousDraft, nextDraft, bindings)`。`MentionPick` 含 `{ botId, action, draft, selectionStart, replacement, binding }`；binding 为 `{ botId, start, end, text }`。精确类型与 action 字面量由 Worker 在 `.d.mts` 提供，App 按该导出消费；bindings 随编辑移位、删改失效，按正文位置生成有序 targets。
- App 的逐 Task 草稿/光标/绑定、菜单互斥、私聊换目标带未发送草稿与确认提示、最终 send 由集成负责人接；不复制原私聊历史，不自动发送。
- **后端最小修正已获单独授权**：显式出现 `targetBotIds` 时它是目标权威（包括空数组），不再从显示名扩大；仍复核成员、active、协作授权、限额、requestId 幂等。没有结构化数组的旧客户端保留文本 @ 兼容；文本同名歧义拒绝，绝不 Map 覆盖任选。`groups.mjs` 和定点相关测试归集成负责人，不归 04。当前 App 未接 bindings，04 模块测试不能宣称真实路由验收通过。

### 08：分配服务（确认主管已放行签名）

```text
CapabilityProjection = { id, kind, name, description, status, revision, version,
  toolNames, requirements, lastCheck }
listBotCapabilities(tx, botId, { catalog })
setCapabilityAssignment(tx, botId,
  { requestId, expectedRevision, capabilityId, enabled, expectedCatalogRevision }, { catalog })
assertCapabilityEnabled(tx, botId, capabilityId, { catalog })
```

- kind=tool|mcp|skill；状态沿用 C6；`enabledForBot` 在 per-Bot 返回投影上提供，不能把 ready 当 enabled。catalog 是本次操作明确传入的已登记目录数据，不得从模型声明构造授权；具体容器/返回 envelope 在 08 服务 API 交付后冻结给 09/10/11，不让后继票猜实现。
- 工具启停唯一权威仍是 ToolAccess assignments/revoked；Skill 只额外保存 enable 选择，绝不能复制工具权限表。revision/目录 revision 均做精确匹配；同 requestId 同内容重放，不同内容 409；跨 Bot、停用 Bot、未登记能力、目录变化不能静默扩权。MCP/Skill 不 ready 时如实投影，不伪造连接。
- `GET/POST /api/bots/:id/configuration` 和旧 tool-groups ask/allow 语义保留；enabled 与 writeMode 分离，新 enable 不自动 ask→allow；关闭读工具也生效。新分配 HTTP 接线由集成负责人在 08 服务交付后加，不能让 UI 提前请求不存在的路由。
- 新 Bot 无默认业务工具/资源及名字推断人格，旧 Bot 的有效分配/规则/记忆不重置；旧 group migration 不得重启补满新 Bot。
- 公共 tools 中主会话 MAIN_TOOLS/automation_pause 的无条件补入由集成负责人处理：必要取消/安全停止保持系统控制，不借此回授业务工具；业务能力关闭后展示、实际调用、历史读边界一致拒绝。
- Skill `activeSkillPrompt` 实时复核与 `/skill` 依赖豁免由 10 修；08 交出分配检查，集成负责人接 tasks/tools，不能把仅隐藏 UI 当通过。
- `BotSkills` 保留现有 `token/botId/mainTaskId` 调用形状；SkillControls.tsx 仍归 10，08 不改；如需扩展只加可选 props 并先同步 10。

### 逐波接线门槛

1. 02/04/08 先在独占路径交可运行模块与局部测试；共享骨架不先重构，不引入通用插件/事件/表单框架。
2. 02 交付→集成负责人验证两处消费后放行 03/05/06/07；08 服务交付→核验旧权限兼容/新 Bot 空白/实时拒绝后冻结 catalog/envelope 给 09/10。
3. 09 只在 SDK 获准后实现 transport；10 可按登记源/分配接口推进。09/10 各自交付→集成负责人接工具目录、checkToolCall、policy、预算/取消/回执，再放 11。
4. 11→共享配置工具/结果卡接线→12 全量和双宽度验收。局部模块完成 ≠ 公共链路可用；未接线、失败、unknown、未验项目必须保留。
5. 原截图只用于视觉：名称/提示词、频率、投递、模型、取消/保存可复用；cron 输入和平台投递被用户后续需求覆盖，必须本机卡片选时 + 单选 Bot（执行=接收），不是照抄截图。

### 核心接入点与共用 fixture

- `app.mjs:createApiServer` 是认证 HTTP 路由；`tasks.mjs:openTaskStore/chatDefinition` 是唯一 Harness 装配与派发。
- tools 的 `installed/toolSets/toolDefinitions/checkToolCall` 当前静态登记；动态工具后续必须进入四处及实时分配、policy REGISTERED_TOOLS/decide 与回执，不能只给模型看 schema。
- `main-session.mjs:MainSessions/ensureMainSession/mirrorToMain/reconcileMainChildren` 维护主会话及结果镜像；会话删除 Worker 从 `session-lifecycle.mjs` 交服务，由本负责人接 TaskArchive/读取过滤/记忆来源，不新增会话库。
- `skills.mjs:SKILL_DIRECTORY/skillCatalogForTask/executeSkillTool/activeSkillPrompt/commandSkills` 是内置来源/快照/激活入口；用户 Skill 已由 10 通过 `skillDirectory.userSkills` 追加受控来源，生产入口在数据库同级 `skills` 目录持久化，不覆盖源码内置目录。
- `tasks.mjs` 的 managementHooks 和 `tools.mjs` 的管理注册是 11 的最小配置挂点；不另造管理运行时。结果卡由 App 现有 SystemCard/SkillControls 边界消费真实回执。
- 现有 `server/fixtures/authorized-task-store.mjs:openTaskStore/assignCapabilities` 可供局部单测；Bot 配置测试已有 mkdtemp/临时 SQLite/清理；loopback 模型参考 model-settings/model-selection 测试。无需现在新增 r1-test-support；授权 fixture 只用于旧测试，不用它证明空白 Bot 默认权限。MCP SDK 假服务 fixture 留 09 实现，不手写完整协议。

### 共享文件锁（2026-10-29 最新主管授权，按责任人串行写）

- 历史前端五文件 owner 为 Huygens（01a18687-5e97-7170-8bf4-c04d748c1125）。本轮主管复核未发现旧 owner 在运行，现将 `my-app/src/App.tsx` **仅会话生命周期接线范围**交 `finish_skill_ui_tests` 独占；保留既有改动，不扩展到其他前端实现。`SettingsPage.tsx`、`App.css`、`index.css`、`shell.css` 本轮不改。
- 本轮 `tasks.mjs`/`app.mjs` 的主会话清空生产接线与同域集成测试交 `finish_capability_tests` 独占；正式文档及执行记录交 `finish_r1_docs`。这是主管的本轮范围调整，不代表整票已完成或旧共享文件可以任意并写。
- 后端：`my-app/server/app.mjs`、`index.mjs`、`tasks.mjs`、`tools.mjs`、`policy.mjs`、`main-session.mjs`；本次追加 `groups.mjs` 与定点回归 `r1-group-targets.test.mjs`。这些后端相对名均位于 `my-app/server/`。
- 依赖：`my-app/package.json`、`my-app/pnpm-lock.yaml`；本次 SDK 1.32.2/Zod 4.6.7 已获用户确认并由 finish_capability_tests 安装成功，依赖改动已冻结；其他依赖仍须另行确认。
- 文档与计划：`docs/**`、`NEXT_STAGE.md`、`plans/**`（含本目录执行记录）；保留已有内容，不让 Worker 各改一份。
- 条件新增共用 helper：`my-app/server/r1-test-support.mjs`（仅现有 helper 真不足时，本阶段不创建）。
- 其他文件仍按 PLAN 各票独占；新增路径需先协调，严禁通过改共享 fixture/源码给空白 Bot 暗授权限。

### 历史窄范围恢复状态

groups 显式目标权威/旧文本同名拒绝已实现，7 新定点 + 旧群回归 19/19，定点 lint 通过；04 的 App 菜单到发送仍待接线，不宣称端到端完成。02 局部实现完成但集成待验，pending 在途锁关闭；unknown 应 pending=false/disabled=true，并留原 requestId 查询动作。主管安排同 Worker 做 05 首个消费。当时 08 共享真实启停执行链未接；现已完成静态启停及主会话独立权限投影，当前状态见下节。此处 SDK/Zod 未批准为历史状态，已被本轮两个固定版本的安装授权覆盖。

### 能力 HTTP 与后续共享接线现状

已接 `GET/POST /api/bots/:botId/capabilities`（认证、`{ data }`），POST精确沿用08的requestId/expectedRevision/capabilityId/enabled/expectedCatalogRevision；GET返回botId/revision/items。共享store导出getBotCapabilities/setBotCapabilityAssignment；09/10可信注入点为openTaskStore({ readCapabilityCatalog: async (tx, { botId }) => projections })，默认[]由08合静态目录，禁止HTTP提交catalog。最初 7 个 HTTP 用例、联合 33/33 和定点 lint 通过。后续已接 tools/tasks 的静态启停与 legacy 主会话独立 mainAssignments 投影；新 v2 Bot 无隐式授权，撤销优先。10 用户 Skill 已接生产受控目录、任务上下文、能力目录和五个认证管理路由，删除影响 Bot 由服务端当前绑定计算，正式 HTTP 2/2 通过。普通会话删除和请求状态查询已接生产；本轮已接 clear-main 生产路由、stopMain/createMain adapter 和 App callback；后台结果换新窗口持久交接、直接协作等待后续跑、删除来源过滤、连续清空/重启去重均已通过边界回归，真实换新/删除/重启主路径在临时库验证。03 已实现自测，本轮源码已冻结；R1 整体仍未完成/未验收。02/04 真实 UI 与完整端到端状态须以本轮独立验证为准，不能仅据接口或模块用例宣称完成。`my-app/server/r1-capability-http.test.mjs` 仍归集成负责人。

### 本轮冻结结果与剩余边界

最终冻结源码全量 1304/1304，lint exit 0（13 条 React warning），build exit 0（606.72 kB JS chunk 提示），diff 检查通过。会话边界 22/22 及此前 87/87 不累计为独立总数。stop/swap 窗口内的后台结果通过持久 pendingMirrors 交接一份，不复制旧聊天；直接协作子任务等待主映射替换后继续，普通 cancel、root stop 和实时撤权仍有效。当前主会话 task_status 排除删除来源，digest 以实际来源和当前权限复核；连续清空及重启保留去重。上述本轮所有权范围完成后冻结，不表示剩余票可任意并写。09 SDK/Zod 固定版本已批准并安装，transport 安全适配/生产接线待完成；11 完整配置闭环、12 总端到端及最终用户验收仍未完成。

### 新一轮固定依赖安装授权

2026-10-29 用户明确回复“安装”，已批准并完成 `@modelcontextprotocol/sdk@1.32.2` + `zod@4.6.7` 两个固定版本的安装，本安装小单元已完成并冻结。`finish_capability_tests` 使用 `pnpm add --save-exact @modelcontextprotocol/sdk@1.32.2 zod@4.6.7 --ignore-scripts`；精确版本列表、Client/StreamableHTTPClientTransport/StdioClientTransport/zod 导入及 frozen-lockfile 校验均成功。安装后已重新实际运行：test **1304/1304**、0 fail/cancel/skip；lint exit 0（13 条 React warning），build exit 0（606.72 kB JS chunk 提示），diff check 通过。安装阶段 configured/缺安全适配器是历史状态；本轮 09 已装配官方 SDK 服务、认证管理和真实 Harness 动态工具链，等待主管最终 UI/集成核验；R1-11 完整配置闭环、R1-12 总端到端及用户验收仍未完成。

上一轮冻结基线和本轮依赖安装后独立重跑均为 1304/1304；本轮日志为 `/tmp/pidot-r1-sdk-install-{test,lint,build}.log`，不只沿用旧基线。


## 当前验收依据

现行产品/架构/HTTP/MCP文档已同步真实Host、动态目录、空白Bot、会话换新及启停/确认边界；本文其余波次与安装等待记录保留为实施历史。逐票状态及历史失败/未验统一见[ACCEPTANCE.md](ACCEPTANCE.md)；最终1395和核心1440/375、同库API重启、输出检查/清理已完成，1391保留为修复前历史快照。仅用户验收未完成，不移done。
