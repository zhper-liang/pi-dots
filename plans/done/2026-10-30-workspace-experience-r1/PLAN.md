# 第一轮工作票（12 票）

> 本文保留原始分票、验收要求与启动时状态。当前代码/本地核心验收及材料已完成、待用户验收；逐票未验/最终1395和失败修复以[验收材料](ACCEPTANCE.md)为准；首波“局部/未完成”记录属于历史，不自动覆盖最新交付。

> 状态：2026-10-29 用户已授权分票实施，**实现进行中**。R1-01 基线/首波冻结已交付，02/04/08 已放行，12 未完成。主管只协调/审核/验收，Sagan 集成负责人拥有原共享文件锁；旧“未授权开工/集成负责人亲写”不再适用。先读 README 与 CONTRACTS C11。
>
> 每票都交实际实现和验证，不以截图、mock UI 或未接线模块充数。文件名带「新增」的是拟议输出；现有公共入口由集成负责人独占，禁止 Worker 为图方便直接改 App/tasks/tools/policy。

## 通用派发约束

- 继承仓库 AGENTS/AGENT、NEXT_STAGE 和本目录契约；保留已有未提交改动，不访问 `.env`、正式 data 或真实账号；不自行安装依赖、提交、推送。
- 只编辑自己的独占文件，读其他文件不限。需要公共接线时给集成负责人导出签名、调用位置和最小说明，由集成负责人修改并验证。
- 新增测试与模块同域；共享 fixture 由 R1-01 集成负责人建立，Worker 自己的 fixture 放独占测试里。测试从 `my-app/` 执行，不重用生产路径。
- “完成”包含：主路径可工作、故障不假成功、权限不过界、局部测试通过、交接清楚。消费者票必须在依赖已合入的版本上验证，不能只靠类型约定推断。
- S/M/L 表示相对复杂度，不承诺分钟数；M/L 票可在同一 Worker 内分两次交付，不能未经协调再拆出重叠写入子任务。

### R1-01 交接契约与核心接入点

**负责人：Sagan 集成负责人；状态：R1-01 基线/契约阶段已交付；复杂度 M；依赖：无；对应所有后续票。**

**交付**
1. 启动时确认当前基线、工作树与用户授权；记录当前测试/lint/build 结果。把 CONTRACTS 中的默认行为和接口交接落实到实际源码，必要时收窄并先说明。
2. 确认当前删除过滤、主会话映射、动态工具列表/派发、Skill 来源、配置工具注册的位置，建立最小接入约定；只补确需的函数参数/适配器，不先大规模抽取 tasks.mjs。
3. 确认可复用的临时库、loopback 假模型/MCP 测试方式；集成负责人负责缺少的共用 fixture 和整个第一轮依赖变更。
4. 确定 MCP SDK 是否可复用现有依赖；若必须新增，列出固定包、用途、许可及影响，得到授权再装。不以手写完整协议规避依赖确认。

**复用**：现有 Task/Harness commit、`ToolAccess`、`policy`、`main-session`、HTTP 路由、已有集成测试建库方式。

**独占范围**：README 列出的全部共享文件；新建共用 `my-app/server/r1-test-support.mjs` 仅在现有测试 helper 不能复用时。全过程只由集成负责人维护这些范围。

**不做**：不实现各 Worker 的业务逻辑，不新增通用插件/表单/事件框架，不把 stub 方法误标为功能已交付。

**验收/交接**：旧路径行为兼容；测试基线可复现；02/04/08 可以拿到清晰输入输出立即开工。后续每个 Worker 完成后集成负责人及时把公共接线补上、验证，再放行消费者，不等到最后才接。

### R1-02 复用弹窗与本机时间选择

**负责人：前端基础 Worker；状态：局部实现完成/集成待验（主管交接新 8/8 + 回归 24/24，tsc/lint）；复杂度 M；依赖：01；来源：UX-05，支撑 UX-02/03/04。**

**交付**：一个小型弹窗壳和日期/小时/分钟选择控件，快捷今天/明天/常用时段；可完整选择时间，键盘/触屏可操作；本机时区读取与格式化 helper。复用既有 CalendarBoard/useDrawer 的焦点约束经验，不能复制整套日历。

**独占范围**：新增 `my-app/src/EditorDialog.tsx`、`LocalTimePicker.tsx`、`local-time.mjs`、`local-time.d.mts`、`local-time.test.mjs`、`editor-controls.css`。若实际命名要变由集成负责人先同步消费者。

