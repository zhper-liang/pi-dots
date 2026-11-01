# 工作区

工作区是用户实际管理的业务数据：日程、待办、计划、提醒、通知。本文讲这些对象、写操作怎么保证一致、后台怎么同步和触发。谁能读写见[能力与权限](capabilities.md)，飞书和 Google 的接入见[外部连接](integrations.md)。

## 一个日历，标明来源

本地、飞书和 Google 日程汇总到同一个日历，按时间排列。日/周/月和手机列表中的日程、全天事项及待办截止项均直接显示来源标签；详情显示具体日历名。来源用于标记归属和确定写入位置，不是独立日历入口，也不表示数据真假。本地日历持久保存在本机，不称为模拟日历。

机器人查询安排和冲突时汇总当前可读来源，逐条标注来源。未连接或未读全的来源要说明覆盖范围，不能把未取得的数据当作空闲。外部来源连接成功后由现有刷新流程加入同一日历；展示聚合不自动绑定账号、复制事项或改变来源的写权限。

## 三个入口，一套规则

| 入口 | 路径 | 调用模型吗 |
|---|---|---|
| 网页手动操作 | 认证 HTTP → `workspace-service` | 不调用，也不生成机器人消息 |
| 应用内 Agent | 宿主管理的内部 MCP 会话（`workspace-mcp-host.mjs`）→ `workspace-service` | 是模型发起的 |
| 本机外部 MCP 客户端 | stdio 桥 → 受限 loopback relay → 内部 MCP | 不涉及 |

三条路径共用身份校验、来源路由、版本检查、确认和审计。MCP 不是数据库或 UI 协议，stdio 桥不打开数据库。

内部 MCP 的规范工具名是 `workspace.list`、`workspace.get`、`workspace.prepare_change`、`workspace.prepare_schedule`、`workspace.operation_status`；模型那边看到的 `workspace_*` 只是别名，服务端还原为规范名。`prepare_change` 名字带 prepare，但裁决允许时直接应用；`prepare_schedule` 只返回不可执行的草案。

## 对象

所有对象存为 Harness Documents（`workspace-repository.mjs`），身份是 `ownerId + sourceId + id`，`schemaVersion` 当前为 1。字段和校验以 [workspace-schema.mjs](../../my-app/server/workspace-schema.mjs) 为准。

| 对象 | 作用 |
|---|---|
| Connection / Source | 外部账号连接和一个日历或任务列表；存权威方和能力，不存明文凭证 |
| Grant | 用户对某个来源的许可：动作、读取范围（none / busy / full）、epoch |
| Event | 日程：带偏移的起止时间和 IANA 时区，保留本地或外部来源身份 |
| Todo | 待办：状态、截止、版本。截止时间不占日历时段 |
| ItemLink | 待办和日程的显式关系，存两端版本；不自动合并，删除不级联 |
| Operation / Outbox | 一次写命令：requestId、精确参数、确认、状态、回执；Outbox 是事务内的派发意图 |
| Schedule / Occurrence | 计划定义和某一次触发；触发唯一键是 `scheduleId + revision + UTC 时间` |
| SyncState / SyncEntry | 同步窗口、generation、coverage、外部版本、最后成功时间 |
| Reminder / Delivery / Notification | 绑定目标版本的提醒、处理记录、收件箱条目 |
| Finding | 检测器发现的问题，按对象版本去重 |

## 谁说了算

- 本地事项以本地库为准；外部事项以飞书或 Google 为准，缓存标明来源、版本、观察时间、是否完整、是否新鲜。缓存不是写回成功，过期或不完整时不能当成最新完整日历。
- 本地来源对所有者始终完整可读写；外部来源连上即授权，用户可以收窄。
- 只给忙闲的来源在服务端投影成时段，界面、工具结果、历史回读、关联关系都拿不到正文。
- 撤权不删来源、Task、确认或审计，也不把旧的 `unknown` 改写成成功或失败。

## 写操作的一致性

**本地写**：业务对象、Operation 和 Outbox 在同一个事务里提交，失败整体回滚。requestId 绑定规范化参数和主体：同键同参返回原回执，同键异参拒绝。修改带 `expectedVersion`，版本不对就返回冲突。

