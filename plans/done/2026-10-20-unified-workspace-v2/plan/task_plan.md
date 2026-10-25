> **归档说明**：本文是计划当时的原文，未改写。文中 `issues/`、`progress/`、`evidence/` 等相对链接指向原始实施目录，原始票据、日志与验收证据保留在本地 `.scratch/`，不随本仓库分发；已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`（用 `git --git-dir=<备份> show HEAD:<路径>` 可取回）。

# V2 阶段计划

## 本轮架构与拆票
|工作|状态|
|---|---|
|源码差距分析与证据|completed|
|架构V2.0与共同契约|completed|
|10张正式票与依赖拆分|completed|
|文档/依赖/保护哈希验证及交接|completed|

用户本轮授权分析、架构、拆票；本轮不实施业务票。前端优化最后，定时任务在本版必交付。

## 实施依赖
|票|交付|直接前置|实施状态|
|---|---|---|---|
|01|[业务对象、权限上下文与持久化基础](../issues/01-domain-repository-contract.md)|无|completed|
|02|[本地日程与待办的统一业务闭环](../issues/02-local-items-service.md)|01|completed|
|03|[飞书适配与统一受控写入](../issues/03-external-source-command.md)|02|completed|
|04|[真实MCP入口与Agent业务工具](../issues/04-mcp-business-tools.md)|03|completed|
|05|[持久化定时任务与执行记录](../issues/05-durable-schedule-core.md)|01、02|completed|
|06|[外部变化同步与缓存一致性](../issues/06-external-sync.md)|03、05|completed|
|07|[关联提醒与持久通知收件箱](../issues/07-reminders-notifications.md)|05、06|completed|
|08|[定时Agent工作流与统一管理](../issues/08-scheduled-agent-workflows.md)|04、05、07|completed|
|09|[V2功能安全与恢复联合验收](../issues/09-joint-acceptance.md)|04、06、07、08|completed|
|10|[最后优化统一工作区并复验](../issues/10-frontend-polish.md)|09|completed|

建议单窗口顺序01→02→03→04→05→06→07→08→09→10；直接依赖如表，不以顺序替代前置核验。01已在后续用户明确授权下完成；02已在本轮授权下完成；01–09已completed；09真实整链和最终回归已通过，10直接前置满足但未领取。每次领取仅一票，完成停止，不启动并行Agent。

## 关键门槛
01先验证既有存储/事务/唤醒API，失败需修订而不是另起底座。09先验功能，10再前端优化并复验。所有票实施状态由真实验收更新，ready-for-agent只是规格状态。

## 重启导航
[共同契约](proposal.md) · [差距分析](code-gap-analysis.md) · [发现](findings.md) · [验收矩阵](acceptance-matrix.md) · [发布日志](../progress/sessions/2026-10-19-architecture-publication.md)

## 01 本轮实施计划
1. 核实已安装Harness事务、文档分页与sleep能力。
2. 实现版本化repository、可信主体及命令骨架和最小诊断。
3. 隔离迁移/规模/强杀原型、专项/全量/lint/build与交接。
本次用户消息已授权01；其余票未领取。

## 01 本轮收尾
2026-10-19T15:19:19.156912+08:00：01 completed（八项）；专项16/全量758、lint/build全部exit0，源码hash一致。02直接前置01已满足，本窗口到此停止。生产定时/MCP/外部业务仍由后续票交付，不用原型冒充产品。

## 02 本轮实施计划
1. 核对契约、保留初始改动并以独占锁领取02。
2. 复用同库repository/service，实现本地CRUD、用户来源授权、显式关联及最小UI。
3. 隔离专项/重启恢复/双尺寸真实UI、全量/lint/build并按证据交接。

## 02 本轮收尾
2026-10-19T16:19:33.030678+08:00：02 completed，8项全部实测；专项11/全量769、lint/build exit0。实际隔离UI双尺寸/重启、真实并发409、断响应查回执、两个SIGKILL通过，0模型/外部写/Task创建。下一03直接前置02满足；05直接前置01/02也满足，但推荐顺序先03。本窗口停止，不连续领取。

## 03 本轮实施计划（2026-10-19T17:05:49.610140+08:00）
- in_progress：仅03，前置02 completed；核对既有provider派发和权限→adapter/Operation确认→最小API/UI→专项/全量/lint/build及真实验收→交接。领取证据[会话](../progress/sessions/2026-10-19-03-external-command.md)。

## 03 本轮收尾
2026-10-19T17:28:40.787690+08:00：03 completed，专项114/全量782，lint/build exit0无警告；真实专用日历六写均code0、两事件删除回读cancelled，手动0模型/0Task；真实旧Agent2模型/1工具/4186 tokens只读；双尺寸UI/原回执重启与新旧unknown守卫、实际SIGKILL通过。下一04直接前置03满足，05前置01/02也满足但推荐04；本窗口停止。

## 04 本轮实施计划（2026-10-19T18:01:50.770261+08:00）
- in_progress：仅04，前置03 completed；工具/主体核对→MCP协议及client/桥→Bot独立授权与最小UI→专项/真实/全量验收→如实交接。不领取05。

## 04 本轮收尾（2026-10-19T18:34:14.153700+08:00）
04 completed：专项129/全量796，lint/build exit0，hash一致；真实MCP/stdio、真实模型8调用4工具25324Token、UI手动v2→Agent读取/提案→用户拒绝/允许v3，撤权模型8→8；双尺寸原回执重启、三点SIGKILL、真实外部只读2GET/0写。失败与修复及N/A见[04证据](../progress/evidence/04/README.md)。下一05前置01/02满足，本窗口停止，不领取05。

## 05 本轮实施计划
1. 核对持久存储、权限、后台唤醒和既有源码；保留全部初始改动。
2. 实现规则、事务claim/恢复、确定性内部驱动器及最小API/UI。
3. 本轮隔离专项/实际SIGKILL/闭页与双尺寸UI/全量/lint/build，按实测交接。

## 05 本轮收尾
2026-10-19T19:20:35.622955+08:00：05 completed，8项验收满足。专项67/全量810，lint/build无警告；六点实际SIGKILL原关联恢复，双尺寸创建/修改/暂停恢复取消、闭页触发、同库重启。仅内部确定性记录，06/07/08生产动作仍禁用；下一06前置03/05均completed，未领取，完成本票即停。详见[证据](../progress/evidence/05/README.md)。

## 06 本轮执行 2026-10-19T19:40:25.568528+08:00
- in_progress：核对契约与源码→复用adapter/repository实现持久同步→最小API/UI→专项/全量/lint/build、恢复与真实外部验收→单票交接。
- 本轮仅06；初始未提交改动已快照保护，无子Agent/新增依赖/正式库/Git提交。

## 06 收尾 2026-10-19T20:09:09.479870+08:00
completed；专项79/79、全量822/822，lint/build无警告。真实闭页同步/3外部写/模型同源/1440与390/同库重启，四点OS强杀；缓存/coverage/Outbox/Reminder invalidated同事务。中间旧取消测试失败保留，最终同源码全量通过，09需关注。下一07前置05/06 completed，未领；只做06即停。[证据](../progress/evidence/06/README.md)。

## 07 本轮执行 2026-10-19T20:17:01.165728+08:00
- in_progress：既有持久调度与变更核对→Reminder/Delivery/权限/最小UI→本轮验收与交接；仅07。

## 07 收尾 2026-10-19T20:45:35.089600+08:00
completed；专项95/95、全量838/838、lint/build无警告，真实闭页/外部核验/双尺寸/同库重启/四点SIGKILL通过。中间失败审计全部保留，最终196源码hash一致；两个新事件6写均code0且cancelled、0模型，服务/Chrome已停。下一08前置04/05/07 completed，未领取。[证据](../progress/evidence/07/README.md)。

## 08 本轮执行 2026-10-19T21:04:05.743380+08:00
- in_progress：仅08；核对现有调度/Task/MCP权限→原子创建和只读约束→最小管理UI→专项/全量/lint/build及真实模型/恢复/UI验收→如实交接。

## 08 本轮收尾 2026-10-19T21:39:00.700775+08:00
completed；专项110/110（08新增15）、全量853/853、lint/build exit0。五点OS SIGKILL原Task关联/unknown计数、真实闭页模型/外部忙闲7行/额度取消/同库重启/双尺寸/撤权已验证，0外部写。中间失败及终态归档修复见[08证据](../progress/evidence/08/README.md)。09直接前置04/06/07/08均completed，未领取。本窗口到此停止。

## 09 本轮实施计划
1. 核对01–08证据及源码，保护既有改动，登记领取。
2. 新隔离库执行联合业务链、安全、分页增长与SIGKILL，修复本票问题。
3. 运行最终专项/全量/lint/build与适用真实模型/provider/双尺寸；如实记录未验收。
4. 同步票/矩阵/发现/进度/NEXT_STAGE；只09，完成或真实阻塞后停止。

## 09 本轮收尾（未完成）
2026-10-19T22:11:25.826954+08:00：已补3联合回归，专项113/全量856/lint/build本轮通过；额外父取消复跑1/5失败，跨来源关系缺口阻塞核心链路。09保持in_progress，先核对证据/contract-gap.md后续做；不得领取10。真实只读模型/provider及双尺寸本地创建已执行，完整真实写链未执行。

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

## 10 本轮 2026-10-20T01:43:28.357902+08:00
仅10领取，09前置满足。实现→专项/全量/lint/build/真实跨入口与恢复→证据/交接；任何必需项未通过则保持未完成。日志：[10](../progress/sessions/2026-10-20-10-frontend-polish.md)。

## 10 最终收尾 2026-10-20T02:07:42.248247+08:00
10 completed，01–10 completed（10/10）；126专项/870全量、lint/build0、关键kill4/4；最终UI与真实模型/provider复验见[10证据](../progress/evidence/10/README.md)。全部必需验收满足、旧豁免/unknown保留；V2关闭，无下一可领正式票，不开新阶段。
