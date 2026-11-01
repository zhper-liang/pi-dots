# 计划

本目录保存所有"要做什么"的计划正文，按状态分三类。已完成的计划保留当时的计划正文，供追溯"为什么这么做"；当前有效的产品与架构结论只在 [docs](../docs/README.md)。

| 状态 | 目录 | 含义 |
|---|---|---|
| 进行中 | `active/` | 已授权立项规划、正在实施或已完成实现但还没验收的计划；具体范围看正文 |
| 已完成 | [`done/`](done) | 已实施并验收、或已被后续计划替代的计划；正文冻结，不再更新状态 |
| 候选 | [`backlog/`](backlog) | 想法和草案，未授权开工；不代表路线承诺 |

## 进行中

长任务持续执行已完成计划与分票，代码未开始；其余下列计划已实现、等用户验收。验证结果见 [NEXT_STAGE](../NEXT_STAGE.md)。

| 计划 | 更新 | 内容 |
|---|---|---|
| [长任务持续执行](active/long-running-agent/README.md) | 2026-11-02 | 四类职责、九张本地票、设计契约与验收矩阵已发布；当前可领取 LR-01，尚未开发 |
| [协作、会话与模型故障修复](active/collaboration-session-reliability/task_plan.md) | 2026-11-01 | 协作结果交付、机器人主会话列表、目录和时间提示；本地验证完成，真实模型原因待查 |
| [会话提问与能力管理优化](active/conversation-capabilities/task_plan.md) | 2026-11-01 | 表单与输入挂起恢复、能力同步、飞书来源统一入口、自动诊断（ADR-027）；实现完成，待验收 |
| [主会话长期记忆与经验沉淀](active/memory-learning/README.md) | 2026-11-01 | 按会话整理记忆、持久作业、历史搜索、学成 Skill（ADR-026） |
| [原生能力与删除确认](active/native-capabilities/README.md) | 2026-11-01 | 自带 bash/read/write/edit，只有删除逐次确认，历史回查默认自带（ADR-024、025） |
| [多模型登记与创建 Bot 选择](active/model-registry/README.md) | 2026-11-01 | 多供应商登记，新建机器人可选模型 |
| [普通 Bot 平等与空白创建](active/bot-equality/README.md) | 2026-11-01 | 除主管外地位相同，默认空白（ADR-023） |
| [第三轮：Google Workspace](active/r3-google-workspace/README.md) | 2026-10-30 | Google 混合接入（ADR-020、021），真实账号待用户手测 |

## 已完成

按完成时间排序。标“未验收即归档”的是已被后续计划替代、用户没有单独验收的。

| 完成日期 | 计划 | 一句话结果 |
|---|---|---|
| 2026-10-17 | [Agent 运行骨架与基础 loop](done/2026-10-17-agent-loop-foundation/README.md) | 23 票：本地对话 → 真实模型 → 工具循环 → Skill → 消息控制 → 恢复 |
| 2026-10-18 | [多 Bot 与 Chief 管理](done/2026-10-17-multi-bot-chief/README.md) | 6 票：Bot 创建、版本化配置与撤权、安全迁移、停用、Chief 对话管理 |
| 2026-10-18 | [跨 Bot 协作与任务闭环](done/2026-10-18-cross-bot-collaboration/README.md) | 6 票：委派、受限共享、阻塞上报、返工验收、停止与概览 |
| 2026-10-18 | [群聊与 @ 协作](done/2026-10-18-group-chat-collaboration/README.md) | 6 票：群入口、定向 @ 与 fork、来源可溯、群内审批与验收 |
| 2026-10-19 | [飞书应用日历](done/2026-10-19-feishu-calendar/README.md) | 6 票：只读连接、审批后创建/更新/删除、忙闲、图形日历与安全编辑 |
| 2026-10-20 | [统一工作区 V2](done/2026-10-20-unified-workspace-v2/README.md) | 10 票：统一日程/待办、MCP 业务工具、持久计划、同步、提醒、定时 Agent |
| 2026-10-23 | [可控自动代理](done/2026-10-23-controlled-automation/README.md) | 8 阶段：权限裁决层、主会话、检测器、审批"总是"、统一卡片、例行任务、帮我想办法 |
| 2026-10-30 | [权限简化](done/2026-10-30-permission-simplify/README.md) | S1–S5：Bot 页勾选即可用、直接做/先问两档、无人值守遇先问跳过；删除默认先问后由 ADR-015 改为直接做 |
| 2026-10-30 | [Bot 工作区与 Hermes 风格统一](done/2026-10-30-hermes-workspace/README.md) | T01–T12：工具组开关、模型连接实时生效、Hermes 外壳与视觉、Bot 目录、事项与日历、周/月例行任务、模型设置、人格与记忆 |
| 2026-10-30 | [第一轮：交互收口与 Agent 能力配置](done/2026-10-30-workspace-experience-r1/README.md) | 12 票：会话删除、模型卡片、@ 菜单、日历与定时任务卡片、能力开关与空白 Bot、外部 MCP、Skill 导入、对话配置；ADR-018 去掉其确认关卡 |
| 2026-10-30 | [第二轮：文件式记忆](done/2026-10-30-r2-file-memory/README.md) | 8 票：每 Bot PROFILE/MEMORY 与共享 USER.md 文件、对账与原子写回、迁移与回滚开关、记忆页文件状态（ADR-019） |
| 2026-11-01 归档 | [第四轮：降低使用负担](done/2026-10-31-r4-simplify/README.md) | **未验收即归档**：能力三栏开关、日程与待办合并、对话/设置/事项收简（ADR-022）；新建默认能力后被 ADR-023 改为空白 |
| 2026-11-01 归档 | [模型上下文、Pi 压缩与记忆工具](done/2026-11-01-context-memory/README.md) | **未验收即归档**：模型容量默认 256K、复用 Pi 压缩、固有记忆工具；后续由记忆学习计划承接 |

## 候选

| 计划 | 状态 |
|---|---|
| [长任务持续推进调研](backlog/2026-11-01-long-running-agent/README.md) | 研究记录；已由长任务持续执行正式计划承接，不单独实施 |
| [2026-10-29 使用反馈：会话、卡片任务与可组合 Bot](backlog/2026-10-29-workspace-experience.md) | 11 项需求来源；第一、二轮已完成，第三轮 Google 实现完成待验收 |

## 约定

1. 计划正文写"要做什么、怎么验收、边界在哪"；实施过程与原始证据留在本地 `.scratch/<topic>/`（不进仓库，可在 git 历史中查到）。
2. 计划完成并验收后，从 `active/` 移到 `done/`，日期取验收日期，正文不再修改；后续变更由新计划承接。被后续计划替代的也可以归档，开头写明“未验收即归档”和替代它的计划。
3. 长期有效的结论（产品规则、架构、接口、决策）提炼进 [docs](../docs/README.md)，计划不承担规范职责。
4. 每份计划开头写明状态与依据；没有明确授权，候选计划不得开工。
5. `plans/done/` 里的计划正文是**当时的原文**，不随结构调整改写。文中 `issues/`、`progress/evidence/` 等相对链接指向原始实施目录，这些票据与证据已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`，不随本仓库分发。