**外部写**：派发前复核权限、版本、冲突和取消 → 持久化派发状态 → 请求外部 API → 收到明确回执就记录结果；发出后没有明确回执就记 `unknown`，保留原 requestId，等核查。不换新 requestId 重试，查询不到不代表没发生。外部写不能和本地事务原子提交，版本预检也不是外部的原子 CAS，不承诺 exactly-once（ADR-006）。

Operation 状态：prepared、awaiting_confirmation、ready、dispatching、succeeded、failed、conflict、unknown、cancelled、expired。不能只凭 HTTP 200 判断外部改成功了。

本地自动改动在版本没变时可以撤销（`workspace-mcp-business.mjs`）；外部写入不能撤销。

## 同步

后台只读重扫外部的时间窗口，并按需精确读取，更新缓存的 generation、coverage、外部版本和最后成功时间（`workspace-sync.mjs`）。移出窗口不等于删除。只读失败按 30 秒、120 秒退避，最多 3 次；这个退避不用于外部写的 `unknown`。外部改期或删除会让旧提醒版本失效。

同步回答“外部发生了什么”，计划回答“什么时候做什么”，两者是不同的状态机（ADR-007）。

## 计划和例行任务

规则支持一次（at）、每天、工作日、每周、每月（短月取最后一天）和 60 秒到一年的固定间隔，必须带时区；不是完整的 cron 或 RRULE。夏令时缺失的时刻跳过，重复的时刻取第一个 UTC 瞬间。最多 200 个计划，每轮扫描预算 1000（`workspace-schedule-rules.mjs`、`workspace-schedule.mjs`）。

派发前检查计划版本和权限。暂停不补跑，取消不撤销已经发生的外部效果。

| 动作 | 怎么执行 |
|---|---|
| 内部确定性动作、普通提醒 | 写记录，不调用模型 |
| 例行任务、只读简报 | 为这次触发创建并关联一个 Harness Task，复用同一个 Agent 循环（`workspace-agent-workflows.mjs`）；失败或 `unknown` 留在原 Task，不新建 Task 重试 |
| 事件触发 | 待办到期、日程变更、本机器人任务结束；合并触发，自己的改动不会触发自己 |

例行任务的结果投递到指定机器人当前的主会话，运行时的权限限制见[能力与权限](capabilities.md#专用运行的限制)。

## 提醒和通知

Reminder 绑定精确目标和版本，目标改期就重新计算；触发前核对来源和正文许可，核对失败就不发，而不是发旧内容。Delivery 和 Notification 持久化并去重（`workspace-reminders.mjs`）。现在只有应用内收件箱：recorded / read 不等于系统推送或用户真的看到了。

## 检测器

`detectors.mjs` 用纯代码找冲突、逾期、会前未准备、话题跟进（等你补充、确认，或等主管验收超过 4 小时）和每日昨日遗留。触发来自数据变化标记（同事务写入，2 秒去抖）和检测器自己的唤醒时间，每次重算 7 天范围。结果按对象版本去重，推到主管主会话和收件箱：每天最多 10 张卡，22:00–08:00 只进收件箱。检测器不调用模型、不读聊天正文（ADR-013）。

“帮我想办法”默认关闭，在设置里打开后，用户点击才会开一个只读分析 Task。

## 启动与回滚

进程停机时什么都不执行；启动后先恢复撤权、取消和未知操作，再按持久状态和错过触发的规则开始派发。回滚是禁用工作区入口或计划，不降 schema，不删审计。具体步骤见[运行手册](../engineering/operations.md)。

## 源码入口

[workspace-service.mjs](../../my-app/server/workspace-service.mjs) · [workspace-local.mjs](../../my-app/server/workspace-local.mjs) · [workspace-repository.mjs](../../my-app/server/workspace-repository.mjs) · [workspace-schema.mjs](../../my-app/server/workspace-schema.mjs) · [workspace-mcp-host.mjs](../../my-app/server/workspace-mcp-host.mjs) · [workspace-mcp-business.mjs](../../my-app/server/workspace-mcp-business.mjs) · [workspace-tools.mjs](../../my-app/server/workspace-tools.mjs) · [workspace-providers.mjs](../../my-app/server/workspace-providers.mjs) · [workspace-sync.mjs](../../my-app/server/workspace-sync.mjs) · [workspace-schedule.mjs](../../my-app/server/workspace-schedule.mjs) · [workspace-reminders.mjs](../../my-app/server/workspace-reminders.mjs) · [detectors.mjs](../../my-app/server/detectors.mjs)
