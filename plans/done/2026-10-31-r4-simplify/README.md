# 第四轮计划：降低使用负担（机器人能力三栏、对话、设置与文案）

> **2026-11-01 未验收即归档。** 新建默认能力被 [ADR-023](../../../docs/decisions/README.md#adr-023-普通-bot-地位相同默认空白创建) 改为空白，历史回读被 ADR-025 改为默认自带；其余界面与权限收简仍是现行做法，见[能力与权限](../../../docs/architecture/capabilities.md)。以下正文保留当时的记录。

状态：**实现完成，待用户验收**（2026-10-31，Asia/Shanghai）。用户选定全部决定，要求“一轮做完”；主管统筹六个子 agent 按完整模块交付，实际结果见 §8。基线：`9e4200d`（第三轮实现完成、待用户验收，与本轮并行，见 D11）。

后续调整：2026-11-01 用户要求普通 Bot 地位相同、默认空白创建，本计划的新建默认能力由 [ADR-023](../../../docs/decisions/README.md#adr-023-普通-bot-地位相同默认空白创建) 替代；实施与验证见[后续计划](../../active/bot-equality/README.md)。下文保留第四轮当时的决定和验证记录。

依据（用户原话）："bot设置来源那一块和 mcp 那一块要改动来源那一块没啥意义了 mcp 改为开关即可不需要那么麻烦细化的管理了"；"不止这些现在用户心智负担还是大"。改动前的走查截图与可见文字在 `.scratch/2026-10-31-load-audit/`（本机，不进仓库）。

本目录：
- `README.md`（本文）：执行规则、决定、验收、工作票与文件归属、汇报格式、常见问题预答。
- [CONTRACTS.md](CONTRACTS.md)：服务端现状事实、逐项改法、一次性迁移、前后端接口、测试改法、ADR-022 草稿与文档清单。
- [UI.md](UI.md)：前端每张票的页面结构与行为。
- [COPY.md](COPY.md)：文案规则、禁用词、新旧文案对照。
- [ui-audit.mjs](ui-audit.mjs)：验收走查脚本（临时库 + 脚本模型 + 两种宽度）。

## 0. 执行规则（先读）

**只有下面两种种情况停下来问用户**，其余一律按本计划直接做：

1. 计划内两处规定互相矛盾，新需求默认覆盖旧需求。只有架构大方向冲突才询问
2. 全量测试出现与本轮改动无关的失败（先 `git stash` 在基线上复跑确认）排查问题再修复。排查不了询问

本计划没写到的细节：选改动更少、更简单的做法，在 `.scratch/r4-simplify/decisions.md` 记一行（做了什么、为什么），继续往下做，不为此停下。

**不做防御性编程**（用户明确要求）：
- 不新增任何确认弹窗、二次确认或"确定吗"提示。已有的两处 `window.confirm`（停用机器人、移除 MCP 连接）和审批卡保持原样。
- 不加功能开关、兼容层、旧路由或旧 hash 别名、回滚开关。唯一的启动选项是 CONTRACTS §5 的 `r4Migration`。
- 不为不会出现的输入加校验、兜底分支、重试或吞错误的 `try/catch`；只在 CONTRACTS 写明的地方报错。
- 被替换的组件、函数、样式、测试直接删除，不保留死代码，不写 "deprecated" 注释。
- 新测试只覆盖 CONTRACTS §7 与 UI.md 各票"测试"一栏列出的行为，不为假想边界写测试。
- 不顺手重构或修与本轮无关的旧问题；发现了记进 `.scratch/r4-simplify/followups.md`。
- 迁移只做 CONTRACTS §5 列出的步骤，不写自动备份或回滚代码；备份由用户在升级前手动复制库文件（写进运行手册）。
- 可以新增或升级依赖 可以读写 `my-app/data/`、`my-app/.env`、项目根 `.env`，或访问真实外部账号与网络。
**冲突优先级**：用户决定（§1）> 本计划正文 > 现有 `docs/` 与 ADR > 现有测试。旧 ADR 与本计划冲突的部分由 ADR-022 替代（CONTRACTS §8），不要拿旧 ADR、旧不变式或旧测试来反驳本计划。

**旧测试怎么处理**：
- 断言本计划改掉的旧行为（新机器人空白、来源逐个分配、重连不恢复分配、日程和待办分两组确认、旧文案）：改成断言新行为。
- 断言本计划删除的东西（`switchGroup`、组的 `mode`/`switchable`、`/tool-groups/` 路由、`tool:calendar`、旧 tab、`BotRules`/`CapabilityList`/`BotSkills`）：删掉这些断言或用例。
- 读 `.tsx` 源码做字符串匹配的前端测试：改成新文案或新结构；元素已删除的断言删掉。
- 与本轮无关的断言不放宽、不删除。

**提交**：先把本目录和 `plans/README.md`、`NEXT_STAGE.md` 的未提交改动单独提交一次（"第四轮计划"），再开工。之后只在本地 `main` 上提交：不推送、不建分支、不改 git 配置；每张票一个提交，主题以票号开头（如 `R4-01 …`）。

**子 agent**：按 §4 的波次派发，一票一个 agent，文件独占。W1 期间子 agent 只跑本票"测试"列的命令，不跑全量 test/build（其他票还在改）。子 agent 交回后，主管核对本票测试结果和越界情况就推进下一步，中途不向用户汇报、不等确认，全部做完后按 §6 汇报一次。

## 1. 用户已定的决定

D1–D11 是用户在选项里点选的答案；D12–D15 是主管提出、用户没有反对的默认做法。

| 编号 | 决定 |
|---|---|
| D1 | 来源跟着工具集走：开了「日程与待办」就能用所有已连接的日历和任务列表；某个机器人要少用某个来源，在它的「设置 → 高级」里关掉。 |
| D2 | 完全去掉「先问 / 直接做」：工具集只有开关，写入一律直接执行；只有全局暂停时改为先问。 |
| D3 | 新机器人默认开「日程与待办」「历史与回读」，MCP 和 Skills 默认关；创建页上都能改。 |
| D4 | 点机器人直接进对话，齿轮进设置；设置页只有「能力 / 记忆 / 设置」三栏。 |
| D5 | 技术信息（请求参数、配置历史、调用上限、时间线、requestId 等）保留，折叠到所在页面底部的「技术信息」。 |
| D6 | 界面上统一叫「机器人」（Chief 仍叫 Chief）。 |
| D7 | 本轮全部一次做完，用户只验收一次。 |
| D8 | 「日历与日程」「待办与事项」合并成「日程与待办」一个开关；已有机器人只开了其中一半的，升级时自动补全。 |
| D9 | 升级时，已开着日程或待办工具的机器人自动拿到所有已连接的日历和任务列表；其余机器人等打开「日程与待办」时再拿到。 |
| D10 | 「模拟日程」从界面上彻底去掉；后端代码和测试保留。 |
| D11 | 现在就在当前 `main` 上开工；用户验收第三轮发现的问题，修完再叠加上去。 |
| D12 | 能力目录只列本机已装、已连接的 Skill、MCP 和内置工具集，带搜索；不做在线技能市场，不做"插件 / Connectors"栏。 |
| D13 | 开了任何一个 Skill，自动带上加载 Skill 所需的工具；界面上不单列「Skills」工具集。 |
| D14 | stdio 凭证签发从机器人页移到「设置 → 高级」，功能不变；全局 MCP 连接管理只改文案和位置。 |
| D15 | 系统级权限（自动化控制、机器人管理）不出现在能力页开关里；Chief 的能力页也不显示「能力配置」（Chief 天生持有）。 |

## 2. 目标与验收

用户要记住的只有五样：机器人、对话、事项（日历 / 定时任务 / 执行记录）、通知、设置。验收清单：

1. 新建机器人：名字必填，「负责什么」可选，模板一排可点；「高级」里是 Skills / MCP / 工具集三栏开关，「日程与待办」「历史与回读」已经开着。建完直接进对话，能读写本地日程和待办。
2. 机器人设置只有「能力 / 记忆 / 设置」三栏；「能力」= Skills / MCP / 工具集三个子栏，每行一个开关，带搜索。
3. 界面上找不到：「每次先问 / 直接执行」下拉、「写入确认」、按来源逐个开关的「来源」区（只剩「设置 → 高级」里的收窄开关）、「模拟日程」、机器人页的「工具 / Skills / MCP / 任务」tab。
4. 对话页标题栏只有：标题、状态（空闲时不显示）、归档（非主会话）、齿轮、ⓘ。工具调用和回执用中文工具名，不出现 `mcp_<hash>` 或英文工具名。每条回复下不再有「请求参数」。
5. 设置页五块：连接（飞书 / Google / MCP 同一列表）、模型、自动化、偏好、高级（stdio 凭证 + 技术信息）。
6. 事项页三个 tab：日历、定时任务（列出所有机器人的定时任务）、执行记录。通知页只有「需要你处理」「提醒」两块。
7. `ui-audit.mjs --label after` 退出码 0：两种宽度无横向溢出，可见文字无禁用词，结构检查全过，除允许列表外无失败请求和页面错误。
8. `pnpm test`、`pnpm lint`（不新增 warning）、`pnpm build` 通过；文档与 ADR-022 已更新。

## 3. 不做

- 在线技能市场、插件、Connectors；Skill 导入仍只走对话。
- 模型侧提示词和工具说明，除 CONTRACTS §3.3 列出的几句与"去掉先问"矛盾的话。
- `policy.mjs` 的 `decide()` 规则引擎、审批卡流程、「以后直接做」、全局暂停、无人值守跳过。
- 服务端错误信息里的 "Bot" 字样；只改 CONTRACTS §4.8 列出的、显示在界面上的服务端字符串。
- Google / 飞书授权流程本身（只挪位置、改文案）；服务器部署；真实账号或真实模型手测；`plans/done/` 下任何文件。

## 4. 工作票、波次与文件归属

### 4.1 波次

- **W0（主管）**：提交计划；在 `my-app/` 下跑 `pnpm test`、`pnpm lint`、`pnpm build` 记录基线（上次为 test 1531/1531、lint 11 条既有 warning、build 通过）；跑 `node ../plans/done/2026-10-31-r4-simplify/ui-audit.mjs --label before` 留改前截图（结构检查失败是预期）。
- **W1（6 个子 agent 并行）**：R4-01 … R4-06。前端各票按 CONTRACTS §6 与 UI.md 写死的接口直接写，不等 R4-01。
- **W2（主管）**：改 §4.3 的共享测试；清理共享样式里不再使用的选择器；按 CONTRACTS §9 改文档和 ADR；全量 test / lint / build；`ui-audit.mjs --label after` 直到退出码 0；提交；按 §6 汇报。W2 里为修全量测试或 `ui-audit.mjs` 查出的问题，主管可以改任何文件（仍守 §0 的规则）。`ui-audit` 只报"提示"、没有失败时，主管对照提到的截图看一眼，没问题就算过。

### 4.2 每票独占的文件与测试命令

未列出的文件谁都不改；确实需要改的，在交接说明里写清楚，由主管在 W2 改。改了 `.mjs` 就同步改对应的 `.d.mts`。

| 票 | 内容 | 独占文件 | 测试命令（`my-app/` 下） |
|---|---|---|---|
| R4-01 服务端 | 合并工具集、去掉写入确认、来源跟着工具集、Skill 工具自动带上、带能力创建、`GET /api/capabilities`、`r4Migration`、服务端文案（CONTRACTS §2–§5、§7） | `server/` 下所有非测试文件（含 `server/fixtures/`）；`server/*.test.mjs`（`server/workspace-ui.test.mjs` 除外）；新文件 `server/resource-sharing.mjs`、`server/r4-migration.mjs` 及其测试 | 见表下 |
| R4-02 能力组件与创建页 | 能力三栏组件、机器人能力 tab、新建机器人页（UI.md R4-02） | 新：`src/CapabilityPicker.tsx`、`src/BotCapabilities.tsx`、`src/bot-capabilities.mjs`、`src/bot-capabilities.d.mts`、`src/bot-capabilities.test.mjs`；改名：`src/capability-list.css` → `src/capabilities.css`；改：`src/BotCreation.tsx`、`src/SkillControls.tsx`；删：`src/BotRules.tsx`、`src/CapabilityList.tsx` | `node --test src/bot-capabilities.test.mjs` |
| R4-03 设置页、目录与侧栏 | 三栏设置页、目录卡片、侧栏与记忆页文案（UI.md R4-03） | `src/BotTemplatePage.tsx`、`src/BotConfiguration.tsx`、`src/bot-directory.mjs`、`src/bot-directory.d.mts`、`src/bot-directory.test.mjs`、`src/BotDirectory.tsx`、`src/bot-directory.css`、`src/ShellSidebar.tsx`、`src/SessionActions.tsx`、`src/session-list.mjs`、`src/session-list.d.mts`、`src/session-list.test.mjs`、`src/session-actions.css`、`src/BotMemory.tsx`、`src/MemoryDocuments.tsx`、`src/memory-helpers.mjs`、`src/memory-helpers.d.mts`、`src/memory.css`、`src/BotAvatar.tsx`、`src/botLook.ts` | `node --test src/bot-directory.test.mjs src/session-list.test.mjs` |
| R4-04 对话页与路由 | 机器人路由、标题栏、消息与回执、输入框「⋯」、详情抽屉、状态文案、`.tech-info` 全局样式、新会话与群聊文案（UI.md R4-04） | `src/App.tsx`、`src/App.css`、`src/shell.css`、`src/index.css`、`src/taskStatus.ts`、`src/ModelPicker.tsx`、`src/TaskApprovalControls.tsx`、`src/CapabilitySetupCard.tsx`、`src/capability-setup.mjs`、`src/capability-setup.d.mts`、`src/capability-setup.css`、`src/system-cards.mjs`、`src/system-cards.d.mts`、`src/SystemCard.tsx`、`src/TaskTimeline.tsx`、`src/timeline.mjs`、`src/timeline.d.mts`、`src/TaskBlockerControls.tsx`、`src/TaskCancellationControls.tsx`、`src/TaskConfigurationMigration.tsx`、`src/WaitingRecoveryNotice.tsx`、`src/ActionOutcomeControls.tsx`、`src/CollaborationOverview.tsx`、`src/CollaborationPanel.tsx`、`src/SharedInformationPanel.tsx`、`src/GroupTaskBoard.tsx`、`src/GroupIssueControls.tsx`、`src/GroupCreation.tsx`、`src/NewSession.tsx`、`src/MainSession.tsx`、`src/CommandMenu.tsx`、`src/commands.mjs`、`src/commands.d.mts`、`src/MentionMenu.tsx`、`src/mentions.mjs`、`src/mentions.d.mts`、`src/ComposerSuggestions.tsx`、`src/composer-suggestions.css`、`src/capability-setup-ui.test.mjs`、`src/r1-composer-integration.test.mjs`、`src/mentions.test.mjs` | `node --test src/capability-setup-ui.test.mjs src/r1-composer-integration.test.mjs src/mentions.test.mjs` |
| R4-05 事项与通知 | 事项三 tab、统一定时任务列表、通知两块（UI.md R4-05） | `src/UnifiedWorkspace.tsx`、`src/workspace-navigation.mjs`、`src/workspace-navigation.d.mts`、`src/BotRoutines.tsx`、`src/routines.css`、`src/ScheduleWorkspace.tsx`、`src/InboxPage.tsx`、`src/ReminderWorkspace.tsx`、`src/CalendarBoard.tsx`、`src/CalendarView.tsx`、`src/calendar.css`、`src/LocalWorkspace.tsx`、`src/LocalTimePicker.tsx`、`src/calendar-accessibility.test.mjs`、`src/workspace-refresh.test.mjs` | `node --test src/calendar-accessibility.test.mjs src/workspace-refresh.test.mjs` |
| R4-06 设置与连接 | 设置五块、连接合并列表、stdio 移到高级（UI.md R4-06） | `src/SettingsPage.tsx`、新 `src/settings.css`、`src/WorkspaceStatus.tsx`、`src/ExternalWorkspace.tsx`、`src/FeishuCalendarPanel.tsx`、`src/ExternalSync.tsx`、`src/WorkspaceIdentity.tsx`、`src/GoogleConnection.tsx`、`src/GoogleWorkspaceMcpStatus.tsx`、`src/google-connection-ui.mjs`、`src/google-connection-ui.d.mts`、`src/google-connection.css`、`src/google-workspace-mcp-ui.mjs`、`src/google-workspace-mcp-ui.d.mts`、`src/google-workspace-mcp.css`、`src/ExternalMcpConnections.tsx`、`src/external-mcp-client.mjs`、`src/external-mcp-client.d.mts`、`src/mcp-connection.css`、`src/McpCredentialForm.tsx`、`src/StdioCredentials.tsx`、`src/AutomationControls.tsx`、`src/Findings.tsx`、`src/ModelSettings.tsx`、`src/model-settings.css`、`src/UserPreferences.tsx`、`src/external-mcp-ui.test.mjs`、`src/google-connection-ui.test.mjs`、`src/r3-05-workspace-mcp-ui.test.mjs` | `node --test src/external-mcp-ui.test.mjs src/google-connection-ui.test.mjs src/r3-05-workspace-mcp-ui.test.mjs` |

R4-01 的测试命令（排除读前端源码、W1 期间会被别的票改动的 `workspace-ui.test.mjs`）：`node --test $(ls server/*.test.mjs | grep -v workspace-ui)`。

固定不变的导出（别的票依赖）：`src/model-settings-ui.mjs` 的导出签名（R4-04 的 `ModelPicker` 用）；`src/routines.mjs` 的导出签名（R4-05 用）；`server/` 的 HTTP 响应形状以 CONTRACTS §6 为准。

### 4.3 共享测试（只由主管在 W2 修改）

子 agent 可以运行它们看失败，但不改；把需要的改动写进交接说明。

| 测试 | 读到谁的文件 |
|---|---|
| `src/capability-session-ui.test.mjs` | R4-02（`BotRules.tsx` 已删）、R4-03 |
| `src/memory-ui.test.mjs` | R4-03、R4-06 |
| `src/model-settings-ui.test.mjs` | R4-04（`ModelPicker`）、R4-06（`ModelSettings`） |
| `server/workspace-ui.test.mjs` | R4-04（`App.tsx`）、R4-05（`UnifiedWorkspace.tsx`） |
| `src/routines.test.mjs`、`src/r1-session-ui-integration.test.mjs`、`src/memory-api.integration.test.mjs` | 会起服务端，受 R4-01 影响 |

## 5. 子 agent 交接说明（每票一份，写进 `.scratch/r4-simplify/R4-0x.md`）

1. 改了哪些文件（应全部在本票独占范围内；越界的逐个说明原因）。
2. 本票测试命令和结果（通过数 / 失败数，失败的贴断言）。
3. 共享测试（§4.3）需要怎么改：文件、断言、改成什么。
4. 写进 `decisions.md` 的条目。
5. 没做完或做不到的，原因。

## 6. 最终汇报（主管给用户，中文，一次）

1. 一句话结论。
2. 用户能看到的变化，按页面列，不按文件列。
3. 验证：test / lint / build 的实际数字；`ui-audit.mjs --label after` 的结果和截图目录；没手测的照实写"未手测"。
4. 和计划不同的地方（`decisions.md` 摘要）；遗留问题（`followups.md` 摘要）。
5. 用户要做的事：升级前停掉服务，复制整个 `my-app/data/` 目录做备份；之后第一次 `pnpm start:api` 会自动迁移一次；按 §2 的清单验收。

## 7. 常见问题（已预先回答，照做，不用再问）

| 问题 | 答案 |
|---|---|
| 旧 hash `#bot=x&tab=rules / skills / mcp / tasks` 要兼容吗？ | 不要。`readBotTab` 对未知 tab 返回 `chat`，等于进对话。 |
| 旧 ADR 或旧测试和本计划冲突？ | 按 §0 的优先级和"旧测试怎么处理"改。 |
| 迁移要写回滚或备份吗？ | 不要。 |
| `BotRules.tsx`、`CapabilityList.tsx`、`BotSkills` 留着以后用？ | 删。 |
| 服务端错误信息里的 "Bot"、模型侧说明里的「Bot」「例行任务」要改吗？ | 不改。只改 CONTRACTS §3.3 和 §4.8 列出的句子。 |
| 去掉写入确认后 `PolicyRules`、`decide()`、`setGroupMode`、`openGroup` 还留吗？ | 留，不改。只删组的开关接口（CONTRACTS §3.2）。 |
| 审批卡上的「以后直接做」？ | 不动。 |
| 组件里已有的 `AbortController`、`requestId` 重试、`mounted` 守卫要删吗？ | 不删；那是现有的正确行为，不是新增防御。新组件照搬同样写法（`BotCapabilities` 复用 `BotRules.tsx` 的 `save()` 逻辑）。 |
| Chief 的能力页显示「能力配置」吗？ | 不显示（D15）。 |
| 收窄过的来源断开后，要清理 `excludedResources` 吗？ | 不清理，不影响行为。 |
| 飞书重新绑定后旧 `feishu:` 资源 id 变了，收窄失效？ | 不处理，写进 ADR-022 的已知限制。 |
| 创建时选的 Skill 或 MCP 不可用？ | 整个创建失败，页面显示服务端错误原文；不做部分成功。 |
| 能力页搜索要拼音或模糊匹配吗？ | 不要。名称或说明包含关键字即可，不区分大小写。 |
| 375px 下三栏怎么排？ | 子栏是一行可换行的 tab，列表单列。 |
| 「技术信息」要做成组件吗？ | 不要。统一写 `<details className="tech-info"><summary>技术信息</summary>…</details>`，样式由 R4-04 放在 `index.css`。 |
| 要真实模型手测吗？ | 不要。只跑 `ui-audit.mjs`（脚本模型）。 |
| 第三轮 Google 还在待验收，会冲突吗？ | R4-06 只改 Google 组件里命中禁用词的句子；授权流程不改。第三轮计划仍留在 `active/`。 |
| 发现和本轮无关的 bug？ | 记进 `followups.md`，不修，除非它挡住本轮验收。 |
| lint 新增 warning？ | 不允许新增；既有的不处理。 |
| 迁移什么时候作用到用户正式库？ | 用户下次自己运行 `pnpm start:api` 时（`server/index.mjs` 传 `r4Migration: true`）。执行方不启动正式库。 |
| 定时任务列表要分页或按机器人分组吗？ | 不要。一个列表，每行标机器人名。 |
| 创建页选模板要设颜色和形状吗？ | 不要。外观按 id 自动生成（`botLook.ts` 的 `defaultLook`），之后在「设置 → 外观」改。 |
| 「外观」（颜色、形状、显示标签）还留吗？ | 留，在「设置」tab 顶部。 |
| 新会话页的「群聊」入口、`/` 命令里的对话 / 时间线切换？ | 都留。 |
| 迁移把用户手动关掉的日程类工具又打开了？ | 符合 D8：合并后只有一个开关，开着其中任何一个工具就补全整组。 |
| Chief 用 `bot_manage` 创建的机器人？ | 默认能力同 D3。 |
| `capabilityDefaultsVersion` 要升到 3 吗？ | 不升，保持 2。 |
| `StdioCredentials` 的 `fixedBotId` 参数不再有人传？ | 不删，它是可选参数。 |
| `GET /api/capabilities` 要分页吗？ | 不要。 |


## 8. 实施与验证记录（2026-10-31）

R4-01 … R4-06 已完成，计划先单独提交，再在本地 `main` 按票提交；未推送、未建分支。R3 继续留在 active 待用户验收。本轮产品决定无范围变化，主管负责接口、范围、正式文档/ADR-022 与最终验收；W2 共享测试整块复用已完成的 agent 执行，避免主管下沉拆碎模块。

| 模块 | 已交付 | 本票定向检查 |
|---|---|---|
| R4-01 | 合并 todos、来源随工具集/单机器人收窄、默认及指定能力创建、Skill 机制工具、全局目录、一次迁移 | 1340/1340 |
| R4-02 | Skills/MCP/工具集三栏、能力搜索/保存、新建模板与高级能力 | 3/3 |
| R4-03 | 能力/记忆/设置三栏、目录进对话/齿轮设置、记忆与侧栏文案 | 13/13 |
| R4-04 | 路由、精简标题/输入框、中文工具结果、详情/技术折叠 | 54/54 |
| R4-05 | 日历/定时任务/执行记录、统一列表、通知两块 | 24/24 |
| R4-06 | 五块设置、同一连接列表、stdio 移至高级、连接摘要 | 22/22 |
| W2 共享收口 | 既有共享测试同步新结构与文案、helper 文案/静态 warning 清理 | 56/56 |

上述定向数字不是相加后的独立覆盖数。最终统一验收：
- `pnpm test`：**1537/1537 通过，0 fail / cancelled / skipped**（基线 1531/1531）。首轮仅 `server/routines.test.mjs` 仍断言旧事件标签，已只同步新文案并全量复跑通过；无放宽无关断言。
- `pnpm lint`：退出 0，**10 条基线既有 warning、0 新增**（基线 11）。删除两个失效测试 helper 与创建页重复 state 重置后收口，未抑制规则。
- `pnpm build`：退出 0，TypeScript 与 Vite 通过；保留既有大于 500 kB 的 chunk 提示，不扩展做性能重构。
- `node ../plans/done/2026-10-31-r4-simplify/ui-audit.mjs --label after`：退出 **0**，1440/375 两宽度共 **22 个画面**；无横向溢出、禁用词、结构失败、非白名单失败请求或页面错误，无人工提示项。已目视检查能力页、对话、定时任务、手机创建和手机设置截图。
- 截图与机器结果：`.scratch/r4-simplify/audit/before/`、`.scratch/r4-simplify/audit/after/`；日志与逐票交接在 `.scratch/r4-simplify/`（本机留存，不进仓库）。
- 真实模型、Google / 飞书真实账号：**未手测**。全部自动验证使用临时库与脚本模型；**正式库未启动、未迁移**。

实施细节：飞书连接摘要补 `calendarName`，直接投影现存绑定的 summary，不新增请求/授权；不存在 Skill 的回归用合法 ASCII id `skill:missing` 测 404，非 ASCII 按冻结输入正则返回 400；不新增兼容层、确认、回滚或计划外测试。

范围外留项：`server/management-tools.mjs` 仍有旧默认/写入模式的模型工具说明，依 §3 的明确不做边界留后续统一；生产创建与权限路径已经改为 R4 行为。飞书换绑生成新 id 后旧 id 收窄不继承，是 ADR-022 已记录限制。

**用户下一步**：停掉服务，复制整个 `my-app/data/` 做手动备份，再启动 `pnpm start:api` 自动迁移一次，按 §2 清单验收；无需再次同意实施。升级流程见[运行手册](../../../docs/engineering/operations.md#第四轮升级r4)。
