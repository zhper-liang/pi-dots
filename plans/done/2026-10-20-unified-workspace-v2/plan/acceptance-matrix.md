> **归档说明**：本文是计划当时的原文，未改写。文中 `issues/`、`progress/`、`evidence/` 等相对链接指向原始实施目录，原始票据、日志与验收证据保留在本地 `.scratch/`，不随本仓库分发；已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`（用 `git --git-dir=<备份> show HEAD:<路径>` 可取回）。

# V2 要求与验收映射

本文件是覆盖矩阵。01基础已完成（版本化记录/同库事务/主体与busy权限原型/迁移/规模/诊断），证据见[01](../progress/evidence/01/README.md)；02本地CRUD、显式授权/关联/版本/回执、隔离恢复与基本UI已通过，证据见[02](../progress/evidence/02/README.md)；03已完成稳定来源/独立授权/精确确认/真实CRUD与旧路径兼容，见[03证据](../progress/evidence/03/README.md)；04真实MCP/独立主体/用户确认/stdio及真实模型已完成，见[04证据](../progress/evidence/04/README.md)；05持久计划与内部动作记录已完成（[05证据](../progress/evidence/05/README.md)），06外部同步已完成（[06证据](../progress/evidence/06/README.md)），07关联提醒与持久收件箱已完成（[07证据](../progress/evidence/07/README.md)），08定时Agent已完成（[08证据](../progress/evidence/08/README.md)），09联合验收已按本轮最终源码及真实整链completed，10未开工。下表跨票产品能力不能因01原型通过视为完整通过。

|要求|主责票|关键验收|
|---|---|---|
|本地权威对象/持久化/迁移|01、02|无模型本地CRUD，事务恢复，版本冲突|
|中立来源/外部真实写回|03|精确确认、回执、冲突、unknown、旧路径兼容|
|UI与Agent共用业务规则但独立权限|01、03、04|同对象交叉操作、busy-only、撤权与主体伪造拒绝|
|MCP实际协议接口|04|内部真实client路径+独立stdio客户端握手/list/call|
|持久化一次性/每日/间隔任务|05|闭页执行、时区/DST、补跑、去重、暂停/取消、重启|
|外部变化同步|06|完整分页/覆盖、迟到generation、删除与移出窗口区别|
|关联提醒与通知|07|改期/删除后失效、到点核验、收件箱持久化、0模型|
|到点启动Agent工作流|08 completed|固定权限/预算、原Task恢复、5点SIGKILL/unknown、真实模型/MCP/外部忙闲/双尺寸，结果/用量可追溯|
|全链安全恢复/旧功能兼容|09|真实provider/模型、MCP、强杀故障点、双尺寸基本操作|
|前端最后优化|10|导航/布局/交互改进及优化后全链关键复验|

## 不得误报
- 关闭页面仍生成应用收件箱，不等于Web Push或系统弹窗。
- 首版只接一个飞书应用日历，身份模型可扩展不等于多连接器已交付。
- 固定daily/interval不等于完整cron/RRULE；外部重复日程仍只读。
- 稳定Operation/Occurrence去重不等于外部exactly-once。
- 旧租户实测豁免、unknown与失败记录继续保留。

## 09 本轮联合验收未通过门禁
专项113/全量856/lint/build通过；新增3测试（其中跨源一项是缺口哨兵，不是产品场景通过）。真实只读模型/provider与1440/390本地创建有本轮证据；真实核心写/关系及外部改期提醒链未验收。旧父取消定向复跑1/5失败。09 in_progress，10 blocked，阶段未关闭；见[09证据](../progress/evidence/09/README.md)。

## 09 取消续做 2026-10-19T23:01:04.839065+08:00（仍未完成）
- 原失败本轮10跑1败已保留；根因是测试未约束阻塞通知触发的合法模型调用顺序，不将原1断言简单改2，不改生产协作逻辑。
- child通知前取消屏障仍断言1；另测通知模型已开始再取消，迟到回执/用量/父子意图/重启均保留且无新调用。30轮×2通过，专项151/151，全量857/857，lint/build exit0。
- 仅collaboration-controls.test.mjs源码变化，其余192个server/src源码hash不变。无真实provider/model/UI新验收，无外部写/新资源/正式库/子Agent/依赖/Git提交。
- 跨来源关系契约确认及两条真实核心链仍阻塞09；保持in_progress，10前置未满足。见[续做证据](../progress/evidence/09/cancel-resume/README.md)。

## 09 契约阻塞复核 2026-10-19T23:23:05.622491+08:00（仍未完成）
- 本轮仅续09：实际源码及隔离缺口哨兵确认ItemLink仍同来源，eventSourceId注入仍拒绝；未获得双端持久引用/两端当前full/回执撤权契约确认，未擅自修改边界或实现新功能。
- 本轮专项151/151、全量857/857，lint/build exit0；200个server/src源码hash不变。无真实模型/provider/UI新验收、外部写或新资源；真实两核心链仍必需且未验，不记N/A。
- 09保持in_progress，10前置未满足；先确认原[最小建议](../progress/evidence/09/contract-gap.md)，再续09。见[本轮证据](../progress/evidence/09/contract-recheck/README.md)。

## 09 跨来源关系已修复 2026-10-19T23:49:34.536208+08:00
用户明确“修复”后在09内完成ItemLink双端规范引用/版本、当前full及live绑定授权、查询/幂等/回执守卫、旧同源兼容和最小UI。最终专项156/156、全量862/862，lint/build exit0；1440/390隔离fixture浏览器持久回读/撤权通过。真实模型/provider两核心链及跨源OS强杀未验收，**09仍in_progress，10前置未满足**；不再以字段契约待确认作为阻塞。详[本轮证据](../progress/evidence/09/link-fix/README.md)。

## 09 恢复与真实业务链续做 2026-10-20T00:46:05.074433+08:00
- 仅续09，直接前置04/06/07/08 completed；**09仍in_progress（8/10），10不得领取**。不是跨来源契约待确认，也不是产品提案接口不存在。
- 新增跨来源真实OS SIGKILL前Operation/后commit两回归：关系/Outbox/Operation原子、原请求重放、旧同源关系不变、busy撤权跨重启隐藏、删除不级联；10轮×2均通过。内部权限fixture不冒充真实provider。
- 本轮专项104/104、兼容专项57/57、全量864/864，lint/build exit0；202个初始server/src源码hash不变，只新增3测试/fixture文件。
- 实际UI创建Todo→真实模型MCP get/外部提案→UI精确批准→真实POST及精确回读→显式跨源关联→真实模型MCP回读相同payloadHash/持久成功回执已实测。实际外部客户端PATCH→后台60秒同步目标v2→闭页实际时钟入箱也已发生。
- 驱动在提醒后错误断言5==3失败：另行主动发起的回执读取2模型调用与提醒窗口重叠，不能据此宣称普通提醒0模型或整链通过。保留原failed报告，不改写成功。随后只读同库恢复，1440/390真实UI见原通知ID并标read、重启保留readAt、撤权redacted，0新模型/0外部写。恢复经历grant撤销/重授，不能冒充无中断全链。
- 本轮共13真实模型调用/37270tokens（unknownTokenCalls=0），27provider GET，只有1个新专用事件POST/PATCH/DELETE各一，均code0，精确GET cancelled，unknown0；不触旧事件，无外部资源待清。API/命名浏览器全停，隔离库保留审计，无正式库/子Agent/依赖/Git提交。
- 尚需：新隔离有界真实链将Agent回执读取置于提醒窗口之前，单独证明提醒0模型；在外部Event仍live时删除Todo并精确核验不级联。当前真实删除在provider已清理后仅证明关系历史保留，不可冒充live不级联。修正驱动仅syntax检查未重跑。
- 证据：[恢复续做](../progress/evidence/09/recovery-resume/README.md)；不借历史结果勾完验收。只续09，不进入10。

## 09 驱动修复与最终真实复验 2026-10-20T01:17:27.282884+08:00
**09 completed；01–09为9/10，10未开工。本节取代旧未完成结论，旧失败原样留存。**
- 修验收流程，不改产品权限：模型回执settle/live Event删Todo精确回读先于提醒观察；窗口拒绝且计数模型attempt，finish同时要求delta0/attempts0；UI marker绑定runId且操作失败不发marker。
- 新隔离库同一授权完成真实UI Todo→模型MCP提案→UI批准→真实POST/readback→跨源关系→模型MCP读同回执→删Todo/live精确GET（version/hash不变，外部写1→1）→闭页独立PATCH→后台sync v2→真实到点inbox→双尺寸UI reopen/read→同库重启保留ID/readAt。观察模型5→5、attempts0，无异常退出/中途重授拼接。
- 本轮专项183/183、全量866/866、守卫+跨源kill4/4，lint/build0；205个初始源码hash不变，仅2acceptance文件新增。01–08八项/证据SHA核验，正式09八项逐项映射见[本轮证据](../progress/evidence/09/driver-fix/README.md)。
- 5真实模型/18046tokens/unknownTokens0；19provider GET；仅1新专用事件POST/PATCH/DELETE各一code0，精确cancelled，unknown0，无外部待清理。API/浏览器/child关闭、授权撤销。无正式库/子Agent/依赖/Git提交，保留所有原改动与历史失败。
- 仍保留真实跨租户豁免、provider无原子CAS/exactly-once、收件箱非送达、停机不执行及规模预算；无新增未验收必需项。只完成09即停；10直接前置09已completed，不自动实施10。

## 10 最终验收 2026-10-20T02:07:42.248247+08:00
01–10 completed（10/10），本轮10八项均见[10映射](../progress/evidence/10/acceptance-checklist.json)。专项126/全量870、lint/build0、关键恢复4/4；真实整链/UI最终只读与所有失败见[10证据](../progress/evidence/10/README.md)。历史“未完成/10 blocked”条目仅历史，当前以NEXT_STAGE为准。功能支持/在线/回滚/unknown限制见[操作矩阵](../progress/evidence/10/operations.md)。
