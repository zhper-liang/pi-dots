# R1 集成负责人执行计划

更新时间：2026-10-30（Asia/Shanghai）

## 当前授权与阶段

最终冻结源码已由root独立验证1395/1395（0 fail/cancel/skip/todo，43.1s）、lint exit0/13条既有React warning、build exit0/651.41kB chunk提示；本轮代码与受控本地核心验收完成，待用户验收，保持active、不移done。 详细结果见[ACCEPTANCE](ACCEPTANCE.md)，下方安装数字是历史基线。

2026-10-29 用户明确回复“安装”，已批准并完成 `@modelcontextprotocol/sdk@1.32.2` + `zod@4.6.7` 两个固定版本的安装，本安装小单元已完成并冻结。`finish_capability_tests` 使用 `pnpm add --save-exact @modelcontextprotocol/sdk@1.32.2 zod@4.6.7 --ignore-scripts`；精确版本列表、Client/StreamableHTTPClientTransport/StdioClientTransport/zod 导入及 frozen-lockfile 校验均成功。安装后已重新实际运行：test **1304/1304**、0 fail/cancel/skip；lint exit 0（13 条 React warning），build exit 0（606.72 kB JS chunk 提示），diff check 通过。安装阶段 configured/缺安全适配器是历史状态；本轮 09 已装配官方 SDK 服务、认证管理和真实 Harness 动态工具链，最终冻结源码已由root独立验证1395/1395（0 fail/cancel/skip/todo，43.1s）、lint exit0/13条既有React warning、build exit0/651.41kB chunk提示；本轮代码与受控本地核心验收完成，待用户验收，保持active、不移done。

上一轮冻结基线和本轮依赖安装后独立重跑均为 1304/1304；本轮日志为 `/tmp/pidot-r1-sdk-install-{test,lint,build}.log`，不只沿用旧基线。

| 阶段 | 状态 | 范围 |
|---|---|---|
| 上一轮会话/能力/Skill 收尾 | complete | 03/08/10 已实现自测，1304/1304 冻结基线保留 |
| 本轮固定 SDK/Zod 安装 | complete | 精确版本安装、四项导入、frozen-lockfile 均通过，依赖改动冻结；安装后 1304/1304、lint/build/diff 检查通过 |
| R1-09/11 实现与R1-12本地验收/材料 | complete | 最终1395、核心1440/375与同库API重启、输出检查/QA清理完成 |
| 用户验收 | pending | 保持active、不移done；真实账户/物理IME/全故障矩阵未验边界保留 |

上一安装小单元仅更新文档授权的职责为历史；本轮已追加共享后端集成所有权，范围见下节。不访问 .env 或正式 data，不提交/推送，不新增依赖。

## 当前 R1-09/11 共享后端接线

状态：09/11实现、共享接线和本轮本地核心验收完成并冻结；待用户验收。主管新增本负责人为共享后端集成 owner，独占 app/index/tasks/tools/policy 及同域 HTTP/runtime 集成测试；09 服务模块和前端由各原 Worker 独占。旧 1304/1304 为安装小单元验证基线，不作为本轮动态 transport 全链结果。已完成认证配置/凭据路由、每store隔离动态目录、显式绑定/版本检查、保守确认、预算/取消和持久回执；不改 package，不触及正式服务/.env/data，不安装额外依赖。

## 历史执行记录

以下保留上一轮启动、失败、修复和冻结过程；其中“未批准”“等待 freeze”、1275/1290、1303/1303 等均为当时状态，已被上一轮最终 1304/1304 和本轮明确安装授权覆盖，不作为当前阻塞。

### 目标与授权

当前用户明确授权分票实施；主 Agent 只协调/审核/验收，业务实现由本集成负责人及其他 Worker 完成。本负责人负责 R1-01 与后续 R1-12 的共享代码接线，不派生子 Agent。旧计划中的“未授权开工/总管亲自写”不再适用。

### 阶段

| 阶段 | 状态 | 范围 |
|---|---|---|
| R1-01 阅读与接入点核查 | complete | 阅读现状、计划与相关 docs；窄范围核查源码 |
| R1-01 基线与接口冻结 | complete | 记录 test/lint/build；冻结 02/04/08 接口、共享文件与逐波接线 |
| R1-01 交付与等待 | complete | 核验记录，向主管交付；等待下一条接线指令 |
| 授权追加：groups 最小消歧 | complete | 7 新定点 + 旧群回归共 19/19，定点 lint 通过 |
| 本轮回归与文档收尾 | in_progress | 迁移旧隐式授权和独立待办 UI 测试，核对已接 HTTP 契约，等待全量及隔离 UI 结果 |
| R1-12 最终共享代码接线与回归 | in_progress | 已接 08/10 与普通会话删除；09 依赖、11 闭环及完整双宽度验收仍未完成 |

### 安全与范围

保留已有未提交计划文件，不提交、不推送、不回滚他人工作；不碰 .env、正式 data 或真实账户；不提前实现 Worker 专属模块。MCP 只核查现有依赖及可用固定版本，未经确认不安装，不自写完整协议替代 SDK。

### 错误与处理