**复用**：`calendar-layout.mjs` 的既有日期逻辑、`routines.mjs` 的规则构建、原 Icons 和样式变量；不改这些共享已有 helper，由消费者或集成负责人处理必要兼容。

**不做**：不同时改 CalendarBoard/BotRoutines/ModelSettings，不在 UI 暴露必填时区字符串，不加组件库或时区库，不改服务端调度算法。

**验收**：无手填时间也能完成选择；本机时区非上海时仍正确；跨日/结束早于开始可提示；Esc/焦点圈定/回焦/滚动锁正确；375px 不溢出；不替已保存周期计划重写时区。

**交接**：给 03/05/06/07 提供导出、props、disabled/pending/error 行为及示例；不得只交一张视觉草图。R1-01 集成负责人验证两处消费即可，不另建永久组件展览页。

### R1-03 会话删除与主会话换新

**负责人：会话 Worker；复杂度 L；依赖：01、02；来源：UX-01。**

**交付**：侧栏操作菜单、明确确认文案、删除进度/错误、持久服务删除标记；普通会话可停止并删除；主会话清空并切到新会话。删除后当前页/置顶/搜索同步处理，不能刷新复活。

**独占范围**：`my-app/src/ShellSidebar.tsx`、`session-list.mjs`、`session-list.d.mts`、`session-list.test.mjs`；新增 `SessionActions.tsx`、`session-actions.css`；新增 `my-app/server/session-lifecycle.mjs`、`session-lifecycle.test.mjs`、`session-lifecycle-http.test.mjs`。

**复用**：现有取消服务、Task 文档/幂等、`MainSessions` 与侧栏排序/置顶 helper；代码封装为服务，公共入口由集成负责人接入。

**集成负责人接线**：app.mjs/tasks.mjs 的删除操作和 list/detail/history 过滤；main-session.mjs 当前映射、child mirror/digest 去重；已有记忆提取/历史读取增加删除源过滤（不改变记忆存储）。Worker 给出需要的 `isDeleted/resolveCurrentMain` 等最小能力，不自己改核心文件。

**不做**：不物理删除审计/Bot/子 Task/外部日程；不把 archive 伪装成 delete；不迁移文件记忆。

**验收**：普通、当前、置顶、主会话、运行中、群聊分别测试；重复请求幂等；重启不出现；丢响应后核实原请求；迟到回执和缓存不恢复条目；旧来源不可再抽取新记忆；主会话换新后后台结果仍在正确 Bot 可追溯且不泄露旧聊天。

**交接**：服务导出、删除态查询约定、UI 回调、错误码草案、停止/删除顺序、对 R1-07 投递的影响。停止失败/unknown 必须原样保留，不写 fallback 成功。

### R1-04 @ Bot 候选菜单

**负责人：输入框 Worker；状态：已放行独占模块实施（未完成）；复杂度 M；依赖：01；来源：UX-07。**

**交付**：输入框光标处 `@` 触发上方 Bot 候选，名称/描述/头像、过滤、键盘选中、Esc；与 `/` 共用一个轻量候选容器/键盘逻辑；稳定 botId 的选择结果。

**独占范围**：`my-app/src/CommandMenu.tsx`、`commands.mjs`、`commands.d.mts`；新增 `ComposerSuggestions.tsx`、`MentionMenu.tsx`、`mentions.mjs`、`mentions.d.mts`、`mentions.test.mjs`、`composer-suggestions.css`。

**复用**：已有 `/` 命令解析和按需 Skill 目录、当前群聊多 @ 派发，不造协作协议。

**集成负责人接线**：App.tsx 草稿/selectionStart/targets、菜单显示互斥与发送；Skill 新注册/撤销后候选目录重新获取由 10/11 服务驱动。现有群协作服务不由此 Worker 重写。

**不做**：不自动拉群、复制私聊、给停用 Bot 授权；私聊转另一 Bot 采用 CONTRACTS C5 的显式换目标带草稿方式，不假装群式原地 @。

**验收**：所有 active 候选可见且不可路由项有说明；群内多目标保持顺序；同名按 ID 区分；邮箱/代码 @ 不误派发；中文 IME Enter 不发送；选择不丢前后文本；`/` Skill 原流程不回归；375px 候选可滚动。

**交接**：候选/选择 payload、草稿替换区间、路由动作回调及测试用例；集成负责人必须验证真实输入框，不仅测正则。

### R1-05 模型摘要卡片与编辑弹窗

**负责人：模型 UI Worker；复杂度 S；依赖：01、02；来源：UX-02a。**

