> **说明**：本文是当时的方案对比原文。文中的 `s4-ui/`、`s4-*.log/` 等相对链接指向原始实施目录 `.scratch/permission-simplify/`，已归档到仓库外的备份仓库，不随本仓库分发。

# 权限简化：两版对比（待选）

更新 2026-10-23。基线提交 `d7d697e`。用户已定：默认只有"删除"先问；先出方案，点头后再动手。选定后，本文件取代 `next-stage-grok-gap/PLAN.md` 第 3、4 节中关于权限的部分，并改写 ADR-005/011/012。

## 现在：一次调用要过的关（已读代码核实）
| 层 | 位置 | 检查 |
|---|---|---|
| 1 工具可见 | `tools.mjs:60-93` | 已安装、Task 快照里有、Bot 已分配、能力池有、未撤、快照未撤、快照池有、池与 Bot 两个 epoch 未变，共 8 个条件；之后再按主会话、例行任务、测试运行、帮我想办法四种情况各裁一次 |
| 2 来源许可 | `workspace-policy.mjs:20`、`workspace-grants.mjs` | 每个来源一份 Bot Grant：actions、readScope(none/busy/full)、grant epoch、连接 epoch |
| 3 档位 | `workspace-mcp-business.mjs:11`、`:159` | 改档位时同时写 Grant 和预设规则，同一个概念存两份 |
| 4 裁决 | `policy.mjs:81` | R4、未登记、R0、规则、H/第 6 条、暂停、每小时 20 条 |
| 5 模块守卫 | `collaboration.mjs:22`、`chief-management.mjs:14-36` | 各自再查一遍分配、epoch、身份 |
| 6 例行任务快照 | `workspace-agent-workflows.mjs:22-42` | 建任务时存一份授权快照（含 Bot 配置版本），运行时做哈希比对，对不上就在 `workspace-schedule.mjs:194` 静默取消 |

一次派生 Task 新建本地待办，要过 1、2、4 三层，约 20 个条件；例行任务还要再加第 6 层。

实际后果：
- 给 Bot 加了工具，已有的 Task 也用不上（快照里没有），必须新建 Task 或走配置迁移（`task-migration.mjs`）。
- 改档位会递增 epoch，运行中的 Task 立即失效（`workspace-mcp-business.mjs:157` 注释）；改档位或改 Bot 配置后，例行任务可能被静默取消。
- 界面上配权限的地方约 6 处：BotConfiguration、BotCreation、BotTemplatePage、BotRules、AgentWorkspace、TaskConfigurationMigration。

## A 极简
- 能不能用：Bot 页上勾选的工具就是能用的工具。能力池、epoch、Task 权限快照、Grant/readScope、档位、配置迁移全部删除。增减权限都从所有 Task 的下一次调用起生效。
- 飞书"只给忙闲"不再靠 readScope：只勾 `calendar_feishu_freebusy`、不勾读详情的工具即可。
- 要不要问：一张表，键是工具（可加动作），值是直接做或先问。默认只有删除先问；审批卡上点"以后直接做"就写一条规则。`policy.mjs` 缩成这张表加一个函数。
- 没有风险分级，也没有硬底线。按你的选择，对外写入、批量改动、建例行任务、Chief 改 Bot 配置（包括给自己加工具）都直接执行。
- 按 Task 种类裁剪工具（主会话、例行任务、测试运行、帮我想办法），收进一张表，不再散在四处 if 里。
- 不变的部分（属于正确性，不是关卡）：凭证只留在服务端；Operation 幂等，unknown 不盲重试；本地自动改动可撤销；取消和暂停照旧。

## B 保守
- 能力层与 A 相同，全部删除。
- 保留 R0–R4/H 和 `decide()`，默认值按你的选择改：只有删除询问，对外写入改为直接做。
- 保留代码里的硬底线：R4 一律拒绝（Bot 改自己权限、停用 Chief 等）；H 必问且卡上没有"总是"（例行任务增改、Bot 权限变更、同一输入第 6 条起的改动）。
- 保留每小时 20 条上限，以及暂停期间 allow 降为询问。

## 对比
| | 现在 | A | B |
|---|---|---|---|
| 新建本地待办要过的检查 | 3 层，约 20 个条件 | 2 个：勾了没、表里是不是先问 | 2 个，外加硬底线 |
| 给 Bot 加工具后旧 Task 能否用 | 不能，要迁移 | 下次调用就能用 | 同 A |
| 配权限的界面 | 约 6 处 | 1 处（Bot 页：工具勾选 + 规则） | 1 处 |
| Bot 能否给自己加权限 | 拒绝 | 能 | 拒绝 |
| 建例行任务 | 必出卡 | 直接建 | 必出卡 |

