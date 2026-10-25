# 统一工作区架构

当前基线：本地单 owner、一个显式绑定飞书应用日历、一个 Node 后端与既有 Harness/SQLite。本文是现行架构，不维护拆票顺序或历史完成流水。支持边界见 [MVP 范围](../product/mvp-scope.md)。

## 统一业务入口
React → 认证 HTTP API；内部 Agent → 宿主管理的 MCP session；外部本地 client → stdio 桥 → 受限 loopback relay。三者共享主体校验、权限、来源路由、版本、确认与审计规则。MCP 不是数据库或 UI 渲染协议，stdio 桥不打开数据库。

用户手动操作产生非聊天 Operation，不制造 Bot 消息、不调用模型。旧聊天审批/Feishu API 保留原语义；旧审批不自动转换成新工作区批准。

## 记录与身份
通过现有 Harness Documents/Document families 封装 repository，不引入第二数据库。当前 schemaVersion 为 1（架构 V2 不是 schemaVersion 2）。记录统一具有 id、ownerId、sourceId；身份复合键隔离来源，授权 epoch 不参与对象身份。

| 记录 | 作用 |
|---|---|
| Connection / Source | provider 账号引用、稳定容器身份、authority 与 capabilities；不保存明文凭证 |
| Grant | user/bot 主体、动作、none/busy/full 读取范围和撤权 epoch |
| Event / Todo | 有版本的业务对象；普通日程使用带偏移时间和 IANA 时区；待办截止不占时段 |
| ItemLink | 本地显式关系；todoRef/eventRef 含 type/sourceId/id，保存两端版本；不自动合并或级联删除 |
| Operation / Outbox | 命令、请求幂等、精确参数/批准/版本/状态、回执与事务内派发意图；pending 不等于送达 |
| Schedule / Occurrence | 持久计划定义与单次触发；触发唯一性为 scheduleId + revision + UTC scheduledFor |
| SyncState / SyncEntry | 窗口、coverage、generation、版本、缓存观察时间和同步错误 |
| Reminder / Notification / Delivery | 目标版本提醒、收件箱与处理结果；记录/已读不等于实际送达 |

记录定义与校验以 [workspace-schema.mjs](../../my-app/server/workspace-schema.mjs) 为准，持久边界见 [workspace-repository.mjs](../../my-app/server/workspace-repository.mjs)。

## 权威来源与权限
- 本地事项为本地权威；飞书为外部权威，缓存注明来源、版本、观察时间、完整性与新鲜度。
- 用户与 Bot 来源权限独立；Bot 还受能力池/工具白名单、Task 快照和实时撤权约束。
- busy-only 在服务端投影，UI 展开、工具结果、历史回读和关联关系都不能泄漏正文。
- 显式跨来源关系需要两端当前权限与版本；外部端使用包含实例身份的缓存引用。查询、回执与幂等恢复同样复核两端授权。
- 撤权不删除来源、Task、审批或审计，不把旧 unknown 改写成失败或成功。

## 命令与一致性
本地提交在同库事务中保存业务对象、Operation 和相关 outbox/执行记录；失败回滚。requestId 绑定规范化参数与主体；同键异参拒绝，同键同参读取原回执。

外部命令按准备 → 用户精确确认 → 派发 → 回执运行，确认绑定来源、对象、版本、参数、授权代数及有效期。派发前再次检查权限、冲突和取消。外部 provider 与本地事务不能原子提交，发送后无回执必须保留 unknown，不以缓存、重试或另建请求消除不确定性。外部版本预检不是 provider 原子 CAS，也不提供通用 exactly-once。

Operation 状态包括 prepared、awaiting_confirmation、ready、dispatching、succeeded、failed、conflict、unknown、cancelled、expired；调用方不得仅凭 HTTP 200 推断外部变更成功。

## 同步
后台只读窗口重扫与精确查询刷新外部缓存，记录 generation、coverage、remoteVersion 和 lastSuccessAt。窗口移出不等于删除；不完整、失败或过期结果明确标识，不能当作完整最新列表。

同步与调度分离；安全只读失败采用有限退避（30/120秒、最多3次），不能套用到外部未知写。外部改期或删除使旧提醒版本失效，重新推导触发或抑制旧内容。

## 持久计划
支持一次性 at、每日 daily、固定 interval（60秒至一年整数秒），需显式时区；不提供完整 cron/RRULE。每日 DST 缺失时刻跳过，重叠时刻选择第一个 UTC 瞬间。

Schedule 固定执行主体、动作、许可、规则、revision 和额度；Occurrence 保存领取、attempts、Operation/Task/Delivery 关联及结果。派发前检查当前计划版本和权限。计划规模上限200、扫描预算1000；暂停不补跑，取消不撤销既有外部效果。

普通内部动作和提醒为确定性执行、不调用模型。只读 Agent 简报复用原 Harness Task；失败或 unknown 留在原 Task，不创建新 Task 盲重试，不开放自动业务写/委派。

## 提醒与通知
Reminder 绑定精确目标及版本，改期重新计算；触发前核验来源和敏感正文，失败则抑制而非发送陈旧内容。Delivery、Notification、去重与执行结果持久化。当前渠道为应用收件箱，recorded/read 不代表系统推送或用户收到。

## 前端与运维
八页分别为待办、日历、定时任务、执行记录、通知提醒、审批权限、来源状态、助理会话。普通导航/查询无模型；来源/epoch 迟到响应隔离，保留草稿与原 requestId。日历是时间窗口事项清单，不承诺完整月视图或拖拽。

API 在线时后台独立于页面运行；进程停机不执行，启动后按持久状态与 misfire 规则处理。一个后端独占一个数据库，先恢复撤权/取消/未知操作，再启用到期派发。回滚禁用工作区入口/计划，不降级 schema 或删除审计。

协议与入口见 [HTTP](../interfaces/http-api.md)、[MCP](../interfaces/mcp.md)；技术取舍见 [决策记录](../decisions/README.md)，故障处理见 [运行手册](../engineering/operations.md)。
