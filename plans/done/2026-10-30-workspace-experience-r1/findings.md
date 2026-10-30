# R1 集成发现与依赖

更新时间：2026-10-30（Asia/Shanghai）

## 当前依赖授权与实现边界

最终冻结源码已由root独立验证1395/1395（0 fail/cancel/skip/todo，43.1s）、lint exit0/13条既有React warning、build exit0/651.41kB chunk提示；本轮代码与受控本地核心验收完成，待用户验收，保持active、不移done。 页面/重启/清理与未验范围见[ACCEPTANCE](ACCEPTANCE.md)。

2026-10-29 用户明确回复“安装”，已批准并完成 `@modelcontextprotocol/sdk@1.32.2` + `zod@4.6.7` 两个固定版本的安装，本安装小单元已完成并冻结。`finish_capability_tests` 使用 `pnpm add --save-exact @modelcontextprotocol/sdk@1.32.2 zod@4.6.7 --ignore-scripts`；精确版本列表、Client/StreamableHTTPClientTransport/StdioClientTransport/zod 导入及 frozen-lockfile 校验均成功。安装后已重新实际运行：test **1304/1304**、0 fail/cancel/skip；lint exit 0（13 条 React warning），build exit 0（606.72 kB JS chunk 提示），diff check 通过。安装阶段 configured/缺安全适配器是历史状态；本轮 09 已装配官方 SDK 服务、认证管理和真实 Harness 动态工具链，最终冻结源码已由root独立验证1395/1395（0 fail/cancel/skip/todo，43.1s）、lint exit0/13条既有React warning、build exit0/651.41kB chunk提示；本轮代码与受控本地核心验收完成，待用户验收，保持active、不移done。

上一轮冻结基线和本轮依赖安装后独立重跑均为 1304/1304；本轮日志为 `/tmp/pidot-r1-sdk-install-{test,lint,build}.log`，不只沿用旧基线。

安装已成功，package 仅新增两个精确依赖，lock 新增 94 条包版本记录及必要可选 peer bindings，原依赖约束未变；`pnpm install --frozen-lockfile --ignore-scripts` 返回 Already up to date。09/11真实服务/Host与页面路径已完成本轮受控本地验证；不把受控SDK fixture写成真实账户/供应商已验。安装后总回归已实际通过 1304/1304，lint/build/diff 检查通过，本安装小单元完成并冻结。

## 历史发现与核查记录

以下按发现过程保留；旧“未批准/待审批”和尚未冻结的回归快照均为历史状态，当前授权以本页上方为准。

### 接入点和边界

- codegraph 仓库无索引，窄读现有源码，不初始化索引。共享入口与首波具体签名见 CONTRACTS C11；不为冻结接口先改整个 tasks/tools 架构。
- 现有 fixtures/authorized-task-store、临时 SQLite 与 loopback 模型足够首波；不新增共用 helper，不用授权 fixture 证明空白 Bot。
- 启动时发现的主会话无条件 MAIN_TOOLS/automation_pause 已移除；当前只对 legacy 主会话投影独立 mainAssignments，撤销优先。Skill 的 activeSkillPrompt、/skill、任务上下文及受控导入目录已接 08/10 的实时启停检查。
- calendar-layout 使用 UTC+8，02 的任意时区转换改复用 routineInstant；DST 缺失拒绝，创建本机/编辑原时区。
- groups 文本名 Map 覆盖 + 与结构化目标合并可错派；当前用户已授权 groups.mjs 与定点测试最小消歧，由集成负责人处理。
- 截图 cron/平台投递被后续用户要求覆盖：本机卡片选时 + 单选 Bot；首波人员/QA 映射已记录 progress/C11。

### 启动基线

详见 execution/r1-01-baseline/README.md 和 results.json：本次 1104/1104，lint 0 错误/7 条既有警告，build 通过/既有 bundle 提示；不是 R1 验收。Node v24.22.0；实际 pnpm 11.1.2 与声明 >=11.21.0 有差异，未升级。起始源码无改动，只有既有计划/文档改动，保留不回滚。

