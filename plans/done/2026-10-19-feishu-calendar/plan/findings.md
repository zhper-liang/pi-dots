> **归档说明**：本文是计划当时的原文，未改写。文中 `issues/`、`progress/`、`evidence/` 等相对链接指向原始实施目录，原始票据、日志与验收证据保留在本地 `.scratch/`，不随本仓库分发；已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`（用 `git --git-dir=<备份> show HEAD:<路径>` 可取回）。

# 飞书日历 — 发布发现

2026-10-18T20:57:34+08:00
- 用户已选定飞书tenant_access_token应用身份，只把飞书当存储；Pidot承担交互。
- 上轮真实鉴权/列表HTTP200/code0、1个可见日历是历史复查，本轮未复测；不等于日程读写权限通过。
- 服务端凭证沿用被忽略的my-app/.env；根.env已跟踪，本轮不读取/修改任何凭证文件。
- 工具权限已通过toolSets的安装/能力池/分配/快照与epoch实时撤权；不可借连接器自动扩权。
- 现有审批绑定、action dispatch intent、未知结果核验可复用，但当前calendar write和重试含模拟语义，需显式分离真实/模拟身份，不能把真实操作记成simulated。
- 官方freebusy/list面向用户主日历/会议室；应用日历忙闲需基于有界事件实例计算，准确语义待本轮查证。
- 新阶段文件按AGENT文档规则放.scratch/feishu-calendar，不新建.planning或根目录重复正文。

## 本轮官方资料核对
- create事件接口文档确认idempotency_key为应用+日历维度唯一，32–128字符；文档片段未确认无限保留期，不能据此宣称外部exactly-once。
- freebusy/list是用户主日历/会议室；应用自有日历需通过有界实例视图计算忙闲。
- instance_view正确文档入口为/document/calendar-v4/calendar-event/instance_view，支持展开重复实例；/document/server-docs/.../instance_view未提取成功。
- 标准web搜索本轮无可用输出，改用Tavily官方文档搜索/提取；freebusy旧路径返回文档不存在，改用官方检索到的主日历页面。
- 初步拆为6个纵向切片：只读接入/创建闭环/更新删除/忙闲查询/图形编辑/群聊联合验收；第四票仅依赖第一票，默认仍按顺序执行而非并行。

## 源码定位补充
- server/tools.mjs toolSets/toolDefinitions/checkToolCall：安装/分配/快照/resource及epoch；新provider需独立资源，不更换旧mock语义。
- server/tasks.mjs openTaskStore/dispatchForBot/dispatchCalendarWrite：现有注入hook用于模拟工具，实际dispatch含Task/权限/取消/群守卫；真实路由需显式接入，不能把测试hook变HTTP参数。
- server/approvals.mjs binding/validApprovalBinding/outcomeApi：已有before/意图/批准一致性与用户风险重试，存在simulated:true路径；02/03须审计所有真实回执来源。
- server/action-query.mjs createActionRecoveryGuard/createActionQuery、action-idempotency.mjs createActionIdempotency：有恢复守卫与有界尝试，但当前模拟能力不能套给飞书。
- src/TaskApprovalControls.tsx当前aria/标题/成功文案为“模拟日历审批/模拟改期成功”；02必须同步真实/模拟投影，不只后端换适配。
- server/bots.mjs目前日历Bot描述与resource为模拟；01保留旧配置，显式新增真实能力和连接绑定；不提高旧Task权限。
- 138个源码/依赖文件基线已保存；已有大量用户未提交源码/文档修改，本轮只写新阶段和导航。

## 01实施实测
- 官方SDK instance_view无分页参数，仅start_time/end_time（<40天），响应items可省略；本轮真实空共享日历返回data={}，已用逐日切片/边界去重/预算和不完整标记，不借用普通list冒充展开。
- calendar GET返回data对象本身；Instance忙闲字段free_busy_status，事件详情data.event。
- 旧探测库test-mode Bot不能被启动参数自动升级成model；实际模型验收另建隔离库并显式授权绑定，复用同一专用容器。
- 真实模型需宿主提供固定resource；不在系统提示提供时模型正确拒绝猜测，修复后Task32实际调用只读工具。
- 本轮专用日历为空，真实详情/非空同源仍是01完成门槛；不为造数据越过只读范围。

## 01续做发现
最终beforeRequest是异步边界，需在其后再次核对连接身份再发送；非法外部时间须阻止complete=true及UI崩溃。群结果来源现有守卫可复用，本轮新增跨群/私聊/撤后重授回归。供应商租户变化未独立证实，不将应用凭证轮换等同覆盖。

## 01 UI隔离发现（2026-10-18T23:11:59+08:00）
权限轮询不仅飞书status有异步边界，Task请求及JSON也可能迟到；须最终epoch检查与单飞，并比较连接/授权版本。Task/token切换及权限检查失败不能残留可见日历名称与选择。真实非空外部数据缺口不因浏览器夹具通过而消失。

## 01真实非空发现（2026-10-19T00:18:43+08:00）
真实instance_view展开实例给recurring_event_id、不返回recurrence，UI须按二者识别重复。授权全天请求date 10-20至10-21，provider创建与读取返回UTC date 10-20至10-22；本轮保留原始返回并明确结束日期不含，不把请求当成功单日结果，不擅自更新/删除。普通+全天+三次重复共5实例，模型与双尺寸详情精确ID同源已验收。

## 01最终收尾（2026-10-19T00:34:09+08:00）
真实群主管task_assign→calendar真实5实例/5详情→shared_publish→主管shared_read/task_review accept通过；另一群/私聊真实模型读取精确共享记录均SHARED_DENIED。资源撤权后群子Task可能整体GROUP_FORK_DENIED（不是必返回脱敏200），历史/上下文也拒绝/隐藏；两次SIGKILL累计用量恢复。独立租户实测用户明确豁免，01 completed，未宣称该项实测通过。

## 02真实创建与恢复（2026-10-19T00:59:26+08:00）
Document是代理，source快照需JSON拷贝。Feishu创建幂等键只核实应用+日历scope及32–128长度，未证保留期，真实能力须false/false而不继承mock。意图、dispatchLease、providerReceipt、verifiedResult与Task结算分层；verified可恢复结算，未知不发新网。真实响应丢失测试实际生成一个事件，旁路精确读取不是产品已收到回执。撤权须隐藏审批本身及群子原事项，不仅聊天正文；风险重试保持真实source/bot，批准/核实都重新sync身份和epoch。

## 03 本轮（2026-10-19T01:45:02+08:00）
精确eventId由当前用户输入明确选择；读取详情的beforeHash与重要字段绑定更新/删除审批。官方calendar详情data直接对象需兼容，已实测回归；update/delete不继承create幂等。本地持久event lease与前后核验不能消除外部写者竞态，CAS未证。provider成功回执与当前目标状态分层，响应丢失保持未知并阻断后续覆盖。[实际数据/错误/官方依据](../progress/evidence/03/README.md)。

## 04实际发现（2026-10-19）
应用busy/free基于instance_view；DST全天不能+24h，UTC Z端点可选择显示时区而本地偏移须对应时区。跨片实例变化/密集/错误均不给free；工具级撤权也保护旧派生结果。真实21GET/0写、4模型15801Token，恢复/双尺寸见[04证据](../progress/evidence/04/README.md)。

## 05 本轮实际发现
实例省略recurrence与详情空字符串必须归一化否则beforeHash误冲突；真实模型正确安全拒绝后修复。图形数据不能把TaskCard快照外投，最新tool级calendarAccess守卫即使schedule仍可用也隐藏旧窗；候选参数在LLM写边界精确绑定。Task send FIFO事务同写输入与requestId回执，不需新审批状态机。实际6写/18模型/190394Token，双尺寸/恢复/失败见[05证据](../progress/evidence/05/README.md)。

## 06本轮实际发现（2026-10-19T12:02:42.650965+08:00）
定向派发应在输入准入核对源日历权限，不能让fork后才fault。读取飞书写回执不应授读者写权；作者权限撤回仍失效。awaitChildren要监听持久steer且watchDoc显式taskId；漏ID的真实故障31/115不可复活，只能保留证据并独立新群843验收。退役无archive返回410/故障投影不污染list。完整本轮复验与969933Token对账见[06证据](../progress/evidence/06/README.md)。
