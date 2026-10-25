> **归档说明**：本文是计划当时的原文，未改写。文中 `issues/`、`progress/`、`evidence/` 等相对链接指向原始实施目录，原始票据、日志与验收证据保留在本地 `.scratch/`，不随本仓库分发；已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`（用 `git --git-dir=<备份> show HEAD:<路径>` 可取回）。

# 规划依据

- NEXT_STAGE.md:3、12–18：23票运行骨架已归档，135条单票和11条联合验收收口；368测试及 lint/build 通过是历史验收记录，本次没有重新运行。
- NEXT_STAGE.md:17–18、30–31：下一阶段尚未排定，不能将候选方向视为开发授权。
- CONTEXT.md:766–792：原 MVP 路线依次是独立 Bot/Chief 管理、长期会话与配置、一层委派/协作、阻塞恢复、重启恢复、责任可视化、真实业务与主动任务、体验优化。
- CONTEXT.md:768–776 的“第一阶段范围”是较宽的产品 MVP，不能与刚完成的运行骨架里程碑等同。
- NEXT_STAGE.md:20–25：沿用 Task 身份、固定配置、回执、Skill、用量及安全边界，不把模拟业务视为真实外部集成。

- CONTEXT.md:176–226、321–341、613–642：Chief 是管理入口但非唯一任务入口；配置在授权能力池内；主管关系按任务确定；协作需保留 Harness Task 关联；delegate 不命名任务派发。
- 推进建议保存在 proposal.md；将原第1–2步作为下一里程碑是本次建议，不是已有自动排期。

## 拆票时的源码核对
- 既有本地tracker位于.scratch/agent-loop-foundation；上一轮明确采用一票一文件和ready-for-agent，无外部tracker。
- bots.mjs仍从三个静态preset构造目录；tasks.mjs在启动时接收bots并固定Task配置；网页已有选择Bot、新建Task与历史列表，因此不能重复拆成新功能。
- 对server/src的migrat/迁移入口检索未发现配置迁移实现；既有旧票README也明确显式迁移留待后续。此前proposal中的“既有显式迁移机制”表述过强，现纠正为本轮新增入口。
- 新增能力池管理、配置迁移与停用语义是建议范围，需随拆票由用户确认。

## 合并评审
- 用户明确否定12票粒度并要求合并，未批准发布或开发。
- 修订为6票：原01/02/03→新01，原04/05/06→新02，原07→新03，原08→新04，原09/10/11→新05，原12→新06。
- 新依赖为01无前置，02←01，03←02，04←01，05←02/04，06←03/05。

## 正式发布
- 用户确认六票合并方案并要求下一步；按to-tickets正式发布，一票一文件，状态ready-for-agent。
- 直接依赖保持01无、02←01、03←02、04←01、05←02/04、06←03/05；当前frontier只有01。
- 正式票不含具体实现路径或代码片段；共33条未勾选验收项，全部来源于获批草案。

## 文档整理规范
- 本阶段唯一入口是阶段README；计划放plan/，正式票放issues/，进度放progress/。
- 已归档旧阶段、证据清单及其原位引用不迁移；旧.planning目录只对当前next-stage-outline释放正文，留下单一导航。
- 原始规划发布日志保留为历史会话，不凭空补写时间或重标历史状态。

## 01实施发现（2026-10-17）
- 原先server/bots.mjs每次启动生成目录；执行器、恢复器、Skill与管理入口必须共享同一已持久化目录，不能仅补HTTP列表。现采用session级Harness Document，完成载入后再resume。
- Task快照和目录配置都固定：启动seed仅首次初始化；后续编辑/迁移留给02/03。历史测试中“下次启动自动改新Task默认”的期望需更新为持久目录语义，旧Task审计仍保留读取。
- Harness draft为Proxy，structuredClone不能直接处理；Document出入使用JSON可序列化副本。
- SQLite documents.kind保存JSON编码字符串；故障注入锚定record里的kind与document_revisions。存储故障后Harness要求关闭并重开，不在失败session里继续快照。
- 当前pnpm实际11.1.2，低于声明11.21.0；不安装/改依赖，使用已有工具链实际执行并披露。
- 新Bot mock-calendar profile只选择已登记日历能力与Skill适用性，Skill活动/产物/队列仍按Task隔离；同mock:personal是明确共享模拟资源，不是跨Bot复制私有历史。

## 02 初始发现
- 01已完成，02为配置/授权完整纵向票；现有BotDirectory持久目录、Task固定快照以及旧tool-access路由需复用。
- 根目录和my-app均无Git；Codegraph无索引，禁止自动初始化。Node v22.22.1；当前PATH pnpm 11.1.2与工程要求11.21.0不一致，后续核对可用固定版本。
- 验收需覆盖安装/用户池/Bot分配/Task快照四层权限、不可变版本/CAS、旧审批、并发撤权及重启。
- 02设计：复用ToolAccess session Document扩展池授权、实时Bot分配和撤销代数；Task记录固定代数快照，撤后再授权不能复活旧Task。BotDirectory保存不可变历史、幂等回执和审计。所有管理修改在同一Harness事务CAS，派发读取持久权限而不是进程缓存。
- 模拟读工具在事务外调用，需要实际调用前再次检查；模拟写与查询/幂等恢复已有边界检查，统一接入四层权限和资源交集。旧tool-access兼容入口保留（不允许扩池）。
- 保留持久Bot默认模型随普通重启不变；仅显式model覆盖限制为当前已配置描述符。旧单测任意model-id覆盖改为配置内模型，并新增未配置拒绝。旧撤权入口也增加代数：解除拒绝仅新Task恢复，旧Task/旧审批不复活（更新原先允许旧Task恢复的测试断言）。
- 即时撤权范围包括旧Skill激活、产物/历史回读、恢复查询和幂等重派；已经完成/在途操作的真实回执保留，不伪造撤回。旧Skill测试原“再授权旧Task可恢复”改为仍拒绝，新Task显式激活才成功。
- 最终安全复核修正：无授权来源的预置白名单不能引导用户能力池。新库与旧版缺池记录均默认空池fail-closed，不根据安装或历史快照猜测用户同意。原运行骨架测试统一通过专用fixture调用真实独立授权API显式建立测试前提（固定幂等回执，重启不重新授予已撤权限）；生产与网页夹具不导入该适配器。
- 空池进一步落实：初始Bot分配也为空（不可把预置建议当已授权分配）；明确扩池不自动分配Bot。新Task工具/资源固定为当时Bot分配，并记录权限来源；旧v01无permissionSnapshot的Task维持fail-closed，不因后来池授权提升。用户需明确分配后创建新Task；迁移仍留给03。

## 03开工（2026-10-17T23:04:48+08:00）
02已完成，03正式需求为安全空闲迁移并保留身份与用量；不允许隐式排队或普通消息触发。根目录无Git、Codegraph无索引，不初始化。

03实现设计：Harness长期awaitInput监听允许安全迁移，但ChatInput非空、ChatQueue、steering、审批/阻塞/未知动作、限额等待和终态一律拒绝。预览返回摘要哈希，确认事务内再次核对配置/任务/实时授权；同一Harness.commit与send共享串行事务，避免竞态。保持用户参数覆盖与显式提额，不重置用量/要求/历史/Skill。目标模型容量未知则拒绝，不猜容量；固定完整Skill校验其版本哈希与目标依赖。
工具链：Node22.22.1，pnpm11.1.2低于声明11.21.0，不自行升级。

03验证：33专项与全量444通过（含已完成运行骨架411）；真实Task9/conversation10从config-2显式迁移config-3，迁移时用量1模型/0工具/1394Token不变，续聊3模型/1模拟工具/4887Token且未知0，新职责与旧代号均进入回复。模型容量采用官方依据下保守128k本地安全上限，仅隔离验收夹具，不修改生产配置。

03最终：39专项与450全量、lint/build通过。已核对迁移后的再次撤权不复活、原成功审批与模拟效果不重放、原审批精确重试只回读不更改决定。跨阶段入口统一到01/02/03完成、frontier仅04。目标仅最新配置，不加入任意历史版本选择或容量客户端覆盖。网页忙碌边界采用确定性Harness测试，真实供应商只验证已实际执行的迁移/历史/新职责/重启链路。

## 04 实施发现（2026-10-18）
停用不能使用Harness.abortTask（会变成取消终态并归档）。采用BotDirectory持久状态、原phase入口停车及独立transport abort signal；所有输入和实际派发事务复查。保留Task原checkpoint/等待/队列，不创建平行执行状态机。迟到回执走原提交链，下一phase停车；取消仍使用既有abortTask。

04补充验证：仅使用原Task input.botId定位生命周期；不创建额外每Task停用索引。原取消检查复用BotDirectory准入。dispatchForBot在同Harness提交线内登记controller并启动transport，不等待外部响应；读工具在该实际边界再次复核撤权，避免新异步间隙破坏原授权语义。原finishReply在inactive时不采纳pending steer、不消费FIFO。配置幂等旧响应同步catalog时保留inactive。

## 05 实施发现（2026-10-18）
- 当前正式票为Chief对话管理（非归档iss5）；前置02/04已完成。
- 工具目录集中server/tools.mjs，授权为用户池/分配/Task快照交集，管理权需独立于业务工具和扩池权。
- 复用bot-directory与bot-configuration及既有Harness串行事务；不另建执行状态机。
- 管理工具独立于业务能力池：新Chief Task由服务端固定bot_inspect/bot_manage/report_blocker快照，旧Task不自动增权；管理工具不出现在可扩池目录，专业Bot不能通过提示词/配置获得管理权。
- 已抽取createConfiguredBot/changeConfiguration/deactivateDirectoryBot给HTTP和工具事务共用；Chief操作与稳定回执及工具结果同Harness提交，目录同步后中断目标在途transport。
- 稳定标识由Task/用户输入/动作/精确目标导出，不信任模型callId；相同输入同目标改参数拒绝，失败CAS也保存，不能自动rebase。创建使用暂存目录避免验证失败残留Bot。
- 初次拆分后测试夹具按toolCatalog全量扩池导致管理工具混入：将管理工具从业务catalog移出；52项前置回归通过。
- 新增12项Chief专项通过（含真实执行管线、阻断提问、并发、撤后重授、在途停用及重启）；完整回归执行中。测试初次send误传对象、blocker误用字段均已修正，不将失败冒称通过。
- 最终15专项、482全量、lint/build通过；确定性网页创建/配置/停用与持久真实管理服务回执、同库重启、1440/390布局通过。
- 现有真实bb-api/deepseek-v4.1-flash两次HTTP404 model_not_found（无configured account）；不擅自切换模型。真实三动作未展示，05不得completed，06仍阻塞。供应商原错误记录在05 evidence/provider-unavailable.log，不含凭证。
- 网页验收补齐停用Bot只读配置/审计，管理回执可跳转；管理源版本与底层审计标记Chief归属。目录同步置于同commit线避免并发旧快照复活inactive，只有管理工具调用才触发该同步。

## 06前置复核（2026-10-18）
- 当前既有配置模型global:deepseek-v4.1-flash真实请求HTTP200；未改.env或切换供应商。05旧404不再直接作为当前阻塞，需实际补验管理三动作。
- 根目录与my-app均无Git；不初始化。Node22.22.1/pnpm11.1.2；后者低于package声明，直接用已安装本地命令，不升级依赖。

- 真实模型同一输入创建两个Bot触发既有每动作/目标幂等边界（create固定new）；第一个落盘，第二个被拒并正确生成blocker。保留此安全证据，后续使用两条独立用户请求，不改变幂等规则。
- 新组合夹具初次迁移未设容量，被MIGRATION_CAPACITY_UNKNOWN正确拒绝；补显式65536测试容量。内部直接executeManagement不负责运行时catalog同步，改用真实用户能力池撤权验证，不改生产逻辑。

- 联合网页发现真实缺陷：迁移preview的changes包含事务draft代理，commit后失效，HTTP JSON序列化抛错；sendJson先写头后序列化，又在catch二次写头引发ERR_HTTP_HEADERS_SENT退出。根因修复：事务内物化preview；响应先序列化，headersSent后仅断开不重写。新增序列化失败后存活回归及迁移预览JSON回归。
