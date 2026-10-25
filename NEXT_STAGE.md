# 当前状态与授权边界

更新：2026-10-25（Asia/Tokyo）。接手前读这一页，再读 [plans](plans/README.md)。

## 一句话状态

本地单用户核心闭环 MVP 已完成；统一工作区 V2（10 票）和"可控自动代理"（8 阶段）已实现、等待用户验收；权限简化 S1–S5 已实现并自测通过，等待用户验收。

## 进行中

| 计划 | 状态 | 下一步 |
|---|---|---|
| [权限简化](plans/active/permission-simplify/README.md) | S1–S5 完成：941/941 全量、lint、build、1440/375 双宽度真实操作通过；ADR-014 已写 | 等用户验收 |

## 已完成待验收

| 计划 | 状态 |
|---|---|
| [可控自动代理](plans/done/2026-10-23-controlled-automation/README.md) | 阶段 0a/0b、1–7 与 Skill 菜单全部实现；957/957、lint、build、双宽度手测通过 |

## 已验收完成

[Agent 运行骨架](plans/done/2026-10-17-agent-loop-foundation/README.md) · [多 Bot 与 Chief](plans/done/2026-10-17-multi-bot-chief/README.md) · [跨 Bot 协作](plans/done/2026-10-18-cross-bot-collaboration/README.md) · [群聊协作](plans/done/2026-10-18-group-chat-collaboration/README.md) · [飞书日历](plans/done/2026-10-19-feishu-calendar/README.md) · [统一工作区 V2](plans/done/2026-10-20-unified-workspace-v2/README.md)

## 授权边界

- 计划内阶段已全部实现，**新阶段、新连接器、新依赖、子 Agent 都需要用户另行授权**。
- 候选方向见 [plans/backlog](plans/backlog/)，未授权不得开工。
- 不操作正式数据库，不把凭证写入文档或日志。

## 交付基线

最近业务验收：全量 941/941（权限简化 S4）、957/957（可控自动代理）、870/870（V2），lint 与 build 通过，含真实模型、provider 整链、重启恢复与 1440/375 双尺寸网页验证。原始失败、unknown 与跨租户豁免保留，不清账、不复活旧 Task。

单 Node / Harness / SQLite、本机单 owner、后台需在线；无系统推送、停机执行或 provider 原子 CAS / exactly-once 保证。邮件、外部待办、手机端/云端及多租户不在本版交付。
