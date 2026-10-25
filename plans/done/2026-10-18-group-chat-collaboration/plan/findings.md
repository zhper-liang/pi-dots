> **归档说明**：本文是计划当时的原文，未改写。文中 `issues/`、`progress/`、`evidence/` 等相对链接指向原始实施目录，原始票据、日志与验收证据保留在本地 `.scratch/`，不随本仓库分发；已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`（用 `git --git-dir=<备份> show HEAD:<路径>` 可取回）。

# 拆票依据与发现

- 既有阶段完成私聊入口一层协作；群聊/@仍为明确缺口，不重开旧票。
- 已安装pi-durable 1.3.0类型声明存在forkConversation与Conversation.fork；仅证明接口存在，不等于Pidot上下文/权限适配已完成。
- task-context.mjs的buildTaskContext要求conversation.owner.taskId匹配并按已消费输入组装历史，不能直接把fork继承历史当成现成可用上下文。
- task-creation.mjs提供createChatTask与admitNextInput；collaboration.mjs提供委派、等待、回报和控制，应复用而非新建一套调度器。
- 本次不运行模型、正式业务或既有回归；最终应只声称文档发布验证。

## 核对后的契约决定
- createChatTask目前总是创建新conversation；02须明确支持子Task持有消息点fork，不只传creationConversationId就宣称继承已完成。
- collaborationService拒绝子任务继续委派并要求活动pidot.user位于自身conversation；群fork适配必须保持这些守卫，不把原群输入直接冒充子输入。
- 已存在task_review精确验收；02最小回报必须保留submitted/accepted边界，04交付完整群内交互和返工路径。
- 串行六票共48项验收；01普通群聊，02@端到端，03共享来源，04待决验收，05控制，06联合验收。
- 本轮从上轮已有未提交文档修改继续，保留既有工作；未修改业务源码或历史票据。

## 发布核验
六票48项、依赖无环与frontier01已验证；活动链接全部可达，1417份源码/历史保护文件哈希一致。真实模型/业务测试未执行，不能将发布校验当作实现验收。

## 01早期映射草案（已由下节与最终源码取代）
早期考虑groupId=taskId和token摘要分主体；最终采用独立UUID groupId与既有单Bearer authenticated-user，不落库token摘要。最终映射及fork扩展点如下。

## 01实施映射（2026-10-18，编码前）
- Group Task复用pidot.chat定义、TaskCard和独立task-owned conversation；card.kind=group，card.groupId引用群Document记录。成员/管理员/创建幂等收据放全局GroupDirectory Document，创建与createChatTask同一Harness事务提交。
- 普通输入仍调用现有send/ChatInput/ChatQueue/admitNextInput；群管理员是Task固定bot，不扩工具/资源/Skill快照，非Chief保持无管理权限。
- API拟提供POST/GET /api/groups和GET /api/groups/:groupId；群消息通过绑定Task的既有入口，所有群历史/控制路径验证群、Task、conversation和authenticated-user归属。当前单Bearer主体沿用既有约束，不虚构多用户系统。
- 02扩展点：groupId→Task/conversation和源messageId；本票不fork、不开放定向派发；结构化@明确拒绝。管理员协作不得越出固定成员集。
- 恢复使用原Harness resume，不增加调度器；创建幂等键和成员持久化，同键变参冲突，失败原子回滚。

## 01最终发现与边界
- GroupDirectory按UUID绑定Task/公共conversation/admin/固定成员，createChatTask同事务；旧私聊记录无群字段仍正常。公开API沿用单本地主体，不能声称支持多租户。
- get验证群归属，旧/api/tasks历史及控制别名先get校验；Bot限定路径拒绝群，groupId不能替代私聊Task。非Chief不继承管理权，成员不扩大授权。
- 首票显式禁止群内旧task_assign协作，避免绕过02的原生fork/回报与成员范围适配；02需解除该门槛并一起交付闭环。
- SIGKILL模型在途沿用既有策略：没有Token阈值时可新计次恢复；本票未知用量+Token阈值夹具验证等待而非自动重试，不将模型结果冒充exactly-once。
- 中途有同期工作区写入导致导出不一致；保留中间失败证据，修复最终接口后重新全量/专项验收。最终12专项/571全量通过，不沿用中间通过。

## 02最终实现发现（2026-10-18）
- 原生tx.forkConversation(parent,at,{ownership:{kind:'task',taskId}})返回带parent/owner的conversation；scanEntries会包含祖先的原conversationId，必须区别来源。createChatTask可选forkSource，在创建子Task的同一事务直接fork，不创建替身conversation或复制全文。
- fork公共上下文动态读取原生祖先，只选截止锚点的已消费公共用户输入/最终管理员文本；当前锚点显式保留，排队未消费、工具、Skill、审批、共享正文及后续消息不注入。子本地输入使用独立brief.id；本子历史/压缩/回执只认本conversation，来源群在读/恢复时复查。
- 结构化targetBotId/requestId的认证输入固定目标，GroupDirectory只存幂等收据；原ChatInput/FIFO准入后在原reply事务派发，已有Collaboration稳定键绑定group/source/root/child/fork。管理员已有collaboration+task_review许可才接收非自身目标，实时撤权及预算再次验证；自动派发计一次父工具预算，子独立预算不归零。
- Harness在首个table write后禁止tx.task等表读，派发后必须返回原awaitChildren检查点，不能同提交继续collect。失败则整笔回滚，恢复从同一输入重建至多一个关系/fork。
- submitted不是accepted；沿用task_review精确revision和绑定主管，群最终回报加原消息/childTaskId/task_id；无@允许既有许可下群成员内自主委派，定向输入不允许管理员追加广播，子Task禁止递归。
- 本轮24专项/583全量、lint/build无警告；真实模型两链共13428Token（6模型/4工具），3定向SIGKILL边界、真实同库恢复和1440/390网页通过。证据见progress/evidence/02，历史01不作02验收。

## 03交付发现（2026-10-18T16:21:45+08:00）
- 既有sharedRecords原子机制可直接复用；新增群同根身份校验与groupId元数据，不额外授权资源。
- Harness禁止在当前事务已append后table scan；来源需在上下文构建时持久化到task-scoped GroupResultSources，结果提交只读该投影，不扫描新日志。
- 工具注册表依赖history/fork，因此结果守卫动态导入shared/groups避免ESM TDZ；普通历史纯对象夹具不执行群路径。
- accessVersion为派发前乐观锁，不是所有已授权读者的内容版本；向B合法分享不能使A既有结果无条件过期。结果回读检查当前ACL和content version，模型派发仍校验本次精确accessVersion。
- 结果/简报/历史/摘要均可能派生受限信息；撤回后隐藏投影并弃旧摘要，已有实际外发上下文无法从模型记忆中擦除，UI明确提示。
- 本轮41/591通过，真实模型11宿主预留attempt、10完成provider调用、8工具、44236已知Token、1未知预留。03completed，下次04，本窗口停止。

## 04实施发现（2026-10-18）
- 原Blocker/Approval/Review已支持精确绑定，缺口在群页子事项聚合与原地处理，不应另建状态机。群children路由查持久关系再调用原API。
- Harness Document draft不能逃逸事务；terminal子任务的事项必须读CancelledTaskArchive；来源守卫限定issueDecision，避免改变既有撤权执行恢复策略。
- hashchange在bot/task相同也清detail，必须刷新effect；最终跨群/私聊/延迟响应、1440/390验证通过。
- 本轮85专项/599全量、lint/build，真实非Chief主管→问题回答/转用户/原审批→同子返工revision2接受，三等待SIGKILL及最终源码同库恢复；详见04证据。不以历史测试替代。

## 05控制与概览发现（2026-10-18）
- 既有stopWork仅依据Collaboration关系，漏掉普通群输入；对群当前activeInput或limited lastInput精确匹配rootWorkId即可复用原watchRootStop/settleStoppedInput，不新增工作状态机。先查持久stop幂等，拒绝terminal新控制，未来输入不会被旧停止污染。
- 概览原来只有有子关系时出现；群无子根也须可见。ChatQueue直接投影、CallUsage按唯一Task求和（长期累计，不伪造每轮账），stops与active根分别显示；accepted子Task不退休/清账。
- 概览也是数据出口：GroupResultSources实时投影不可见时，不能泄漏原待决正文。取消意图从TaskCancellation读，不等待terminal归档；单子取消事件可追溯。群children cancel/limits校验群/原关系，仍遵守原TASK_BUSY/限额/撤权守卫。
- 1440/390中主管链接必须bot=groups；已接受/已提交/等待原事项用明确文字，队列独立展示。切群延迟验收需拦实际/api/tasks/:id（仅拦/api/groups不会命中App读取）；最终实际命中1次延迟，未串群。
- 本轮122/610通过，新增11测试含3SIGKILL；真实12预留attempt/8工具/29811已知Token/2未知，均如实保留。下一可领取06，05完成即停。

## 06联合验收发现（2026-10-18）
- 单目标@固定目标与普通自主同根两子是两类契约：不可把@后的第二Bot暗中塞进同一输入；A分别验证两类真实路径。
- 共享来源保守绑定作者配置中全部calendar_*资源工具，主管/目标只有read_schedule时不能读含write/read_event作者的事实；用最小只读专业Bot的新隔离库验证可分享事实，不能为演示放宽生产ACL或给Chief写许可。原失败/预留账保留。
- accepted+原根已结算是稳定重启核对点；只比较业务/用量和身份，恢复审计可合法追加。新增联合回归覆盖accepted SIGKILL、重复输入及后续根。
- 本轮236专项/611全量，真实45宿主预留/43可靠usage/33工具/230203已知Token/2未知；A/B及三处真实SIGKILL、1440/390通过。详见06证据。阶段关闭，无新票自动授权。