### MCP SDK 依赖审查（只查元数据，未安装）

核查时间：2026-10-29。package.json 无直接 SDK，lock 只有 @google/genai 的可选 peer @modelcontextprotocol/sdk ^1.25.2，并非已解析 SDK；import.meta.resolve SDK/client/zod 全部 ERR_MODULE_NOT_FOUND，不能复用“幽灵依赖”。现有 workspace MCP 是对外 host，不是外部连接客户端；不重写其协议替代 SDK。

建议待确认新增（均固定，无 ^/~）：

| 包 | 用途 | 许可 / 兼容 | 影响 |
|---|---|---|---|
| @modelcontextprotocol/sdk@1.32.2 | 官方 Client + stdio + Streamable HTTP；假服务也复用 SDK | MIT，Node >=18；满足现有可选 peer ^1.25.2 | 服务端运行依赖，需改 package/lock；增加 AJV、Zod、HTTP/事件流等传递依赖，不能把 SDK 内置 OAuth 支持等同本轮支持全部授权流 |
| zod@4.6.7 | SDK 必需 schema peer/导出类型依赖，应用显式固定避免 pnpm 隐式 peer 漂移 | MIT，符合 SDK ^3.25 || ^4.0 | 服务端 schema 依赖；不把凭据或 SDK 打包到前端，不另造校验/协议框架 |

SDK 1.32.2 的 npm 元数据发表于 2026-10-23；官方包注册表只读查询已确认固定版本存在。另有 @modelcontextprotocol/client@2.4.0（Apache-2.0，Node >=20，拆分 core），此阶段不选新主版本以保持现有 v1 可选 peer 基线一致，不同时安装两套。@cfworker/json-schema 是可选 peer，不提请安装；传递依赖具体闭包/许可证/漏洞与 lock 差异需授权安装后审查，当前不声称已审计无风险。

源（只读 npm 元数据）：https://registry.npmjs.org/@modelcontextprotocol/sdk/1.32.2、https://registry.npmjs.org/zod/4.6.7、https://registry.npmjs.org/@modelcontextprotocol/client/2.4.0。拟新增包元数据摘要见 execution/r1-01-baseline/sdk-metadata.json。

**待主管转请用户确认**：新增上述 SDK + Zod 固定版本是否批准。未确认不安装、不改 package/lock，不用 npx/pnpm dlx 隐式下载，不手写完整协议。此项阻塞 09 真 transport/SDK fixture 验证，不阻塞 02/04/08，也不阻塞 10 的声明式导入/08 分配服务。

### 当前窄范围成果

groups 显式数组目标权威与旧文本歧义拒绝已落地，定点 7 新用例 + 旧群回归共 19/19、两文件 lint 通过。08 CAS/HTTP 与静态真实启停链已接入，legacy 主会话 intrinsic 工具迁移到独立 `mainAssignments`，不污染普通 Bot 分配；新 v2 Bot 保持空白。02 主管交接局部完成（新 8/8 + 回归 24/24，tsc/lint），两处消费集成待验；unknown 消费者需关闭 pending 锁、保留 disabled 并提供原 requestId 查询动作。SDK 阻塞不变。

### 能力 HTTP 小单元①完成

真实08服务已接 store/认证HTTP，默认内置静态；openTaskStore 的 readCapabilityCatalog(tx, {botId}) 为09/10可信注入挂点。7新HTTP/联合33/33，定点lint通过。主会话工具已迁入单独投影，并有真实模型回调撤权回归。10 Skill 注册源、导入目录任务上下文、能力投影和认证管理 HTTP 已接入；正式 HTTP 测试通过。09 SDK/Zod 未获批准，transport 仍 blocked。

### 接管后的共享接线核验