预计删除或缩减的部分（按调用关系估算，开工时逐个确认）：`workspace-grants.mjs`、`workspace-policy.mjs`（只留认证）、`task-migration.mjs`、`AgentWorkspace.tsx`、`TaskConfigurationMigration.tsx`、`TIERS`/`setTier`/`manageGrant`、各处快照与 epoch；对应测试重写。B 在这些之外保留 `policy.mjs` 的分级。

## 已定（2026-10-23 用户点选）
1. 选 A 极简。
2. 主会话直接写：带上 Bot 勾选的全部工具；派生 Task 只用于长任务。
3. 无人值守遇到"先问"：不出卡，跳过这一步，在运行结果里写明"跳过了，需要你来做"。
4. 保留 stdio MCP 桥和凭证，删除 AgentWorkspace 面板；凭证的发放和撤销移到设置页。

## 实施步骤
每步做完都要满足：`pnpm test` 全绿（删掉断言旧关卡的测试，为新行为补测试）、`pnpm lint` 和 `pnpm build` 通过。全程不提交 git，不改 `.env`。

### S1 能力层：实时生效
- 实施状态（2026-10-24）：已完成。补齐旧 Task 实时增加/撤销工具与资源、主会话直接写、飞书及工作区历史在撤权后复核等测试。全量测试 940/940 通过，lint、build 通过。
- 删除能力池：`access.pool`、`poolEpochs`、`botEpochs`、`revokeEpochs`、`permissionSnapshot`，以及 `/api/capability-pool` 的 get/update。唯一依据是 `access.assignments[botId]`。可选工具 = 已安装的非管理工具；可选资源 = `supportedResources` 加当前飞书绑定的资源。飞书断开或换绑时，把旧资源从所有 Bot 的分配里去掉（`feishu-calendar.mjs:90/103/107`）。
- `initializeConfiguration`：分配默认取 `bot.defaults`，不再按池过滤。行为变化：预置 Bot 的默认工具直接算已勾选。新建 Bot 默认带本地工作区工具（D-15），同样不看池。
- `toolSets`：authorized = 已安装 ∩ 当前分配 − `access.revoked`。不再看 `card.parameters.tools` 和快照。Chief 的管理工具只要没撤销就有。按 Task 种类裁剪：scheduledWorkflow、findingAssist 保留原有裁剪；主会话 = authorized + MAIN_TOOLS + automation_pause，不再过滤成只读。resources = 当前分配，scheduledWorkflow 和 findingAssist 再与 `card.parameters.toolResources` 取交集。
- 删除所有"固定授权仍然有效"的检查：`collaboration.mjs:116/137`、`blockers.mjs:101`、`task-migration.mjs:60` 等。`main-session.mjs` 每次输入的权限刷新和"降权后上下文从刷新点开始"（D-04）一并删除。
- 系统提示里按工具拼接的段落（`task-context.mjs:124/125/156/196`）改按实时可用工具生成。
- 新测试：给 Bot 加工具后，已有 Task 的下一次调用就能用；取消勾选后，下一次调用就不能用；主会话能直接调用写工具。

### S2 工作区授权：去掉 Bot Grant
- 实施状态（2026-10-24）：已完成。Bot 工作区权限改为实时工具/来源分配；stdio 凭证保留独立范围与到期/撤销；例行任务派发实时复核并记录失效原因。S2 相关测试 61/61 通过；lint、build 通过。S2 单步验收时尚未处理的 S1 旧测试与 S3 裁决断言，现已在 S1/S3 阶段补齐。
- `workspace-policy.mjs` 的 `authorize`：保留来源和连接 active、来源能力、用户 Grant（local 走所有者隐式许可，外部来源照旧）。Bot 一侧改为实时判断：读需要分配了 list/get，写需要分配了 prepare_change，并且分配了 `workspace:<sourceId>`、没有撤销。stdio client 还要检查自己的 scope（sources/actions/readScope）、未过期、未撤销。readScope = 用户 readScope，client 再与自己的取交集。删除各种 epoch、`grantEpochs`、`scheduleRevision` 的比对。
- 删除 `captureWorkspaceGrants`、`card.workspaceSnapshot`。`workspaceHistoryAllowed` 改为实时判断：Bot active、有对应工具和资源、来源连接 active。`workspaceShareAllowed` 改为：读者的 Bot 当前分配了作者用过的每个 workspace 资源。
- 删除 `TIERS`、`setTier`、`manageGrant`、`grantStatus` 和对应接口（agent-grant、agent-grant-status、档位接口），以及 `tasks.mjs:1371` 给 Chief 设 read 档的那段。client-issue 改为只校验 Bot 存在且当前分配了对应的 workspace 工具和资源。
- 例行任务：去掉 `workspace-agent-workflows.mjs` 的授权快照和哈希比对。派发时实时检查 Bot active、分配了 list/get、分配了各来源资源、来源 active；不满足就取消并写明原因。改 Bot 配置不再导致例行任务被静默取消。
- 用户级提醒和内部计划的 `authorizationSnapshot`（用户与连接 epoch）不动。

