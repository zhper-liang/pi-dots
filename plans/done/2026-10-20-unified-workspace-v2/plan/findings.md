> **归档说明**：本文是计划当时的原文，未改写。文中 `issues/`、`progress/`、`evidence/` 等相对链接指向原始实施目录，原始票据、日志与验收证据保留在本地 `.scratch/`，不随本仓库分发；已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`（用 `git --git-dir=<备份> show HEAD:<路径>` 可取回）。

# V2 差距分析发现

- 日历UI不是独立业务入口：app.mjs:90–102 → tasks.mjs:1216–1248，读取要求taskId，写提案回到聊天/模型审批。
- FeishuCalendar是session Document，只有identity/binding/containers；sync(tx)只刷新认证身份/绑定，不是外部事件增量同步。
- toolSets有任务固定权限与撤权epoch；缺少可与Agent区分的业务用户操作上下文。
- 现有通知userNotifier仅更新群协作blocker，不能当作通用提醒/推送服务。
- 现有Harness恢复是执行恢复，不是已实现的一次性/周期业务计划；未在扫描范围发现MCP协议入口或通用持久化计划实体。扫描结果是范围性证据，不是全仓绝对否定。
- 已安装pi-durable类型存在sleep(until,context)，不能仅据此宣称到点持久化/唤醒满足要求；01/05要求隔离原型和崩溃测试。继续唯一Harness执行权，不引入第二套Agent调度状态机。
- 新版以既有SQLite/Harness Documents实现业务repository，业务记录与Task运行状态区分。01必须先验证事务、规模与迁移，失败回报而不是静默换库。
- 官方MCP 2025-11-25 lifecycle/transports已读取并保存；作为固定兼容基线，不声称这是最新版本。无新增依赖决定。
- 检索异常：codegraph第二次偏向历史fixture，已改为明确源码路径；不存在的dist/task.d.ts与harness.d.ts未继续猜路径，采用实际types.d.ts。

## 官方协议依据（固定兼容基线，不是最新版本断言）
- MCP 2025-11-25 Transports：`https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`；官方原文保存在[证据](../progress/evidence/publication/mcp-transports.txt)。本版只选择本地stdio及宿主内部协议边界，不开发公网HTTP MCP。
- MCP 2025-11-25 Lifecycle：`https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle`；官方原文保存在[证据](../progress/evidence/publication/mcp-lifecycle.txt)。支持版本协商与能力协商；实现前明确冻结支持子集，不把普通tool定义视为MCP。
- 工具检索官方文档后通过官方站点直接读取markdown存档；本文不引入第三方SDK，不对未测试版本组合做兼容保证。

## 发布核验
10票/80条验收均未实施；直接前置无环、首票01。841个基线文件未改变，14个检查源文件hash一致。所有新文档相对链接已检查；初次发现票据NEXT_STAGE层级错误，已统一修正并重验。设计指定的默认间隔/重试值是V2选择，不是从旧实现推断。

## 01 实施发现（2026-10-19）
- 本次用户自动化明确授权当前正式阶段一票，与发布时历史等待授权不同；仅领取01，无前置，初始工作树干净。
- 已安装1.3.0 `defineDocFamily`支持session复合键与同commit修改；`Tx`无scanDocuments，而Storage有该方法。实现repository自有100-ID分页+256哈希存在性分片，不越过Harness私接adapter，不复制整个历史。
- Harness `runtime.sleep`是内存等待，不自带持久计划：隔离Probe用持久Schedule/Task checkpoint、watch版本变更与重启重读验证基础。普通同Harness Task与20 sleep同进程实际聊天均通过，但不是已交付生产定时器。05仍需实现规则、补跑/租约/恢复，08才启动实际工作流。
- 生产01只发可信user句柄并开放认证诊断。agent/background authority seam默认拒绝，测试用明确宿主resolver验证工具action/resource/readScope及各epoch交集。04/05/08须从真实Task/Bot/plan按事务生成resolver，不能信任body或把fixture scope当生产授权。缺失readScope失败关闭。
- 对象14类schemaVersion1；Occurrence具schedule+revision+UTC触发唯一索引且身份不可改写；普通Todo与TaskCard完全分离。缺少V2元数据只新增基础，不改旧审批/unknown/权限。v0仅空白未初始化标记支持显式迁移；不声称任意旧业务版本迁移。
- 首次专项暴露原型错误：后台fixture Bot不匹配、误用done/succeeded状态、Node无活跃句柄提前退出、旧Task创建参数不符。均修复原型/测试并保留初始失败日志，未修改SDK或换库。另修UI证据脚本相对导入层级错误。
- 规模边界：每记录32KiB，每分区10万记录，分页最多100；存在性分片最多1000键，追加页100 ID，软删除保留历史；临界容量需归档评审。1000 Todo+1000 Occurrence分页/去重已本轮测试，未据此声称百万级性能。

## 02 实施发现（2026-10-19）
- 前置01 completed，自动化本轮授权只领取02；初始01未提交代码与证据已保存hash/diff，不重开01、不启动代理。
- 生产服务真实只有01 diagnostics/get/命令事务骨架；本轮新增workspace-local并挂入同一workspaceService，复用commitLocal/repository/可信user。Bot/后台仍失败关闭，未用UI token冒充Bot。
- 本地用户明确授权/撤销独立Grant（epoch检查、Operation审计），默认不授权；来源授权管理不是Bot授权。正文不足时列表/详情/关联/回执与幂等重放均失败关闭；同来源ItemLink不跨来源查找目标。
- Todo due支持可选date或带偏移ISO，并保存IANA timezone；Event只普通带偏移定时，重复/全天/不支持字段显式拒绝。服务校验真实日期、顺序与版本；不将TaskCard当Todo。
- 删除是保留版本的tombstone，ItemLink保留且投影两端deleted/completed状态，不连带创建/删除另一对象；Outbox与对象/Operation同事务。没有Reminder产品记录入口，后续07消费目标版本失效，不提前实施提醒产品。
- 专项模拟抛错以及真实OS SIGKILL（object+outbox后Operation前、commit后HTTP回执前）核对无半提交/原requestId仅一个对象回执，均为隔离SQLite/Harness。
- UI工具两次playwright-cli run-code发生Session closed（保留日志），改用已安装playwright-core直接启动Chrome，无新依赖。首UI locator命中strong/option两元素与删除断言未等待请求结束均是验收脚本问题，修正后新隔离库重跑；未用夹具成功代替业务持久化。
- 实际UI 1440/390可无Task CRUD、完成/重开、显式关联、取消、权限撤销/再授权；409来自真实并发API写。503是浏览器故障夹具，移除后恢复；断响应先route.fetch真实commit再abort，查询原请求获得持久回执。

- 首批专项5/5通过；接入成功回执缓存时专项暴露create合成投影丢visibility导致多增版本（3而非2），修为dispatcher返回真实回读投影，保留失败日志special-second.log。初lint未用import警告已移除。

- 增加Agent原主体再核验时，文本替换误入read权限对象导致专项TypeError；修正仅在Operation确认/派发核验，并保留special-expanded.log。

- 真实UI已POST成功并精确回读；随后list失败，查得UI默认窗口含毫秒导致provider拒绝非整秒timestamp；当前事件留在本轮manifest，不重复创建。修复UI默认整秒并服务端拒绝毫秒窗口；继续原事件CRUD与清理。

- 真实桌面CRUD三次均provider code0、原事件已DELETE；尺寸检查发现新panel落入260px grid列造成溢出，修仅本panel跨列及换行（非整体样式优化）。不重复桌面副作用，原请求回执复验后做390。

- 新旧交叉fixture首测MODEL_FAILED：测试reply不合既有model契约（漏mode/reply），不是生产模型失败；按旧专项fixture修复，并保留interop-debug.log。真实Agent只读实测2模型调用、1工具、4186 tokens已独立通过。

- 首最终lint exit0但有fixture未用assert警告；删除该import后重新跑最终专项/全量/lint/build，不将警告轮当最终无警告结果。

## 03 收尾（2026-10-19T17:28:40.787690+08:00）
稳定source身份与授权epoch分离；旧eventLeases及未决Task扫描保留，双向unknown不重发。真实provider六写/两事件均已删除精确回读；真实模型只读2调用4186 tokens。最终114专项/782全量，lint/build无警告；未把fixture外部故障当真实unknown。详见[03证据](../progress/evidence/03/README.md)。旧跨租户豁免保留，CAS竞态公开，04才接实际MCP工具宿主。

## 04 收尾（2026-10-19T18:34:14.153700+08:00）
- MCP固定2025-11-25实际JSON-RPC/session/client与本机stdio；内部Bot走协议、凭证外置。OpenAI provider工具名不支持点，显式workspace_*别名恢复canonical，已实际模型验收，不另引SDK。
- 用户来源∩Bot独立Grant∩固定Task工具/资源及workspaceSnapshot；源/连接/epoch撤销不能由旧历史、产物分页、共享或群派生绕过。独立client无Task冒用，SHA256摘要/TTL/撤销保留审计；本地/外部提案无自批。
- 同库local apply/Outbox/Operation事务复用，原requestId先查回执避免版本变化阻断幂等；5分钟精确确认、原主体授权变化失效。外部复用03 dispatcher，0新增真实写、2GET真实MCP只读。
- 本轮最终专项129/全量796、lint/build无警告；8真实模型/4工具/25324Token，实际UI编辑v2后Agent同ID读取，拒绝cancelled/允许v3，撤权模型8→8；双尺寸重启原回执与3点实际SIGKILL。错误与修复不删，见[04证据](../progress/evidence/04/README.md)。
- 初全量19失败：terminal派生结果用归档读取而非退役doc；工具目录顺序保持；单history paging fixture显式足够容量避免新增快照使合法压缩影响另一测试目标。生产压缩策略未变，不把fixture容量当真实容量。
- 最后真实外部user撤权参数需enabled=false但readScope仍full/busy，首清理失败后只恢复同库清理，未重复provider读取；服务/浏览器已停，用户/Bot/client许可撤销。旧03六写上限/CAS及跨租户豁免原样保留。下一05前置01/02满足，未领。

## 05 收尾（2026-10-19T19:20:35.622955+08:00）
- 同库repository/Operation/Occurrence事务复用，严格at/daily/interval、IANA/DST、用户来源授权snapshot、revision、唯一UTC触发点；启动重扫、250ms timer仅有界唤醒，不占Agent slot/不另造Agent状态机。
- 唯一可用动作internal_deterministic_record明确不是通知；Operation与Occurrence同commit。六点实际SIGKILL保留原关联，一次性15分钟/每日间隔latest/全局每tick10/同计划不重叠；unknown/旧Task/Delivery不盲重派。
- 本轮专项67/全量810、lint/build无警告；真实UI1440/390管理/并发409/闭页两次trigger/同库重启原回执；0模型/provider/通知。最大200计划含保留审计；筛选前历史分页保留next。
- 首required误扩展致4旧原型失败、夹具漏botId、React警告、UI label定位均已修复并最终重跑，失败原位保留。详见[05证据](../progress/evidence/05/README.md)。下一06前置03/05满足，未领取。

## 06 领取与源码核对
- 03/05 completed；06于本轮用户单票授权下独占领取，初始未提交改动已快照保护。
- 实际calendar.read对instance_view按每日切片，供应商非分页；has_more/page_token/密集片即complete=false，不能伪称增量或完整分页。06复用此adapter，不造HTTP客户端。
- 05生产动作仍仅内部记录；06通过既有后台唤醒tick附加持久SyncState扫描，业务计划与SyncState分离，不创建Agent Task或第二执行状态机。
- 读网络不持事务；缓存发布须检查授权快照、run claim及cacheRevision，防旧同步覆盖实时写回执；失败保留已发布coverage并显式stale。
- 06扩展专项10/10含原子rollback、Reminder invalidated、Outbox重复/ABA、重复实例/移出窗口/空coverage；四点真实SIGKILL通过，非provider强杀。
- MCP外部list原实现把limit/cursor传给adapter严格校验，实际参数不兼容；06在共享MCP边界先剥离分页参数，查询后有界投影，不扩大授权。
- 真实provider本轮独立新事件创建/外部修改，Chrome关闭后后台实际读取到新版；验收脚本复用参数不正确被guard拒绝，已依实际Task创建契约修正，不改授权守卫。

## 06 收尾 2026-10-19T20:09:09.479870+08:00
- completed；最终专项79/全量822、lint/build无警告；真实provider独立新事件三写code0、精确cancelled，闭页同步/双尺寸同库重启/真实模型同源通过。用户/Bot撤权403，服务Chrome停。
- 旧父取消计数测试中间全量及单跑2≠1、最终全量通过；保留证据而非修改旧断言，09需关注时序风险。1000窗口成员/Reminder预算、非增量推送/非外部权威/未启用通知限制见[06证据](../progress/evidence/06/README.md)。下一07未领。

## 07 实施发现（进行中）
- 06已在其他窗口完成，本窗口按最新交接领取07，不续旧06。初始未提交源码/diff已保存。
- 实际05仅内部动作、06仅Reminder.invalidated，无送达驱动；本轮复用05事务claim，注入deliver_notification动作而非另造执行状态机。
- Notification不存标题/正文，详情按当前授权目标投影；失权仅保留redacted状态，不借local授权读取external历史。External发送每次精确get校验，网络不在commit内。
- 当前首轮新增5专项通过、lint/build exit0；尚未完成外部/恢复/闭页/最终全量验收。

## 07 最终收尾 2026-10-19T20:45:35.089600+08:00
- completed，最终专项95/全量838、lint/build无警告；提醒16专项含四点实际OS强杀同库恢复。
- 本轮15源码文件，196源码hash一致。真实最终新库：到期前改期与同步版本2、闭Chrome后fresh核验只一external入箱、另一local入箱；390创建/确认停用/已读，1440/390重启/503恢复/撤权自动redacted无溢出。
- 中间已完成at重复重排已修completed/cancelled不复活并保留旧3历史；旧无scheduleId Reminder保留、unknown原关联阻止重排；Operation旧回执也复核目标源权限。失败见[证据](../progress/evidence/07/README.md)。
- 共2个本票新事件6写全code0/精确cancelled、25 provider reads、0模型；两隔离运行均已撤权并停止。无Push/闭页系统弹窗，后端停机不执行；200计划/1000扫描预算保留。下一08前置04/05/07 completed，未领。

## 08 实施中发现
- 原repository transaction无conversation scope；复用既有createChatTask必须传Harness root.id，不能假设UI root.commit上下文。原Task和Occurrence.taskId需同commit。
- 能力池、Bot工具分配、业务Grant是三个独立门槛；测试/后台不得因业务Grant就扩池。
- 已发模型请求后重启不能盲重放；本票在既有Task增加workflowUnknown停等phase，CallUsage unknownTokenCalls与原Task均保留，取消仍用原入口。
- 当前真实模型闭页简报与5点SIGKILL已首测，但未完成最终验收，不标completed。

## 08 收尾 2026-10-19T21:39:00.700775+08:00
- completed，最终专项110/全量853、lint/build exit0，193源码hash一致；真实外部忙闲7行仅start/end/timezone、2模型/1MCP、0外部写；实际取消保留unknown1。
- 真实终态取消退役Task Document必须从原readCancelledArchive读取；直接tx.doc会试图重新创建而报Task terminal，已修且加回归，不另造归档或执行器。
- 飞书窗口继承整秒限制，毫秒失败保留；Agent业务错误不再误标“模拟工具”，保留已知TaskInputError错误码/脱敏文本。
- 模型失败/额度在原Task停等，后续到期只coalesced不另建重试；计划未来取消与Task当前取消明确分离。固定只读Task禁止追加/steer/迁移。
- 真实失败、OS强杀、网络故障、清理与适用N/A详08证据，09仍需联合验收。

## 09 联合核对（进行中）
- 本轮重新运行既有专项110/110、全量853/853通过；仅本轮结果，不替代真实全链验收。
- 核心场景阻塞候选：09要求本地Todo显式关联外部Event，但当前ItemLink schema仅todoId/eventId/relation、按同source查两端；workspace-local.mjs明确同来源，外部来源仅Event且禁止本地命令。当前UI也只有同源关系。不能把“同标题”或复制外部Event到本地伪装关联。需用隔离用例证明后明确最小契约修订建议，不擅自扩大来源权限。
- 本轮先补1000对象/1000执行历史分页、后台sync→reminder跨模块回归；所有SIGKILL既有专项已重新运行。
- shell证据汇总命令中echo ===$n被zsh作=扩展，exit1；改用printf，不影响已完成测试。

## 09 收尾发现（2026-10-19T22:11:25.826954+08:00，未完成）
- ItemLink跨来源缺口已由新隔离联合用例证明；详细最小契约修订建议见[09缺口](../progress/evidence/09/contract-gap.md)。不私扩权限/持久化边界，不复制外部对象冒充关系。
- 1000对象/1000执行记录28页无丢失/重复，同库重启后验证；后台sync→reminder→inbox/重启/撤权跨模块夹具通过，普通提醒0模型。
- 最终专项113/113、全量856/856、lint/build exit0后，旧父取消五次定向复跑1失败/4通过，重现2≠1；非根治，不放行09。
- 真实只读模型2调用/1MCP/6345tokens、4provider reads，0写/0新外部资源、撤权清理已做；双尺寸创建持久化通过。真实全链写/外部改期到提醒仍未验收。
- 脚本失败如实保留：漏actionSpec、zsh status只读/echo展开、UI selector超时/重名文本；均修脚本，不重放业务写。

## 09 取消续做 2026-10-19T23:01:04.839065+08:00（仍未完成）
- 原失败本轮10跑1败已保留；根因是测试未约束阻塞通知触发的合法模型调用顺序，不将原1断言简单改2，不改生产协作逻辑。
- child通知前取消屏障仍断言1；另测通知模型已开始再取消，迟到回执/用量/父子意图/重启均保留且无新调用。30轮×2通过，专项151/151，全量857/857，lint/build exit0。
- 仅collaboration-controls.test.mjs源码变化，其余192个server/src源码hash不变。无真实provider/model/UI新验收，无外部写/新资源/正式库/子Agent/依赖/Git提交。
- 跨来源关系契约确认及两条真实核心链仍阻塞09；保持in_progress，10前置未满足。见[续做证据](../progress/evidence/09/cancel-resume/README.md)。

## 09 契约阻塞复核 2026-10-19T23:23:05.622491+08:00（仍未完成）
- 本轮仅续09：实际源码及隔离缺口哨兵确认ItemLink仍同来源，eventSourceId注入仍拒绝；未获得双端持久引用/两端当前full/回执撤权契约确认，未擅自修改边界或实现新功能。
- 本轮专项151/151、全量857/857，lint/build exit0；200个server/src源码hash不变。无真实模型/provider/UI新验收、外部写或新资源；真实两核心链仍必需且未验，不记N/A。
- 09保持in_progress，10前置未满足；先确认原[最小建议](../progress/evidence/09/contract-gap.md)，再续09。见[本轮证据](../progress/evidence/09/contract-recheck/README.md)。

## 09 阻塞判断排查 2026-10-19T23:27:04.409553+08:00
正式架构已规定复合身份与派生授权，Reminder已有跨源引用/实时权限/回执复核；缺的是ItemLink贯通，不能把同源源码当正式禁令或笼统称全部契约不存在。保留边界确认约束，不将本次排查解释为批准持久字段。定向缺口1/1，无业务代码改动。[详细证据](../progress/evidence/09/blocker-diagnosis/README.md)。

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

## 10 实施发现
- 原App将6个业务面板全部堆在会话grid之前；本轮只拆前端导航，保留已挂载面板以免切页丢失unknown请求/草稿。
- ExternalWorkspace来源轮询与query/get响应原无epoch迟到隔离；补前端请求guard，来源/权限变更即作废，服务端契约不变。
- Schedule历史轮询原响应可能覆盖新选计划；补selectedRef检查。

## 10 收尾 2026-10-20T02:07:42.248247+08:00
- V2 10/10 completed。导航只前端复用，旧业务后端0改动；最终126/870、lint/build0，UI双尺寸/闭页/确认/延迟隔离，真实三写清理及最终只读撤权已过。
- 真实链5模型/18289tokens，最终源码只读2模型/4662tokens；失败驱动也计入全轮11模型/32416tokens、47GET，只有新事件三写/unknown0。
- 当前只支持单机在线执行、应用recorded/read；provider竞态/旧跨租户豁免和历史失败不隐瞒。清理误用内部API被拒后可信公开wrapper恢复，服务浏览器全停。
