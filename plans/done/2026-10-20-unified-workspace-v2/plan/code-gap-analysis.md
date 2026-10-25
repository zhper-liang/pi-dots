> **归档说明**：本文是计划当时的原文，未改写。文中 `issues/`、`progress/`、`evidence/` 等相对链接指向原始实施目录，原始票据、日志与验收证据保留在本地 `.scratch/`，不随本仓库分发；已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`（用 `git --git-dir=<备份> show HEAD:<路径>` 可取回）。

# V2 代码差距分析

分析日期：2026-10-19；工作区当前文件而非HEAD。没有运行业务验收。范围与源码SHA见[证据](../progress/evidence/publication/inspected-sources.json)，关键词扫描见[扫描](../progress/evidence/publication/code-scan.json)。旧742/742等仅为旧交接，不是本次结果。下表路径均相对仓库根目录。

|能力|实际源码证据|已有边界与V2差距|处置/归属票|
|---|---|---|---|
|服务生命周期|my-app/server/index.mjs:9–42；openTaskStore/createApiServer|Node API与Task存储有启动/关闭；关闭网页不关闭服务，但没有业务计划恢复入口|复用启动，接业务repository及计划恢复；01/05|
|持久化与执行|my-app/server/tasks.mjs:35–36,714–724,1204–1212；TaskCard/ChatInput/ChatQueue|已用Harness及官方SQLite adapter，消息、权限、审批与检查点持久化；不是日程/待办数据库产品模型|新增业务Documents/repository，不复制Task状态机；01/02|
|原生UI|my-app/src/CalendarView.tsx；FeishuCalendarPanel.tsx|已有日/周图形日历、查询和表单，provider/Task强绑定。CalendarView.submit→feishu/command→模型精确审批；不是无模型手动CRUD|保留旧入口兼容；最小工作区切片逐票加入，视觉重构最后；02/03/10|
|HTTP服务|my-app/server/app.mjs:76–102；tasks.mjs:1216–1248|API统一token；飞书读取明确要求taskId，且消耗该Task工具额度。没有用户与Agent两种业务主体的统一命令入口|抽出workspaceService/ActorContext；用户操作不借Bot配额，不绕过自身授权；01–03|
|来源管理|my-app/server/feishu-calendar.mjs:7,84–107；createCalendarService|FeishuCalendar session Document存identity、单binding与containers；绑定变更使授权epoch失效|保留连接器安全行为，补中立Source/Connection/Capability映射；01/03|
|外部日程读取|同文件projectFeishuEvent/read、feishu-availability.mjs|已映射实例、时区、只读重复/全天、分页完整性与忙闲；不是可跨连接器的持久缓存|抽取adapter，保留完整性/来源，不把忙闲读取升级为正文权限；03/06|
|外部写入|feishu-write.mjs:23 dispatchFeishuCreate；feishu-mutation.mjs:28 dispatchFeishuMutation；approvals.mjs:85–153|已有参数规范化、精确审批、beforeHash、发送守卫、回执/unknown；依赖聊天Task审批绑定。provider reliableQuery/stableIdempotency明确false|新命令/确认实体复用派发策略，旧审批保持旧身份恢复，禁止强迁移和伪造Task；03|
|权限|tools.mjs:43–76 toolSets；feishuTaskAllowed；groups/collaboration守卫|Bot固定工具/资源与实时撤权epoch、来源隔离已实现；没有独立业务用户grant与Agent busy-only投影契约|保留所有守卫，新增主体/目的/来源授权交集；01/03/04|
|MCP|server顶层非测试mjs、src顶层tsx及package扫描无MCP/jsonrpc/tools/list/tools/call；tools.mjs为进程内工具定义|现有模型tool调用不是已实现MCP协议。这里只对扫描范围作结论|实际协议边界及宿主客户端、受限凭证、list/call测试；04|
|本地日程/待办|已检视生产模块清单；MockCalendar/模拟工具为验收资源|模拟日历不是用户本地权威对象；未发现统一业务Todo/Event及API|新增，不把任务卡/审批blocker改名成待办；02|
|同步|feishu-calendar.mjs:85–93 sync(tx)|该sync仅比较client.identity，重置binding及授权版本；不是外部事件变化同步。现有前端3秒轮询是权限核验|独立SyncJob/coverage/tombstone，窗口重查先行；06|
|定时任务|execution-recovery.mjs:1–2；index.mjs；扫描未见业务scheduleId/nextRunAt|Harness负责已有Task恢复，非用户可管理的一次性/每日计划。installed types.d.ts:196存在sleep，但仅类型不证明产品语义|必须交付Schedule/Occurrence与后台恢复、取消/去重/补跑；05/07|
|通知|blockers.mjs:76–87 userNotifier|仅群协作blocker持久投影，注释明确无外部推送|通用持久收件箱/Delivery与旧blocker适配；07|
|工程保障|package.json；server/*recovery.test.mjs；旧证据|测试/lint/build脚本与隔离验收模式可复用；V2没有测试通过记录|每票实测，09最终联合验收，10优化后复测|

## 核心结论
不是“补几个定时按钮”，也不是重写已有运行底座。最大结构差距是业务入口与聊天Task耦合、缺中立业务对象、缺真实MCP边界和独立业务计划。业务repository、命令、连接器与调度都由现有后端承载，避免引入多服务/双库分布式事务。

## 不据此作出的结论
没有证明不存在任何历史原型；没有验证全仓所有分支；没有运行真实日历/模型/数据库；没有验证外部服务原子CAS、exactly-once、全租户和Web Push。关键词无命中不代替01的精确原型检查。