**交付**：现有模型设置以摘要卡显示名称、地址摘要、是否配 key、状态；编辑进入弹窗，保存/取消清楚；输入框选择器更紧凑易选，继续只展示真正可用模型。

**独占范围**：`my-app/src/ModelSettings.tsx`、`ModelPicker.tsx`、`model-settings-ui.mjs`、`model-settings-ui.d.mts`、`model-settings-ui.test.mjs`、`model-settings.css`。

**复用**：现有模型 API、环境配置只读逻辑、密钥保留策略及 02 弹窗；参考 DSH 的摘要/编辑分层，不复制全部字段。

**集成负责人接线**：SettingsPage/App 的必要组件 props；不改模型后端除非发现明确现有 bug，由集成负责人另审。

**不做**：不新增多提供方路由、远端模型发现 API、OAuth、未知协议；不展示不可保存的“添加第二提供方”。

**验收**：取消不写；保存失败留草稿；已保存 key 不回显；环境只读正确；更换模型从主会话下一条输入生效；在途/独立 Task 保持快照；错误模型不自动替换；移动端可完整操作。

**交接**：截图、局部 helper 测试、现有 model-settings 安全测试结果与未验真实供应商说明。

### R1-06 日历卡片、无感刷新与待办 UI 收口

**负责人：日历 Worker；复杂度 L；依赖：01、02；来源：UX-04/06。**

**交付**：复用日历网格与现有弹窗，换成可选日期/时间；创建/编辑保存为日程卡片；移除常驻待办页和今日待办块；写入成功、前台恢复/联网与有界刷新自动更新内容，无正常路径“刷新工作区”要求。

**独占范围**：`my-app/src/CalendarBoard.tsx`、`calendar.css`、`calendar-layout.mjs`、`calendar-layout.d.mts`、`calendar-layout.test.mjs`、`calendar-accessibility.test.mjs`、`UnifiedWorkspace.tsx`、`workspace-navigation.mjs`、`workspace-navigation.d.mts`、`LocalWorkspace.tsx`；新增 `useWorkspaceRefresh.ts`、`workspace-refresh.mjs`、`workspace-refresh.d.mts`、`workspace-refresh.test.mjs`。

**复用**：原分页查询、外部来源许可、请求序号保护、冲突处理和 mutation 回执；LocalWorkspace 仅调整仍可达的创建入口/日期选择，旧业务服务保留。

**集成负责人接线**：App 顶层导航/失效回调；R1-07 的刷新和 Bot 选择接口通过既有 `BotRoutines` props 扩展接入，Worker 不改 BotRoutines。

**不做**：不重写日历、不删 Todo 数据/API、不把 Todo 截止日当 Event 占时；不加缓存框架，不添加独立全局事件总线；外部资源需要确认的写入语义不变。

**验收**：新建、编辑、取消、版本冲突闭环；后台/其他入口改变后可见页 15 秒内或前台恢复时更新；无加载闪白/草稿丢失/滚动跳跃；隐藏页不持续轮询；权限失效立即清旧数据；乱序响应不串 Bot/日期；旧待办 hash 给明确兼容落点不白屏。

**交接**：hook 入参/清理与失效接口、保持挂载策略、导航别名；与 07 共用时间和刷新，不各写一套。若两票并行，仅按已冻结 props 开发，hook 最终由集成负责人接线。

### R1-07 定时任务弹窗卡片与 Bot 投递

**负责人：定时任务 Worker；复杂度 L；依赖：01、02；来源：UX-03。**

**交付**：新建→弹窗（名称、提示词、频率/时间、单选 Bot、模型）→保存卡片；点击编辑、菜单暂停/恢复/删除、运行历史。正常主页面不铺一长串配置；投递结果进入指定 Bot 当前主会话，通知仅索引。

**独占范围**：`my-app/src/BotRoutines.tsx`、`ScheduleWorkspace.tsx`、`routines.mjs`、`routines.d.mts`、`routines.test.mjs`、`routines.css`、`MainSession.tsx`（仅镜像卡展示）；`my-app/server/workspace-agent-workflows.mjs`、`workspace-agent-workflows.test.mjs`；新增 `routine-delivery.mjs`、`routine-delivery.test.mjs`。

**复用**：现有 schedule/occurrence 幂等及周期规则、工作流 Task、MainSession 镜像、02 控件；`server/routines.mjs` 不存在，不据文件名假设另造一套调度器。