- `tasks.mjs` 通过受控 `skillDirectory.userSkills` 暴露 Skill 导入管理操作；没有导入服务时以 `SKILL_IMPORT_UNAVAILABLE` 失败关闭。`app.mjs` 的五个 Skill 管理端点均先经过 Bearer 认证和 JSON 校验，且只接受 POST。
- `index.mjs` 使用数据库文件同级的 `skills` 目录，生产目录同时包含内置 Skill 和用户 Skill 服务。`readCapabilityCatalog` 只调用 `skillCapabilityCatalog` 投影，不把导入服务原始 catalog 当作能力授权目录。
- Skill 删除的影响范围由当前 `CapabilityAssignments` 绑定状态计算；客户端传入的 `affectedBotIds` 不作为权限或影响范围来源。导入/更新/回滚仍由导入服务以 requestId、准备凭据和版本校验保证幂等/并发安全。
- 上轮全量 `pnpm test` 为 1290 项、1275 通过、15 失败。剩余 13 项位于 Bot 配置/Skill/onboarding/工具组旧测试，仍假定 Bot 或新 Skill 会获得隐式默认授权；2 项 workspace UI 测试仍断言独立 todos 页面。T09 fixture 的显式只读授权和 2 项 08 工作流失败已修正，相关套件 51/51 通过。
- 工作流收敛：未知模型结果不生成 mirror/notification，只保留原 Task 与 occurrence 的 unknown 状态供核对；周期工作流到达确定 failed 状态时暂停计划，避免下个 due 自动创建新 Task，用户可显式 resume。单次计划保持 completed 语义；R1-07 通用 delivery service 对显式传入的 unknown 仍保留 truthful mirror 能力，但 Agent workflow 的未知 dispatch 不调用 delivery。
- 当前剩余风险：R1-09 官方 MCP SDK/Zod 仍未获批准，不能进行真实 transport 验证；R1-11 Agent 自动配置闭环和 R1-12 用户验收材料尚未完成。

### 本轮文档核对

- 现有 `/api/tasks/:taskId/delete` 和 `/api/session-requests/:requestId` 只接普通会话删除；生产 `createSessionLifecycle` 未注入 stopMain/createMain，store 未导出 clearMainSession，不能把服务层主会话换新测试当生产支持。普通删除主会话会返回 `SESSION_ACTION_CONFLICT`。
- R1-06 要求收起独立待办页面及今日待办块，保留旧 Todo 数据/API；旧 todos 导航别名落到日历，不能继续沿用 T08 的待办同屏断言。
- 本轮正式文档以实际认证路由为准：能力 CAS 分配、Skill 受控管理和普通会话删除已接；外部 MCP 客户端仍受 SDK/Zod 审批阻塞，与现有入站 stdio/loopback relay 分开描述。
- 隔离 UI 核对发现 R1-07 真实兼容缺陷：种子 Bot 的缺失 status 具有 legacy active 语义，`routineBotSelection` 却仅接受 `status === active`，会阻止例行任务创建。已交 Worker 修复；不将本轮归类为仅更新旧测试。

### R1-03 App 接线核对

- 核查时 `App.tsx` 的 `ShellSidebar` 调用未传 `onSessionAction`、`onVerifySessionAction` 或 `onSessionActionComplete`，因此已有 SessionActions 删除/换新菜单按组件契约禁用。
- 最小接线是按 target.kind 调已认证 delete/clear-main，复用组件 requestId 并解包 data；原请求核对仅 GET session-requests，成功才返回 result；完成时更新 tasks/detail/mainSessions 及对应草稿/Skill/模型/mention 状态，提升 requestEpoch 拒绝旧详情响应回填。Sidebar 已负责本地 tombstone、pin 清理及普通选中会话回首页。
- App 现有列表轮询 1.5 秒、详情轮询 750 毫秒，清空后须立即替换主会话 ID/清旧详情；不能只等待列表刷新或让迟到结果恢复旧视图。
- 主管已转移本轮限定所有权；旧 Huygens 锁作为历史记录保留，不再表述为运行中的独占 owner。

### 阶段性 UI 核对结果与限制

