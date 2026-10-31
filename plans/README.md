# 计划

本目录保存所有"要做什么"的计划正文，按状态分三类。已完成的计划保留当时的计划正文，供追溯"为什么这么做"；当前有效的产品与架构结论只在 [docs](../docs/README.md)。

| 状态 | 目录 | 含义 |
|---|---|---|
| 进行中 | `active/` | 已授权、正在实施或已完成实现但还没验收的计划 |
| 已完成 | [`done/`](done) | 已实施并验收的计划，正文冻结，不再更新状态 |
| 候选 | [`backlog/`](backlog) | 想法和草案，未授权开工；不代表路线承诺 |

## 进行中

| 计划 | 更新 | 状态 |
|---|---|---|
| [第三轮：Google Workspace](active/r3-google-workspace/README.md) | 2026-10-30 | 实现完成，test 1531/1531、lint/build 通过；待用户验收（真实 Google 账号手测由用户做） |
| [第四轮：降低使用负担](active/r4-simplify/README.md) | 2026-10-31 | 实现完成，test 1537/1537、lint 10 条既有 warning（无新增）、build 通过；双尺寸 UI 22 画面通过，待用户验收；与第三轮并行 |

## 已完成

按完成时间排序。

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

## 候选

| 计划 | 状态 |
|---|---|
| [Grok 风格前端布局](backlog/frontend-layout-grok.md) | 草案，未授权开工 |
| [2026-10-29 使用反馈：会话、卡片任务与可组合 Bot](backlog/2026-10-29-workspace-experience.md) | 11 项需求来源；第一轮、第二轮已完成（见上方已完成），Google 为第三轮候选 |

## 约定

1. 计划正文写"要做什么、怎么验收、边界在哪"；实施过程与原始证据留在本地 `.scratch/<topic>/`（不进仓库，可在 git 历史中查到）。
2. 计划完成并验收后，从 `active/` 移到 `done/`，日期取验收日期，正文不再修改；后续变更由新计划承接。
3. 长期有效的结论（产品规则、架构、接口、决策）提炼进 [docs](../docs/README.md)，计划不承担规范职责。
4. 每份计划开头写明状态与依据；没有明确授权，候选计划不得开工。
5. `plans/done/` 里的计划正文是**当时的原文**，不随结构调整改写。文中 `issues/`、`progress/evidence/` 等相对链接指向原始实施目录，这些票据与证据已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`，不随本仓库分发。