**集成负责人接线**：tasks.mjs/app.mjs 路由的缺口；main-session.mjs 当前主会话/镜像/摘要去重；UnifiedWorkspace 的 Bot 列表与选择由 06 提供，集成负责人对齐 props。未合入 03 时使用现有映射，合入后必须补交叉回归。

**不做**：不多 Bot 广播，不混淆 Event 与自动执行，不手填 cron，不自动扩张无人值守 MCP/Skill 权限；现有 scheduledWorkflow 工具/来源限制保留。

**验收**：单次/日/工作日/周/月正确；无必填自由时间/时区；取消无副作用；重复保存不重复计划；停用 Bot 不可新选；新空白 Bot 缺工作区能力时提示并可引导 Agent 配置，不自动授予；暂停不补跑、同计划不重叠、旧运行归属不改；清空主会话后结果不丢/不重复。

**交接**：卡片刷新 callback、运行与投递状态、最小服务接线与 schedule 兼容测试。后台 ask/unknown 保留真实状态，不用 UI 标“送达”掩盖未执行。

### R1-08 能力开关、空白 Bot 与统一列表

**负责人：Bot 能力 Worker；状态：已放行独占模块实施（未完成）；复杂度 L；依赖：01；来源：BOT-01/02 的基础部分。**

**交付**：工具启停与写入确认分离；每 Bot MCP/Skill 分配投影和统一名称/描述/开关行；“规则”改“工具”；新 Bot 无业务角色推断/默认业务能力，旧 Bot 配置保留。预留已注册 MCP/Skill 的投影消费，不造假连接。

**独占范围**：`my-app/server/bot-configuration.mjs`、`bot-configuration.test.mjs`、`tool-group-settings.mjs`、`tool-groups.mjs`、`tool-groups.test.mjs`、`bot-directory.mjs`、`bot-directory.test.mjs`、`bot-templates.mjs`；新增 `capability-assignments.mjs`、`capability-assignments.test.mjs`；`my-app/src/BotRules.tsx`、`BotTemplatePage.tsx`、`BotCreation.tsx`、`BotDirectory.tsx`、`bot-directory.mjs`、`bot-directory.d.mts`、`bot-directory.test.mjs`、`bot-directory.css`；新增 `CapabilityList.tsx`、`capability-list.css`。

**复用**：ToolAccess 当前分配/撤销、已有配置版本和原子幂等、Switch。全局登记/每 Bot enable 不复制为另一套 permissions。

**集成负责人接线**：tools/policy 对启停的实时检查、Bot 创建时种子/目录初始化、App/Settings 的 MCP 对外凭证高级入口；SkillControls 仍归 10，BotTemplatePage 调用的 Skill props 由契约固定。

**不做**：不删除旧 Bot 记忆或角色，不自动给空白 Bot 文件/网络管理能力，不将旧 ask 自动降为 allow，不迁移文件记忆，不让所有 Bot 获得配置管理工具。

**验收**：关后 schema/后端调用/新 Skill 注入一致不可用；读工具也可禁用；开关不混淆 ask；旧 Bot 权限逐项保持；新 Bot 首次与重启均空白，旧 group migration 不重新灌满；同名不推断人格；无能力时可正常聊天；新外部工具出现不自动放行。

**交接**：09/10/11 所需最小注册投影、绑定/解绑/状态接口；状态列表、每 Bot 来源/工具边界；集成负责人须实际验证静态/动态工具两条链。

### R1-09 MCP 外部连接与工具适配

**负责人：MCP Worker；复杂度 L；依赖：01、08；来源：BOT-01 的 MCP 接入部分。**

**交付**：远程 Streamable HTTP、已安装本机 executable+argv stdio 的配置保存、连接/发现/受控派发、状态/重连/禁用/移除；提供不含秘密的注册投影和安全凭据写入入口。现有对外 stdio 凭证管理原样保留。

**独占范围**：新增 `my-app/server/external-mcp.mjs`、`external-mcp-config.mjs`、`external-mcp-transport.mjs`、`external-mcp.test.mjs`、`external-mcp-security.test.mjs`；新增 `my-app/src/McpCredentialForm.tsx`、`mcp-connection.css`。允许同域额外测试文件，须列清单。

**复用**：01 确认的 SDK/协议兼容策略、08 绑定服务、现有服务端凭据隔离/原子文件写入模式、Task 回执。不要修改 model-settings 的凭据文件来塞 MCP token。

**集成负责人接线**：工具目录动态扩展、toolSets/checkToolCall/policy/预算/取消/结果读取、HTTP 受认证凭据入口。外部原 tool name 必须按 connectionId 稳定映射且受当前 Bot 授权。