- codegraph：仓库未建索引（无 .codegraph/）；按工具建议改用窄范围源码读取，本会话不再调用 codegraph。
- 首次文件清点使用父目录 find，触及无关目录权限拒绝；已改为仅扫描本仓库明确目录。

### R1-01 历史阶段结果

1104/1104、lint/build 通过；首波 02/04/08 已放行，C11 冻结签名/所有权/逐波门槛。SDK 固定 1.32.2 + Zod 4.6.7 的新增建议待确认，不安装。新增授权的 groups 最小消歧单独核验，其余核心业务接线等待下一条指令。完整 12 票仍实施中，不标已完成。

### 当前停止点

（历史记录，已被后续授权覆盖。）当时 groups 小修复已交付，08 接线待下一条指令；现状见文末“接管后执行结果”。

### 历史恢复状态

（下列为接管前记录，当前状态见文末。）仅交接，不启动新实现：groups 已落盘/19/19 + 定点 lint；capability 只读核对 08 服务，零共享接线落盘。CAS HTTP、主会话旁路/静态执行链、共享集成测试分别待小单元指令。恢复 handoff：`/home/zhper/code/pidot/.scratch/2026-10-29-workspace-experience-r1/r1-01/handoff.md`。

### 小单元①结果

能力 CAS 服务 + 认证 HTTP 已完成：7 新HTTP用例/联合33/33，定点lint/syntax/diff通过；主会话旁路后来已接入，02/04 UI仍待验。证据：`/home/zhper/code/pidot/.scratch/2026-10-29-workspace-experience-r1/r1-01/capability-http/handoff.md`。

### 接管后执行结果

1. 已完成主会话静态启停链的修复核对：`mainAssignments` 与普通 Bot ToolAccess 分离，主会话 intrinsic 工具只对已迁移 legacy Bot 投影，新 v2 Bot 不隐式授权，撤销仍优先。
2. 已完成 R1-10 生产接线：受控用户 Skill 导入服务、内置/用户 Skill 目录合并、任务上下文注入、能力 catalog 投影和认证管理 HTTP 路由均已接入。
3. 正式 `r1-skill-import-http.test.mjs` 已加入，覆盖认证、方法校验、prepare/import、能力目录、绑定和删除影响 Bot 计算；Skill / R1 定点套件 119/119、`pnpm lint`、`pnpm build` 通过。
4. 上轮全量 `pnpm test` 为 1275/1290；15 项失败中 13 项仍断言旧隐式默认授权，2 项仍断言独立 todos 页面。T09 fixture 已补显式 `workspace.list/get`；未知执行不投递，周期失败暂停行为已修并通过定点回归 51/51。R1-09 依赖审批、R1-11 Agent 闭环、R1-12 总集成与用户验收仍未完成。

### 本轮收尾状态

- 权限测试与 Skill/UI 测试按 R1 契约分别核对；新增 Skill 发现不等于分配，独立待办 UI 收起，旧 todos 链接落到日历。
- 正式 HTTP/MCP 文档同步区分已接入与待验功能；普通会话删除已接生产，主会话 clear-main 和 App callback 本轮已接，但生产回归仍 5/6，不宣称端到端完成。
- 隔离 UI 已发现并交回修复 R1-07 legacy Bot status 兼容缺陷；等待修复、全量、lint/build 与 1440/375 操作结果后更新证据，09/11/12 和用户验收保留未完成。

### 本轮会话接线所有权调整

主管已复核旧 Huygens owner 无在运行证据。`finish_skill_ui_tests` 独占 `App.tsx` 的会话生命周期最小接线，其余四个前端共享文件不动；`finish_capability_tests` 独占 `tasks.mjs`/`app.mjs` 的 clear-main 后端与集成测试；`finish_r1_docs` 维护正式文档和执行记录。后端/组件局部通过后仍由主管执行真实浏览器确认，不提前将主会话换新标为已交付。

### 阶段性 UI 核对

已收到主管的临时库/loopback 1440/375 阶段证据：日历时间保存、@ 稳定 ID 路由、逐输入模型与草稿跨轮询保留通过所述操作；静态构建早于最终会话接线，需重建复测。窄屏 toast 遮挡底部导航按钮保留为已观察限制，不将阶段证据升级为完整 R1-12 或无障碍验收。

### 会话换新接线后回归缺口

App 的三个生命周期 handlers 与 BotCreation 清理已落盘冻结；后端认证 `/clear-main`、stopMain/createMain adapter 已接。事务新建 Task 后禁止读表的 ReadAfterWrite 已由事务级 WeakMap 保留真实新 card 解决。主管报告生产回归 5/6：派生 Task 结果仍 mirror 旧主会话，新主会话为 0；直接 task_assign 子任务仍被旧 parent cancellation guard 拒绝。已授权原后端 owner 最小扩展 main-session/collaboration 修复，继续等待真实通过和最终构建/UI 复测。

### 重建后的前端增量验证

375px 已验证新空白 Bot 工具/来源为空且可聊天；为 Chief 显式 fixture 分配所需工具/来源后，定时任务选择、09:15 时间、模型与确认创建卡片通过。这不改变默认空白契约。前端已重建，临时后端尚待 main 修复更新；最终会话换新及导航遮挡复核仍待主管。