主管在临时库/loopback、1440/375 两宽度下已观察日历可选时间保存、@ 同名 Bot 稳定 ID 换目标且不自动发送、选择模型后发送，以及日程草稿跨轮询保留/Esc 关闭；相关页面无横向溢出。截图在 `.scratch/2026-10-29-workspace-experience-r1/browser-020405/r1-finish-*.png`。这些证据早于会话生命周期后续接线，不覆盖最终构建或完整 R1-12。窄屏切 Bot toast 会遮挡展开导航后的底部导航按钮，关闭 toast 后恢复；保留为已观察 UI 限制，未宣称完整无障碍通过。

- 模型环境只读弹窗在 1440/375 的阶段核对通过：URL/模型/API key 控件继承禁用状态，key 不回显，375 无横向溢出，Esc 关闭；375 截图已由主管视觉检查。该构建仍早于会话生命周期后续接线，不替代最终 UI 复测。

### 主会话换新接线后状态

后端 `/api/tasks/:taskId/clear-main` 与 stopMain/createMain、App 三个生命周期 callback 已接；先前“尚未装配”的观察已被本轮接线覆盖。新 Task 创建后 Harness 不允许在同事务再次读表，adapter 使用事务级 WeakMap 暂存真实新 card 供校验，避免 ReadAfterWrite。生产回归仍为 5/6：派生 Task 的结果目标仍是旧主会话，直接 task_assign 子任务仍受旧 parent cancellation guard 拒绝。主管已将 main-session/collaboration 最小修复交回原后端 owner；未将当前路由存在或模块通过当作整体交付。

### 重建前端后的 R1-07/08 操作证据

375px 实际新建空白 Bot 的 API 工具/来源均为空，普通聊天获得 loopback 回复；这验证无业务能力仍可聊天。定时任务路径使用独立 fixture **显式**给予 Chief `workspace.list/get` 与 `workspace:local` 后，Chief 可选且不再误报停用，09:15 时间控件/模型选择/确认创建卡片通过，无横向溢出。两项证据来自重建后的前端，但临时后端尚未更新最终 main 修复，不覆盖 clear-main。导航提示遮挡修复已落 App，针对该遮挡的最终复核待确认。

### 当前后端会话 UI 核对

1440px 主会话真实清空将旧 43 换到新 149，旧 GET410、新 messages=[]/composer 空且独立 Task 保留；375px 独立 Task 置顶后删除并重载，API 列表不含目标、pin 清空、主会话不变、无横向溢出。导航 toast 打开侧栏即清除后直接点击事项通过，先前遮挡限制已有本轮回归证据。最新构建通过（606.72 kB JS chunk 提示）。后台结果换新窗口和已删除来源 task_status 过滤仍在收尾，不宣称完整 R1-03/12 完成。

### 本轮自动验证快照

已核对 `/tmp/pidot-r1-finish-full-test.log`：1303 tests/pass、0 fail/cancel/skip/todo。主管报告 lint exit 0，保留 13 条 React warning；build exit 0，保留 606.72 kB JS chunk 提示；diff check 通过。后端 owner 最后收尾未冻结，当前仅为已执行验证快照，不等于最终源码已全部验收。


2026-10-29 · Tavily MCP 0.2.22 在用户明确指定命令下完成一次隔离官方 SDK 直连：initialize、发现五工具及一次受限 basic tavily_search 均成功（isError=false，3193ms，返回官方文档 URL）。这是单次外部服务 smoke，不能据此宣称 Pidot 生产 transport 已接，也不授予产品自动 npx 安装权限；R1-09/11/12 仍未完成。Key 未写入证据，测试进程/cache/kernel 已清理，未改产品源码；安装后 1304/1304 保持为既有验证结果，本次没有重新跑全量。脱敏记录见 `.scratch/2026-10-29-workspace-experience-r1/tavily-mcp-smoke/result.json`。


R1-09 共享接线 WIP：已接认证外部 MCP HTTP 和每 store 的无秘密动态目录缓存（缓存不作为授权权威），真实调用复核服务当前 capability revision/绑定/policy/预算。原静态审批回归发现 runtime.commit 读布尔值被当作 Task state 的兼容错误，已修复并通过精确审批定点。真实 Harness 首次入模还发现事务代理 schema 越出事务，已在 commit 内复制 metadata 后修复；官方 SDK echo 的审批/单次调用/回执已通过。两次脚本工作目录错误未落盘业务变更，已统一使用仓库根目录绝对前缀。