**不做**：不自动执行 npx/uvx/pip/install，不安装任意新服务、不做完整 OAuth 平台或公共市场、不接真实 Google、不开放通用 shell；不信任 server annotations 放行写工具，不复用内部 loopback client 假称支持全部外部 MCP。

**验收**：假 HTTP/stdio server 可握手分页发现/调用，重启配置保留；超时/协议错误/进程退出可诊断；env 仅白名单、stdout 协议/stderr 脱敏；SSRF/跳转/名称冲突/巨型 schema/result 有界；跨 Bot 拒绝、撤销立即生效；未知写入不自动重试；无凭据状态非 ready。

**交接**：configuration + check + catalog + invoke + disable/remove 导出，credentialRef 安全通道、需要的最小 tool hooks。给 11 提供假服务可重复自动化验收，不要求人工连真实提供方。

### R1-10 Skill 导入、适配与版本管理

**负责人：Skill Worker；复杂度 L；依赖：01、08；来源：BOT-01 的 Skill 接入部分。**

**交付**：本机目录、单 SKILL.md、公开仓库明确目录的声明式导入；Agent 无须用户手写 manifest；记录来源/固定版本/hash、依赖与状态，支持绑定、更新、回退/移除。内置 Skill 仍从原位置读取，用户 Skill 从受控数据目录读取。

**独占范围**：`my-app/server/skills.mjs`、`skills.test.mjs`、`skill-lifecycle.test.mjs`；新增 `skill-import.mjs`、`skill-import.test.mjs`、`skill-import-security.test.mjs`；`my-app/src/SkillControls.tsx`。Skill 工具注册涉及公共 tools/tasks，由集成负责人接线。

**复用**：现有 skill_activate/read/deactivate、Task 固定快照、按需摘要目录、依赖与资源检查；08 分配控制。远端获取走确定性白名单/有界读取，不要求完整 git clone 或执行仓库命令。

**不做**：不写 server/skills 内置源码目录，不执行任何脚本/postinstall/hook，不从 Skill 声明获得工具/来源权限；不做全站目录爬取、私有仓库 OAuth 或任意格式兼容器。

**验收**：标准 metadata 转内部清单，references/assets 边界正确；无 name/description/路径异常可诊断；同名不覆盖、重复导入幂等；路径/软链/压缩体积逃逸防护；脚本依赖未支持则明确不可用而非静默删字段；更新不改变已运行 Task 快照，禁用立即阻止新加载；用户文件变更需重新确认版本，不能任意热替换固定包。

**交接**：prepare/import/update/remove + catalog/source 导出；来源校验、manifest 映射和新增 Skill 分配检查位置。09 与 10 可并行，不同时写能力权限模型。

### R1-11 Agent 配置能力与结果卡闭环

**负责人：Agent 配置 Worker；复杂度 L；依赖：01、08、09、10；来源：用户补充的 Agent 优先要求。**

**交付**：用户说“把这个 MCP/Skill 加给 Bot A”，Chief/获权配置 Agent 可自动完成来源解析、配置/导入、绑定、验证；缺凭据引导安全输入，完成后原流程续办；一张结果卡展示名称/描述/目标 Bot/开关/真实状态。之后通过对话修改、停用、解绑和移除。

**独占范围**：新增 `my-app/server/capability-management.mjs`、`capability-management-tools.mjs`、`capability-management.test.mjs`、`capability-management-security.test.mjs`；新增 `my-app/src/CapabilitySetupCard.tsx`、`capability-setup.css`。不改 08/09/10 模块内部；接口缺陷回原 Worker 修。

**复用**：现有 Bot 管理/配置服务、Task/审批/阻塞恢复、SystemCard、09/10 接入器与 08 分配；不另造持久工作流或管理 Agent 运行时。

**集成负责人接线**：管理工具只给 Chief/授权 Agent；app/tasks/tools/policy 注册与真实工具回执到 App/SystemCard 投影；卡片凭据控件使用 09 安全入口。所有新配置 mutation 留与真实用户指令绑定的授权上下文。

**不做**：不把模型自填 approved 当用户确认，不透传明文 key 到工具 args，不让普通 Bot 自己授予管理能力；不把“待授权/缺依赖”说成完成，不增通用脚本/包安装器，不因 Skill 内文字自动接入更多服务。