### 当前会话 UI 主路径证据

已收到主管以当前临时后端/重建前端完成的 1440 主会话换新和 375 独立会话置顶/删除/重载证据，旧 GET410、新上下文空、独立 Task 保留、pin 清理及无横向溢出均通过所述操作；导航提示遮挡回归也通过。最新 build 通过（606.72 kB 提示）；已删除来源 task_status 和普通派生结果换新窗口仍待后端最终回归，R1 整体未完成。

### 本轮全量通过，等待源码冻结

主管全量日志已核对：1303/1303、0 fail/skip/cancel；lint exit 0（13 条 React warning），build exit 0（606.72 kB JS chunk 提示），diff 检查通过。后端最后窗口/删除来源过滤收尾尚未收到 owner 冻结，故本轮回归阶段保持 in_progress，不能将该数字视为最终冻结源码结论。日志 `/tmp/pidot-r1-finish-{full-test,lint,build}.log`；等冻结确认后判断是否仍需针对最终差异复验。


09 共享范围交付前核验：7 个真实 SDK HTTP/Harness 正常功能用例覆盖配置/凭据/绑定/停用/移除、精确审批单次调用、大结果完整分页、来源更新后的合法新请求、正常停用 unknown/重启不重发及 store 隔离。相关工具/配置/policy/产物/main/context/history/migration/memory/来源回归 172/172，定点 oxlint 通过；这是本轮真实广回归，不照抄安装后1304基线。11 factory 尚待实接，不放空成功 hook。


恢复 R1-11：此前三个 Agent 因 403 余额中断，当前工具已恢复可执行。原 QA 由主管核验后仅关闭其 acceptance-server 与浏览器，正式服务未碰；具体现场见 root-resume-handoff。新 Bot GET500 尚待隔离定位，已发现共享 WIP 引用了尚未定义的11 Host helper，正在补齐真实接线并用冷启动/GET回归核验。R1-11/12 未完成，旧1304不是本轮验收。


当前恢复状态：403 已解除，11真实Host函数与认证setup查询/续办已接；新Bot GET500已由overlay泄漏定位并修复，冷启动和已有MCP目录后的GET已覆盖。剩余本轮最后角色兼容/广回归/lint与冻结，不等待docs才向主管交业务源。生产index显式开启capabilityManagementEnabled:true；嵌入测试默认false保留旧调用兼容。


R1-11共享Host可运行冻结：六条真实集成与相关广回归 **219/219**、0 fail/cancel/skip，定点oxlint无警告；日志 `/tmp/pidot-r1-management-host-{wide,lint}.log`。生产index显式开启capabilityManagementEnabled:true，嵌入调用默认false。包含启用前旧Chief主会话同库开启重启不换ID、普通旧Bot分配不扩张、实际Host精确批准/真实SDK绑定、缺凭据原输入跨重启续办、Skill第二次机制确认、显式获权配置Agent；Skill requestStatus真实持久四类operation回执已补。源文件SHA与运行handoff在 `.scratch/2026-10-29-workspace-experience-r1/r1-09-12/shared-backend-11-{result.json,handoff.md}`。

当前实际缺陷记录：原GET500由toolSets.externalTools事务overlay越过commit导致HTTP序列化Cannot use a settled overlay，已复制为普通JSON，并通过冷GET及已有MCP目录后的direct/scoped GET；早期UNKNOWN/未诊断观察和随后WIP helper未定义启动错误仍保留其历史，不混为同一结论。Root探索性真实页面另发现TaskApprovalControls把manager operation当calendar读取stableIdempotency而白屏，已交前端owner修，非后端成功结论。Root前端build独立通过，645.31kB JS体积提示保留；最终浏览器/整轮全量及用户验收仍待root，不沿用旧1304。


本轮有界恢复检查成功，未再出现403；仅修复全量1383项快照中唯一登记缺口：新增真实“能力配置”工具组（capabilities）登记mcp_manage/skill_manage，并补中文工具名，没有修改失败断言。分组只提供目录元数据/独立开关，原ToolAccess、Chief或宿主显式管理授权及精确Host确认不变；marker迁移不补授普通Bot能力。分组/settings/能力分配/真实Host与policy影响回归39/39、定点lint无警告，日志 `/tmp/pidot-r1-group-registration-{test,lint}.log`。1382/1383是修复前历史快照，最终全量由root重跑，不将39项相加成总数。共享Host此前六条真实集成及219/219冻结交付继续有效为既有证据：旧Chief同库开启新工具且不换ID、普通旧Bot不扩权、新Bot主会话GET200、原输入凭据续办、Skill机制确认及真实Skill requestStatus持久回执；本轮不重复全量。


当前仅做R1-12文档验收材料，业务源码和测试继续freeze。已建立ACCEPTANCE.md逐票实现/阶段证据/未验表与失败索引；1391/1391是外部MCP审批渲染修复前快照，最终精确计数、1440/375、Skill、disable与restart等root回执待补。R1保持active/待最终QA与用户验收，不移done。