### S3 裁决：只有直接做/先问
- 实施状态（2026-10-24）：已完成。默认新建/修改直接执行、删除先问；最具体规则优先，同级 deny > ask > allow；全局暂停降为先问；无人值守跳过需确认的动作并记录；Chief 创建/配置直接执行、停用先问。移除旧风险档位、批量计数和小时上限，保留精确意图/幂等与结果未知保护。全量测试 940/940 通过，lint、build 通过。
- `decide(tx, call)`：
  - 读和内部协作工具（原 R0 列表）一律 allow，规则不作用于它们。
  - 写工具先查规则（tool、action、sourceId、type，取最具体的；同样具体时 deny > ask > allow）。没有规则时，删除类为 ask，其余为 allow。删除类包括：`workspace.prepare_change` 的 delete 动作、`calendar_feishu_delete_event`、`bot_manage` 的 deactivate。
  - 全局暂停时，写入的 allow 降为 ask。
  - 未知工具 deny。
- 无人值守（origin 为 routine、event、detector）遇到 ask：不出卡，返回工具结果"已跳过：这一步需要你来做"，并在运行记录里留一条。删除 30 分钟过期的逻辑。在场时本地提案仍保留 5 分钟。
- 删除 R0–R4 与 H 的分级、R4、批量计数（InputChanges）、每小时上限（AutoWrites）、client 必须确认、`writeTierPreset`、`migrateLegacyRules`、`TIER_PRESETS`。已有的 origin='preset' 规则读取时忽略，写入时清掉。`validateRule` 不再限制 allow，`match` 去掉 risk。
- 任何 ask 卡都可以点"以后直接做"。`src/system-cards.mjs` 去掉 H 类不显示"总是"；暂停中和结果未知后的重做审批照旧不显示。
- `chief-management.mjs`：create 和 configure 直接执行，deactivate 先问；删除池相关的 R4；`admissionDenied` 去掉 epoch 比对。保留"Chief 不能停用自己"，因为停用后主入口就没了。
- 新测试：删除默认先问，点"以后直接做"后自动执行；暂停时写入改为询问；无人值守的删除被跳过并有记录；Chief 能直接改其他 Bot 的配置。

### S4 界面
- 实施状态（2026-10-24）：已完成。删除能力池、档位和 AgentWorkspace 界面；Bot 设置统一工具/资源与规则；stdio 凭证发放、列表、撤销移到设置页。模型/提示词迁移保留，权限不再迁移。补齐主会话工作区删除确认卡与“以后直接做”，修复同 Bot 配置入口。全量测试 941/941 通过，lint、build 通过；1440/375 隔离数据库真实 UI 流程通过（建 Bot、勾选、删除确认→规则生效、凭证发放/刷新/撤销）。验收见 [S4 acceptance](s4-ui/acceptance.md)。
- 删除能力池界面、档位界面（`botTier.ts` 及其引用）和 `AgentWorkspace.tsx`。stdio 凭证的发放、撤销和列表移到 SettingsPage，做成一个精简区块。
- Bot 页只剩工具和资源勾选，加上规则列表（BotRules）。`TaskConfigurationMigration` 删掉权限相关部分；只为模型和提示词迁移保留，如果它已经没有作用就整个删除。
- 双宽度手测按 [[pidot-manual-ui-test]] 的做法：1440 和 375，建 Bot、勾工具、对话里删除并点"以后直接做"。

### S5 文档
- 实施状态（2026-10-24）：已完成。新增 ADR-014，明确实时工具/资源分配与“直接做/先问”规则，并标注替代 ADR-005/011/012；同步改写运行架构、HTTP API、MVP 范围与系统设计；在 next-stage-grok-gap/PLAN.md 第 3、4 节顶部注明取代关系。文档链接检查通过；全量测试 941/941、lint、build 通过。
- 在 `docs/decisions/README.md` 新增 ADR-014，替代 ADR-005（Task 固定许可）、ADR-011（Bot 档位和 Bot Grant）、ADR-012（风险分级）中的相应部分。
- 同步改写 `agent-runtime.md` 的权限段、`http-api.md` 中删掉的接口、`mvp-scope.md` 和 `system-design.md` 的"权限与责任"。
- 在 `next-stage-grok-gap/PLAN.md` 的第 3、4 节顶部注明已被本文件取代。
