# 当前状态与授权边界

更新：2026-10-29（Asia/Shanghai）。接手前读这一页，再读 [plans](plans/README.md)。

## 一句话状态

本地单用户核心闭环 MVP 已完成；统一工作区 V2（10 票）和"可控自动代理"（8 阶段）已实现、等待用户验收；权限简化 S1–S5 已实现并自测通过，等待用户验收；新阶段「Bot 工作区与 Hermes 风格统一」T01–T11 已实现并完成本轮自测，等待用户最终验收。

## 进行中

| 计划 | 状态 | 下一步 |
|---|---|---|
| [权限简化](plans/active/permission-simplify/README.md) | S1–S5 完成：941/941 全量、lint、build、1440/375 双宽度真实操作通过；ADR-014 已写 | 等用户验收；其中「删除默认先问」已由下一行计划的 T01 改为直接执行（ADR-015） |
| [Bot 工作区与 Hermes 风格统一](plans/active-hermes-workspace-deepseek.md) | 2026-10-28 用户授权。已先做：工具组开关、`/Skill` 门槛、思考深度、多 @ 按序派发与验收后公开。T01/T03/T04 已从 hermes-shell 合并，与 T02 集成后 978/978、lint、build 通过；T03/T04 原分支临时库 1440/375 手测通过（假模型地址的失败为预期）。T01 工具组 ADR-015，T02 模型连接 ADR-016 | T01–T04 集成回归通过；T06 已实现并自测 984/984、lint/build、临时库 loopback 1440/375 通过，未验真实供应商；用户指定 T05 hermes-shell/7a0ce97 已于 6ec9a56 合并（唯一 CLAUDE.md 冲突已解决），保留 T02/T06，987/987、lint/build 通过；T07 已实现事项三标签/默认今日日历+到期待办、通知两分区与 skipped 收据；最终 991/991、lint/build 通过，临时库 loopback 1440/375 流程通过；真实供应商、真实键盘/系统减少动画、正式库与原库重启恢复未验；待用户验收 |

## 2026-10-29 续作：T08–T12

用户明确授权总管分派子 agent，按约 30 分钟独立工作包继续 T07 后票据，沿用 Hermes 视觉和简单交互。T08–T11 已实现并完成集成；T12 自动回归、隔离双宽度操作与文档同步已完成，**仍等待用户最终验收**，不移入 done。

- T08：桌面日历/待办同屏，窄屏切换和点击改期；冲突显示当前版本，断线保留原 requestId；外部来源只读。
- T09：每周/每月、短月取月末、六种频率表单、模型名/通知选项；正式结果通知与只读测试运行语义分开。回滚前在新版取消周/月计划，不能仅暂停后降级。
- T10：模型设置页（key 永不回显、环境只读），主会话逐输入选模型，独立 Task 保留快照；旧地址/key 每次调用实时生效。
- T11：人格替代旧职责、Bot 记忆与共享偏好，版本/来源/历史/纠正/删除；空闲有界提取、独立预算、实时注入、凭证过滤、来源隔离与删除防复活；生产入口已启用。
- 最终总管验证：**1104/1104**、lint 通过（7 条既有警告）、build 通过（bundle 大小提示），diff 检查通过；临时库 + loopback 供应商适配器 1440/375 主路径、偏好跨 Bot/删除、模型切换、接口与 SQLite/WAL 凭证扫描通过。原始证据在 `.scratch/hermes-workspace/t08-t12/`；自动重启/SIGKILL与权限/多@回归在全量套件内。
- 未验：真实外部模型供应商、真实飞书写入、正式库迁移/原库重启、真实系统辅助技术、真实鼠标拖动及真实触屏。浏览器验收使用隔离脚本操作，不等于用户验收。未加依赖，未改旧 Document/schemaVersion，未触碰 `.env`/正式 data，未提交/推送。

## 本次独立授权：T02 模型连接实时生效

用户已授权并完成 T02 后端：逐调用读取模型地址/key、同库目录 0600 设置文件、认证 `GET/POST /api/settings/model`；旧 Task 模型名及既有 Bot 版本不变，无配置启动后保存可使新 Task 使用真实模型。说明见 [运行手册](my-app/README.md) 与 [ADR-016](docs/decisions/README.md#adr-016-模型连接实时读取与独立凭证文件)。

自测：950/950、lint（7 条既有警告）、build 通过；临时库/一次性 token 的 curl loopback 模型链路含热更新、凭证隔离及重启恢复通过。未访问真实供应商/正式数据库；本票无前端改动，未做双尺寸网页验收。T02 待用户验收；2026-10-29 已合并 T01/T03/T04 并完成 T06；本次用户指定合并 T05 hermes-shell/7a0ce97 后实施 T07，不推送。

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