09 动态目录缓存只存无秘密服务端投影，显式 ToolAccess/CapabilityAssignments 和服务当前 catalog 为调用授权来源；连接 mutation revision 不用于 Bot 工具绑定。TaskCard.externalMcpUsedRefs 为独立来源；来源变更后新认证输入设 externalMcpHistoryFloor，退役旧派生 context/审批原文/摘要并清 compaction，避免旧 refs 永久阻断新回执，同时不重放旧历史/产物。pendingMirrors/digest 保留 refs，记忆与协作走共同 gate；完整大结果按 mcp 资源和当前目录版本校验分页读取。HTTP 移除影响范围另用原 Harness receipt 保存，避免解除绑定后重放原移除响应的影响名单漂移。


最终广回归曾从仓库根执行，两个既有 SIGKILL migration 子进程因固定相对路径找不到 fixture 而失败（170/172）；已按仓库约定回 my-app 目录重跑，不改用例来追绿。记忆兼容静态核查确认 memorySourceAllowed 只接受真实直接 pidot.user；已移除会误伤用户旧偏好的 MCP floor 判断，并仅对该可信用户记忆来源忽略 MCP 派生 refs，原 deleted/cancel/Bot/workspace gate 保留。


R1-11共享Host可运行冻结：六条真实集成与相关广回归 **219/219**、0 fail/cancel/skip，定点oxlint无警告；日志 `/tmp/pidot-r1-management-host-{wide,lint}.log`。生产index显式开启capabilityManagementEnabled:true，嵌入调用默认false。包含启用前旧Chief主会话同库开启重启不换ID、普通旧Bot分配不扩张、实际Host精确批准/真实SDK绑定、缺凭据原输入跨重启续办、Skill第二次机制确认、显式获权配置Agent；Skill requestStatus真实持久四类operation回执已补。源文件SHA与运行handoff在 `.scratch/2026-10-29-workspace-experience-r1/r1-09-12/shared-backend-11-{result.json,handoff.md}`。

当前实际缺陷记录：原GET500由toolSets.externalTools事务overlay越过commit导致HTTP序列化Cannot use a settled overlay，已复制为普通JSON，并通过冷GET及已有MCP目录后的direct/scoped GET；早期UNKNOWN/未诊断观察和随后WIP helper未定义启动错误仍保留其历史，不混为同一结论。Root探索性真实页面另发现TaskApprovalControls把manager operation当calendar读取stableIdempotency而白屏，已交前端owner修，非后端成功结论。Root前端build独立通过，645.31kB JS体积提示保留；最终浏览器/整轮全量及用户验收仍待root，不沿用旧1304。


本轮有界恢复检查成功，未再出现403；仅修复全量1383项快照中唯一登记缺口：新增真实“能力配置”工具组（capabilities）登记mcp_manage/skill_manage，并补中文工具名，没有修改失败断言。分组只提供目录元数据/独立开关，原ToolAccess、Chief或宿主显式管理授权及精确Host确认不变；marker迁移不补授普通Bot能力。分组/settings/能力分配/真实Host与policy影响回归39/39、定点lint无警告，日志 `/tmp/pidot-r1-group-registration-{test,lint}.log`。1382/1383是修复前历史快照，最终全量由root重跑，不将39项相加成总数。共享Host此前六条真实集成及219/219冻结交付继续有效为既有证据：旧Chief同库开启新工具且不换ID、普通旧Bot不扩权、新Bot主会话GET200、原输入凭据续办、Skill机制确认及真实Skill requestStatus持久回执；本轮不重复全量。


验收材料整理发现正式产品/架构导读仍残留“新Bot默认全部工具/按名字推职责”“主会话只能只读”“公网MCP不支持”等旧阶段描述；将按当前真实实现区分新Bot空白、启停与确认、入站stdio/relay与外部MCP客户端，旧ADR作为历史决策保留。暂不写最终计数或全面UI成功。
