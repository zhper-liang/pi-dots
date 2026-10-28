# 当前状态与授权边界

更新：2026-10-29（Asia/Shanghai）。接手前读这一页，再读 [plans](plans/README.md)。

## 一句话状态

本地单用户核心闭环 MVP 已完成；统一工作区 V2（10 票）和"可控自动代理"（8 阶段）已实现、等待用户验收；权限简化 S1–S5 已实现并自测通过，等待用户验收；新阶段「Bot 工作区与 Hermes 风格统一」已授权，进行中。

## 进行中

| 计划 | 状态 | 下一步 |
|---|---|---|
| [权限简化](plans/active/permission-simplify/README.md) | S1–S5 完成：941/941 全量、lint、build、1440/375 双宽度真实操作通过；ADR-014 已写 | 等用户验收；其中「删除默认先问」已由下一行计划的 T01 改为直接执行（ADR-015） |
| [Bot 工作区与 Hermes 风格统一](plans/active-hermes-workspace-deepseek.md) | 2026-10-28 用户授权。已先做：工具组开关、`/Skill` 门槛、思考深度、多 @ 按序派发与验收后公开。T01/T03/T04 已从 hermes-shell 合并，与 T02 集成后 978/978、lint、build 通过；T03/T04 原分支临时库 1440/375 手测通过（假模型地址的失败为预期）。T01 工具组 ADR-015，T02 模型连接 ADR-016 | T01–T04 集成回归通过；T06 已实现并自测 984/984、lint/build、临时库 loopback 1440/375 通过，未验真实供应商；T05 已在独立 codex/t05-responsive-a11y（279ee5f）完成，未合并/推送 |

## 本次独立授权：T02 模型连接实时生效

用户已授权并完成 T02 后端：逐调用读取模型地址/key、同库目录 0600 设置文件、认证 `GET/POST /api/settings/model`；旧 Task 模型名及既有 Bot 版本不变，无配置启动后保存可使新 Task 使用真实模型。说明见 [运行手册](my-app/README.md) 与 [ADR-016](docs/decisions/README.md#adr-016-模型连接实时读取与独立凭证文件)。

自测：950/950、lint（7 条既有警告）、build 通过；临时库/一次性 token 的 curl loopback 模型链路含热更新、凭证隔离及重启恢复通过。未访问真实供应商/正式数据库；本票无前端改动，未做双尺寸网页验收。T02 待用户验收；2026-10-29 已授权合并 T01/T03/T04 后推进 T06，T05 独立分支。

## 已完成待验收

| 计划 | 状态 |
|---|---|
| [可控自动代理](plans/done/2026-10-23-controlled-automation/README.md) | 阶段 0a/0b、1–7 与 Skill 菜单全部实现；957/957、lint、build、双宽度手测通过 |

## 已验收完成

[Agent 运行骨架](plans/done/2026-10-17-agent-loop-foundation/README.md) · [多 Bot 与 Chief](plans/done/2026-10-17-multi-bot-chief/README.md) · [跨 Bot 协作](plans/done/2026-10-18-cross-bot-collaboration/README.md) · [群聊协作](plans/done/2026-10-18-group-chat-collaboration/README.md) · [飞书日历](plans/done/2026-10-19-feishu-calendar/README.md) · [统一工作区 V2](plans/done/2026-10-20-unified-workspace-v2/README.md)

## 授权边界

- 2026-10-28 用户授权新阶段「Bot 工作区与 Hermes 风格统一」，范围以 [该计划](plans/active-hermes-workspace-deepseek.md) 为准；计划内的票可以直接开工。
- 计划以外的**新阶段、新连接器、新依赖、子 Agent 仍需用户另行授权**；Google Workspace 本轮不接。
- 候选方向见 [plans/backlog](plans/backlog/)，未授权不得开工。
- 不操作正式数据库，不把凭证写入文档或日志。

## 交付基线

本阶段开工基线（2026-10-28，未提交的工作区，自动检查）：全量 953/953、lint 0 错误（既有 7 条 React effect 警告）、build 通过（既有 bundle 体积提示）；本轮改动尚未做浏览器手测。

最近业务验收：全量 941/941（权限简化 S4）、957/957（可控自动代理）、870/870（V2），lint 与 build 通过，含真实模型、provider 整链、重启恢复与 1440/375 双尺寸网页验证。原始失败、unknown 与跨租户豁免保留，不清账、不复活旧 Task。

单 Node / Harness / SQLite、本机单 owner、后台需在线；无系统推送、停机执行或 provider 原子 CAS / exactly-once 保证。邮件、外部待办、手机端/云端及多租户不在本版交付。