**验收**：一句自然语言 + fixture 来源完成 MCP 和 Skill 两条端到端链路且出现在目标 Bot 列表；不要求编辑 JSON；重复请求不复制条目；凭据等待后续办；无调用回执不声称成功；关闭后已有 Task 下一次调用被拒；跨 Bot/Prompt injection/换源扩大权限被挡；涉及其他 Bot 引用的卸载要求明确意图。

**交接**：演示完整用户输入→管理调用→持久记录→目标 Bot 使用→停用→拒绝后续调用；提供每一步实际测试证据。普通对话文本里的“我已经装好”不算验收。

### R1-12 总集成、回归与用户验收材料

**负责人：Sagan 集成负责人；状态：等待后续接线指令/依赖交付；复杂度 M；依赖：02–11 全部合入；不得只抽样看截图。**

**交付**：逐票审查与共享入口接线、全量回归、1440/375 主路径可操作验证、当前产品/架构/HTTP/MCP/ADR 文档更新；保留失败/unknown 和未验项目。用户验收前仍不移入 done。

**范围**：集成负责人独占共享文件；按必要与 Worker 协调局部修复，不在仍运行的 Worker 路径同时落笔。新接口只在真实可用后写现行 docs，原反馈与本计划保留历史决策。

**必过业务链**
1. 删普通/运行中会话、清空主会话 → 重启不复活 → 子 Task/定时结果仍可追溯。
2. 新建/编辑日历、定时任务全程选择时间 → 保存卡片 → 指定 Bot 投递 → 后台刷新不丢草稿。
3. @ 与 /、模型选择及环境只读配置互不回归。
4. 新空白 Bot → Agent 配置能力 → 能力列表出现 → 正常使用 → 关闭后真实后端拒绝；旧 Bot 权限和旧 Task 快照不变。
5. 两种 MCP transport 和声明式 Skill 导入可重启恢复；待授权续办；恶意输入不会扩权、执行脚本或泄漏秘密。

**必过故障矩阵**：网络未知/断线、重复提交、响应乱序、Bot 停用、撤权、重启、主会话换新、跨日/夏令时、无效时间、缺依赖、巨型/恶意外部数据、导入路径逃逸、端点/工具版本变化。

**验证**：`pnpm test`、`pnpm lint`、`pnpm build`；双宽度真实页面操作而非 DOM 文本快照；键盘/中文 IME/焦点/滚动/关闭弹窗；安全凭据输出扫描。临时数据库与假服务，不碰正式 data/.env，不真实发邮件/改外部日历。记录实际计数，不能照抄 1104。

**验收材料**：每票完成/未完成表、测试命令与结果、页面截图、迁移/兼容说明、未验真实账号/系统行为清单。文件记忆仍原实现，Google 仍未接入，不能在此票顺手完成后两轮。

## 需求覆盖与不做清单

| 原 issue | 第一轮票 | 本轮界限 |
|---|---|---|
| UX-01 | 03、12 | 持久逻辑删除，不承诺物理擦除 |
| UX-02 | 05、12 | 02a 单连接 UI；02b 多 provider 不在三轮既定承诺中，后续另定 |
| UX-03 | 02、07、12 | 单 Bot 执行/接收，不扩张无人值守外部能力 |
| UX-04 | 02、06、12 | 隐藏独立待办 UI，保留数据/兼容 |
| UX-05 | 02、06、07 | 隐藏时区 UI，保留正确时区数据 |
| UX-06 | 06、07、12 | 相关查询有界刷新，不造新实时平台 |
| UX-07 | 04、12 | 输入体验复用；不新增协作协议 |
| BOT-01 | 08、09、10、11、12 | Agent 优先接入配置；无强制手工向导 |
| BOT-02 | 08、11、12 | 新 Bot 默认空白，旧 Bot 不重置 |
| MEM-01 | 第二轮 | 本轮不迁移文件记忆 |
| INT-01 | 第三轮 | 本轮不做 Google 实际授权/业务适配 |

## 共享文件锁与可并行性

- 所有 Worker 路径互斥；新增 helper 仅在所属票命名域。`App.tsx`、`tasks.mjs` 等核心入口由集成负责人串行接线。
- 06 和 07 可并行：06 拥有 UnifiedWorkspace/刷新 hook，07 拥有 BotRoutines/投递；靠 C3/C4 小回调衔接，互不写对方文件。
- 08 完成并合入后 09/10 才并行，11 等两者通过；不先写一堆猜想 API 再让集成负责人修两套实现。
- 每票返回后集成负责人先验公共接线，满足依赖后再派下一票；12 是最终验收，不是首次把模块拼到一起。
